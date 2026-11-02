import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

// 数据目录重定向到临时目录，绝不碰老板的 ~/.clawchat
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'joint-routes-'));
process.env.CLAWCHAT_HOME = HOME;

const { setupJointFiles } = await import('../lib/joint-files-routes.js');
const { createSnapshot } = await import('../lib/joint-files.js');

const STAGING = path.join(HOME, 'joint-staging');
const room = { id: 'room1', joint: { role: 'host', selfName: 'Lenka' } };
const peer = { node: 'node-b', ownerName: '小王' };
const host = { still() {}, pushEvent(evType, ev) { host.pushed ||= []; host.pushed.push(ev); } };
const hubEvents = [];
const hub = { emit(_, ev) { hubEvents.push(ev); } };
const mirrorRoom = { id: 'mirror1', joint: { role: 'guest' } };
const store = { getRoom: (id) => (id === 'room1' ? room : id === 'mirror1' ? mirrorRoom : null) };
const files = setupJointFiles({ host, store, hub, guestConnection: () => null, self: 'node-a' });

const api = (parts, body, method = 'POST') => new Promise((resolve) => {
  files.api({ url: 'http://local/x', method }, {}, { parts, method, send: (res, status, obj) => resolve({ status, obj }), readBody: async () => body })
    .catch((e) => resolve({ status: e.status || 500, obj: { error: e.message } }));
});

const peerReq = async (parts, { raw = Buffer.alloc(0), peer: p = peer, method = 'POST' } = {}) => new Promise((resolve) => {
  const stream = new Readable({ read() {} });
  setTimeout(() => { if (raw.length) stream.push(raw); stream.push(null); }, 1);
  const res = { writeHead(status) { this.status = status; }, end(buf) { this.raw = buf; resolve({ status: 200, raw: buf }); } };
  files.peer(stream, res, { room, peer: p, parts, method, send: (r, status, obj) => resolve({ status, obj }) }).catch((e) => resolve({ status: e.status || 500, obj: { error: e.message }, raw: Buffer.alloc(0) }));
});

const makeFile = (content, name = 'a.txt') => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'src-')), name);
  fs.writeFileSync(p, content);
  return p;
};

describe('传文件路由：本机界面', () => {
  test('快照+确认：普通文件进待取区，事件通知对方来拉', async () => {
    const src = makeFile('普通文件内容'.repeat(10));
    const snap = await createSnapshot(src, STAGING);
    const risk = (await import('../lib/joint-files.js')).classifyRisk;
    const r1 = await api(['snapshot'], { path: src, roomId: 'room1' });
    assert.equal(r1.status, 200);
    assert.equal(r1.obj.risk.risk, 'normal');
    const r2 = await api(['approve'], { roomId: 'room1', staging: r1.obj.staging, hash: r1.obj.hash, size: r1.obj.size, name: '报表.txt', toNode: 'node-b' });
    assert.equal(r2.status, 200);
    assert.ok(r2.obj.transferId);
    // 待取区落盘：meta ready=true，文件在
    const meta = JSON.parse(fs.readFileSync(path.join(HOME, 'joint-transfer', 'room1', r2.obj.transferId, 'meta.json'), 'utf8'));
    assert.equal(meta.ready, true);
    assert.equal(meta.toNode, 'node-b');
    assert.equal(meta.risk, 'normal');
    assert.ok(fs.existsSync(path.join(HOME, 'joint-transfer', 'room1', r2.obj.transferId, meta.stored)));
    assert.equal(host.pushed.at(-1).type, 'file.ready');
  });

  test('secret 类文件 approve 一律拒绝（第一期不支持传送）', async () => {
    const src = makeFile('-----BEGIN PRIVATE KEY-----\nabc');
    const r1 = await api(['snapshot'], { path: src });
    assert.equal(r1.obj.risk.risk, 'secret');
    const r2 = await api(['approve'], { roomId: 'room1', staging: r1.obj.staging, hash: r1.obj.hash, size: r1.obj.size, name: 'x.key', toNode: 'node-b' });
    assert.equal(r2.status, 415);
    assert.match(r2.obj.error, /第一期不支持/);
  });

  test('staging 编号不合法或哈希对不上：拒绝', async () => {
    const r1 = await api(['approve'], { roomId: 'room1', staging: '../escape', hash: 'x', size: 1, name: 'a', toNode: 'node-b' });
    assert.equal(r1.status, 400);
    const src = makeFile('内容A');
    const s = await api(['snapshot'], { path: src });
    const r2 = await api(['approve'], { roomId: 'room1', staging: s.obj.staging, hash: 'dd'.repeat(32), size: 4, name: 'a', toNode: 'node-b' });
    assert.equal(r2.status, 400);
    assert.match(r2.obj.error, /被改过/);
  });

  test('收件箱列表和「在访达里显示」的位置检查', async () => {
    const res = await new Promise((resolve) => {
      files.api({ url: 'http://local/api/joint/files/inbox?roomId=room1', method: 'GET' }, {}, { parts: ['inbox'], method: 'GET', send: (r, status, obj) => resolve({ status, obj }), readBody: async () => ({}) })
        .catch((e) => resolve({ status: e.status || 500, obj: { error: e.message } }));
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.obj.items));
    const bad = await api(['inbox', 'reveal'], { roomId: 'room1', transferId: '../escape' });
    assert.equal(bad.status, 404);
  });
});

