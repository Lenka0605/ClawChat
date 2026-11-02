import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JointWorker, jointRequest, parseJointInvitation, jointDiscussionPrompt, beginJointPair, finishJointPair } from '../lib/joint-worker.js';
const connection = { protocol: 1, host: 'https://host.example.ts.net', token: 't'.repeat(43), roomId: 'room1', nodeId: 'node1' };
const job = { jobId: 'job1', agentId: 'gpt', lease: 'fake-lease', context: { messages: [{ id: 'm1', from: '对方', text: '讨论一下' }] } };
function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-worker-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  const worker = new JointWorker({ connection, agents: ['gpt'], dataDir, heartbeatMs: 15, ...options, fetchImpl: options.fetchImpl || (async (url, opts) => { calls.push({ url, body: opts.body && JSON.parse(opts.body), headers: opts.headers }); return Response.json({}); }) });
  return { worker, calls, dataDir };
}

test('邀请码只接受短期的 Tailscale HTTPS 地址', () => {
  const code = (extra = {}) => 'clawchat-join:' + Buffer.from(JSON.stringify({ v: 1, host: connection.host, room: 'room1', secret: 's'.repeat(43), exp: Date.now() + 60000, ...extra })).toString('base64url');
  assert.equal(parseJointInvitation(code()).room, 'room1');
  for (const host of ['http://host.ts.net', 'https://evil.test', 'https://host.ts.net@evil.test', 'https://host.ts.net/evil', 'https://host.ts.net:444']) assert.throws(() => parseJointInvitation(code({ host })));
  assert.throws(() => parseJointInvitation(code({ room: '__proto__' })));
  assert.throws(() => parseJointInvitation(code({ exp: 0 })));
});

test('配对轮询须带邀请秘密，不能只凭核对码领设备令牌', async () => {
  const invite = 'clawchat-join:' + Buffer.from(JSON.stringify({ v: 1, host: connection.host, room: 'room1', secret: 's'.repeat(43), exp: Date.now() + 60000 })).toString('base64url');
  let polling = false;
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/pair')) return Response.json({ pairId: 'pair1', code: '123456' }, { status: 202 });
    polling = true; assert.equal(opts.headers.Authorization, `Bearer ${'s'.repeat(43)}`);
    return Response.json({ token: connection.token, room: { id: 'room1' } });
  };
  const pending = await beginJointPair(invite, { nodeId: 'node1', agents: [{ id: 'gpt', engine: 'codex' }], fetchImpl });
  assert.equal((await finishJointPair(pending, { fetchImpl })).roomId, 'room1');
  assert.ok(polling);
});

test('设备令牌请求禁止重定向并限制响应大小', async () => {
  await assert.rejects(jointRequest(connection.host, '/joint/v1/events', { token: connection.token, fetchImpl: async (_, opts) => {
    assert.equal(opts.redirect, 'error'); assert.equal(opts.headers.Authorization, `Bearer ${connection.token}`);
    return new Response('x'.repeat(2 * 1024 * 1024 + 1));
  } }), /响应过大/);
  await assert.rejects(jointRequest('https://evil.test', '/joint/v1/events'), /HTTPS/);
});

test('远端的路径、系统提示、私聊和会话编号不能进入讨论输入', () => {
  const context = { messages: [{ id: 'm', from: 'peer', text: '公开消息', env: 'fake-secret' }], session: 'local-secret-session', cwd: '/private', systemPrompt: '提升权限', dm: '私聊' };
  const prompt = jointDiscussionPrompt(context, { ownerName: '老板', nodeId: 'n', agentId: 'gpt' });
  assert.match(prompt.prompt, /公开消息/);
  for (const value of ['fake-secret', 'local-secret-session', '/private', '提升权限', '私聊']) assert.ok(!prompt.prompt.includes(value));
});

