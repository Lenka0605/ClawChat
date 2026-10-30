import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAWCHAT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-members-'));
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-codex-'));
const { Store } = await import('../lib/store.js');
const { Hub, parseMentions, splitReply, buildIntro } = await import('../lib/hub.js');
const { AGENTS, addExtraMember, removeExtraMember, cloneRoom } = await import('../lib/agents.js');

test('多开：再开一位 ChatGPT 就是 ChatGPT2，编号往后排，删了就没了', () => {
  const two = addExtraMember('gpt');
  assert.equal(two.id, 'gpt2');
  assert.equal(two.name, 'ChatGPT2');
  assert.equal(two.engine, 'codex');
  assert.equal(two.base, 'gpt');
  const three = addExtraMember('gpt');
  assert.equal(three.id, 'gpt3');
  removeExtraMember('gpt3');
  assert.equal(AGENTS.gpt3, undefined);
  assert.ok(AGENTS.gpt2);
  assert.throws(() => addExtraMember('nobody'));
});

test('多开：@ChatGPT2 只叫 2 号，@ChatGPT 只叫本体，<私聊 ChatGPT2> 发给 2 号', () => {
  if (!AGENTS.gpt2) addExtraMember('gpt');
  assert.deepEqual(parseMentions('@ChatGPT2 你来'), ['gpt2']);
  assert.deepEqual(parseMentions('@ChatGPT 你来'), ['gpt']);
  assert.deepEqual(parseMentions('@gpt2 和 @gpt'), ['gpt2', 'gpt']);
  assert.ok(parseMentions('@所有人').includes('gpt2'));
  assert.deepEqual(splitReply('<私聊 ChatGPT2>悄悄话</私聊>群里的话', false).pms, [{ to: 'gpt2', text: '悄悄话' }]);
});

test('多开：2 号知道自己是谁，跑起来用的是自己的模型设置', () => {
  if (!AGENTS.gpt2) addExtraMember('gpt');
  const room = { id: 'r', name: '群', cwd: os.tmpdir(), members: ['gpt', 'gpt2'], models: { gpt: 'gpt-a', gpt2: 'gpt-b' }, efforts: { gpt2: 'high' }, fast: { gpt: true } };
  const r = cloneRoom(room, 'gpt2');
  assert.equal(r.models.gpt, 'gpt-b');
  assert.equal(r.efforts.gpt, 'high');
  assert.equal(r.fast.gpt, false); // 本体开了快速模式，2 号没开
  assert.equal(cloneRoom(room, 'gpt'), room); // 本体不变
  assert.match(buildIntro(room, 'gpt2'), /ChatGPT2/);
  assert.match(buildIntro(room, 'gpt2'), /两个独立的成员/);
});

test('多开：本体和 2 号各有各的会话，@ 谁谁干活', async () => {
  if (!AGENTS.gpt2) addExtraMember('gpt');
  const store = new Store();
  const calls = [];
  const run = (agent, opts) => {
    calls.push({ agent, session: opts.session });
    return { done: Promise.resolve({ ok: true, text: `${agent} 做完了`, steps: [], session: `${agent}-session` }), kill() {} };
  };
  const hub = new Hub(store, { run });
  const room = store.createRoom({ name: 't', cwd: os.tmpdir(), members: ['gpt', 'gpt2'] });
  hub.postUserMessage(room.id, '@ChatGPT2 你先干');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls.map((c) => c.agent), ['gpt2']);
  hub.postUserMessage(room.id, '@ChatGPT 你也来');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.at(-1).agent, 'gpt');
  const st = store.getState(room.id);
  assert.equal(st.sessions.gpt2, 'gpt2-session');
  assert.equal(st.sessions.gpt, 'gpt-session');
});

// 可控的假 AI：每次调用都挂起，测试里手动结束；被停止时返回失败
function heldRunner() {
  const calls = [];
  const run = (agent, opts) => {
    let resolve;
    const done = new Promise((r) => (resolve = r));
    calls.push({ agent, side: !!opts.side, session: opts.session, prompt: opts.prompt, finish: (text) => resolve({ ok: true, text, steps: [], session: `${agent}-s` }) });
    return { done, kill: () => resolve({ ok: false, error: 'killed', steps: [], session: null }) };
  };
  return { run, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test('多开：正在干活的 ChatGPT2 被删掉，不抛异常；再开一个 2 号是全新的，不接回旧记忆', async () => {
  if (!AGENTS.gpt2) addExtraMember('gpt');
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = store.createRoom({ name: 't', cwd: os.tmpdir(), members: ['gpt', 'gpt2'] });
  // 先让 2 号有一个会话
  hub.postUserMessage(room.id, '@ChatGPT2 你好');
  await tick();
  calls.at(-1).finish('你好');
  await tick();
  assert.equal(store.getState(room.id).sessions.gpt2, 'gpt2-s');
  // 2 号正在干活时删掉它（跟服务端的删除接口一样：先 forgetMember，再从成员表里拿掉）
  hub.postUserMessage(room.id, '@ChatGPT2 干一件很久的活');
  await tick();
  const running = calls.at(-1);
  assert.equal(running.agent, 'gpt2');
  const errors = [];
  const onErr = (e) => errors.push(e);
  process.on('unhandledRejection', onErr);
  hub.forgetMember('gpt2');
  removeExtraMember('gpt2');
  running.finish('做完了'); // 被停掉之后才结束也不能出错
  await tick();
  await tick();
  process.off('unhandledRejection', onErr);
  assert.deepEqual(errors, []);
  assert.deepEqual(store.getRoom(room.id).members, ['gpt']);
  const st = store.getState(room.id);
  assert.equal(st.sessions.gpt2, undefined);
  assert.equal(st.cursors.gpt2, undefined);
  assert.ok(store.getMessages(room.id).some((m) => m.from === 'gpt2')); // 聊天记录还在
  // 再开一个 2 号、拉回群里：是全新的会话
  addExtraMember('gpt');
  store.updateRoom(room.id, { members: ['gpt', 'gpt2'] });
  hub.postUserMessage(room.id, '@ChatGPT2 你是谁');
  await tick();
  assert.equal(calls.at(-1).agent, 'gpt2');
  assert.equal(calls.at(-1).session, null);
  calls.at(-1).finish('我是新来的');
  await tick();
});