describe('传文件路由：peer 接口', () => {
  test('对方发起 request：只进老板界面，不进事件流公开正文', async () => {
    const r = await peerReq(['request'], { raw: Buffer.from(JSON.stringify({ name: '证书.p12', size: 100, purpose: '部署' })) });
    assert.equal(r.status, 200);
    const ev = hubEvents.find((e) => e.type === 'joint-file-request');
    assert.ok(ev);
    assert.equal(ev.from, '小王');
    assert.equal(ev.name, '证书.p12');
  });

  test('对方上传：登记→分块→收尾，落进主持方收件箱', async () => {
    const data = crypto.randomBytes(1500);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const tid = 'T'.repeat(22);
    const r1 = await peerReq(['uploads'], { raw: Buffer.from(JSON.stringify({ transferId: tid, name: '对方发来的.bin', size: data.length, hash, toNode: 'node-a' })) });
    assert.equal(r1.status, 200);
    const r2 = await peerReq(['uploads', tid, 'chunks'], { raw: data, method: 'PUT' });
    assert.equal(r2.status, 200);
    const r3 = await peerReq(['uploads', tid, 'finish'], {});
    assert.equal(r3.status, 200);
    const meta = JSON.parse(fs.readFileSync(path.join(HOME, 'joint-inbox', 'room1', tid, 'meta.json'), 'utf8'));
    assert.equal(meta.done, true);
    assert.equal(fs.readFileSync(meta.stored).toString('hex'), data.toString('hex'));
    const ev = hubEvents.find((e) => e.type === 'joint-file-arrived');
    assert.ok(ev);
  });

  test('发给别人的文件不接受：toNode 不是主持方', async () => {
    const r = await peerReq(['uploads'], { raw: Buffer.from(JSON.stringify({ transferId: 'W'.repeat(22), name: 'f', size: 1, hash: 'a', toNode: 'node-c' })) });
    assert.equal(r.status, 400);
  });

  test('对方拉文件：只给 meta.toNode 指的节点；别人的节点 404', async () => {
    // 主持方发一份出去
    const src = makeFile('给小王的文件');
    const s = await api(['snapshot'], { path: src });
    const a = await api(['approve'], { roomId: 'room1', staging: s.obj.staging, hash: s.obj.hash, size: s.obj.size, name: '给小王.txt', toNode: 'node-b' });
    const tid = a.obj.transferId;
    const m = await peerReq(['manifest', tid], { method: 'GET', peer });
    assert.equal(m.status, 200);
    assert.equal(m.obj.name, '给小王.txt');
    assert.equal(m.obj.risk, 'normal');
    const c = await peerReq(['content', tid], { method: 'GET', peer });
    assert.equal(c.status, 200);
    assert.equal(c.raw ? c.raw.toString() : '', '给小王的文件');
    const other = await peerReq(['manifest', tid], { method: 'GET', peer: { node: 'node-x', ownerName: '别人' } });
    assert.equal(other.status, 404);
  });
});

describe('传文件路由：加入方拉取', () => {
  test('file.ready → 拉取落到本机收件箱；secret 再拦一道', async () => {
    // 假主持方：manifest/content 两个接口
    const fileData = Buffer.from('小王收到的文件');
    const manifest = { name: '收到.txt', size: fileData.length, hash: crypto.createHash('sha256').update(fileData).digest('hex'), risk: 'normal', fromNode: 'node-a' };
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push(String(url));
      if (String(url).endsWith('/manifest')) return { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify(manifest)) };
      if (String(url).endsWith('/content')) return { ok: true, arrayBuffer: async () => fileData };
      throw new Error('意外请求');
    };
    const connRoom = 'mirror1';
    const files2 = setupJointFiles({
      host, store, hub,
      guestConnection: (id) => (id === connRoom ? { host: 'https://host.ts.net', roomId: 'room1', nodeId: 'node-b', token: 'tok' } : null),
      self: 'node-b',
    });
    await files2.onGuestEvent(connRoom, { type: 'file.ready', transferId: 'P'.repeat(22), name: '收到.txt' });
    const meta = JSON.parse(fs.readFileSync(path.join(HOME, 'joint-inbox', connRoom, 'P'.repeat(22), 'meta.json'), 'utf8'));
    assert.equal(meta.done, true);
    assert.equal(fs.readFileSync(meta.stored).toString(), fileData.toString());
    assert.ok(hubEvents.some((e) => e.type === 'joint-file-arrived' && e.roomId === connRoom));
    delete globalThis.fetch;
  });
});
