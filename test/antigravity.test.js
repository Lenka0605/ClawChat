import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-agy-test-'));
process.env.CLAWCHAT_HOME = path.join(root, 'data');
process.env.GEMINI_CLI_HOME = path.join(root, 'gemini');
process.env.FAKE_SECS = '0.01';
delete process.env.GEMINI_API_KEY;
const fake = fileURLToPath(new URL('../scripts/fake/', import.meta.url));
process.env.PATH = `${fake}${path.delimiter}${process.env.PATH}`;
const { runAntigravity, antigravityArgs, antigravityUsage, agyState } = await import('../lib/antigravity.js');
agyState.version = '1.4.10-fake';
const { runGemini, detectGemini } = await import('../lib/gemini.js');
const { saveConfig, Store } = await import('../lib/store.js');
const { runAgent, which } = await import('../lib/agents.js');
const { Hub } = await import('../lib/hub.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const room = { cwd: root, permission: 'full', models: {} };
const events = [
  { event: 'init', conversation_id: 'native-id', init: { model: 'gemini-4-argon-high' } },
  { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, text_delta: '先检查' } },
  { event: 'step_update', step_update: { step_type: 'tool', step_index: 2, state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'npm test' } } } },
  { event: 'step_update', step_update: { step_type: 'tool', step_index: 2, state: 'DONE', tool_name: 'run_command' } },
  { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 3, state: 'ACTIVE', text_delta: '完' } },
  { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 3, state: 'DONE', text_delta: '成', usage: { input_tokens: 12, output_tokens: 3 } } },
  { event: 'result', result: { conversation_id: 'native-id', status: 'SUCCESS', response: '完成', usage: { input_tokens: 12000, output_tokens: 3000 } } },
];
function runtime(list = events, exit = { code: 0 }) {
  const captured = {};
  return { captured, which: () => '/fake/agy', spawnJsonl(bin, args, opts) {
    Object.assign(captured, { bin, args, opts });
    return { kill() { captured.killed = true; }, done: Promise.resolve().then(() => { list.forEach(opts.onEvent); return exit; }) };
  } };
}

test('订阅：每轮关闭点数和 API，权限覆盖只在本次生效，默认锁定 Gemini', () => {
  for (const permission of ['full', 'project', 'readonly']) {
    const args = antigravityArgs({ room: { ...room, permission } });
    const s = JSON.parse(args[args.indexOf('--settings') + 1]);
    assert.equal(s.useG1Credits, false);
    assert.equal(s.modelProvider, '');
    assert.match(s.model, /^gemini-/);
    assert.equal(args.includes('--dangerously-skip-permissions'), false);
    if (permission === 'project') {
      assert.equal(s.toolPermission, 'proceed-in-sandbox');
      assert.equal(s.permissions.allow.includes('command(*)'), false);
      assert.equal(args.includes('--sandbox'), true);
    }
    if (permission === 'readonly') for (const name of ['write_file', 'command', 'mcp', 'execute_url']) assert.ok(s.permissions.deny.includes(`${name}(*)`));
  }
  const side = antigravityArgs({ room, session: 'agy:native-id', side: true });
  assert.equal(side.includes('--conversation'), false);
  assert.equal(side.includes('--sandbox'), true);
});

test('订阅：解析真实官方事件、步骤去重、以最终回复为准并保留精确会话', async () => {
  const rt = runtime();
  const result = await runAntigravity({ room, prompt: '@Claude\n正文' }, rt).done;
  assert.equal(result.ok, true);
  assert.equal(result.text, '完成');
  assert.equal(result.session, 'agy:native-id');
  assert.equal(result.model, 'gemini-4-argon-high');
  assert.deepEqual(result.steps, [{ kind: 'say', text: '先检查' }, { kind: 'run', text: 'npm test' }]);
  assert.equal(JSON.parse(rt.captured.opts.input).message.content, '@Claude\n正文');
  assert.equal(rt.captured.opts.env.GEMINI_API_KEY, '');
  assert.equal(rt.captured.opts.env.GOOGLE_API_KEY, '');
  assert.deepEqual(antigravityUsage(result.session), { images: 0, used: 15, window: 0 });
  const next = runtime();
  await runAntigravity({ room, session: result.session, prompt: '继续' }, next).done;
  assert.equal(next.captured.args[next.captured.args.indexOf('--conversation') + 1], 'native-id');
});

test('订阅：分身使用最近文字另开会话，不能修改本体备份或混入私聊', async () => {
  const file = path.join(process.env.CLAWCHAT_HOME, 'gemini', 'antigravity', 'native-id.json');
  const before = fs.readFileSync(file, 'utf8');
  const rt = runtime(events.map((e) => e.event === 'result' ? { ...e, result: { ...e.result, conversation_id: 'side-id' } } : e));
  const result = await runAntigravity({ room, session: 'agy:native-id', side: true, prompt: '私聊问题' }, rt).done;
  assert.equal(result.ok, true);
  assert.notEqual(result.session, 'agy:native-id');
  assert.equal(rt.captured.args.includes('--conversation'), false);
  assert.match(JSON.parse(rt.captured.opts.input).message.content, /@Claude/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(rt.captured.opts.cwd), false);
});

test('订阅：无终态、失败、被停止都不保存新会话；无最终文字的成功任务不重跑', async () => {
  for (const list of [events.slice(0, -1), [{ event: 'result', result: { status: 'ERROR', error: 'quota exhausted' } }]]) {
    assert.equal((await runAntigravity({ room, prompt: '测试' }, runtime(list)).done).ok, false);
  }
  const rt = runtime();
  const proc = runAntigravity({ room, prompt: '测试' }, rt); proc.kill();
  assert.equal((await proc.done).ok, false);
  assert.equal(rt.captured.killed, true);
  const silent = events.map((e) => e.event === 'result' ? { ...e, result: { ...e.result, response: '' } } : e);
  assert.equal((await runAntigravity({ room, prompt: '工具任务' }, runtime(silent)).done).ok, true);
});

