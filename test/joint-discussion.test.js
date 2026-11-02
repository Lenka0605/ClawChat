import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-discussion-test-'));
process.env.CLAWCHAT_HOME = dataDir;
const { claudeArgs, codexServerArgs, runAgent } = await import('../lib/agents.js');
const { grokArgs } = await import('../lib/grok.js');
const { cursorDeny } = await import('../lib/cursor.js');
const { geminiArgs } = await import('../lib/gemini.js');
const { antigravityArgs } = await import('../lib/antigravity.js');
const { prepareJointRoom, JOINT_CODEX_CONFIG, codexDiscussionFeaturesSupported, jointAuthEnv } = await import('../lib/joint-discussion.js');
const room = { id: 'joint-test', jointDiscussion: true, cwd: '/untrusted', permission: 'full' };
const value = (args, flag) => args[args.indexOf(flag) + 1];
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('联合群讨论覆盖旧 full 权限，关闭 Claude 文件/命令/MCP 工具与自动读须知', () => {
  const args = claudeArgs(room, null, '群规', null, false, 'fake-model');
  assert.equal(value(args, '--tools'), '');
  assert.equal(value(args, '--permission-mode'), 'dontAsk');
  assert.ok(args.includes('--restricted')); assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!value(args, '--append-system-prompt').includes('先用 Read'));
  assert.deepEqual(JSON.parse(value(args, '--mcp-config')), { mcpServers: {} });
});

test('联合群 Codex 显式关闭命令、文件看图、插件、浏览器与电脑控制', () => {
  const args = codexServerArgs({ ...room, permission: 'readonly' });
  for (const [key, v] of Object.entries(JOINT_CODEX_CONFIG)) assert.ok(args.includes(`${key}=${JSON.stringify(v)}`), key);
  for (const key of ['features.shell_tool','features.view_image','features.multi_agent','features.hooks','features.apps','features.plugins','features.computer_use']) assert.equal(JOINT_CODEX_CONFIG[key], false);
});

test('联合群 Grok 不开放任何内建工具，Cursor 明确拒绝读写命令与 MCP', () => {
  const args = grokArgs({ room: { ...room, permission: 'readonly' }, side: false, systemPrompt: '', promptFile: '/fake/prompt', newId: 'fake-id' });
  assert.equal(value(args, '--tools'), ''); assert.ok(args.includes('--no-subagents'));
  assert.ok(!args.includes('--always-approve')); assert.ok(args.includes('--deny'));
  const deny = cursorDeny(room, false);
  for (const x of ['Read(**)', 'Write(**)', 'Shell(*)', 'Mcp(*:*)']) assert.ok(deny.includes(x));
});

test('联合群两种 Gemini 不附加共享目录，订阅权限明确拒绝读取', () => {
  const a = geminiArgs({ room: { ...room, permission: 'readonly' }, policy: '/fake/admin-policy.toml' });
  assert.ok(!a.includes('--include-directories')); assert.ok(a.includes('--admin-policy'));
  const b = antigravityArgs({ room: { ...room, permission: 'readonly' } });
  const settings = JSON.parse(value(b, '--settings'));
  assert.deepEqual(settings.permissions.allow, []);
  for (const x of ['read_file(*)','write_file(*)','command(*)','mcp(*)','unsandboxed(*)']) assert.ok(settings.permissions.deny.includes(x));
});

test('讨论工作目录是专用空目录，不能引用本机已有私聊会话', async () => {
  const prepared = prepareJointRoom(room, 'gpt');
  assert.ok(prepared.cwd.startsWith(path.join(dataDir, 'joint')));
  assert.equal(prepared.permission, 'readonly');
  assert.deepEqual(fs.readdirSync(prepared.cwd), []);
  const denied = await runAgent('gpt', { room, session: 'private-existing-session', prompt: '不应启动' }).done;
  assert.equal(denied.ok, false); assert.match(denied.error, /本地群或私聊/);
  assert.throws(() => prepareJointRoom({ ...room, jointSessionDir: path.join(dataDir, '../escape') }, 'gpt'));
});

test('旧 Codex 缺少禁用开关时拒绝讨论档，不能静默忽略安全参数', () => {
  const supported = Object.keys(JOINT_CODEX_CONFIG).filter((key) => key.startsWith('features.')).map((key) => `${key.slice(9)} stable true`).join('\n');
  assert.equal(codexDiscussionFeaturesSupported(supported), true);
  assert.equal(codexDiscussionFeaturesSupported(supported.replace('shell_tool stable true', '')), false);
  assert.equal(codexDiscussionFeaturesSupported(''), false);
});

test('Claude 讨论档保留原认证目录，不复制凭据或改换钥匙串入口', () => {
  const prepared = prepareJointRoom({ ...room, id: 'joint-auth' }, 'claude');
  const source = { HOME: '/fake/user', CLAUDE_CONFIG_DIR: '/fake/account-home', ANTHROPIC_AUTH_TOKEN: 'fake-only' };
  assert.strictEqual(jointAuthEnv(prepared, 'claude', source), source);
  assert.ok(!fs.existsSync(path.join(prepared.jointSessionDir, 'cli', 'claude')));
});
