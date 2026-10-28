import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAWCHAT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-test-'));
const { Store } = await import('../lib/store.js');
const { Hub, parseMentions, isPass, buildTurn, splitReply } = await import('../lib/hub.js');
const { unwrapShell } = await import('../lib/agents.js');

test('parseMentions 识别点名', () => {
  assert.deepEqual(parseMentions('@Claude 你来'), ['claude']);
  assert.deepEqual(parseMentions('@gpt 和 @claude'), ['gpt', 'claude']);
  assert.deepEqual(parseMentions('@所有人 看一下'), ['claude', 'gpt']);
  assert.deepEqual(parseMentions('@Codex 写页面'), ['gpt']);
  assert.deepEqual(parseMentions('邮箱 me@gpt.com 不算'), []);
  assert.deepEqual(parseMentions('代码里的 `@claude` 不算'), []);
  assert.deepEqual(parseMentions('```\n@gpt\n```'), []);
});

test('isPass', () => {
  assert.ok(isPass('[PASS]'));
  assert.ok(isPass(' pass '));
  assert.ok(!isPass('PASS 了测试'));
});

test('unwrapShell 去掉 zsh -lc 外壳', () => {
  assert.equal(unwrapShell(`/bin/zsh -lc "sed -n '1p' a.txt"`), "sed -n '1p' a.txt");
  assert.equal(unwrapShell('/bin/zsh -lc \'echo "hi"\''), 'echo "hi"');
  assert.equal(unwrapShell('ls -la'), 'ls -la');
});

test('buildTurn 标注发言人，图片按顺序编号', () => {
  const room = { name: 'r', members: ['claude', 'gpt'] };
  const { prompt: p, images } = buildTurn(room, 'gpt', [
    { from: 'user', text: '开工', ts: 0, images: [{ id: 'a.png', type: 'image/png' }] },
    { from: 'claude', text: '@GPT 写页面', ts: 0 },
    { from: 'gpt', text: '好', ts: 0 },
    { from: 'user', text: '', ts: 0, images: [{ id: 'b.jpg', type: 'image/jpeg' }] },
  ], false, '/up');
  assert.match(p, /老板\] 开工 〔图 #1〕/);
  assert.match(p, /Claude\] @GPT 写页面/);
  assert.match(p, /你（GPT）\] 好/);
  assert.match(p, /老板\] 〔图 #2〕/);
  assert.match(p, /@Claude/);
  assert.deepEqual(images.map((i) => [i.n, i.path, i.type]), [[1, '/up/a.png', 'image/png'], [2, '/up/b.jpg', 'image/jpeg']]);
});

test('splitReply 拆出私聊和群聊', () => {
  assert.deepEqual(splitReply('好的。<私聊老板>我觉得 Claude 的方案有问题</私聊老板>', false), { group: '好的。', dm: '我觉得 Claude 的方案有问题' });
  assert.deepEqual(splitReply('<私聊老板>只跟你说', false), { group: '', dm: '只跟你说' });
  assert.deepEqual(splitReply('收到老板。<群聊>@Claude 按你的方案来</群聊>', true), { group: '@Claude 按你的方案来', dm: '收到老板。' });
  assert.deepEqual(splitReply('普通回复', false), { group: '普通回复', dm: '' });
});

// 假的 AI：按脚本回复，记录每次收到的消息
function fakeRunner(script) {
  const calls = [];
  const run = (agent, opts) => {
    calls.push({ agent, prompt: opts.prompt, session: opts.session, images: opts.images });
    const reply = script(agent, opts.prompt, calls.length);
    return { done: new Promise((r) => setTimeout(() => r({ ok: true, text: reply, steps: [], session: `${agent}-session` }), 5)), kill() {} };
  };
  return { run, calls };
}

function settle(hub) {
  return new Promise((resolve) => {
    const check = () => (hub.runs.size === 0 ? setTimeout(() => (hub.runs.size === 0 ? resolve() : check()), 30) : setTimeout(check, 10));
    check();
  });
}

function newRoom(store, extra = {}) {
  return store.createRoom({ name: 't', cwd: os.tmpdir(), ...extra });
}

// 可控的假 AI：每次调用都挂起，测试里手动结束；被停止时返回失败
function heldRunner() {
  const calls = [];
  const run = (agent, opts) => {
    let resolve;
    const done = new Promise((r) => (resolve = r));
    const call = { agent, prompt: opts.prompt, finish: (text) => resolve({ ok: true, text, steps: [], session: `${agent}-s` }) };
    calls.push(call);
    return { done, kill: () => resolve({ ok: false, error: 'killed', steps: [], session: null }) };
  };
  return { run, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test('不 @ 时两位同时开工，并且知道对方也在干', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '你俩看看这个文件夹');
  await tick();
  assert.deepEqual(calls.map((c) => c.agent).sort(), ['claude', 'gpt']); // 两位都已经开始，谁也没等谁
  assert.match(calls.find((c) => c.agent === 'claude').prompt, /同时发给了你和 GPT/);
  assert.match(calls.find((c) => c.agent === 'gpt').prompt, /同时发给了你和 Claude/);
  calls.forEach((c) => c.finish(`${c.agent} 看完了`));
  await settle(hub);
  assert.equal(store.getMessages(room.id).filter((m) => m.from !== 'user' && m.from !== 'system').length, 2);
});

