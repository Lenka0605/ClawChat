// 联合群主持方：安全复核（ChatGPT，e858080）查出来的几处，各留一条回归
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-joint-host-'));
process.env.CLAWCHAT_HOME = home;
const { Store } = await import('../lib/store.js');
const { Hub } = await import('../lib/hub.js');
const { JointHost, publicPart } = await import('../lib/joint.js');

function setup() {
  const store = new Store();
  let clock = Date.now();
  const hub = new Hub(store, { run: () => ({ done: new Promise(() => {}), kill: async () => true }) });
  const host = new JointHost(store, hub, { now: () => clock });
  const room = host.createRoom({ name: '测', members: ['claude'], ownerName: 'Lenka', cwd: home });
  const { code } = host.invite(room.id, 'https://x.ts.net');
  const secret = JSON.parse(Buffer.from(code.slice(14), 'base64url').toString()).secret;
  const { pairId } = host.pairRequest('b@test', { secret, nodeId: 'aaaaaaaaaaaa', ownerName: '小王', agents: [{ id: 'claude', name: 'Claude', engine: 'claude' }], protocol: 1 });
  host.decide(pairId, true);
  const peer = host.data.peers[room.id];
  return { store, hub, host, room: store.getRoom(room.id), peer, tick: (ms) => (clock += ms) };
}

test('公开出口剥掉 <私聊老板> 和 <私聊 某位>：私下的话不离开本机', () => {
  assert.equal(publicPart('公开<私聊老板>秘密</私聊老板>部分'), '公开部分');
  assert.equal(publicPart('公开<私聊 Claude>悄悄</私聊>'), '公开');
  assert.equal(publicPart('公开<私聊老板>没写结束标签的秘密'), '公开');
  const { host, room, store } = setup();
  const m = store.appendMessage(room.id, { from: 'claude', text: '大家好<私聊老板>FAKE_SECRET</私聊老板>' });
  assert.ok(!JSON.stringify(host.publicMessage(room, m)).includes('FAKE_SECRET'));
});

test('联合群只有一位本机 AI 时，回复里的 <私聊老板> 也要拆出去，不进公开记录', () => {
  const store = new Store();
  const hub = new Hub(store, { run: () => ({ done: new Promise(() => {}), kill: async () => true }) });
  const host = new JointHost(store, hub);
  const room = host.createRoom({ name: '单人', members: ['claude'], ownerName: 'Lenka', cwd: home });
  hub.deliver(room.id, 'claude', '公开的话<私聊老板>FAKE_BEFORE_PAIR</私聊老板>', false, {});
  const msgs = store.getMessages(room.id);
  const pub = msgs.filter((m) => !m.dm).map((m) => m.text).join('\n');
  assert.ok(!pub.includes('FAKE_BEFORE_PAIR'), '公开消息里不能有私聊内容');
  assert.ok(msgs.some((m) => m.dm === 'claude' && m.text.includes('FAKE_BEFORE_PAIR')), '私聊部分照常给老板');
});

test('租约按实际时间核对：过了 90 秒、定时器还没跑，结果和心跳都不收', async () => {
  const { host, room, peer, tick } = setup();
  const key = room.members.find((a) => a.includes('_'));
  const handle = host.run(key, { room, messages: [] });
  const { job } = await host.claim(room, peer, 0);
  tick(91 * 1000);
  assert.throws(() => host.result(room, peer, job.jobId, { ok: true, text: '晚到', lease: job.lease }), (e) => e.status === 410);
  assert.deepEqual(host.heartbeat(room, peer, job.jobId, { lease: job.lease }), { cancelled: true }, '已经关掉的任务，心跳只会叫对方停');
  const res = await handle.done;
  assert.equal(res.ok, false);
});

test('撤权后，之前挂着的长轮询不能再领到任务（同一节点重新配对也不行）', async () => {
  const { host, room, peer } = setup();
  const waiting = host.claim(room, peer, 5000);
  host.removePeer(room.id);
  await assert.rejects(waiting, (e) => e.status === 404);
  // 同一节点重新配对拿到新授权：旧的 peer 对象照样被拒
  const { code } = host.invite(room.id, 'https://x.ts.net');
  const secret = JSON.parse(Buffer.from(code.slice(14), 'base64url').toString()).secret;
  const { pairId } = host.pairRequest('b@test', { secret, nodeId: 'aaaaaaaaaaaa', ownerName: '小王', agents: [{ id: 'claude', name: 'Claude', engine: 'claude' }], protocol: 1 });
  host.decide(pairId, true);
  const fresh = host.store.getRoom(room.id);
  host.run(fresh.members.find((a) => a.includes('_')), { room: fresh, messages: [] });
  assert.throws(() => host.still(fresh, peer), (e) => e.status === 404);
  const { job } = await host.claim(fresh, host.data.peers[room.id], 0);
  assert.ok(job, '新授权照常能领');
});

