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
const { runAntigravity, antigravityArgs, antigravityUsage, agyState, agyShown } = await import('../lib/antigravity.js');
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
  assert.equal(result.model, 'gemini-4-argon');
  assert.equal(result.effort, 'high');
  assert.deepEqual(result.steps, [{ kind: 'say', text: '先检查' }, { kind: 'run', text: 'npm test' }]);
  assert.equal(JSON.parse(rt.captured.opts.input).message.content, '@Claude\n正文');
  assert.equal(rt.captured.opts.env.GEMINI_API_KEY, '');
  assert.equal(rt.captured.opts.env.GOOGLE_API_KEY, '');
  assert.deepEqual(antigravityUsage(result.session), { images: 0, used: 15, window: 1048576 }); // Gemini 4 的上限按公开资料补上
  const next = runtime();
  await runAntigravity({ room, session: result.session, prompt: '继续' }, next).done;
  assert.equal(next.captured.args[next.captured.args.indexOf('--conversation') + 1], 'native-id');
});

test('订阅：读写步骤显示具体文件，路径晚到也只显示一次', async () => {
  const update = (step_index, tool_name, parameters, state = 'ACTIVE') => ({
    event: 'step_update', step_update: { step_type: 'tool', step_index, tool_name, tool_info: { parameters }, state },
  });
  const outside = path.join(path.dirname(room.cwd), '其他项目', 'a.js');
  const replay = [
    { ...events[0], conversation_id: 'tool-paths' },
    update(1, 'read_file', {}),
    update(5, 'run_command', { CommandLine: 'npm test' }),
    update(1, undefined, { Path: path.join(fs.realpathSync(room.cwd), 'src', 'a.js'), StartLine: 4 }),
    update(1, 'read_file', {}, 'DONE'),
    update(2, 'edit_file', { Path: outside, Target: '原文', Replacement: '替换内容' }),
    update(3, 'write_file', { Path: '文档/新 文件.md', Content: '正文' }),
    update(4, 'read_file', {}),
    { event: 'result', result: { conversation_id: 'tool-paths', status: 'SUCCESS', response: '完成' } },
  ];
  const live = [];
  const result = await runAntigravity({ room, prompt: '检查文件', onStep: (s) => live.push(s) }, runtime(replay)).done;
  assert.deepEqual(live, [
    { kind: 'read', text: path.join('src', 'a.js') },
    { kind: 'run', text: 'npm test' },
    { kind: 'edit', text: outside },
    { kind: 'edit', text: '文档/新 文件.md' },
    { kind: 'read', text: 'read_file' },
  ]);
  assert.deepEqual(result.steps, live);
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

test('订阅：中途插话写进同一个进程，它做完手上这一轮接着做，两轮的回复都发出来；收尾后再插话由 hub 排到下一轮', { skip: process.platform === 'win32' }, async () => {
  const prev = process.env.FAKE_SECS;
  process.env.FAKE_SECS = '0.3';
  try {
    const handle = runAgent('gemini', { room, prompt: '先做这件' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(handle.steer('插一句：顺便看下日志'), true);
    const res = await handle.done;
    assert.equal(res.ok, true);
    assert.match(res.text, /做完了/);
    assert.match(res.text, /收到插话/);
    assert.equal(handle.steer('太晚了'), false);
    const file = path.join(process.env.CLAWCHAT_HOME, 'fake-agy', `${res.session.slice(4)}.json`);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).slice(-2).map((t) => t.slice(-10)), ['先做这件'.slice(-10), '插一句：顺便看下日志'.slice(-10)]);
    const side = runAgent('gemini', { room, session: res.session, side: true, prompt: '分身' });
    assert.equal(side.steer('分身不收插话'), false);
    await side.done;
  } finally {
    process.env.FAKE_SECS = prev;
  }
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

test('订阅：模型列表按 agy models 来；群里选的模型账号用不了时，这一轮退回默认并提示', async () => {
  const { parseAgyModels, antigravityModels } = await import('../lib/antigravity.js');
  const out = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n';
  const listed = parseAgyModels(out);
  assert.deepEqual(listed.map((m) => m.id), ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'claude-sonnet-4-6']);
  assert.equal(parseAgyModels('Fetching available models...\n'), null, '拿不到列表时不覆盖');
  const before = agyState.models;
  agyState.models = listed;
  try {
    const ids = antigravityModels().map((m) => m.id);
    assert.deepEqual(ids, ['gemini-3.8-flash', 'claude-sonnet-4-6'], '同一模型的几档合成一项；「默认」就是 Gemini 3.8 Flash，不再单列 auto');
    assert.ok(!ids.includes('gemini-4-argon-high'), '账号没开通的不出现在列表里');
    const room = { cwd: root, permission: 'project', models: { gemini: 'gemini-4-argon-high' } };
    const args = antigravityArgs({ room });
    assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.8-flash-medium', '用不了的模型退回默认');
    const ok = { cwd: root, permission: 'project', models: { gemini: 'claude-sonnet-4-6' } };
    const args2 = antigravityArgs({ room: ok });
    assert.equal(args2[args2.indexOf('--model') + 1], 'claude-sonnet-4-6', '能用的照选');
  } finally {
    agyState.models = before;
  }
});

test('订阅：连接中途断了先报中文让老板「继续」；同一个对话继续以后又断，交给 hub 换新会话', async () => {
  const cut = (id) => [
    { event: 'init', conversation_id: id, init: { model: 'gemini-4-hydrogen-high' } },
    { event: 'result', result: { conversation_id: id, status: 'ERROR', error: 'The stream was interrupted. Please continue the task you were working on.' } },
  ];
  const first = await runAntigravity({ room, prompt: '干活', session: 'agy:cut-id' }, runtime(cut('cut-id'))).done;
  assert.equal(first.ok, false);
  assert.match(first.error, /连接中途断了/);
  assert.ok(!first.sessionMismatch, '第一次断：不换会话，让老板叫它继续');
  const again = await runAntigravity({ room, prompt: '继续', session: 'agy:cut-id' }, runtime(cut('cut-id'))).done;
  assert.equal(again.ok, false);
  assert.equal(again.sessionMismatch, true, '同一个对话又断：交给 hub 换新会话');
  // 别的对话、别的错误不受影响
  const other = await runAntigravity({ room, prompt: '干活', session: 'agy:other-id' }, runtime(cut('other-id'))).done;
  assert.ok(!other.sessionMismatch);
});

test('订阅：断线但已经说了话：照常发出来、标一句可能不完整；同一个对话接连断：话照发，下一轮换新会话', async () => {
  const cutWithText = (id) => [
    { event: 'init', conversation_id: id, init: { model: 'gemini-4-hydrogen-high' } },
    { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, state: 'DONE', text_delta: '已经核对完发布状态，一切正常' } },
    { event: 'result', result: { conversation_id: id, status: 'ERROR', error: 'The stream was interrupted. Please continue the task you were working on.' } },
  ];
  const first = await runAntigravity({ room, prompt: '干活', session: 'agy:salvage-id' }, runtime(cutWithText('salvage-id'))).done;
  assert.equal(first.ok, true, '说了话就不作废');
  assert.equal(first.text, '已经核对完发布状态，一切正常');
  assert.match(first.warning, /可能不完整/);
  assert.equal(first.session, 'agy:salvage-id', '会话照常保留');
  const again = await runAntigravity({ room, prompt: '继续', session: 'agy:salvage-id' }, runtime(cutWithText('salvage-id'))).done;
  assert.equal(again.ok, true);
  assert.equal(again.resetSession, true, '接连断：下一轮换新会话');
  assert.match(again.warning, /接连中断/);
});

test('订阅：同一模型的几档思考强度合成一项、按家族分组；选模型 + 思考强度拼回 agy 的完整型号，老的完整型号照常能用', async () => {
  const { agyGroupedModels, agyModelId, antigravityModels } = await import('../lib/antigravity.js');
  const raw = [
    'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)', 'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)', 'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
    'gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)', 'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)', 'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  ].map((l) => { const [id, name] = l.split('\t'); return { id, name }; });
  const grouped = agyGroupedModels(raw);
  const hydrogen = grouped.find((m) => m.id === 'gemini-4-hydrogen');
  assert.deepEqual(hydrogen.efforts, ['low', 'high', 'xhigh']);
  assert.equal(hydrogen.name, 'Gemini 4 Hydrogen');
  assert.equal(hydrogen.defaultEffort, 'high');
  assert.equal(hydrogen.group, 'Gemini');
  assert.equal(grouped.find((m) => m.id === 'claude-opus-5-5').group, 'Claude');
  assert.equal(grouped.find((m) => m.id === 'gpt-oss-120b-medium').efforts.length, 0, '只有一档的不拆');
  assert.deepEqual(grouped.map((m) => m.group), ['Gemini', 'Gemini', 'Claude', '其他']);
  const before = agyState.models;
  agyState.models = raw;
  try {
    assert.equal(agyModelId({ models: { gemini: 'gemini-4-hydrogen' }, efforts: { gemini: 'xhigh' } }), 'gemini-4-hydrogen-xhigh');
    assert.equal(agyModelId({ models: { gemini: 'gemini-4-hydrogen' }, efforts: {} }), 'gemini-4-hydrogen-high', '没选思考强度用默认档');
    assert.equal(agyModelId({ models: { gemini: 'gemini-4-hydrogen-low' }, efforts: {} }), 'gemini-4-hydrogen-low', '以前存的完整型号照常用');
    assert.equal(agyModelId({ models: { gemini: 'gemini-4-hydrogen-low' }, efforts: { gemini: 'high' } }), 'gemini-4-hydrogen-high', '老型号 + 新选的思考强度');
    assert.equal(agyModelId({ models: { gemini: 'gemini-pro-orchestrator-g1-pro' }, efforts: { gemini: 'high' } }), 'gemini-pro-orchestrator-g1-pro');
    assert.ok(antigravityModels().some((m) => m.id === 'gemini-4-hydrogen' && m.efforts.length === 3));
  } finally {
    agyState.models = before;
  }
});

test('订阅：拿不到模型列表时也不把不带档位的型号交给 agy；「默认」选了思考强度就用 Gemini 3.8 Flash 那一档', async () => {
  const { agyModelId } = await import('../lib/antigravity.js');
  const before = agyState.models;
  try {
    agyState.models = null;
    assert.equal(agyModelId({ models: { gemini: 'gemini-4-hydrogen' }, efforts: { gemini: 'xhigh' } }), 'gemini-4-hydrogen-xhigh');
    assert.equal(agyModelId({ models: { gemini: 'gemini-4-hydrogen' }, efforts: {} }), 'gemini-4-hydrogen-high');
    assert.equal(agyModelId({ models: { gemini: 'gemini-4-hydrogen-low' }, efforts: {} }), 'gemini-4-hydrogen-low', '老的完整型号原样');
    assert.equal(agyModelId({ models: { gemini: 'gemini-pro-orchestrator-neon' }, efforts: { gemini: 'high' } }), 'gemini-pro-orchestrator-neon', '不是家族型号的不乱拼');
    agyState.models = [{ id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }, { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' }];
    assert.equal(agyModelId({ models: {}, efforts: { gemini: 'high' } }), 'gemini-3.8-flash-high', '默认 + 高');
    assert.equal(agyModelId({ models: {}, efforts: {} }), 'gemini-3.8-flash-medium', '默认 + 默认');
    // agyState.models 为空时，agyShown 也按家族拆出思考强度，不误拆单档型号
    agyState.models = null;
    assert.deepEqual(agyShown('gemini-4-hydrogen-high'), { model: 'gemini-4-hydrogen', effort: 'high' });
    assert.deepEqual(agyShown('claude-opus-5-5-medium'), { model: 'claude-opus-5-5', effort: 'medium' });
    assert.deepEqual(agyShown('gpt-oss-120b-medium'), { model: 'gpt-oss-120b-medium', effort: '' });
  } finally {
    agyState.models = before;
  }
});

test('订阅：断线挽救没收到新 usage 时保留上轮上下文用量；分身断线不影响本体 cutSessions', async () => {
  const { antigravityUsage } = await import('../lib/antigravity.js');
  const prevVersion = agyState.version;
  agyState.version = '1.5.12';
  const runEvents = (events, code, stderr = '', extra = {}) => runAntigravity(
    { room: { cwd: root, permission: 'project' }, prompt: '测试', ...extra },
    {
      which: () => '/usr/bin/agy',
      spawnJsonl: (_b, _a, { onEvent }) => ({
        done: Promise.resolve().then(() => { for (const ev of events) onEvent(ev); return { code, stderr }; }),
        kill() {},
        end() {},
      }),
    },
  ).done;
  try {
    const r1 = await runEvents([
      { event: 'init', conversation_id: 'conv-audit-1', init: { model: 'gemini-4-hydrogen-high' } },
      { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, text_delta: '完成', usage: { input_tokens: 4000, output_tokens: 200 } } },
      { event: 'result', result: { conversation_id: 'conv-audit-1', status: 'SUCCESS', response: '完成' } },
    ], 0);
    assert.equal(antigravityUsage(r1.session).used, 4200);
    // 本体断线挽救，本轮没收到新 s.usage：保留上轮 4200，同时 cutSessions 记下本体会话
    const r2 = await runEvents([
      { event: 'init', conversation_id: 'conv-audit-1', init: { model: 'gemini-4-hydrogen-high' } },
      { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, text_delta: '半截结论' } },
    ], 1, 'The stream was interrupted', { session: r1.session });
    assert.equal(r2.ok, true);
    assert.equal(antigravityUsage(r2.session).used, 4200, '保留上一轮的上下文用量');
    // 分身断线挽救：不触发接连中断，也不清除本体 cutSessions 标记
    const rSide = await runEvents([
      { event: 'init', conversation_id: 'side-conv-1', init: { model: 'gemini-4-hydrogen-high' } },
      { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, text_delta: '分身半句' } },
    ], 1, 'The stream was interrupted', { session: r1.session, side: true });
    assert.equal(rSide.ok, true);
    assert.equal(rSide.resetSession, undefined);
    // 本体紧接着再次纯断线：仍能正确触发 sessionMismatch 自动换会话
    const r3 = await runEvents([
      { event: 'init', conversation_id: 'conv-audit-1', init: { model: 'gemini-4-hydrogen-high' } },
    ], 1, 'The stream was interrupted', { session: r1.session });
    assert.equal(r3.ok, false);
    assert.equal(r3.sessionMismatch, true);
  } finally {
    agyState.version = prevVersion;
  }
});
