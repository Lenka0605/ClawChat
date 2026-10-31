import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-grok-test-'));
const fake = path.join(root, 'bin');
fs.mkdirSync(fake);
const source = fs.readFileSync(new URL('../scripts/fake/grok', import.meta.url), 'utf8');
fs.writeFileSync(path.join(fake, 'grok'), source.replace(/^#!.*\n/, `#!${process.execPath}\n`), { mode: 0o755 });
fs.writeFileSync(path.join(fake, 'grok.mjs'), source);
fs.writeFileSync(path.join(fake, 'grok.cmd'), '@echo off\r\n"%~dp0\\grok.mjs" %*\r\n');
// 没有真实登录信息和真实 AI：故意放入假的付费 Key，验证它不能传到 Grok。
process.env.CLAWCHAT_HOME = path.join(root, 'data');
process.env.GROK_HOME = path.join(root, 'user-grok');
process.env.PATH = `${fake}${path.delimiter}${process.env.PATH}`;
process.env.FAKE_GROK_LOG = path.join(root, 'calls.jsonl');
process.env.FAKE_GROK_SECS = '0.02';
process.env.XAI_API_KEY = 'test-must-not-pass';
process.env.GROK_CONFIG = '{"models":{"default":"paid-custom"}}';
process.env.GROK_CLI_CHAT_PROXY_BASE_URL = 'http://must-not-connect.invalid';
fs.mkdirSync(process.env.GROK_HOME);
const authFile = path.join(process.env.GROK_HOME, 'auth.json');
fs.writeFileSync(authFile, JSON.stringify({ 'https://auth.x.ai::test-client': { key: 'test-oauth-token', auth_mode: 'oidc', refresh_token: 'test-refresh' } }));
const configFile = path.join(process.env.GROK_HOME, 'config.toml');
fs.writeFileSync(configFile, '[model.grok-4.7]\napi_key = "paid-key"\nbase_url = "http://must-not-connect.invalid"\n');
const { runAgent, sessionUsage, AGENTS, BASE_AGENTS } = await import('../lib/agents.js');
const { grokEnv, grokApiKeyWarning, parseGrokModels, grokArgs, grokError, detectGrok, removeGrokHome } = await import('../lib/grok.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => { delete process.env.FAKE_GROK_SCENARIO; delete process.env.FAKE_GROK_LOGGED_OUT; });
const room = { cwd: root, permission: 'project', models: { grok: 'grok-4.7' }, efforts: { grok: 'low' } };
const calls = () => fs.existsSync(process.env.FAKE_GROK_LOG) ? fs.readFileSync(process.env.FAKE_GROK_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const start = (opts = {}) => {
  const steps = [];
  const handle = runAgent('grok', { room, prompt: '记住暗号，然后检查项目', systemPrompt: '你是 Grok，按群规工作', onStep: (s) => steps.push(s), ...opts });
  return { ...handle, steps };
};
const findHistory = (home, id) => {
  const group = fs.readdirSync(path.join(home, 'sessions')).find((g) => fs.existsSync(path.join(home, 'sessions', g, id)));
  return path.join(home, 'sessions', group, id, 'chat_history.jsonl');
};
async function until(check) {
  const deadline = Date.now() + 20000;
  while (!check()) {
    assert.ok(Date.now() < deadline, '等待假 Grok 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('Grok：登记成员和模型清单；免费账号不因没有付费订阅被挡住', async () => {
  assert.equal(AGENTS.grok.engine, 'grok');
  assert.ok(BASE_AGENTS.includes('grok'));
  assert.deepEqual(AGENTS.grok.aliases, ['grok']);
  const model = parseGrokModels('You are logged in with grok.com.\nDefault model: grok-4.7\n  * grok-4.7 (default)\n  * grok-4.6\n  * grok-4.7');
  assert.equal(model.loggedIn, true);
  assert.deepEqual(model.models.map((m) => m.id), ['grok-4.7', 'grok-4.6']);
  assert.equal(parseGrokModels('You are not authenticated.').loggedIn, false);
  const info = await detectGrok({ which: () => 'fake', run: async (_bin, args, _timeout, env) => {
    assert.equal(env.XAI_API_KEY, undefined);
    assert.equal(env.GROK_CONFIG, undefined);
    assert.notEqual(env.GROK_HOME, process.env.GROK_HOME);
    assert.equal(env.GROK_AUTH_PATH, authFile);
    assert.equal(env.GROK_DISABLE_API_KEY_AUTH, '1');
    if (args[0] === '--version') return { ok: true, stdout: 'grok 1.0.70', stderr: '' };
    return { ok: true, stdout: 'You are logged in with grok.com.\nDefault model: grok-4.7\n * grok-4.7', stderr: '' };
  } });
  assert.equal(info.ok, true);
  assert.equal(info.loggedIn, true);
  assert.equal(info.authMode, 'subscription');
  assert.ok(info.apiKeyWarning);
  assert.equal(fs.readFileSync(configFile, 'utf8').includes('paid-key'), true);
});

test('Grok：付费 Key、配置覆盖和接口地址不继承；配置隔离、官方 OAuth 登录存储共用', async () => {
  const env = grokEnv('/isolated', { PATH: 'safe', XAI_API_KEY: 'secret', GROK_API_KEY: 'secret', GROK_CONFIG_PATH: '/paid', GROK_AUTH_PROVIDER_COMMAND: 'bad', ANTHROPIC_AUTH_TOKEN: 'secret', OPENAI_API_KEY: 'secret' });
  assert.equal(env.PATH, 'safe');
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.GROK_CONFIG_PATH, undefined);
  assert.equal(env.GROK_AUTH_PROVIDER_COMMAND, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.ok(grokApiKeyWarning());
  const res = await start().done;
  assert.equal(res.ok, true, res.error);
  const call = calls().at(-1);
  assert.equal(call.env.XAI_API_KEY, undefined);
  assert.equal(call.env.GROK_CONFIG, undefined);
  assert.equal(call.env.GROK_CLI_CHAT_PROXY_BASE_URL, undefined);
  assert.notEqual(call.home, process.env.GROK_HOME);
  const config = fs.readFileSync(path.join(call.home, 'config.toml'), 'utf8');
  assert.doesNotMatch(config, /paid-key|base_url/);
  assert.match(config, /\[compat.claude\][\s\S]*skills = false/);
  assert.match(config, /load_envrc = false/);
  assert.equal(fs.existsSync(path.join(call.home, 'auth.json')), false);
  assert.equal(call.env.GROK_AUTH_PATH, authFile);
  assert.equal(call.env.GROK_DISABLE_API_KEY_AUTH, '1');
  assert.match(call.input, /记住暗号/);
  assert.ok(call.args.includes('--no-subagents'));
});

test('Grok：续接记忆保持编号；只读分身复制记忆，原会话完全不变', async () => {
  const first = await start().done;
  assert.equal(first.ok, true);
  const originalHome = calls().at(-1).home;
  const second = await start({ session: first.session, prompt: '接着读上一轮' }).done;
  assert.equal(second.ok, true, second.error);
  assert.equal(second.session, first.session);
  const history = findHistory(originalHome, first.session);
  const before = fs.readFileSync(history, 'utf8');
  const side = await start({ session: first.session, side: true, prompt: '分身私聊' }).done;
  assert.equal(side.ok, true, side.error);
  assert.notEqual(side.session, first.session);
  assert.equal(fs.readFileSync(history, 'utf8'), before);
  const call = calls().at(-1);
  assert.ok(call.args.includes('--fork-session'));
  assert.equal(call.profile, 'clawchat');
  assert.ok(call.args.includes('--tools'));
  assert.equal(fs.existsSync(call.home), false);
  assert.equal(fs.existsSync(path.dirname(path.dirname(history))), true);
});

test('Grok：每档权限明确传入；变更权限通过独立策略保留记忆，失败不会替换原会话', async () => {
  for (const [permission, profile] of [['project', 'workspace'], ['readonly', 'read-only'], ['full', 'off']]) {
    const args = grokArgs({ room: { ...room, permission }, promptFile: 'input' });
    assert.equal(args[args.indexOf('--sandbox') + 1], profile === 'off' ? 'off' : 'clawchat');
    assert.ok(args.includes('--always-approve'));
  }
  const first = await start().done;
  const next = await start({ session: first.session, room: { ...room, permission: 'readonly' } }).done;
  assert.equal(next.ok, true);
  assert.equal(next.session, first.session);
  assert.ok(!calls().at(-1).args.includes('--fork-session'));
  assert.match(fs.readFileSync(path.join(calls().at(-1).home, 'sandbox.toml'), 'utf8'), /read-only/);
  process.env.FAKE_GROK_SCENARIO = 'failure';
  const failed = await start({ session: first.session, room: { ...room, permission: 'full' } }).done;
  assert.equal(failed.ok, false);
  assert.equal(failed.session, first.session);
});

test('Grok：过程、实际模型和上下文用量正确；不用整轮累计值冒充上下文', async () => {
  const h = start();
  const res = await h.done;
  assert.equal(res.ok, true);
  assert.equal(res.text, '（假的 Grok）做完了');
  assert.equal(res.model, 'grok-4.7');
  assert.ok(h.steps.some((s) => s.kind === 'read'));
  assert.ok(h.steps.some((s) => s.kind === 'think'));
  assert.equal(res.steps.filter((s) => s.kind === 'say').length, 0);
  assert.deepEqual(await sessionUsage('grok', res.session), { used: 138, window: 256000, images: 0, model: 'grok-4.7' });
  assert.equal(h.steer, undefined);
});

test('Grok：未登录、额度耗尽、错误登录方式都及时结束，不切到 API、不重试', async () => {
  for (const scenario of ['logged-out', 'quota', 'quota-stderr', 'api-key']) {
    process.env.FAKE_GROK_SCENARIO = scenario;
    const h = start();
    const result = await Promise.race([h.done, new Promise((_, reject) => { const t = setTimeout(() => { h.kill(); reject(new Error('没有及时结束')); }, 20000); t.unref(); })]);
    assert.equal(result.ok, false, scenario);
    assert.equal(result.session, null);
    assert.match(result.error, scenario === 'logged-out' ? /grok login/ : scenario === 'api-key' ? /API/ : /额度/);
  }
  assert.match(grokError('429 rate limited'), /频繁/);
  assert.match(grokError('Not signed in. Run grok login'), /grok login/);
});

test('Grok：进程崩溃、没有最终结果、收尾后崩溃、编号不符都不能误报成功', async () => {
  for (const scenario of ['crash', 'no-result', 'crash-after-result', 'wrong-session']) {
    process.env.FAKE_GROK_SCENARIO = scenario;
    const res = await start().done;
    assert.equal(res.ok, false, scenario);
    assert.equal(res.session, null);
  }
});

test('Grok：停止结束进程及脱离进程组的命令；停止不假装完成', async () => {
  process.env.FAKE_GROK_SCENARIO = 'stop-tree';
  process.env.FAKE_GROK_CHILD = path.join(root, 'child.pid');
  const h = start();
  await until(() => fs.existsSync(process.env.FAKE_GROK_CHILD));
  const pid = Number(fs.readFileSync(process.env.FAKE_GROK_CHILD, 'utf8'));
  await h.kill();
  const res = await h.done;
  assert.equal(res.ok, false);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});

test('Grok：附图路径不转成巨大启动参数；换模型和群规逐轮明确传入', async () => {
  const image = path.join(root, '带 空格的图片.png');
  fs.writeFileSync(image, '假的图片');
  const res = await start({ images: [{ n: 1, label: '参考图', path: image }], room: { ...room, models: { grok: 'grok-4.6' }, efforts: { grok: 'high' } } }).done;
  assert.equal(res.ok, true);
  const call = calls().at(-1);
  assert.match(call.input, /图 #1/);
  assert.ok(call.input.includes(image));
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'grok-4.6');
  assert.equal(call.args[call.args.indexOf('--reasoning-effort') + 1], 'high');
  assert.match(call.args[call.args.indexOf('--rules') + 1], /你是 Grok/);
});

test('Grok：已经做完但记忆未保存时不报失败重跑，由聊天记录恢复', async () => {
  process.env.FAKE_GROK_SCENARIO = 'no-session-file';
  const res = await start().done;
  assert.equal(res.ok, true);
  assert.equal(res.session, null);
  assert.equal(res.resetSession, true);
  assert.match(res.warning, /记忆没有保存/);
  assert.match(res.text, /做完了/);
});

test('Grok：退出登录不再沿用缓存；没登录时不启动命令或弹浏览器', async () => {
  const auth = fs.readFileSync(authFile);
  const before = calls().length;
  fs.rmSync(authFile);
  try {
    const res = await start().done;
    assert.equal(res.ok, false);
    assert.match(res.error, /grok login/);
    assert.equal(calls().length, before);
  } finally { fs.writeFileSync(authFile, auth); }
});

test('Grok：不同群的权限配置分开，同时执行不会互相覆盖', async () => {
  const a = start({ room: { ...room, id: 'room-a', permission: 'full' } });
  const b = start({ room: { ...room, id: 'room-b', permission: 'readonly' } });
  assert.equal((await a.done).ok, true);
  assert.equal((await b.done).ok, true);
  const [first, second] = calls().slice(-2).sort((a, b) => a.profile.localeCompare(b.profile));
  assert.notEqual(first.home, second.home);
  assert.deepEqual([first.profile, second.profile], ['clawchat', 'off']);
  assert.match(fs.readFileSync(path.join(first.home, 'sandbox.toml'), 'utf8'), /read-only/);
  assert.match(fs.readFileSync(path.join(second.home, 'requirements.toml'), 'utf8'), /off/);
});

test('Grok：多个群与终端共用认证文件，刷新后不会被旧副本覆盖', async () => {
  const original = fs.readFileSync(authFile);
  try {
    process.env.FAKE_GROK_SCENARIO = 'refresh';
    assert.equal((await start({ room: { ...room, id: 'auth-a' } }).done).ok, true);
    delete process.env.FAKE_GROK_SCENARIO;
    assert.equal((await start({ room: { ...room, id: 'auth-b' } }).done).ok, true);
    const latest = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    assert.equal(Object.values(latest)[0].refresh_token, 'fake-refreshed-token');
    for (const call of calls().slice(-2)) {
      assert.equal(call.env.GROK_AUTH_PATH, authFile);
      assert.equal(fs.existsSync(path.join(call.home, 'auth.json')), false);
      const policy = fs.readFileSync(path.join(call.home, 'sandbox.toml'), 'utf8');
      assert.ok(policy.includes(JSON.stringify(path.dirname(authFile))));
      assert.ok(policy.includes(JSON.stringify(configFile)));
    }
    await removeGrokHome({ ...room, id: 'auth-a' });
    await removeGrokHome({ ...room, id: 'auth-b' });
    assert.equal(fs.existsSync(authFile), true);
  } finally { fs.writeFileSync(authFile, original); }
});

test('Grok：删除房间目录和用量，不影响同群其他成员、其他群或官方登录', async () => {
  const aRoom = { ...room, id: 'remove-a' }, bRoom = { ...room, id: 'remove-b' };
  const a = await start({ room: aRoom }).done;
  const aHome = calls().at(-1).home;
  const b = await start({ room: bRoom }).done;
  const bHome = calls().at(-1).home;
  const { ensureExtraMember } = await import('../lib/agents.js');
  ensureExtraMember('grok2');
  const clone = await runAgent('grok2', { room: aRoom, prompt: '2 号的任务', onStep() {} }).done;
  const cloneHome = calls().at(-1).home;
  assert.equal(clone.ok, true);
  await removeGrokHome(aRoom, 'grok');
  assert.equal(fs.existsSync(aHome), false);
  assert.equal(fs.existsSync(cloneHome), true);
  assert.equal(await sessionUsage('grok', a.session), null);
  assert.ok(await sessionUsage('grok', b.session));
  await removeGrokHome(aRoom);
  assert.equal(fs.existsSync(cloneHome), false);
  assert.equal(fs.existsSync(bHome), true);
  assert.equal(fs.existsSync(authFile), true);
  await removeGrokHome(bRoom);
});

test('Grok：删除正在执行的群后不留目录，新建同名成员等退出后再保存新记忆', async () => {
  const r = { ...room, id: 'delete-running' };
  process.env.FAKE_GROK_SCENARIO = 'hang';
  const run = start({ room: r });
  await until(() => run.steps.length > 0);
  const oldHome = calls().at(-1).home;
  const deleting = removeGrokHome(r);
  delete process.env.FAKE_GROK_SCENARIO;
  const next = start({ room: r });
  await deleting;
  assert.equal((await run.done).ok, false);
  const res = await next.done;
  assert.equal(res.ok, true, res.error);
  assert.equal(fs.existsSync(oldHome), true);
  assert.ok(fs.existsSync(findHistory(oldHome, res.session)));
  await removeGrokHome(r);
  assert.equal(fs.existsSync(oldHome), false);
});

test('Grok：新文件所有提示都有英文，占位符一致', () => {
  const code = fs.readFileSync(new URL('../lib/grok.js', import.meta.url), 'utf8');
  const dictDir = fileURLToPath(new URL('../public/locales/en/', import.meta.url));
  const dict = Object.assign({}, ...fs.readdirSync(dictDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dictDir, f), 'utf8'))));
  for (const m of code.matchAll(/\btr\('([^']+)'/g)) {
    assert.ok(dict[m[1]], `缺少译文：${m[1]}`);
    const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
    assert.deepEqual(holes(dict[m[1]]), holes(m[1]));
  }
});