test('邀请码只能用一次；令牌只发一次，必须带邀请秘密和同一个账号', () => {
  const { host } = setup();
  const room = host.createRoom({ name: '另一个', members: ['claude'], ownerName: 'Lenka', cwd: home });
  const { code } = host.invite(room.id, 'https://x.ts.net');
  const secret = JSON.parse(Buffer.from(code.slice(14), 'base64url').toString()).secret;
  const body = { secret, nodeId: 'bbbbbbbbbbbb', ownerName: '老李', agents: [{ id: 'gpt', name: 'ChatGPT', engine: 'codex' }], protocol: 1 };
  const { pairId } = host.pairRequest('c@test', body);
  assert.throws(() => host.pairRequest('c@test', body), (e) => e.status === 410, '同一个邀请码不能用第二次');
  assert.throws(() => host.pairStatus('other@test', pairId, secret), (e) => e.status === 404, '换个账号领不到');
  assert.throws(() => host.pairStatus('c@test', pairId, 'x'.repeat(43)), (e) => e.status === 404, '没有邀请秘密领不到');
  assert.equal(host.pairStatus('c@test', pairId, secret).status, 202, '还没同意时只说在等');
  host.decide(pairId, true);
  assert.ok(host.pairStatus('c@test', pairId, secret).body.token, '同意后领到令牌');
  assert.throws(() => host.pairStatus('c@test', pairId, secret), (e) => e.status === 404, '令牌只发一次');
  assert.throws(() => host.invite(room.id, 'https://x.ts.net'), (e) => e.status === 400, '已经有同事加入时不能再邀请');
});

test('对方慢慢传正文、这边中途撤了权：正文补齐以后照样拒绝，不发消息', async () => {
  const { setupJoint } = await import('../lib/joint-server.js');
  const store = new Store();
  const posted = [];
  const hub = new Hub(store, { run: () => ({ done: new Promise(() => {}), kill: async () => true }) });
  hub.postPeerMessage = (...a) => posted.push(a);
  const j = setupJoint({ store, hub, runAgent: () => {}, port: 1, appVersion: 't', publicHost: () => 'https://x.ts.net' });
  try {
    const room = j.host.createRoom({ name: '慢', members: ['claude'], ownerName: 'Lenka', cwd: home });
    const { code } = j.host.invite(room.id, 'https://x.ts.net');
    const secret = JSON.parse(Buffer.from(code.slice(14), 'base64url').toString()).secret;
    const { pairId } = j.host.pairRequest('b@test', { secret, nodeId: 'cccccccccccc', ownerName: '小王', agents: [{ id: 'claude', name: 'Claude', engine: 'claude' }], protocol: 1 });
    j.host.decide(pairId, true);
    const { body } = j.host.pairStatus('b@test', pairId, secret);
    let release;
    const slowBody = () => new Promise((r) => (release = () => r({ clientId: 'c1', text: '迟到的消息' })));
    const out = {};
    const send = (res, status, data) => Object.assign(out, { status, data });
    const req = { method: 'POST', headers: { authorization: `Bearer ${body.token}` } };
    const url = new URL(`http://x/joint/v1/rooms/${room.id}/messages`);
    const pending = j.peer(req, {}, url, 'b@test', { send, readBody: slowBody });
    await new Promise((r) => setImmediate(r));
    j.host.removePeer(room.id); // 正文还没传完，这边撤权
    release();
    await pending;
    assert.equal(out.status, 404);
    assert.equal(posted.length, 0, '撤权以后补齐的消息不能发出去');
  } finally {
    j.close();
  }
});

test('嵌套的私聊标签：外层私聊的尾巴不能漏进公开记录（主持方 Hub 和公开出口都按层数拆）', () => {
  const nested = '公开A<私聊老板>私1<私聊 Claude>私2</私聊>FAKE_TAIL</私聊老板>公开B';
  assert.equal(publicPart(nested), '公开A公开B');
  const store = new Store();
  const hub = new Hub(store, { run: () => ({ done: new Promise(() => {}), kill: async () => true }) });
  const host = new JointHost(store, hub);
  const room = host.createRoom({ name: '嵌套', members: ['claude'], ownerName: 'Lenka', cwd: home });
  hub.deliver(room.id, 'claude', nested, false, {});
  const pub = store.getMessages(room.id).filter((m) => !m.dm);
  assert.ok(!pub.some((m) => /FAKE_TAIL|私1|私2/.test(m.text)), '公开消息里不能有私聊内容');
  assert.ok(pub.some((m) => m.text.includes('公开A') && m.text.includes('公开B')));
  for (const m of pub) assert.ok(!JSON.stringify(host.publicMessage(store.getRoom(room.id), m)).includes('FAKE_TAIL'));
});

test('联合群没有私聊接力：私聊里 @ 同事不会私下叫它；被私下找来的回合，回复也不会公开到群里', () => {
  const store = new Store();
  const hub = new Hub(store, { run: () => ({ done: new Promise(() => {}), kill: async () => true }) });
  const host = new JointHost(store, hub);
  const room = host.createRoom({ name: '私聊', members: ['claude', 'gpt'], ownerName: 'Lenka', cwd: home });
  hub.deliver(room.id, 'claude', '@ChatGPT 帮我看看 FAKE_DM_RELAY', true, {});
  let msgs = store.getMessages(room.id);
  assert.ok(!msgs.some((m) => m.pm), '不生成 AI 之间的私聊');
  assert.ok(msgs.filter((m) => !m.dm).every((m) => !m.text.includes('FAKE_DM_RELAY')), '私聊回复不进公开记录');
  // 以前排进来的「被同事私下找来」的回合（peer）：dmMode=false 也不能公开
  hub.deliver(room.id, 'gpt', '这是私下回 Claude 的 FAKE_PEER_REPLY', false, {}, 'claude');
  msgs = store.getMessages(room.id);
  assert.ok(msgs.filter((m) => !m.dm).every((m) => !m.text.includes('FAKE_PEER_REPLY')), '私下回合的回复不能公开');
});