test('订阅和 API 不自动互相回退；切换入口时报会话找不到，交给 hub 自动开新会话', async () => {
  saveConfig({ geminiKey: '' });
  let checked = '';
  const info = await detectGemini({ which(name) { checked = name; return null; }, run() { throw new Error('不应调用'); } });
  assert.equal(checked, 'agy'); assert.equal(info.authMode, 'subscription');
  agyState.version = '1.4.10-fake';
  const missing = await runGemini({ room, prompt: '测试' }, { which: () => null }).done;
  assert.equal(missing.ok, false); assert.match(missing.error, /Antigravity/);
  const legacy = await runGemini({ room, session: 'legacy-session', prompt: '测试' }, runtime()).done;
  assert.equal(legacy.ok, false); assert.match(legacy.error, /session not found/);
  saveConfig({ geminiKey: 'dummy-api-key' });
  const api = await detectGemini({ which(name) { checked = name; return null; } });
  assert.equal(checked, 'gemini'); assert.equal(api.authMode, 'api');
  const switched = await runGemini({ room, session: 'agy:native-id', prompt: '测试' }, runtime()).done;
  assert.equal(switched.ok, false); assert.match(switched.error, /session not found/);
  saveConfig({ geminiKey: '' });
});

test('订阅：文字备份失败不重跑工具，也不清除仍有效的原生会话', async () => {
  const obstacle = path.join(process.env.CLAWCHAT_HOME, 'gemini', 'antigravity', 'archive-fail.json');
  fs.mkdirSync(obstacle, { recursive: true });
  const list = events.map((e) => e.event === 'result' ? { ...e, result: { ...e.result, conversation_id: 'archive-fail' } } : e);
  try {
    const result = await runAntigravity({ room, prompt: '已执行的任务' }, runtime(list)).done;
    assert.equal(result.ok, true);
    assert.equal(result.session, 'agy:archive-fail');
    assert.equal(result.resetSession, undefined);
    assert.match(result.warning, /文字备份保存失败/);
  } finally { fs.rmSync(obstacle, { recursive: true, force: true }); }
});

test('订阅：实际假进程经 Hub 收发，退出重开后沿用原生会话，分身不串记忆', { skip: process.platform === 'win32' }, async () => {
  assert.equal(which('agy'), path.join(fake, 'agy'));
  const wait = async (hub) => { const end = Date.now() + 5000; while (hub.runs.size) { assert.ok(Date.now() < end); await new Promise((r) => setTimeout(r, 10)); } };
  const store = new Store();
  const group = store.createRoom({ cwd: root, members: ['gemini'], permission: 'full' });
  const hub = new Hub(store);
  hub.postUserMessage(group.id, '记住订阅第一轮'); await wait(hub);
  const session = store.getState(group.id).sessions.gemini;
  assert.match(session, /^agy:/);
  const fresh = new Store(); const again = new Hub(fresh);
  again.postUserMessage(group.id, '订阅第二轮'); await wait(again);
  assert.equal(fresh.getState(group.id).sessions.gemini, session);
  const file = path.join(process.env.CLAWCHAT_HOME, 'fake-agy', `${session.slice(4)}.json`);
  const before = fs.readFileSync(file, 'utf8');
  assert.match(before, /记住订阅第一轮/); assert.match(before, /订阅第二轮/);
  const side = await runAgent('gemini', { room, session, side: true, prompt: '私聊独有内容' }).done;
  assert.equal(side.ok, true); assert.notEqual(side.session, session);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('agy 版本太旧：检测时标成不能用、每轮直接提示升级；后台运行放宽超时', async () => {
  const { agyVersionOk, antigravityArgs, agyState } = await import('../lib/antigravity.js');
  assert.equal(agyVersionOk('1.0.16'), false);
  assert.equal(agyVersionOk('agy 1.4.9'), false);
  assert.equal(agyVersionOk('1.4.10'), true);
  assert.equal(agyVersionOk('2.0.0'), true);
  assert.equal(agyVersionOk(''), false);
  saveConfig({ geminiKey: '' });
  const info = await detectGemini({ which: () => '/usr/bin/agy', run: async () => ({ stdout: '1.0.16\n' }) });
  assert.equal(info.ok, false);
  assert.match(info.error, /agy update/);
  const res = await runGemini({ room, prompt: '测试' }, runtime()).done;
  assert.equal(res.ok, false);
  assert.match(res.error, /agy update/);
  agyState.version = null;
  const unknown = await runGemini({ room, prompt: '测试' }, runtime()).done;
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /agy update/);
  agyState.version = '1.4.10-fake';
  const args = antigravityArgs({ room, session: null, side: false });
  assert.equal(args[args.indexOf('--print-timeout') + 1], '6h');
});

test('订阅：做完了但没拿到会话编号，不算失败、不重跑，让 hub 清掉会话下一轮重来', async () => {
  saveConfig({ geminiKey: '' });
  const list = events.map((e) => (e.event === 'init' ? { ...e, conversation_id: '' } : e.event === 'result' ? { ...e, result: { ...e.result, conversation_id: '' } } : e));
  const res = await runGemini({ room, prompt: '测试' }, runtime(list)).done;
  assert.equal(res.ok, true);
  assert.equal(res.text, '完成');
  assert.equal(res.resetSession, true);
  assert.equal(res.session, null);
  assert.match(res.warning, /会话编号/);
});