test('停止可以只停一位：停 Claude，GPT 照常干完', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '@所有人 开工');
  await tick();
  hub.stop(room.id, 'claude');
  await tick();
  assert.equal(hub.runs.size, 1);
  assert.ok(hub.runs.has(hub.key(room.id, 'gpt')));
  calls.find((c) => c.agent === 'gpt').finish('我干完了');
  await settle(hub);
  const texts = store.getMessages(room.id).map((m) => m.text);
  assert.ok(texts.includes('已停止 Claude'));
  assert.ok(texts.includes('我干完了'));
});

test('依次模式：停掉前一位，后一位照样开工；全部停止则都不再开工', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store, { defaultTarget: 'sequential' });
  hub.postUserMessage(room.id, '开工');
  await tick();
  assert.deepEqual(calls.map((c) => c.agent), ['claude']);
  hub.stop(room.id, 'claude');
  await tick();
  assert.deepEqual(calls.map((c) => c.agent), ['claude', 'gpt']);
  hub.stop(room.id); // 全部停止
  await settle(hub);
  hub.postUserMessage(room.id, '再来');
  await tick();
  assert.equal(calls.length, 3); // 只有新消息的第一位开工
  hub.stop(room.id);
  await settle(hub);
});

test('依次模式：两位依次回答，后答的能看到前一位的话', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent) => (agent === 'claude' ? '我来当组长' : '收到'));
  const hub = new Hub(store, { run });
  const room = newRoom(store, { defaultTarget: 'sequential' });
  hub.postUserMessage(room.id, '你们俩商量一下');
  await settle(hub);
  assert.deepEqual(calls.map((c) => c.agent), ['claude', 'gpt']);
  assert.match(calls[1].prompt, /Claude\] 我来当组长/);
  assert.deepEqual(store.getMessages(room.id).map((m) => m.from), ['user', 'claude', 'gpt']);
});

test('@ 谁就只叫谁；[PASS] 不显示', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner(() => '[PASS]');
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '@GPT 在吗');
  await settle(hub);
  assert.deepEqual(calls.map((c) => c.agent), ['gpt']);
  assert.deepEqual(store.getMessages(room.id).map((m) => m.from), ['user']);
});

test('互相 @ 接力，到上限自动暂停', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent) => (agent === 'claude' ? '@GPT 再改一版' : '@Claude 改好了'));
  const hub = new Hub(store, { run });
  const room = newRoom(store, { maxAutoTurns: 3 });
  hub.postUserMessage(room.id, '@Claude 开始');
  await settle(hub);
  assert.equal(calls.length, 4); // 老板叫 1 次 + 自动接力 3 次
  const last = store.getMessages(room.id).at(-1);
  assert.equal(last.from, 'system');
  assert.match(last.text, /先停一下/);
});

test('关闭协作后不会互相叫醒；会话 id 会续上', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner(() => '@GPT 你看看');
  const hub = new Hub(store, { run });
  const room = newRoom(store, { collab: false });
  hub.postUserMessage(room.id, '@Claude 第一句');
  await settle(hub);
  hub.postUserMessage(room.id, '@Claude 第二句');
  await settle(hub);
  assert.deepEqual(calls.map((c) => c.agent), ['claude', 'claude']);
  assert.equal(calls[0].session, null);
  assert.equal(calls[1].session, 'claude-session');
  assert.match(calls[1].prompt, /第二句/);
  assert.doesNotMatch(calls[1].prompt, /第一句/); // 续上会话后只发新消息
});

test('GPT 在群里私下找老板：私聊部分另一位看不到，也不会叫醒它', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent, prompt) => {
    if (agent === 'claude') return '@GPT 把整个页面重写成 jQuery';
    return '收到，我先看看。<私聊老板>老板，用 jQuery 重写没必要，现在的代码挺好，要不要拦一下？</私聊老板>';
  });
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '@Claude 你安排一下');
  await settle(hub);
  const msgs = store.getMessages(room.id);
  const dm = msgs.find((m) => m.dm === 'gpt');
  assert.equal(dm.from, 'gpt');
  assert.match(dm.text, /没必要/);
  assert.ok(msgs.some((m) => m.from === 'gpt' && !m.dm && m.text === '收到，我先看看。'));
  assert.equal(store.getRoom(room.id).dmLast.gpt.from, 'gpt');

  // 老板私聊回复 GPT：只叫醒 GPT，它这一轮是私聊模式；Claude 之后也看不到这段私聊
  hub.postUserMessage(room.id, '你说得对，按你的来', [], 'gpt');
  await settle(hub);
  const last = calls.at(-1);
  assert.equal(last.agent, 'gpt');
  assert.match(last.prompt, /老板（私聊你）\] 你说得对/);
  assert.match(last.prompt, /只有老板能看到/);
  assert.equal(store.getMessages(room.id).at(-1).dm, 'gpt'); // 回复也进私聊

  hub.postUserMessage(room.id, '@Claude 进度如何');
  await settle(hub);
  const claudeLast = calls.filter((c) => c.agent === 'claude').at(-1);
  assert.doesNotMatch(claudeLast.prompt, /没必要|你说得对/);
});

