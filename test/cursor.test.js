import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 假 Cursor CLI：不连任何模型、不碰真账号
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-cursor-test-'));
const fake = path.join(root, 'bin');
fs.mkdirSync(fake);
const source = fs.readFileSync(new URL('../scripts/fake/cursor-agent', import.meta.url), 'utf8');
fs.writeFileSync(path.join(fake, 'cursor-agent'), source.replace(/^#!.*\n/, `#!${process.execPath}\n`), { mode: 0o755 });
fs.writeFileSync(path.join(fake, 'cursor-agent.mjs'), source);
fs.writeFileSync(path.join(fake, 'cursor-agent.cmd'), '@echo off\r\n"%~dp0\\cursor-agent.mjs" %*\r\n');
process.env.CLAWCHAT_HOME = path.join(root, 'data');
process.env.PATH = `${fake}${path.delimiter}${process.env.PATH}`;
process.env.FAKE_CURSOR_LOG = path.join(root, 'calls.jsonl');
process.env.FAKE_CURSOR_SECS = '0.02';
process.env.OPENAI_API_KEY = 'test-must-not-pass';
process.env.CURSOR_CONFIG_DIR = path.join(root, 'user-cursor'); // 老板自己的 Cursor 配置：不能被用上
process.env.CLAWCHAT_CURSOR_LONG_PROMPT = '3000'; // 测试里把「太长」的门槛调低
const { runAgent, AGENTS, BASE_AGENTS, sessionUsage } = await import('../lib/agents.js');
const { parseCursorModels, cursorArgs, cursorError, detectCursor, removeCursorHome, cursorEnv } = await import('../lib/cursor.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => { delete process.env.FAKE_CURSOR_SCENARIO; delete process.env.FAKE_CURSOR_LOGGED_OUT; });
const project = path.join(root, 'project');
fs.mkdirSync(project);
const room = { id: 'room-a', cwd: project, permission: 'project', models: { cursor: 'grok-4.7' } };
const calls = () => fs.existsSync(process.env.FAKE_CURSOR_LOG) ? fs.readFileSync(process.env.FAKE_CURSOR_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const start = (opts = {}) => {
  const steps = [];
  const handle = runAgent('cursor', { room, prompt: '检查一下项目', systemPrompt: '你是 Cursor，按群规工作', onStep: (s) => steps.push(s), ...opts });
  return { ...handle, steps };
};

test('Cursor：登记成员、解析模型清单、检测登录', async () => {
  assert.equal(AGENTS.cursor.engine, 'cursor');
  assert.ok(BASE_AGENTS.includes('cursor'));
  const m = parseCursorModels('\x1b[2mAvailable models\x1b[0m\n\nauto - Auto (current, default)\ngrok-4.7 - Grok 4.7\nauto - 重复\n\nTip: use --model');
  assert.deepEqual(m.models.map((x) => x.id), ['auto', 'grok-4.7']);
  assert.equal(m.defaultModel, 'auto');
  const which = (n) => (n === 'cursor-agent' ? path.join(fake, 'cursor-agent') : null);
  const { execFile } = await import('node:child_process');
  const run = (bin, args, _t, env) => new Promise((r) => execFile(bin, args, { env }, (err, stdout, stderr) => r({ ok: !err, stdout, stderr })));
  const info = await detectCursor({ which, run });
  assert.equal(info.loggedIn, true);
  assert.ok(info.models.some((x) => x.id === 'grok-4.7'));
  process.env.FAKE_CURSOR_LOGGED_OUT = '1';
  const out = await detectCursor({ which, run });
  assert.equal(out.loggedIn, false);
  assert.match(out.error, /cursor-agent login/);
  assert.equal((await detectCursor({ which: () => null, run })).path, null);
});

test('Cursor：只认 cursor-agent，不会用到 Grok 装的同名 agent 命令', async () => {
  const res = await runAgent('cursor', { room, prompt: 'x' }, ).done.catch((e) => e);
  assert.ok(res.ok, res.error);
  assert.ok(calls().length >= 1);
});

test('Cursor：第一轮带群规、开新会话；第二轮续上同一段记忆，不再重复群规', async () => {
  fs.rmSync(process.env.FAKE_CURSOR_LOG, { force: true });
  const first = start();
  const r1 = await first.done;
  assert.ok(r1.ok, r1.error);
  assert.equal(r1.text, '（假的 Cursor）做完了');
  assert.match(r1.session, /^[a-f\d-]{36}$/);
  assert.equal(r1.model, 'grok-4.7');
  assert.ok(first.steps.some((s) => s.kind === 'think'));
  assert.ok(first.steps.some((s) => s.kind === 'read' && s.text === 'README.md'));
  assert.ok(!r1.steps.some((s) => s.kind === 'say' && s.text === r1.text), '最终回复不在过程里重复');
  const c1 = calls().at(-1);
  assert.match(c1.prompt, /群规/);
  assert.ok(c1.args.includes('--new-session-id'));
  assert.ok(c1.args.includes('--force'));
  assert.equal(c1.args[c1.args.indexOf('--sandbox') + 1], 'enabled');
  assert.ok(c1.home.startsWith(path.join(process.env.CLAWCHAT_HOME, 'cursor', 'homes')), '用 ClawChat 自己的配置目录');
  const r2 = await start({ session: r1.session, prompt: '接着来' }).done;
  assert.ok(r2.ok, r2.error);
  assert.equal(r2.session, r1.session);
  const c2 = calls().at(-1);
  assert.equal(c2.args[c2.args.indexOf('--resume') + 1], r1.session);
  assert.doesNotMatch(c2.prompt, /群规/);
  assert.equal(c2.home, c1.home);
  const usage = await sessionUsage('cursor', r1.session);
  assert.equal(usage.used, 150);
});

test('Cursor：分身只读、复制记忆到临时目录，不写回本体', async () => {
  const r1 = await start().done;
  const before = calls().at(-1).home;
  const side = await start({ session: r1.session, side: true, prompt: '分身来看看' }).done;
  assert.ok(side.ok, side.error);
  assert.equal(side.session, r1.session);
  const c = calls().at(-1);
  assert.notEqual(c.home, before);
  assert.equal(c.args[c.args.indexOf('--mode') + 1], 'ask');
  assert.ok(!c.args.includes('--force'));
  assert.equal(c.args[c.args.indexOf('--resume') + 1], r1.session);
  assert.ok(!fs.existsSync(c.home), '分身的临时目录用完删掉');
  const hist = fs.readdirSync(path.join(before, 'chats')).map((d) => path.join(before, 'chats', d, r1.session, 'history.jsonl')).find((f) => fs.existsSync(f));
  assert.doesNotMatch(fs.readFileSync(hist, 'utf8'), /分身来看看/);
});

test('Cursor：权限对应到参数', () => {
  const base = { cwd: '/p', models: {} };
  const full = cursorArgs({ room: { ...base, permission: 'full' } });
  assert.equal(full[full.indexOf('--sandbox') + 1], 'disabled');
  assert.ok(full.includes('--force'));
  const ro = cursorArgs({ room: { ...base, permission: 'readonly' } });
  assert.equal(ro[ro.indexOf('--mode') + 1], 'ask');
  assert.ok(!ro.includes('--force'));
  assert.ok(cursorArgs({ room: base, session: 'x', newId: 'y' }).includes('--resume'));
  assert.ok(!cursorArgs({ room: base, session: 'x', newId: 'y' }).includes('--new-session-id'));
});

test('Cursor：环境变量去掉别家的 Key，配置目录换成自己的', () => {
  const env = cursorEnv('/h', { OPENAI_API_KEY: 'a', ANTHROPIC_BASE_URL: 'b', CURSOR_CONFIG_DIR: '/user', CURSOR_API_KEY: 'k', PATH: '/bin' });
  assert.equal(env.CURSOR_CONFIG_DIR, '/h');
  assert.equal(env.CURSOR_DATA_DIR, path.join('/h', 'data'));
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.CURSOR_API_KEY, 'k');
  assert.equal(env.PATH, '/bin');
});

test('Cursor：没登录、额度用完、找不到记忆都给出能看懂的提示', async () => {
  process.env.FAKE_CURSOR_LOGGED_OUT = '1';
  const a = await start().done;
  assert.equal(a.ok, false);
  assert.match(a.error, /cursor-agent login/);
  delete process.env.FAKE_CURSOR_LOGGED_OUT;
  process.env.FAKE_CURSOR_SCENARIO = 'quota';
  const b = await start().done;
  assert.match(b.error, /额度/);
  delete process.env.FAKE_CURSOR_SCENARIO;
  const c = await start({ session: '11111111-1111-1111-1111-111111111111' }).done;
  assert.equal(c.ok, false);
  assert.match(c.error, /session not found/);
  assert.equal(c.session, '11111111-1111-1111-1111-111111111111');
  assert.match(cursorError('Warning: The provided API key is invalid.'), /cursor-agent login/);
  process.env.FAKE_CURSOR_SCENARIO = 'crash';
  const d = await start().done;
  assert.equal(d.ok, false);
  assert.equal(d.session, null, '第一轮就失败的会话不保存');
});

test('Cursor：停止能结束这一轮', async () => {
  process.env.FAKE_CURSOR_SCENARIO = 'hang';
  const h = start();
  await new Promise((r) => setTimeout(r, 300));
  await h.kill();
  const res = await h.done;
  assert.equal(res.ok, false);
});

test('Cursor：删群时清掉这一群的记忆目录，别的群不受影响', async () => {
  const other = { ...room, id: 'room-b' };
  await runAgent('cursor', { room: other, prompt: 'x' }).done;
  await start().done;
  const homes = () => fs.readdirSync(path.join(process.env.CLAWCHAT_HOME, 'cursor', 'homes'));
  assert.equal(homes().length, 2);
  await removeCursorHome(room);
  assert.equal(homes().length, 1);
});

test('一键安装、一键登录：用官方安装命令（测试里换成假的），装完能找到命令；登录把网址交给界面', async () => {
  const { installEngine, loginEngine, INSTALLERS, which } = await import('../lib/agents.js');
  assert.match(INSTALLERS.codex.mac, /chatgpt\.com\/codex\/install\.sh/);
  assert.match(INSTALLERS.grok.mac, /x\.ai\/cli\/install\.sh/);
  assert.match(INSTALLERS.cursor.mac, /cursor\.com\/install/);
  const target = path.join(root, 'installed');
  fs.mkdirSync(target);
  // 装完会按登录 shell 重排 PATH：本机真装了 cursor-agent 时会排到假的前面，测完要把 PATH 还原
  const savedPath = process.env.PATH;
  process.env.PATH = `${target}${path.delimiter}${process.env.PATH}`;
  process.env.CLAWCHAT_INSTALL_CMD = `printf '#!/bin/sh\\necho ok\\n' > "${target}/fake-tool-$CLAWCHAT_INSTALL_ENGINE"; echo installed`;
  const bad = await installEngine('nope');
  assert.equal(bad.ok, false);
  const res = await installEngine('codex');
  assert.match(res.output, /installed/);
  delete process.env.CLAWCHAT_INSTALL_CMD;
  // 装完会按登录 shell 重排 PATH，本机真装了 cursor-agent 就会排到假的前面：先还原，下面的登录一定要用假的（真的会打开浏览器）
  process.env.PATH = savedPath;
  assert.ok(which('cursor-agent').startsWith(fake), '登录用的必须是假的 cursor-agent');
  const login = await loginEngine('cursor');
  assert.equal(login.ok, true);
  assert.match(login.url, /^https:\/\/cursor\.com\//);
  assert.equal((await loginEngine('claude')).ok, false);
});

test('Cursor：消息太长时放进临时文件，命令行里只放一句「先读文件」，跑完文件删掉', async () => {
  const long = '很长的历史记录。'.repeat(1000);
  const res = await start({ prompt: long }).done;
  assert.ok(res.ok, res.error);
  const c = calls().at(-1);
  assert.ok(c.prompt.length < 500, '参数里只有一句引导');
  const file = c.prompt.match(/(\/\S+message\.md)/)[1];
  assert.ok(!fs.existsSync(file), '跑完删掉临时文件');
});

test('Cursor：按群的权限写拒绝规则，只有完全放开能调 MCP；只读、分身连命令和写文件都拦', async () => {
  const { cursorDeny } = await import('../lib/cursor.js');
  assert.deepEqual(cursorDeny({ permission: 'full' }), []);
  assert.deepEqual(cursorDeny({ permission: 'project' }), ['Mcp(*:*)']);
  assert.deepEqual(cursorDeny({ permission: 'readonly' }), ['Mcp(*:*)', 'Shell(*)', 'Write(**)']);
  assert.deepEqual(cursorDeny({ permission: 'full' }, true), ['Mcp(*:*)', 'Shell(*)', 'Write(**)']);
  await start().done;
  const home = calls().at(-1).home;
  const read = () => JSON.parse(fs.readFileSync(path.join(home, 'cli-config.json'), 'utf8')).permissions.deny;
  assert.deepEqual(read(), ['Mcp(*:*)']);
  await runAgent('cursor', { room: { ...room, permission: 'full' }, prompt: 'x' }).done;
  assert.deepEqual(read(), [], '换了权限，下一轮就按新的来');
  await start().done;
  assert.deepEqual(read(), ['Mcp(*:*)']);
});

test('登录：自己失败退出、又清理不掉时，记录留着，之后再点也不会再开一套', async () => {
  const { loginEngine } = await import('../lib/agents.js');
  const dir = fs.mkdtempSync(path.join(root, 'login-fail-'));
  const pids = path.join(dir, 'pids.txt');
  // 假登录：开一个脱离的子进程，然后自己失败退出；假 ps：查询总是失败（清理没法确认）
  fs.writeFileSync(path.join(dir, 'cursor-agent'), `#!${process.execPath}\nimport fs from 'node:fs';import { spawn } from 'node:child_process';const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });c.unref();fs.appendFileSync(${JSON.stringify(pids)}, c.pid + '\\n');console.error('登录失败');setTimeout(() => process.exit(1), 100);`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  try {
    const first = await loginEngine('cursor');
    assert.equal(first.ok, false);
    await new Promise((r) => setTimeout(r, 4000)); // 等自动清理有结果
    const second = await loginEngine('cursor');
    const third = await loginEngine('cursor');
    assert.equal(second.ok, false);
    assert.equal(third.ok, false);
    assert.equal(fs.readFileSync(pids, 'utf8').trim().split('\n').length, 1, '只开过一套登录');
  } finally {
    process.env.PATH = oldPath;
    for (const pid of fs.readFileSync(pids, 'utf8').trim().split('\n')) try { process.kill(Number(pid), 'SIGKILL'); } catch {}
  }
});

test('登录：程序打印出网址后马上就退出了，网址也不能丢', async () => {
  const { loginEngine } = await import('../lib/agents.js');
  const dir = fs.mkdtempSync(path.join(root, 'login-quick-'));
  // 用 grok 来测：前面那条测试故意留下了 cursor 的「没清理干净」记录，cursor 的登录会被拦下
  fs.writeFileSync(path.join(dir, 'grok'), `#!${process.execPath}\nconsole.log('Open https://accounts.x.ai/device?code=quick');process.exit(0);`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  try {
    const res = await loginEngine('grok');
    assert.equal(res.ok, true);
    assert.match(res.url, /^https:\/\/accounts\.x\.ai\//);
  } finally {
    process.env.PATH = oldPath;
  }
});
