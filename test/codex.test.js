import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-codex-rpc-'));
const fake = path.join(root, 'bin');
fs.mkdirSync(fake, { recursive: true });
const entry = new URL('../scripts/fake/codex-cli.mjs', import.meta.url).href;
// 两个平台都造出真正能被 which 找到的假启动器；Windows 的 .cmd 也走生产代码里的 npm shim 解析。
fs.writeFileSync(path.join(fake, 'codex'), `#!${process.execPath}\nimport(${JSON.stringify(entry)});\n`, { mode: 0o755 });
fs.writeFileSync(path.join(fake, 'codex.js'), `import(${JSON.stringify(entry)});\n`);
fs.writeFileSync(path.join(fake, 'codex.cmd'), '@echo off\r\n"%~dp0\\codex.js" %*\r\n');
process.env.CLAWCHAT_HOME = path.join(root, 'clawchat');
process.env.CODEX_HOME = path.join(root, 'codex-home');
process.env.PATH = `${fake}${path.delimiter}${process.env.PATH}`;
process.env.FAKE_CODEX_RPC_LOG = path.join(root, 'rpc.jsonl');
process.env.FAKE_CODEX_SECS = '0.25';
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'service_tier = "priority"\n');
const { runAgent, codexServerArgs } = await import('../lib/agents.js');
const { Store } = await import('../lib/store.js');
const { Hub } = await import('../lib/hub.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => { delete process.env.FAKE_CODEX_RPC_SCENARIO; });
const room = { cwd: root, permission: 'project', models: { gpt: 'gpt-test' }, efforts: { gpt: 'high' }, fast: { gpt: false } };
const logs = () => fs.existsSync(process.env.FAKE_CODEX_RPC_LOG)
  ? fs.readFileSync(process.env.FAKE_CODEX_RPC_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const clearLog = () => fs.rmSync(process.env.FAKE_CODEX_RPC_LOG, { force: true });
async function until(check) {
  const start = Date.now();
  while (!check()) {
    assert.ok(Date.now() - start < 5000, '等待假进程超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}
function start(opts = {}) {
  const steps = [];
  const handle = runAgent('gpt', { room, prompt: '第一条要求', systemPrompt: '只在新会话传的群规', onStep: (s) => steps.push(s), ...opts });
  return { ...handle, steps };
}

test('Codex app-server：同一回合接收多次插话和图片，最终只交回一次；保存并精确续接旧会话', async () => {
  clearLog();
  const image = path.join(root, '图.png');
  fs.writeFileSync(image, '假图片路径，只验证协议');
  const h = start({ images: [{ path: image }] });
  await until(() => h.steps.some((s) => s.kind === 'run'));
  assert.equal(await h.steer('老板加的要求', [{ path: image }]), true);
  assert.equal(await h.steer('Claude：@ChatGPT 同事补充'), true);
  const res = await h.done;
  assert.equal(res.ok, true);
  assert.match(res.text, /中途收到 2 条新消息/);
  assert.match(res.text, /同事补充/);
  assert.equal(await h.steer('已经做完后的消息'), false);
  assert.ok(res.session);
  assert.equal(res.steps.filter((s) => s.kind === 'say').length, 0);
  const messages = logs();
  assert.equal(messages.filter((m) => m.method === 'turn/start').length, 1);
  const setup = messages.find((m) => m.method === 'thread/start').params;
  assert.equal(setup.developerInstructions, '只在新会话传的群规');
  assert.equal(setup.historyMode, 'legacy');
  assert.equal(setup.ephemeral, false);
  assert.equal(setup.approvalPolicy, 'never');
  assert.equal(setup.sandbox, 'workspace-write');
  const turn = messages.find((m) => m.method === 'turn/start').params;
  assert.equal(turn.effort, 'high');
  assert.equal(turn.serviceTierForTurn, 'default');
  assert.deepEqual(turn.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [root], networkAccess: true });
  assert.equal(turn.input[1].path, image);
  assert.equal(messages.find((m) => m.method === 'turn/steer').params.input[1].path, image);
  clearLog();
  const next = await start({ session: res.session }).done;
  assert.equal(next.ok, true);
  assert.equal(next.session, res.session);
  const resume = logs().find((m) => m.method === 'thread/resume').params;
  assert.equal(resume.threadId, res.session);
  assert.equal('developerInstructions' in resume, false);
});

test('Codex app-server：标准档不继承用户快速档，完全开放和只读权限逐轮明确传入', async () => {
  assert.ok(codexServerArgs(room).includes('features.fast_mode=false'));
  for (const permission of ['full', 'readonly']) {
    clearLog();
    const res = await start({ room: { ...room, permission, fast: { gpt: true } } }).done;
    assert.equal(res.ok, true);
    const turn = logs().find((m) => m.method === 'turn/start').params;
    assert.equal(turn.serviceTierForTurn, 'fast');
    assert.equal(turn.approvalPolicy, 'never');
    assert.equal(turn.sandboxPolicy.type, permission === 'full' ? 'dangerFullAccess' : 'readOnly');
  }
  assert.equal(fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8'), 'service_tier = "priority"\n');
});

test('Codex app-server：插话被拒绝返回 false；收尾通知先到也等回执，不把消息误认成已接收', async () => {
  for (const scenario of ['reject-steer', 'reject-after-complete', 'complete-before-steer-reply']) {
    process.env.FAKE_CODEX_RPC_SCENARIO = scenario;
    const h = start();
    await until(() => h.steps.some((s) => s.kind === 'run'));
    assert.equal(await h.steer('收尾竞态'), scenario === 'complete-before-steer-reply');
    const res = await h.done;
    assert.equal(res.ok, true);
    assert.equal(/收尾竞态/.test(res.text), scenario === 'complete-before-steer-reply');
  }
});

test('Codex app-server：失败、进程崩溃和会话丢失都不能误报成功，首轮失败不保存会话', async () => {
  for (const scenario of ['fail-turn', 'crash', 'missing-session']) {
    process.env.FAKE_CODEX_RPC_SCENARIO = scenario;
    const res = await start(scenario === 'missing-session' ? { session: 'missing-thread' } : {}).done;
    assert.equal(res.ok, false);
    assert.ok(res.error);
    if (scenario === 'missing-session') assert.match(res.error, /session not found/);
  }
  process.env.FAKE_CODEX_RPC_SCENARIO = 'fail-turn';
  const store = new Store();
  const r = store.createRoom({ ...room, name: '失败不保存', members: ['gpt'], collab: false });
  const hub = new Hub(store, { imageBytes: async () => 0 });
  hub.postUserMessage(r.id, '首轮失败');
  await until(() => !hub.runs.size);
  assert.equal(store.getState(r.id).sessions.gpt, undefined);
  assert.equal(store.getState(r.id).cursors.gpt, -1);
});

test('Codex app-server：停止会结束单独进程组里的子进程，停止后的插话不再接收', async () => {
  process.env.FAKE_CODEX_RPC_SCENARIO = 'stop-tree';
  const childFile = path.join(process.env.CLAWCHAT_HOME, 'fake-codex', 'child.pid');
  const h = start();
  await until(() => fs.existsSync(childFile));
  const pid = Number(fs.readFileSync(childFile, 'utf8'));
  h.kill();
  const res = await h.done;
  assert.equal(res.ok, false);
  assert.equal(await h.steer('停止后'), false);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});

test('Codex 分身保留原来的临时只读 fork，不向本体的 app-server 会话写入', async () => {
  clearLog();
  const res = await start({ side: true, session: 'fake-source' }).done;
  assert.equal(res.ok, true);
  assert.equal(logs().length, 0);
});

test('Codex app-server：思考、命令、修改、搜索、计划、压缩和最终回复分开；审批不挂起也不自动放权', async () => {
  process.env.FAKE_CODEX_RPC_SCENARIO = 'events';
  clearLog();
  const h = start();
  const res = await h.done;
  assert.equal(res.ok, true);
  assert.equal(res.text, '（假的 ChatGPT）做完了');
  for (const kind of ['run', 'think', 'edit', 'tool', 'web', 'todo', 'compact']) assert.ok(res.steps.some((s) => s.kind === kind), kind);
  assert.ok(res.steps.some((s) => s.text === '我先看一下'));
  assert.deepEqual(logs().find((m) => m.id === 900 && !m.method).result, { decision: 'decline' });
  assert.deepEqual(logs().find((m) => m.id === 901 && !m.method).result, { permissions: {}, scope: 'turn' });
  assert.deepEqual(logs().find((m) => m.id === 902 && !m.method).result, { answers: {} });
});

test('Codex app-server：有成功终态但没有最终文字，不重跑已做完的工具', async () => {
  process.env.FAKE_CODEX_RPC_SCENARIO = 'no-final';
  const res = await start().done;
  assert.equal(res.ok, true);
  assert.equal(res.text, '');
});

test('Codex 经 Hub 完整收发：老板、同事的插话进同一回合，只发一次回复，退出重载后还能续聊', async () => {
  clearLog();
  const store = new Store();
  const r = store.createRoom({ ...room, name: '完整插话', members: ['gpt', 'claude'], collab: true });
  const hub = new Hub(store, { imageBytes: async () => 0 });
  hub.postUserMessage(r.id, '@ChatGPT 开工');
  await until(() => hub.runs.get(hub.key(r.id, 'gpt'))?.steps.some((s) => s.kind === 'run'));
  hub.postUserMessage(r.id, '@ChatGPT 老板的补充');
  hub.deliver(r.id, 'claude', '@ChatGPT 同事的补充', false, {});
  await until(() => !hub.runs.size && !hub.wanted.size);
  const messages = store.getMessages(r.id).filter((m) => m.from === 'gpt');
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /中途收到 2 条新消息/);
  assert.equal(logs().filter((m) => m.method === 'turn/start').length, 1);
  const sid = store.getState(r.id).sessions.gpt;
  const reloaded = new Store();
  const nextHub = new Hub(reloaded, { imageBytes: async () => 0 });
  nextHub.postUserMessage(r.id, '@ChatGPT 重开后接着干');
  await until(() => !nextHub.runs.size);
  assert.equal(reloaded.getState(r.id).sessions.gpt, sid);
});

test('Codex 经 Hub：插话回执拒绝后，原消息只排到下一轮，不漏掉也不重复开工', async () => {
  process.env.FAKE_CODEX_RPC_SCENARIO = 'reject-steer';
  clearLog();
  const store = new Store();
  const r = store.createRoom({ ...room, name: '拒绝后排队', members: ['gpt'], collab: false });
  const hub = new Hub(store, { imageBytes: async () => 0 });
  hub.postUserMessage(r.id, '首轮开工');
  await until(() => hub.runs.get(hub.key(r.id, 'gpt'))?.steps.some((s) => s.kind === 'run'));
  hub.postUserMessage(r.id, '这条必须进下一轮');
  await until(() => !hub.runs.size && !hub.wanted.size);
  const starts = logs().filter((m) => m.method === 'turn/start');
  assert.equal(starts.length, 2);
  assert.match(starts[1].params.input[0].text, /这条必须进下一轮/);
  assert.equal(store.getMessages(r.id).filter((m) => m.from === 'gpt').length, 2);
});
