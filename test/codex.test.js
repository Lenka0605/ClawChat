import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

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
const { runAgent, codexServerArgs, sessionUsage } = await import('../lib/agents.js');
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
  assert.equal('historyMode' in setup, false);
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

test('Codex app-server：初始化期间收到补充，等回合就绪后插入同一轮，不另开一轮', async () => {
  clearLog();
  const h = start();
  assert.equal(await h.steer('卡片刚出现时的补充'), true);
  const res = await h.done;
  assert.equal(res.ok, true);
  assert.match(res.text, /卡片刚出现时的补充/);
  assert.equal(logs().filter((m) => m.method === 'turn/start').length, 1);
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

test('Codex 分身：分页会话用临时只读 fork，保留本体历史和用量，不收中途插话', async () => {
  const primary = await start().done;
  const parent = path.join(process.env.CLAWCHAT_HOME, 'fake-codex', `${primary.session}.json`);
  const before = fs.readFileSync(parent, 'utf8');
  const count = fs.readdirSync(path.dirname(parent)).length;
  const usage = await sessionUsage('gpt', primary.session);
  clearLog();
  const h = start({ side: true, session: primary.session, room: { ...room, permission: 'full' } });
  await until(() => h.steps.some((s) => s.kind === 'run'));
  assert.equal(await h.steer('分身不收插话'), false);
  const res = await h.done;
  assert.equal(res.ok, true);
  assert.notEqual(res.session, primary.session);
  const fork = logs().find((m) => m.method === 'thread/fork').params;
  assert.equal(fork.threadId, primary.session);
  assert.equal(fork.ephemeral, true);
  assert.equal(fork.excludeTurns, true);
  assert.equal(fork.sandbox, 'read-only');
  assert.equal(logs().find((m) => m.method === 'turn/start').params.sandboxPolicy.type, 'readOnly');
  assert.equal(fs.readFileSync(parent, 'utf8'), before);
  assert.equal(fs.readdirSync(path.dirname(parent)).length, count);
  assert.deepEqual(await sessionUsage('gpt', primary.session), usage);
  assert.equal(await sessionUsage('gpt', res.session), null);
  assert.ok(codexServerArgs(room, true).includes('sandbox_mode="read-only"'));
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

test('Codex 会话隔离：续聊返回错误编号、分身返回本体编号时，停止且不发送任何模型回合', async () => {
  const primary = await start().done;
  for (const scenario of ['wrong-session', 'fork-reuses-parent']) {
    clearLog();
    process.env.FAKE_CODEX_RPC_SCENARIO = scenario;
    const res = await start({ session: primary.session, side: scenario === 'fork-reuses-parent' }).done;
    assert.equal(res.ok, false);
    assert.equal(logs().filter((m) => m.method === 'turn/start').length, 0);
  }
});

test('Codex 分页用量：继承旧 JSONL 图片，累加新附件和看图，重开后保留；压缩清零，不复活旧图', async () => {
  const sid = 'legacy-codex-history';
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '31');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-${sid}.jsonl`), `${JSON.stringify({ type: 'response_item', payload: { image_url: 'data:image/png;base64,AAAAAAAAAAAA' } })}\n`);
  const fakeDir = path.join(process.env.CLAWCHAT_HOME, 'fake-codex');
  fs.writeFileSync(path.join(fakeDir, `${sid}.json`), '{}');
  const image = path.join(root, 'usage.png');
  fs.writeFileSync(image, '123456');
  assert.equal((await sessionUsage('gpt', sid)).images, 12);
  process.env.FAKE_CODEX_RPC_SCENARIO = 'usage';
  assert.equal((await start({ session: sid, images: [{ path: image }] }).done).ok, true);
  assert.deepEqual(await sessionUsage('gpt', sid), { images: 28, used: 42, window: 65536 });
  const file = path.join(process.env.CLAWCHAT_HOME, 'codex-usage', `${sid}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { images: 28, used: 42, window: 65536 });
  process.env.FAKE_CODEX_RPC_SCENARIO = 'compact';
  assert.equal((await start({ session: sid }).done).ok, true);
  assert.deepEqual(await sessionUsage('gpt', sid), { images: 0, used: 42, window: 65536 });
});

test('Codex 结构化上下文错误：保留 contextWindowExceeded 标记，不依赖英文报错文案', async () => {
  process.env.FAKE_CODEX_RPC_SCENARIO = 'context-exceeded';
  const res = await start().done;
  assert.equal(res.ok, false);
  assert.match(res.error, /contextWindowExceeded/);
});

test('Codex 图片估算：主动重看同图仍增加用量，同一工具事件重发只算一次', async () => {
  const image = path.join(root, 'repeated.png');
  fs.writeFileSync(image, '123456');
  process.env.FAKE_CODEX_RPC_SCENARIO = 'usage';
  const h = start({ images: [{ path: image }] });
  await until(() => h.steps.some((s) => s.kind === 'run'));
  assert.equal(await h.steer('同图再发一次', [{ path: image }]), true);
  const res = await h.done;
  assert.equal(res.ok, true);
  assert.equal((await sessionUsage('gpt', res.session)).images, 32);
  // 新一轮单独调用查看工具，没有新附件时仍应计数。
  const toolImage = path.join(root, 'tool-view.png');
  fs.writeFileSync(toolImage, '123');
  const { runCodexServer } = await import('../lib/codex.js');
  const handle = runCodexServer({ room, prompt: '看工具图片', onStep() {} }, {
    bin: '假进程', args: [], unwrapShell: (x) => x,
    spawnJsonl(_bin, _args, { onEvent }) {
      let finish;
      const done = new Promise((resolve) => { finish = resolve; });
      return {
        done, kill() { finish({ code: 0 }); }, end() { finish({ code: 0 }); },
        write(line) {
          const m = JSON.parse(line);
          queueMicrotask(() => {
            if (m.method === 'initialize') onEvent({ id: m.id, result: {} });
            else if (m.method === 'thread/start') onEvent({ id: m.id, result: { thread: { id: 'tool-view-only' } } });
            else if (m.method === 'turn/start') {
              onEvent({ id: m.id, result: { turn: { id: 'view-turn' } } });
              onEvent({ method: 'item/completed', params: { threadId: 'tool-view-only', item: { id: 'view', type: 'imageView', path: toolImage } } });
              onEvent({ method: 'turn/completed', params: { threadId: 'tool-view-only', turn: { id: 'view-turn', status: 'completed' } } });
            }
          });
          return true;
        },
      };
    },
  });
  assert.equal((await handle.done).ok, true);
  assert.equal((await sessionUsage('gpt', 'tool-view-only')).images, 4);
});

test('Codex 旧版本没有 app-server：明确提示升级，不伪装成普通进程失败', async () => {
  process.env.FAKE_CODEX_RPC_SCENARIO = 'old-cli';
  const res = await start().done;
  assert.equal(res.ok, false);
  assert.match(res.error, /设置.*Codex 的更新/);
});

test('Codex 经 Hub：续接编号异常先停掉错误回合，再自动带记录开新会话，保留原始会话文件', async () => {
  const previous = await start().done;
  const oldFile = path.join(process.env.CLAWCHAT_HOME, 'fake-codex', `${previous.session}.json`);
  const content = fs.readFileSync(oldFile, 'utf8');
  const store = new Store();
  const r = store.createRoom({ ...room, name: '编号异常恢复', members: ['gpt'], collab: false });
  store.getState(r.id).sessions.gpt = previous.session;
  store.saveState(r.id);
  clearLog();
  process.env.FAKE_CODEX_RPC_SCENARIO = 'wrong-session';
  const hub = new Hub(store, { imageBytes: async () => 0 });
  hub.postUserMessage(r.id, '从最近记录继续处理');
  await until(() => !hub.runs.size);
  const messages = logs();
  assert.equal(messages.filter((m) => m.method === 'thread/resume').length, 1);
  assert.equal(messages.filter((m) => m.method === 'thread/start').length, 1);
  assert.equal(messages.filter((m) => m.method === 'turn/start').length, 1);
  assert.notEqual(store.getState(r.id).sessions.gpt, previous.session);
  assert.match(JSON.stringify(messages.find((m) => m.method === 'turn/start')), /从最近记录继续处理/);
  assert.equal(fs.readFileSync(oldFile, 'utf8'), content);
  assert.equal(store.getMessages(r.id).filter((m) => m.from === 'gpt').length, 1);
});

test('Codex 用量清理：换会话、删群后清估算，其他群仍在引用的记录和真实会话都保留', async () => {
  const previous = await start().done;
  const usageFile = path.join(process.env.CLAWCHAT_HOME, 'codex-usage', `${previous.session}.json`);
  const realFile = path.join(process.env.CLAWCHAT_HOME, 'fake-codex', `${previous.session}.json`);
  const store = new Store();
  const rooms = ['引用一', '引用二'].map((name) => store.createRoom({ ...room, name, members: ['gpt'], collab: false }));
  for (const r of rooms) {
    store.getState(r.id).sessions.gpt = previous.session;
    store.saveState(r.id);
  }
  const hub = new Hub(store, { imageBytes: async () => 0 });
  assert.equal(hub.resetAgent(rooms[0].id, 'gpt', 'boss'), 'reset');
  assert.equal(fs.existsSync(usageFile), true);
  const candidates = Object.values(store.getState(rooms[1].id).sessions);
  store.deleteRoom(rooms[1].id);
  hub.cleanupCodexUsage(candidates);
  assert.equal(fs.existsSync(usageFile), false);
  assert.equal(fs.existsSync(realFile), true);
  const next = await start().done;
  const nextUsage = path.join(process.env.CLAWCHAT_HOME, 'codex-usage', `${next.session}.json`);
  store.getState(rooms[0].id).sessions.gpt = next.session;
  store.saveState(rooms[0].id);
  hub.resetSessions(rooms[0].id);
  assert.equal(fs.existsSync(nextUsage), false);
});

test('Codex 经 Hub：结构化上下文超限会自动换会话恢复，不需要真的耗尽模型上下文', async () => {
  const previous = await start().done;
  const store = new Store();
  const r = store.createRoom({ ...room, name: '上下文恢复', members: ['gpt'], collab: false });
  store.getState(r.id).sessions.gpt = previous.session;
  store.saveState(r.id);
  process.env.FAKE_CODEX_RPC_SCENARIO = 'context-exceeded';
  const hub = new Hub(store, { imageBytes: async () => 0 });
  hub.postUserMessage(r.id, '换新会话后继续完成');
  await until(() => hub.runs.get(hub.key(r.id, 'gpt'))?.steps.some((s) => s.kind === 'run'));
  delete process.env.FAKE_CODEX_RPC_SCENARIO; // 第一轮假进程已经启动；自动恢复那轮改为成功。
  await until(() => !hub.runs.size);
  assert.notEqual(store.getState(r.id).sessions.gpt, previous.session);
  assert.equal(store.getMessages(r.id).filter((m) => m.from === 'gpt').length, 1);
  assert.ok(store.getMessages(r.id).some((m) => m.from === 'system' && m.text.includes('上下文满了')));
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

test('Codex 失败用量：首轮失败和停止不留无引用文件，续聊失败仍保留原会话的用量', async () => {
  process.env.FAKE_CODEX_RPC_SCENARIO = 'fail-turn';
  const failed = await start().done;
  const file = (sid) => path.join(process.env.CLAWCHAT_HOME, 'codex-usage', `${sid}.json`);
  assert.equal(fs.existsSync(file(failed.session)), false);
  delete process.env.FAKE_CODEX_RPC_SCENARIO;
  const previous = await start().done;
  process.env.FAKE_CODEX_RPC_SCENARIO = 'fail-turn';
  assert.equal((await start({ session: previous.session }).done).ok, false);
  assert.equal(fs.existsSync(file(previous.session)), true);
  delete process.env.FAKE_CODEX_RPC_SCENARIO;
  const handle = start();
  await until(() => handle.steps.some((s) => s.kind === 'run'));
  handle.kill();
  const stopped = await handle.done;
  assert.equal(stopped.ok, false);
  assert.equal(fs.existsSync(file(stopped.session)), false);
});

test('Codex 用量合并：密集通知只写一次，收尾保存最后用量；保存失败仍然成功并提示', async () => {
  const { runCodexServer } = await import('../lib/codex.js');
  for (const writeFails of [false, true]) {
    const sid = writeFails ? 'usage-write-fails' : 'usage-batched';
    const original = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = (file, ...args) => {
      if (String(file).includes(`${sid}.json`)) {
        writes++;
        if (writeFails) throw new Error('假的磁盘写入失败');
      }
      return original(file, ...args);
    };
    try {
      const h = runCodexServer({ room, prompt: '密集用量', onStep() {} }, {
        bin: '假的用量进程', args: [], unwrapShell: (x) => x,
        spawnJsonl(_bin, _args, { onEvent }) {
          let finish;
          const done = new Promise((r) => { finish = r; });
          return {
            done, end() { finish({ code: 0 }); }, kill() { finish({ code: 0 }); },
            write(line) {
              const m = JSON.parse(line);
              queueMicrotask(() => {
                if (m.method === 'initialize') onEvent({ id: m.id, result: {} });
                else if (m.method === 'thread/start') onEvent({ id: m.id, result: { thread: { id: sid } } });
                else if (m.method === 'turn/start') {
                  onEvent({ id: m.id, result: { turn: { id: 'batch-turn' } } });
                  for (let i = 1; i <= 100; i++) onEvent({ method: 'thread/tokenUsage/updated', params: { threadId: sid, tokenUsage: { last: { totalTokens: i }, modelContextWindow: 65536 } } });
                  onEvent({ method: 'turn/completed', params: { threadId: sid, turn: { id: 'batch-turn', status: 'completed' } } });
                }
              });
              return true;
            },
          };
        },
      });
      const res = await h.done;
      assert.equal(res.ok, true);
      assert.equal(writes, 1);
      if (writeFails) assert.match(res.warning, /用量记录没能保存/);
      else assert.deepEqual(await sessionUsage('gpt', sid), { images: 0, used: 100, window: 65536 });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(writes, 1, '收尾后没有晚到定时器再写一次');
    } finally { fs.writeFileSync = original; }
  }
});

function testBin(dir, name, code) {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(script, code);
  fs.writeFileSync(path.join(dir, name), `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(script).href)});\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n"%~dp0\\${name}.mjs" %*\r\n`);
}

test('运行进程隔离：本体崩溃后清掉脱离进程组且持有管道的子命令，不碰另一轮或正常完成的后台服务', async () => {
  const dir = path.join(root, 'process-test-bin');
  const oldPath = process.env.PATH;
  const handles = [];
  const pids = [];
  testBin(dir, 'codex', `
    import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline'; import {spawn} from 'node:child_process';
    const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    const rl=readline.createInterface({input:process.stdin});
    rl.on('line',line=>{const m=JSON.parse(line);
      if(m.method==='initialize')send({id:m.id,result:{}});
      if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'process-'+process.pid}}});
      if(m.method==='turn/start'){
        const mode=m.params.input[0].text;
        const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:mode==='crash'?['ignore',1,2]:'ignore'});
        fs.writeFileSync(path.join(m.params.cwd,mode+'.pid'),String(c.pid));
        if(mode==='crash')process.exit(2);
        send({id:m.id,result:{turn:{id:'pt'}}});
        send({method:'item/started',params:{item:{id:'cmd',type:'commandExecution',command:'假的后台命令'}}});
        if(mode==='completed')send({method:'turn/completed',params:{turn:{id:'pt',status:'completed'}}});
      }
    });
    rl.on('close',()=>process.exit(0));
  `);
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const childPid = (mode) => { const pid = Number(fs.readFileSync(path.join(root, `${mode}.pid`), 'utf8')); pids.push(pid); return pid; };
  try {
    const running = start({ prompt: 'running' }); handles.push(running);
    await until(() => running.steps.length > 0);
    const runningPid = childPid('running');
    const crash = start({ prompt: 'crash' }); handles.push(crash);
    assert.equal((await crash.done).ok, false);
    const crashedPid = childPid('crash');
    await until(() => !alive(crashedPid));
    assert.equal(alive(runningPid), true);
    running.kill();
    await running.done;
    await until(() => !alive(runningPid));
    const completed = start({ prompt: 'completed' }); handles.push(completed);
    assert.equal((await completed.done).ok, true);
    assert.equal(alive(childPid('completed')), true, '正常完成不杀用户有意启动的后台服务');
  } finally {
    process.env.PATH = oldPath;
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    for (const h of handles.slice(0, 2)) await h.kill();
  }
});

test('Windows 进程清理：父进程先退出仍找回子进程，编号已复用时不误杀', async () => {
  const { processGuard } = await import('../lib/processes.js');
  for (const reused of [false, true]) {
    const calls = [];
    let killed = false;
    const time = Date.now();
    const guard = processGuard({ platform: 'win32', sleep: async () => {}, exec(cmd, args, _opts, cb) {
      calls.push({ cmd, args });
      if (cmd === 'taskkill') { killed = true; cb(null, ''); return; }
      cb(null, JSON.stringify(killed ? [] : [
        { pid: 501, ppid: 500, started: new Date(time + (reused ? 10000 : 0)).toISOString() },
        { pid: 502, ppid: 1, started: new Date(time).toISOString() },
        { pid: 503, ppid: 501, started: new Date(time + 10).toISOString() },
      ]));
    } });
    const child = Object.assign(new EventEmitter(), { pid: 500, exitCode: 2 });
    guard.attach(child);
    child.emit('exit', 2, null);
    assert.equal(await guard.kill(), true);
    assert.deepEqual(calls.filter((c) => c.cmd === 'taskkill').map((c) => c.args), reused ? [] : [['/PID', '503', '/F'], ['/PID', '501', '/F']]);
  }
});

test('Windows 进程清理：拒绝结束后代或进程查询失败时，不能声称全部停止', async () => {
  const { processGuard } = await import('../lib/processes.js');
  for (const scenario of ['denied', 'query-failed']) {
    let clock = Date.now();
    const started = new Date(clock).toISOString();
    const guard = processGuard({ platform: 'win32', now: () => clock, sleep: async (ms) => { clock += ms; }, exec(cmd, _args, _opts, cb) {
      if (scenario === 'query-failed' || cmd === 'taskkill') cb(new Error('假的权限拒绝'), '');
      else cb(null, JSON.stringify([{ pid: 501, ppid: 500, started }]));
    } });
    const child = Object.assign(new EventEmitter(), { pid: 500, exitCode: 2 });
    guard.attach(child);
    child.emit('exit', 2, null);
    assert.equal(await guard.kill(), false, scenario);
  }
});

test('模型试用：用统一参数明确关闭快速档并保持只读，不沿用全局 priority', async () => {
  const dir = path.join(root, 'probe-test-bin');
  const argFile = path.join(root, 'probe-args.json');
  const oldPath = process.env.PATH;
  testBin(dir, 'codex', `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(argFile)},JSON.stringify(process.argv.slice(2)));fs.readFileSync(0,'utf8');console.log(JSON.stringify({type:'turn.completed'}));`);
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  try {
    const { probeModel } = await import('../lib/agents.js');
    assert.equal((await probeModel('gpt', 'fake-custom')).ok, true);
    const args = JSON.parse(fs.readFileSync(argFile, 'utf8'));
    assert.ok(args.includes('features.fast_mode=false'));
    assert.ok(args.includes('sandbox_mode="read-only"'));
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes('--ephemeral'));
    if (process.platform === 'win32') assert.ok(args.includes('windows.sandbox="unelevated"'));
    assert.equal(fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8'), 'service_tier = "priority"\n');
  } finally { process.env.PATH = oldPath; }
});

test('Claude 模型缓存：同一路径的程序升级后重新读取模型名', async () => {
  const dir = path.join(root, 'aliases-test-bin');
  const oldPath = process.env.PATH;
  const envKeys = ['DEEPSEEK_API_KEY', 'GLM_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  const oldEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  const write = (version) => {
    testBin(dir, 'claude', `// latest_per_family:{opus:"claude-opus-${version}"}\nconsole.log(process.argv[2]==='--version'?'fake-'+${JSON.stringify(version)}:'{"loggedIn":true}');`);
    fs.appendFileSync(path.join(dir, 'claude'), `// latest_per_family:{opus:"claude-opus-${version}"}\n`);
  };
  write('5-5');
  // 只允许测试程序和系统工具，不能找到机器上真的 AI 命令。
  process.env.PATH = [dir, fake, ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot, 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter);
  try {
    const { detectEngines } = await import('../lib/agents.js');
    assert.equal((await detectEngines()).claude.models.find((m) => m.id === 'opus').name, 'Opus 5.5');
    write('6-0');
    assert.equal((await detectEngines()).claude.models.find((m) => m.id === 'opus').name, 'Opus 6.0');
  } finally {
    process.env.PATH = oldPath;
    for (const [k, v] of Object.entries(oldEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('Windows 重启保护：旧服务未退、无法停新服务、脏目录或错误提交时不自动覆盖', async () => {
  const { restartServer } = await import('../windows/restart.js');
  const from = 'a'.repeat(40), to = 'b'.repeat(40);
  for (const scenario of ['old-alive', 'cannot-stop', 'dirty', 'wrong-head', 'invalid-record']) {
    const dataDir = path.join(root, `restart-${scenario}`);
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, 'update-prev.json'), JSON.stringify({ from: scenario === 'invalid-record' ? '--help' : from, to }));
    let clock = 0, starts = 0;
    const commands = [], errors = [];
    const result = await restartServer({
      root, dataDir, healthTimeout: 30, exitTimeout: 20, now: () => clock, sleep: async (ms) => { clock += ms; },
      alive: async () => scenario === 'old-alive',
      startServer() { starts++; return { stop: async () => scenario !== 'cannot-stop' }; },
      showError: (e) => errors.push(e),
      async git(_root, args) {
        commands.push(args);
        return { ok: true, out: args[0] === 'rev-parse' ? (scenario === 'wrong-head' ? from : to) : args[0] === 'status' && scenario === 'dirty' ? ' M windows/launch.js' : '' };
      },
    });
    assert.equal(result.ok, false, scenario);
    assert.equal(starts, scenario === 'old-alive' ? 0 : 1, scenario);
    assert.equal(errors.length, 1, scenario);
    assert.equal(commands.some((a) => a[0] === 'reset'), false, scenario);
    assert.equal(fs.existsSync(path.join(dataDir, 'update-prev.json')), true, scenario);
  }
});

test('Windows 升级恢复：健康成功才清标记；失败时在隔离仓库真实退回并在旧服务启动前写提示', async () => {
  const { restartServer } = await import('../windows/restart.js');
  const repo = path.join(root, 'rollback-repo');
  const dataDir = path.join(root, 'rollback-data');
  fs.mkdirSync(repo); fs.mkdirSync(dataDir);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  const commit = (text) => {
    fs.writeFileSync(path.join(repo, 'version.txt'), text);
    git('add', 'version.txt');
    git('-c', 'user.name=假测试', '-c', 'user.email=test@example.invalid', 'commit', '-qm', text);
    return git('rev-parse', 'HEAD');
  };
  const from = commit('old'), to = commit('new');
  const pending = path.join(dataDir, 'update-prev.json');
  fs.writeFileSync(pending, JSON.stringify({ from, to, at: Date.now() }));
  let clock = 0, starts = 0, stopped = 0;
  const errors = [];
  const runtime = {
    root: repo, dataDir, healthTimeout: 30, exitTimeout: 20, now: () => clock, sleep: async (ms) => { clock += ms; },
    alive: async () => starts === 2,
    startServer() {
      starts++;
      if (starts === 2) {
        assert.equal(stopped, 1);
        assert.equal(fs.readFileSync(path.join(repo, 'version.txt'), 'utf8'), 'old');
        assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'update-rollback.json'), 'utf8')).to, to);
      }
      return { stop: async () => { stopped++; return true; } };
    },
    showError: (e) => errors.push(e),
  };
  assert.deepEqual(await restartServer(runtime), { ok: true, rolledBack: true });
  assert.equal(git('rev-parse', 'HEAD'), from);
  assert.equal(fs.existsSync(pending), false);
  assert.deepEqual(errors, []);
  // 普通成功启动不需要读取或重置仓库，只在健康检查成功后清标记。
  starts = 0;
  fs.writeFileSync(pending, JSON.stringify({ from, to }));
  const success = await restartServer({ ...runtime, alive: async () => starts > 0, startServer() { starts++; assert.equal(fs.existsSync(pending), true); return {}; } });
  assert.equal(success.ok, true);
  assert.equal(fs.existsSync(pending), false);
  assert.equal(git('rev-parse', 'HEAD'), from);
});
