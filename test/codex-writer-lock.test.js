import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-codex-writer-'));
process.env.CLAWCHAT_HOME = path.join(root, 'data');
process.env.CODEX_HOME = path.join(root, 'codex');
const { runCodexServer, storedCodexUsage } = await import('../lib/codex.js');
const { Store } = await import('../lib/store.js');
const { Hub } = await import('../lib/hub.js');
const { setLang } = await import('../lib/i18n.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, '等待假写锁场景超时');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

// 全部协议响应在内存里生成，不启动真 CLI、账号或模型。持久会话表用来验证 fork 和后续 resume。
function backend(options = {}) {
  const threads = new Map([['source-thread', { model: 'saved-model', effort: 'high', rules: '原会话群规', history: ['很早以前的完整历史'] }]]);
  const requests = [];
  let serial = 0;
  const source = structuredClone(threads.get('source-thread'));
  const runtime = {
    bin: '假 Codex', args: [], model: 'chosen-model', effort: 'low', unwrapShell: (s) => s,
    requestTimeout: 1000, loadUsage: async () => ({ images: 12, used: 100, window: 65536 }),
    spawnJsonl(_bin, _args, { onEvent }) {
      let finish;
      let closed = false;
      const done = new Promise((resolve) => { finish = resolve; });
      const end = () => { if (!closed) { closed = true; finish({ code: 0, stderr: '' }); } };
      return {
        done, end, kill: end,
        write(line) {
          if (closed) return false;
          const m = JSON.parse(line);
          requests.push(m);
          queueMicrotask(() => {
            if (closed || !m.method || m.method === 'initialized' || options.hold === m.method) return;
            const reply = (result) => onEvent({ id: m.id, result });
            const fail = (message) => onEvent({ id: m.id, error: { code: -32602, message } });
            const p = m.params || {};
            if (m.method === 'initialize') return reply({});
            if (m.method === 'thread/resume') {
              if (options.resumeError) return fail(options.resumeError);
              if (p.threadId === 'source-thread' && options.locked !== false) return fail('thread source-thread already has an active writer');
              if (options.badResume) return reply({ thread: { id: 'wrong-thread' } });
              const saved = threads.get(p.threadId);
              return reply({ thread: { id: p.threadId }, model: p.model || saved.model, reasoningEffort: saved.effort });
            }
            if (m.method === 'thread/read') {
              if (options.readError) return fail(options.readError);
              const saved = threads.get(p.threadId);
              return reply({ thread: { id: p.threadId, model: saved.model, reasoningEffort: saved.effort } });
            }
            if (m.method === 'thread/fork') {
              if (options.forkError) return fail(options.forkError);
              if (options.badFork) return reply({ thread: options.badFork });
              const saved = structuredClone(threads.get(p.threadId));
              const id = `fork-${++serial}`;
              saved.model = p.model || 'default-model';
              saved.effort = p.config?.model_reasoning_effort || 'medium';
              threads.set(id, saved);
              return reply({ thread: { id, forkedFromId: p.threadId }, model: saved.model, reasoningEffort: saved.effort });
            }
            if (m.method === 'turn/start') {
              if (options.turnError) return fail(options.turnError);
              const saved = threads.get(p.threadId);
              saved.history.push(p.input[0].text);
              reply({ turn: { id: 'fake-turn' } });
              onEvent({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: 'fake-turn' } } });
              onEvent({ method: 'item/completed', params: { threadId: p.threadId, turnId: 'fake-turn', item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: '假 ChatGPT 完成' } } });
              return onEvent({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: 'fake-turn', status: 'completed' } } });
            }
            fail('unknown fake method');
          });
          return true;
        },
      };
    },
  };
  const room = { cwd: root, permission: 'project', models: { gpt: 'chosen-model' }, efforts: { gpt: 'low' }, fast: { gpt: false } };
  return {
    threads, source, requests, runtime, room,
    start(opts = {}) { return runCodexServer({ room, prompt: '本轮要求', session: 'source-thread', systemPrompt: '这一轮不能覆盖旧群规', ...opts }, runtime); },
  };
}