test('干活时退出：重新打开后提醒一次，下一轮把没做完的消息再交给它', async () => {
  const store = new Store();
  const calls = [];
  // 第一轮一直不结束，直到被结束进程
  const hangRun = (agent, opts) => {
    calls.push({ agent, prompt: opts.prompt });
    let resolve;
    const done = new Promise((r) => (resolve = r));
    return { done, kill: () => resolve({ ok: false, error: 'killed', steps: [], session: 's1' }) };
  };
  const hub = new Hub(store, { run: hangRun });
  const room = newRoom(store, { members: ['claude'] });
  hub.postUserMessage(room.id, '写个登录页');
  await new Promise((r) => setTimeout(r, 20));
  hub.shutdown();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getMessages(room.id).filter((m) => m.from === 'system' && /已停止/.test(m.text)).length, 0);

  // 模拟重新打开：新的 Store 从磁盘读
  const store2 = new Store();
  const { run, calls: calls2 } = fakeRunner(() => '登录页写好了');
  const hub2 = new Hub(store2, { run });
  hub2.noticeInterrupted();
  hub2.noticeInterrupted();
  assert.equal(store2.getMessages(room.id).filter((m) => /被打断/.test(m.text)).length, 1);
  hub2.postUserMessage(room.id, '继续');
  await settle(hub2);
  assert.match(calls2[0].prompt, /被打断/);
  assert.match(calls2[0].prompt, /写个登录页/);
  assert.match(calls2[0].prompt, /继续/);
  assert.equal(store2.getMessages(room.id).at(-1).text, '登录页写好了');
});

test('出错的一轮：不保存会话，下次叫到时把没处理的消息重新给它', async () => {
  const store = new Store();
  let fail = true;
  const calls = [];
  const run = (agent, opts) => {
    calls.push({ prompt: opts.prompt, session: opts.session });
    const res = fail ? { ok: false, error: 'model not supported', steps: [], session: 'bad' } : { ok: true, text: '在的', steps: [], session: 'good' };
    return { done: Promise.resolve(res), kill() {} };
  };
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['gpt'] });
  hub.postUserMessage(room.id, '在吗');
  await settle(hub);
  assert.match(store.getMessages(room.id).at(-1).text, /出错了.*模型/);
  assert.equal(store.getState(room.id).sessions.gpt, undefined);
  fail = false;
  hub.postUserMessage(room.id, '现在呢');
  await settle(hub);
  assert.equal(calls[1].session, null);
  assert.match(calls[1].prompt, /在吗/);
  assert.match(calls[1].prompt, /现在呢/);
  assert.equal(store.getState(room.id).sessions.gpt, 'good');
});

test('回复上记下这一轮实际用的模型（群聊和私聊两条都记）', async () => {
  const store = new Store();
  const run = (agent) => ({
    done: Promise.resolve({ ok: true, text: '群里说一句<私聊老板>私下说一句</私聊老板>', steps: [], session: 's', model: 'gpt-6-astra' }),
    kill() {},
  });
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '@GPT 你好');
  await settle(hub);
  const replies = store.getMessages(room.id).filter((m) => m.from === 'gpt');
  assert.equal(replies.length, 2);
  assert.ok(replies.every((m) => m.model === 'gpt-6-astra'));
});

test('回复 GPT 的消息：只有 GPT 回答，而且知道是在回它哪句话；回复时 @ 了别人就按 @ 的来', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent) => `${agent} 收到`);
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '你俩各说一句');
  await settle(hub);
  const gptMsg = store.getMessages(room.id).find((m) => m.from === 'gpt');
  const before = calls.length;
  hub.postUserMessage(room.id, '展开说说', [], null, { seq: gptMsg.seq, from: 'gpt', text: gptMsg.text });
  await settle(hub);
  assert.deepEqual(calls.slice(before).map((c) => c.agent), ['gpt']); // Claude 没被叫醒
  assert.match(calls.at(-1).prompt, /老板，回复你的「gpt 收到」\] 展开说说/);
  assert.equal(store.getMessages(room.id).find((m) => m.text === '展开说说').replyTo.from, 'gpt');

  const mid = calls.length;
  hub.postUserMessage(room.id, '@Claude 你怎么看', [], null, { seq: gptMsg.seq, from: 'gpt', text: gptMsg.text });
  await settle(hub);
  assert.deepEqual(calls.slice(mid).map((c) => c.agent), ['claude']);
  assert.match(calls.at(-1).prompt, /回复GPT的「gpt 收到」/);
});

test('单聊：没有 @ 规则，消息只发给这一位', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner(() => '好的');
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude'] });
  hub.postUserMessage(room.id, '@GPT 在吗', [{ id: 'x.png', type: 'image/png' }]);
  await settle(hub);
  assert.deepEqual(calls.map((c) => c.agent), ['claude']);
  assert.equal(calls[0].images.length, 1);
  assert.doesNotMatch(calls[0].prompt, /私聊老板/);
});