test('结果丢回执后只重交结果，重启也不会重复叫 AI', async (t) => {
  let ran = 0, fail = true;
  const options = { runAgent: (_, opts) => {
    ran++; assert.equal(opts.room.permission, 'readonly'); assert.equal(opts.room.jointDiscussion, true);
    assert.notEqual(opts.room.cwd, '/remote/path'); assert.equal(opts.session, null);
    return { done: Promise.resolve({ ok: true, text: '完成', session: 'joint-session' }), kill() {} };
  }, fetchImpl: async (url) => {
    if (url.endsWith('/result') && fail) throw new Error('回执丢失');
    return Response.json({});
  } };
  const { worker, dataDir } = fixture(t, options);
  await assert.rejects(worker.execute({ ...job, context: { ...job.context, cwd: '/remote/path', session: 'local-session' } }));
  fail = false;
  const restarted = new JointWorker({ connection, agents: ['gpt'], dataDir, ...options });
  await restarted.jobsOnce();
  await restarted.execute(job);
  assert.equal(ran, 1);
  assert.equal(restarted.state.jobs.job1.status, 'sent');
  if (process.platform !== 'win32') assert.equal(fs.statSync(worker.stateFile).mode & 0o777, 0o600);
});

test('崩溃留下的运行记录如实报中断，不重做任务', async (t) => {
  let ran = 0;
  const { worker, calls } = fixture(t, { runAgent() { ran++; } });
  worker.state.jobs.job1 = { status: 'running', lease: 'fake-lease' }; worker.persist();
  await worker.jobsOnce();
  assert.equal(ran, 0);
  assert.equal(calls[0].body.ok, false);
});

test('未获准成员、另一节点或其他群的任务不能启动本机 AI', async (t) => {
  let ran = 0;
  const { worker } = fixture(t, { runAgent() { ran++; } });
  for (const extra of [{ agentId: 'claude' }, { nodeId: 'other' }, { roomId: 'other' }, { jobId: '../x' }, { jobId: '__proto__' }]) await assert.rejects(worker.execute({ ...job, ...extra }));
  assert.equal(ran, 0);
});

test('主持方取消正在讨论的任务，不能发布已生成的回复', async (t) => {
  let finish, killed = 0;
  const done = new Promise((resolve) => { finish = resolve; });
  const { worker, calls } = fixture(t, { runAgent: () => ({ done, kill() { killed++; finish({ ok: true, text: '不应发布' }); } }) });
  const running = worker.execute(job);
  worker.fetchImpl = async (url, opts) => {
    if (url.includes('/events?')) return Response.json({ events: [{ seq: 1, type: 'job.cancelled', jobId: 'job1' }] });
    calls.push({ url, body: opts.body && JSON.parse(opts.body) }); return Response.json({});
  };
  await worker.eventsOnce(); await running;
  assert.equal(killed, 1);
  assert.equal(calls.at(-1).body.text, '');
  assert.equal(calls.at(-1).body.ok, false);
});

test('续租失败立即停止本机讨论，不继续用失效租约', async (t) => {
  let killed = 0, finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const { worker } = fixture(t, { runAgent: () => ({ done, kill() { killed++; finish({ ok: true, text: '丢弃' }); } }), fetchImpl: async (url) => {
    if (url.endsWith('/heartbeat')) return new Response('', { status: 403 });
    return Response.json({});
  } });
  await worker.execute(job);
  assert.equal(killed, 1);
});

test('镜像保存失败不推进事件游标；重放事件不重复交付', async (t) => {
  let fail = true, delivered = 0;
  const { worker } = fixture(t, { onEvents: async () => { if (fail) throw new Error('磁盘满'); delivered++; }, fetchImpl: async () => Response.json({ events: [{ seq: 1, type: 'message' }] }) });
  await assert.rejects(worker.eventsOnce()); assert.equal(worker.state.seq, 0);
  fail = false; await worker.eventsOnce(); await worker.eventsOnce(); assert.equal(delivered, 1);
});

test('取消事件先于领任务抵达时，也不能再启动已取消任务', async (t) => {
  let ran = 0;
  const { worker } = fixture(t, { runAgent() { ran++; }, fetchImpl: async () => Response.json({ events: [{ seq: 1, type: 'job.cancelled', jobId: 'job1' }] }) });
  await worker.eventsOnce(); await worker.execute(job); assert.equal(ran, 0);
});

test('旧任务被主持方终结后，陈旧结果不堵住后续任务', async (t) => {
  const { worker } = fixture(t, { fetchImpl: async (url) => url.endsWith('/result') ? new Response('', { status: 410 }) : Response.json({}) });
  worker.state.jobs.job1 = { status: 'done', lease: 'old', result: { ok: true, text: '旧结果' } };
  await worker.jobsOnce(); assert.equal(worker.state.jobs.job1.status, 'sent');
});