test('Codex 写锁：只在 resume 被拒后 fork 一次，保留历史和群规，后续精确续接新编号', async () => {
  const b = backend();
  const res = await b.start().done;
  assert.equal(res.ok, true, res.error);
  assert.equal(res.session, 'fork-1');
  assert.equal(res.model, 'chosen-model');
  assert.equal(res.effort, 'low');
  assert.match(res.warning, /保留历史/);
  const fork = b.requests.find((m) => m.method === 'thread/fork').params;
  assert.equal(fork.threadId, 'source-thread');
  assert.equal(fork.ephemeral, false);
  assert.equal(fork.excludeTurns, true);
  assert.equal('developerInstructions' in fork, false);
  assert.equal(fork.config.model_reasoning_effort, 'low');
  assert.equal(fork.config['features.fast_mode'], false);
  assert.equal(fork.sandbox, 'workspace-write');
  assert.equal(fork.approvalPolicy, 'never');
  assert.deepEqual(b.threads.get('source-thread'), b.source, '不能向桌面端原会话写入');
  assert.equal(b.threads.get(res.session).rules, '原会话群规');
  assert.deepEqual(b.threads.get(res.session).history, ['很早以前的完整历史', '本轮要求']);
  assert.deepEqual(storedCodexUsage(res.session), { images: 12, used: 100, window: 65536 });
  const next = await b.start({ session: res.session }).done;
  assert.equal(next.ok, true);
  assert.equal(next.session, res.session);
  assert.equal(next.warning, undefined);
  assert.equal(b.requests.filter((m) => m.method === 'thread/fork').length, 1);
  assert.equal(b.requests.filter((m) => m.method === 'turn/start').length, 2);
});

test('Codex 写锁：未明确选择模型和思考档时，只读元数据并恢复原设置，不用当前群规覆盖历史', async () => {
  const b = backend();
  b.runtime.model = '';
  b.runtime.effort = '';
  const result = await b.start().done;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.model, 'saved-model');
  assert.equal(result.effort, 'high');
  const read = b.requests.find((m) => m.method === 'thread/read').params;
  assert.deepEqual(read, { threadId: 'source-thread', includeTurns: false });
  const fork = b.requests.find((m) => m.method === 'thread/fork').params;
  assert.equal(fork.model, 'saved-model');
  assert.equal(fork.config.model_reasoning_effort, 'high');
  assert.equal(b.threads.get(result.session).rules, b.source.rules);
});

test('Codex 写锁：普通错误、异常 resume 编号和分身失败不能触发本体恢复', async () => {
  for (const options of [{ resumeError: 'permission denied' }, { locked: false, badResume: true }]) {
    const b = backend(options);
    const result = await b.start().done;
    assert.equal(result.ok, false);
    assert.equal(b.requests.some((m) => m.method === 'thread/fork'), false);
    assert.equal(b.requests.some((m) => m.method === 'turn/start'), false);
    if (options.badResume) assert.equal(result.sessionMismatch, true);
  }
  const b = backend({ forkError: 'already has an active writer' });
  const result = await b.start({ side: true }).done;
  assert.equal(result.ok, false);
  assert.equal(b.requests.filter((m) => m.method === 'thread/fork').length, 1, '分身原本就在 fork，失败不能套本体的重试');
  assert.equal(b.requests.some((m) => m.method === 'thread/resume'), false);
});

