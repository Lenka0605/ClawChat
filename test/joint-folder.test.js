import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-folder-test-'));
process.env.CLAWCHAT_HOME = path.join(root, 'data');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'auth-claude');
process.env.CODEX_HOME = path.join(root, 'auth-codex');
process.env.OPENAI_API_KEY = 'fake-folder-token';
process.env.FAKE_CODEX_RPC_LOG = path.join(root, 'rpc.jsonl');
process.env.FAKE_CODEX_SECS = '0.01';
const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
const controls = path.join(root, 'controls.json');
const captures = path.join(root, 'capture.jsonl');
fs.writeFileSync(controls, '{}');
const fakeServer = path.join(root, 'fake-app-server.mjs');
fs.writeFileSync(fakeServer, fs.readFileSync(new URL('../scripts/fake/codex-app-server.mjs', import.meta.url), 'utf8')
  .replace("else if (m.method === 'initialized') return;", `else if (m.method === 'initialized') return;\nelse if (m.method === 'config/read') reply(m.id,{config:{mcp_servers:JSON.parse(fs.readFileSync(${JSON.stringify(controls)},'utf8')).mcp?{bad:{enabled:true}}:{}}});`));
const { JOINT_CODEX_CONFIG, JOINT_FOLDER_ENGINES, prepareJointRoom, selectJointSession, jointFolderVersionSupported } = await import('../lib/joint-discussion.js');
const features = [...Object.keys(JOINT_CODEX_CONFIG).filter((k) => k.startsWith('features.')).map((k) => k.slice(9)), 'network_proxy'];
for (const name of ['claude', 'codex']) {
  const body = `import fs from 'node:fs';import crypto from 'node:crypto';
const args=process.argv.slice(2),c=JSON.parse(fs.readFileSync(${JSON.stringify(controls)},'utf8'));
if(args[0]==='--version'){if(c.delay)await new Promise(r=>setTimeout(r,c.delay));console.log(${name === 'claude' ? "c.oldClaude?'2.1.248':'2.1.316'" : "c.oldCodex?'codex-cli 0.164.0':'codex-cli 0.165.0'"});}
else if(args[0]==='features'){console.log(${JSON.stringify(features)}.filter(k=>k!==c.missing).map(k=>k+' enabled').join('\\n'));}
else{fs.appendFileSync(${JSON.stringify(captures)},JSON.stringify({name:${JSON.stringify(name)},args,cwd:process.cwd(),tmp:process.env.TMPDIR,config:process.env.CLAUDE_CONFIG_DIR,home:process.env.CODEX_HOME})+'\\n');
${name === 'codex' ? `await import(${JSON.stringify(pathToFileURL(fakeServer).href)});` : `process.stdin.once('data',()=>{console.log(JSON.stringify({type:'result',subtype:'success',result:'假完成',session_id:args.includes('--resume')?args[args.indexOf('--resume')+1]:'fake-'+crypto.randomUUID()}));process.stdin.resume();});`}}
`;
  const entry = path.join(bin, `${name}.mjs`); fs.writeFileSync(entry, body);
  fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(entry).href)};\n`, { mode: 0o755 });
}
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const { runAgent } = await import('../lib/agents.js');
const projectA = fs.mkdtempSync(path.join(root, 'project-a-'));
const projectB = fs.mkdtempSync(path.join(root, 'project-b-'));
const canonicalA = fs.realpathSync(projectA);
const room = { id: 'joint-folder-test', jointDiscussion: true, jointMode: 'folder', jointFolder: canonicalA, permission: 'full', cwd: '/untrusted', models: {} };
const calls = () => fs.existsSync(captures) ? fs.readFileSync(captures, 'utf8').trim().split('\n').map(JSON.parse) : [];
const run = (agent = 'claude', extra = {}) => runAgent(agent, { room, prompt: '假任务', systemPrompt: '原群规', jointBeforeStart: () => true, onStep() {}, ...extra });
const value = (args, flag) => args[args.indexOf(flag) + 1];
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('文件夹开放范围只包含真实验收的 Mac 引擎；其他系统保持讨论档', () => {
  assert.deepEqual(JOINT_FOLDER_ENGINES, process.platform === 'darwin' ? ['claude', 'deepseek', 'glm', 'api', 'codex'] : []);
  const unavailable = prepareJointRoom(room, 'grok', 'grok');
  assert.equal(unavailable.jointMode, 'discuss'); assert.equal(unavailable.permission, 'readonly');
  assert.notEqual(unavailable.cwd, room.cwd); assert.notEqual(unavailable.cwd, canonicalA);
  assert.equal(jointFolderVersionSupported('claude', '2.1.315'), false);
  assert.equal(jointFolderVersionSupported('claude', '2.1.316'), true);
  assert.equal(jointFolderVersionSupported('codex', 'codex-cli 0.165.0'), true);
  assert.equal(jointFolderVersionSupported('codex', 'unknown'), false);
});

test('文件夹权限变更隔离记忆：不能接本地会话，失败不存；切回原目录可以续接', { skip: process.platform !== 'darwin' }, async () => {
  const a = await run().done; assert.ok(a.ok, a.error);
  const resumed = await run('claude', { session: a.session }).done; assert.equal(resumed.session, a.session);
  const b = await run('claude', { room: { ...room, jointFolder: fs.realpathSync(projectB) }, session: a.session }).done;
  assert.ok(b.ok, b.error); assert.notEqual(b.session, a.session);
  const back = await run('claude', { session: b.session }).done; assert.equal(back.session, a.session);
  const discussion = await run('claude', { room: { ...room, jointMode: 'discuss' }, session: a.session }).done;
  assert.ok(discussion.ok, discussion.error); assert.notEqual(discussion.session, a.session);
  assert.equal(value(calls().at(-1).args, '--tools'), '');
  assert.equal((await run('claude', { session: discussion.session }).done).session, a.session);
  const before = calls().length;
  const foreign = await run('claude', { session: 'private-foreign-session' }).done;
  assert.equal(foreign.ok, false); assert.match(foreign.error, /本地群或私聊/); assert.equal(calls().length, before);
  const r = prepareJointRoom({ ...room, id: 'failed-only' }, 'claude');
  selectJointSession(r, null).save({ ok: false, session: 'failed-session' });
  assert.ok(!fs.existsSync(path.join(r.jointSessionDir, 'native-sessions.json')));
});

test('Claude 文件夹通过实际启动入口：根目录拒读、固定工作根、短临时目录、无 MCP/hooks/提权', { skip: process.platform !== 'darwin' }, async () => {
  const h = run('claude', { room: { ...room, id: 'claude-args' } });
  assert.equal(h.steer('不能插入未重新审批的任务'), false);
  const result = await h.done; assert.ok(result.ok, result.error);
  const c = calls().at(-1); assert.equal(c.name, 'claude'); assert.equal(c.cwd, canonicalA);
  assert.match(value(c.args, '--append-system-prompt'), /这一轮权限已由本机老板批准/);
  assert.equal(value(c.args, '--tools'), 'Read,Grep,Glob,Write,Edit,Bash');
  assert.equal(value(c.args, '--setting-sources'), '');
  assert.ok(!c.args.includes('--add-dir')); assert.ok(!c.args.includes('--dangerously-skip-permissions'));
  assert.equal(c.config, process.env.CLAUDE_CONFIG_DIR, '保留钥匙串认证入口');
  const settings = JSON.parse(value(c.args, '--settings'));
  assert.deepEqual(settings.sandbox.filesystem.denyRead, ['/']);
  assert.ok(settings.sandbox.filesystem.allowRead.includes(canonicalA));
  assert.ok(!settings.sandbox.filesystem.allowRead.includes('/System'));
  assert.equal(settings.sandbox.failIfUnavailable, true); assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox.excludedCommands, []); assert.equal(settings.disableAllHooks, true);
  assert.ok(settings.sandbox.credentials.envVars.some((v) => v.name === 'CLAUDE_CODE_OAUTH_TOKEN' && v.mode === 'deny'));
  assert.match(c.tmp, /^\/private\/tmp\/ccjf-/); assert.ok(c.tmp.length + 18 < 44);
  assert.ok(!fs.existsSync(c.tmp), '回合结束后只清理自己生成的临时目录');
});

test('Codex 文件夹通过实际启动入口：命名权限逐轮覆盖，禁 legacy 和额外工具，运行目录退出即清', { skip: process.platform !== 'darwin' }, async () => {
  const result = await run('gpt', { room: { ...room, id: 'codex-args' } }).done; assert.ok(result.ok, result.error);
  const c = calls().at(-1); assert.equal(c.name, 'codex'); assert.equal(c.cwd, canonicalA);
  assert.ok(c.args.includes('features.network_proxy=true')); assert.ok(c.args.includes('features.shell_tool=true'));
  assert.ok(c.args.includes('mcp_servers={}'));
  assert.ok(!c.args.some((s) => s.startsWith('sandbox_mode=') || s.startsWith('sandbox_workspace_write.')));
  const rpc = fs.readFileSync(process.env.FAKE_CODEX_RPC_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  const thread = rpc.find((m) => m.method === 'thread/start').params;
  const turn = rpc.find((m) => m.method === 'turn/start').params;
  for (const p of [thread, turn]) { assert.equal(p.permissions, 'clawchat-joint-folder'); assert.equal(p.approvalPolicy, 'never'); assert.equal(p.cwd, canonicalA); }
  assert.ok(!('sandbox' in thread)); assert.ok(!('sandboxPolicy' in turn));
  const policy = thread.config['permissions.clawchat-joint-folder.filesystem'];
  assert.equal(policy[':root'], 'deny'); assert.equal(policy['/private/tmp'], 'deny'); assert.equal(policy[canonicalA], 'write');
  const network = thread.config['permissions.clawchat-joint-folder.network'];
  assert.equal(new URL(network.proxy_url).hostname, '127.0.0.1'); assert.equal(network.domains['registry.npmjs.org'], 'allow');
  assert.equal(network.allow_local_binding, false);
  assert.deepEqual(thread.config['shell_environment_policy.exclude'], ['OPENAI_API_KEY', 'CODEX_API_KEY']);
  assert.ok(!fs.existsSync(c.tmp));
});

test('旧版本、缺安全开关和准备期间停止，都不能启动有文件工具的回合', { skip: process.platform !== 'darwin' }, async () => {
  const before = calls().length;
  for (const control of [{ oldClaude: true }, { oldCodex: true }, { missing: 'network_proxy' }]) {
    fs.writeFileSync(controls, JSON.stringify(control));
    const result = await run(control.oldClaude ? 'claude' : 'gpt', { room: { ...room, id: 'rejected' } }).done;
    assert.equal(result.ok, false); assert.match(result.error, /更新/);
  }
  fs.writeFileSync(controls, JSON.stringify({ delay: 60 }));
  const pending = run('claude', { room: { ...room, id: 'stopped-preflight' } }); pending.kill();
  assert.equal((await pending.done).ok, false);
  assert.equal(calls().length, before);
  fs.writeFileSync(controls, '{}');
});

test('启动前授权检查作废时不启动本轮工具，Codex 连接初始化后也会复查', { skip: process.platform !== 'darwin' }, async () => {
  const before = calls().length;
  for (const check of [undefined, async () => true]) {
    const invalid = await run('claude', { room: { ...room, id: 'missing-or-async-proof' }, jointBeforeStart: check }).done;
    assert.equal(invalid.ok, false);
  }
  const rejected = await run('claude', { room: { ...room, id: 'revoked-before-start' }, jointBeforeStart: () => false }).done;
  assert.equal(rejected.ok, false); assert.equal(calls().length, before);
  let checks = 0;
  const result = await run('gpt', { room: { ...room, id: 'revoked-during-init' }, jointBeforeStart: () => ++checks < 2 }).done;
  assert.equal(result.ok, false); assert.match(result.error, /授权已改变/);
  assert.equal(checks, 2);
});

test('Codex 生效配置仍含 MCP 时，在 thread/start 之前拒绝，不能先启动再检查', { skip: process.platform !== 'darwin' }, async () => {
  const before = fs.existsSync(process.env.FAKE_CODEX_RPC_LOG) ? fs.readFileSync(process.env.FAKE_CODEX_RPC_LOG, 'utf8').length : 0;
  fs.writeFileSync(controls, JSON.stringify({ mcp: true }));
  const result = await run('gpt', { room: { ...room, id: 'blocked-mcp' } }).done;
  fs.writeFileSync(controls, '{}');
  assert.equal(result.ok, false); assert.match(result.error, /MCP/);
  const messages = fs.readFileSync(process.env.FAKE_CODEX_RPC_LOG, 'utf8').slice(before).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(messages.some((m) => m.method === 'config/read'));
  assert.ok(!messages.some((m) => m.method === 'thread/start' || m.method === 'turn/start'));
});

test('工具成功后会话索引写失败只向本机告警，不能把已经完成的动作判失败重做', { skip: process.platform !== 'darwin' }, async () => {
  const r = { ...room, id: 'index-write-failed' };
  const target = path.join(prepareJointRoom(r, 'claude').jointSessionDir, 'native-sessions.json');
  const rename = fs.renameSync;
  const steps = [];
  fs.renameSync = (src, dest) => {
    if (dest === target) throw Object.assign(new Error('假磁盘写失败'), { code: 'EIO' });
    return rename(src, dest);
  };
  try {
    const result = await run('claude', { room: r, onStep: (s) => steps.push(s) }).done;
    assert.equal(result.ok, true); assert.ok(result.session); assert.equal(result.sessionWarning, true);
    assert.ok(steps.some((s) => /不要重复执行/.test(s.text)));
  } finally { fs.renameSync = rename; }
});