test('Codex 写锁：fork 失败或回合阶段冲突只报可读错误，不无限分叉或重做工具', async () => {
  try {
    for (const lang of ['zh', 'en']) {
      setLang(lang);
      for (const forkError of ['already has an active writer', 'fork method unavailable']) {
        const b = backend({ forkError });
        const result = await b.start().done;
        assert.equal(result.ok, false);
        assert.equal(result.session, 'source-thread');
        assert.equal(result.sessionMismatch, undefined);
        assert.match(result.error, lang === 'zh' ? /桌面 App/ : /desktop app/);
        if (lang === 'en') assert.doesNotMatch(result.error, /[一-鿿]/);
        assert.equal(b.requests.filter((m) => m.method === 'thread/fork').length, 1);
        assert.equal(b.requests.some((m) => m.method === 'turn/start'), false);
      }
    }
  } finally { setLang('zh'); }
  const b = backend({ locked: false, turnError: 'already has an active writer' });
  const result = await b.start().done;
  assert.equal(result.ok, false);
  assert.match(result.error, /换新会话/);
  assert.equal(b.requests.some((m) => m.method === 'thread/fork'), false);
  assert.equal(b.requests.filter((m) => m.method === 'turn/start').length, 1);
  const later = backend({ turnError: '上下文已满 (contextWindowExceeded)' });
  const laterResult = await later.start().done;
  assert.equal(laterResult.ok, false);
  assert.match(laterResult.error, /contextWindowExceeded/, '恢复成功后的真实回合错误不能被占用提示覆盖');
});

test('Codex 写锁：分叉编号回给原会话或错误来源时停止，元数据失败也不猜着续', async () => {
  for (const badFork of [{ id: 'source-thread' }, { id: 'foreign-thread', forkedFromId: 'unrelated-thread' }]) {
    const b = backend({ badFork });
    const result = await b.start().done;
    assert.equal(result.ok, false);
    assert.equal(result.session, 'source-thread');
    assert.equal(result.sessionMismatch, undefined, '不能让 hub 自动清空仍可恢复的原会话');
    assert.equal(b.requests.some((m) => m.method === 'turn/start'), false);
  }
  const b = backend({ readError: 'metadata unavailable' });
  b.runtime.effort = '';
  const result = await b.start().done;
  assert.equal(result.ok, false);
  assert.equal(b.requests.some((m) => m.method === 'thread/fork'), false);
});

test('Codex 写锁：恢复中按停止，不再开始回合或保存新的会话', async () => {
  const b = backend({ hold: 'thread/fork' });
  const handle = b.start();
  await until(() => b.requests.some((m) => m.method === 'thread/fork'));
  await handle.kill();
  const result = await handle.done;
  assert.equal(result.ok, false);
  assert.equal(result.session, 'source-thread');
  assert.equal(b.requests.some((m) => m.method === 'turn/start'), false);
});

test('Codex 写锁经 Hub：成功后持久化新编号、重启续聊；失败保留原编号和未读消息', async () => {
  for (const fails of [false, true]) {
    const b = backend(fails ? { forkError: 'already has an active writer' } : {});
    const store = new Store();
    const room = store.createRoom({ name: '假写锁恢复', cwd: root, members: ['gpt'], collab: false });
    store.getState(room.id).sessions.gpt = 'source-thread';
    store.saveState(room.id);
    const previousCursor = store.getState(room.id).cursors.gpt ?? -1;
    const run = (_agent, opts) => runCodexServer(opts, b.runtime);
    const hub = new Hub(store, { run, imageBytes: async () => 0 });
    hub.postUserMessage(room.id, '写锁恢复第一条');
    await until(() => !hub.runs.size);
    if (fails) {
      assert.equal(store.getState(room.id).sessions.gpt, 'source-thread');
      assert.equal(store.getState(room.id).cursors.gpt ?? -1, previousCursor);
      assert.equal(store.getMessages(room.id).filter((m) => m.from === 'gpt').length, 0);
    } else {
      const saved = new Store();
      assert.equal(saved.getState(room.id).sessions.gpt, 'fork-1');
      const nextHub = new Hub(saved, { run, imageBytes: async () => 0 });
      nextHub.postUserMessage(room.id, '重启后第二条');
      await until(() => !nextHub.runs.size);
      assert.equal(saved.getState(room.id).sessions.gpt, 'fork-1');
      assert.equal(b.requests.filter((m) => m.method === 'thread/fork').length, 1);
      assert.equal(saved.getMessages(room.id).filter((m) => m.from === 'gpt').length, 2);
    }
    assert.deepEqual(b.threads.get('source-thread'), b.source);
  }
});
