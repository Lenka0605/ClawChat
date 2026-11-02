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
const peer = { nodeId: 'node-b', ownerName: '小王' };
const host = { still() {}, pushEvent(evType, ev) { host.pushed ||= []; host.pushed.push(ev); }, on() {}, data: { peers: { room1: { epoch: 'epoch-1' } } } };
const hubEvents = [];
const hub = { emit(_, ev) { hubEvents.push(ev); } };
const mirrorRoom = { id: 'mirror1', joint: { role: 'guest' } };
const store = { getRoom: (id) => (id === 'room1' ? room : id === 'mirror1' ? mirrorRoom : null) };
const files = setupJointFiles({ host, store, hub, guestConnection: () => null, self: 'node-a' });

const api = (parts, body, method = 'POST') => new Promise((resolve) => {
  files.api({ url: 'http://local/x', method, headers: { host: '127.0.0.1:7451' } }, {}, { parts, method, send: (res, status, obj) => resolve({ status, obj }), readBody: async () => body })
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
  test('Touch ID 登记、出挑战只认电脑窗口；同一把钥匙重复登记只提示一次', async () => {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = kp.publicKey.export({ format: 'jwk' });
    const pub = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
    const phone = (parts, body) => new Promise((resolve) => {
      files.api({ url: 'http://local/x', method: 'POST', headers: { 'x-forwarded-for': '10.0.0.1', host: 'fake.ts.net' } }, {}, { parts, method: 'POST', send: (r, status, obj) => resolve({ status, obj }), readBody: async () => body })
        .catch((e) => resolve({ status: e.status || 500, obj: { error: e.message } }));
    });
    const keyFile = path.join(HOME, 'joint-biometric.json');
    // 手机来源：登记、出挑战都 403，也没落下登记记录
    assert.equal((await phone(['biometric-enroll'], { pub })).status, 403);
    assert.equal(fs.existsSync(keyFile), false);
    assert.equal((await phone(['biometric-challenge'], { hash: 'aa'.repeat(32), toNode: 'node-b' })).status, 403);
    // 本机电脑窗口直连但 Host 被改成别的（经代理转进来）也拒绝
    const proxied = await new Promise((resolve) => {
      files.api({ url: 'http://local/x', method: 'POST', headers: { host: 'fake.ts.net' } }, {}, { parts: ['biometric-enroll'], method: 'POST', send: (r, status, obj) => resolve({ status, obj }), readBody: async () => ({ pub }) })
        .catch((e) => resolve({ status: e.status || 500, obj: { error: e.message } }));
    });
    assert.equal(proxied.status, 403);
    // 电脑窗口：第一次登记弹提示；外壳下次启动再来同一把，200 但不再弹
    const before = hubEvents.filter((e) => e.type === 'joint-biometric-enrolled').length;
    const r1 = await api(['biometric-enroll'], { pub });
    assert.equal(r1.status, 200);
    assert.equal(r1.obj.enrolled, true);
    const r2 = await api(['biometric-enroll'], { pub });
    assert.equal(r2.status, 200);
    assert.equal(r2.obj.enrolled, false);
    assert.equal(hubEvents.filter((e) => e.type === 'joint-biometric-enrolled').length - before, 1, '两次登记只弹一次提示');
    fs.rmSync(keyFile, { force: true }); // 别影响后面按输文件名走的用例
  });

  test('快照+确认：普通文件进待取区，事件通知对方来拉', async () => {
    const src = makeFile('普通文件内容'.repeat(10));
    const snap = await createSnapshot(src, STAGING);
    const risk = (await import('../lib/joint-files.js')).classifyRisk;
    const r1 = await api(['snapshot'], { path: src, roomId: 'room1' });
    assert.equal(r1.status, 200);
    assert.equal(r1.obj.risk.risk, 'normal');
    const r2 = await api(['approve'], { roomId: 'room1', staging: r1.obj.staging, hash: r1.obj.hash, size: r1.obj.size, name: r1.obj.name, toNode: 'node-b' });
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

  test('secret 类：手机来源拒绝；电脑上文件名没对上拒绝；对上了才放行（老板拍板的第一期方案）', async () => {
    const src = makeFile('-----BEGIN PRIVATE KEY-----\nabc', 'server.key');
    const r1 = await api(['snapshot'], { path: src });
    assert.equal(r1.obj.risk.risk, 'secret');
    // 电脑窗口、但文件名没输对
    const bad = await api(['approve'], { roomId: 'room1', staging: r1.obj.staging, hash: r1.obj.hash, size: r1.obj.size, name: 'server.key', confirmName: '输错了.key', toNode: 'node-b' });
    assert.equal(bad.status, 400);
    // 名字对上了：放行
    const ok = await api(['approve'], { roomId: 'room1', staging: r1.obj.staging, hash: r1.obj.hash, size: r1.obj.size, name: 'server.key', confirmName: 'server.key', toNode: 'node-b' });
    assert.equal(ok.status, 200);
    // 手机来源（x-forwarded-*）：即便名字对也拒绝
    const src2 = makeFile('-----BEGIN PRIVATE KEY-----\nabc', 'phone.key');
    const s2 = await api(['snapshot'], { path: src2 });
    const fromPhone = await new Promise((resolve) => {
      files.api({ url: 'http://local/x', method: 'POST', headers: { 'x-forwarded-for': '10.0.0.1', host: 'host.ts.net' } }, {}, { parts: ['approve'], method: 'POST', send: (r, status, obj) => resolve({ status, obj }), readBody: async () => ({ roomId: 'room1', staging: s2.obj.staging, hash: s2.obj.hash, size: s2.obj.size, name: 'phone.key', confirmName: 'phone.key', toNode: 'node-b' }) })
        .catch((e) => resolve({ status: e.status || 500, obj: { error: e.message } }));
    });
    assert.equal(fromPhone.status, 403);
    assert.match(fromPhone.obj.error, /电脑/);
  });

  test('staging 编号不合法或哈希对不上：拒绝', async () => {
    const r1 = await api(['approve'], { roomId: 'room1', staging: '../escape', hash: 'x', size: 1, name: 'a', toNode: 'node-b' });
    assert.equal(r1.status, 400);
    const src = makeFile('内容A');
    const s = await api(['snapshot'], { path: src });
    const r2 = await api(['approve'], { roomId: 'room1', staging: s.obj.staging, hash: s.obj.hash, size: s.obj.size, name: '改过的名字.txt', toNode: 'node-b' });
    assert.equal(r2.status, 400);
    assert.match(r2.obj.error, /不一致|重新选择/);
    const r3 = await api(['approve'], { roomId: 'room1', staging: s.obj.staging, hash: s.obj.hash, size: 999, name: s.obj.name, toNode: 'node-b' });
    assert.equal(r3.status, 400);
    assert.match(r3.obj.error, /不一致|重新选择/);
  });

  test('登记过指纹公钥的电脑：secret 必须带签名，输文件名这条路关掉（组长定的规则）', async () => {
    // 手动登记一个公钥（模拟这台电脑之前按过指纹）
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = kp.publicKey.export({ format: 'jwk' });
    const pub = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
    fs.writeFileSync(path.join(HOME, 'joint-biometric.json'), JSON.stringify({ pub }), { mode: 0o600 });
    const src = makeFile('-----BEGIN PRIVATE KEY-----\nabc', '登记后.key');
    const s2 = await api(['snapshot'], { path: src });
    // 不带签名：拒绝
    const r1 = await api(['approve'], { roomId: 'room1', staging: s2.obj.staging, hash: s2.obj.hash, size: s2.obj.size, name: s2.obj.name, toNode: 'node-b' });
    assert.equal(r1.status, 403);
    assert.match(r1.obj.error, /指纹/);
    // 带真签名：放行
    const ch = (await api(['biometric-challenge'], { hash: s2.obj.hash, toNode: 'node-b' })).obj;
    const sig = crypto.sign('sha256', Buffer.from(ch.message, 'utf8'), kp.privateKey).toString('base64url');
    const r2 = await api(['approve'], { roomId: 'room1', staging: s2.obj.staging, hash: s2.obj.hash, size: s2.obj.size, name: s2.obj.name, toNode: 'node-b', auth: { message: ch.message, pub, sig } });
    assert.equal(r2.status, 200);
    // 清掉登记，不影响后面的测试
    fs.rmSync(path.join(HOME, 'joint-biometric.json'), { force: true });
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
    assert.equal(fs.readFileSync(path.join(HOME, 'joint-inbox', 'room1', tid, meta.stored)).toString('hex'), data.toString('hex'));
    const ev = hubEvents.find((e) => e.type === 'joint-file-arrived');
    assert.ok(ev);
  });

  test('发给别人的文件不接受：toNode 不是主持方', async () => {
    const r = await peerReq(['uploads'], { raw: Buffer.from(JSON.stringify({ transferId: 'W'.repeat(22), name: 'f', size: 1, hash: 'a', toNode: 'node-c' })) });
    assert.equal(r.status, 400);
  });

  test('撤权重配（换账号同节点号）后，新身份拿不到旧文件；过期 410（复核反例）', async () => {
    const src = makeFile('给老身份的文件');
    const s2 = await api(['snapshot'], { path: src });
    const a2 = await api(['approve'], { roomId: 'room1', staging: s2.obj.staging, hash: s2.obj.hash, size: s2.obj.size, name: s2.obj.name, toNode: 'node-b' });
    const tid2 = a2.obj.transferId;
    // 同节点号、换了身份（epoch 不同）：404
    const newIdentity = await peerReq([tid2, 'manifest'], { method: 'GET', peer: { nodeId: 'node-b', epoch: 'epoch-2-new-pair', ownerName: '新同事' } });
    assert.equal(newIdentity.status, 404);
    // 同一代次正常拿
    const same = await peerReq([tid2, 'manifest'], { method: 'GET', peer: { nodeId: 'node-b', epoch: 'epoch-1', ownerName: '小王' } });
    assert.equal(same.status, 200);
    // 把 meta 时间改到 25 小时前：下载入口自己核有效期 → 410
    const metaFile = path.join(HOME, 'joint-transfer', 'room1', tid2, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.at = Date.now() - 25 * 60 * 60 * 1000;
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    const expired = await peerReq([tid2, 'manifest'], { method: 'GET', peer });
    assert.equal(expired.status, 410);
  });

  test('manifest 声明超限：拉取直接拒绝，不进收件箱（复核反例）', async () => {
    const connRoom2 = 'mirror9';
    const mirror9 = { id: connRoom2, joint: { role: 'guest' } };
    const bigManifest = { name: 'big.bin', size: 200 * 1024 * 1024, hash: 'x', risk: 'normal', fromNode: 'node-a' };
    let manifestAsked = false, contentAsked = false;
    const oldGetRoom = store.getRoom;
    store.getRoom = (id) => (id === connRoom2 ? mirror9 : oldGetRoom(id));
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/manifest')) { manifestAsked = true; return { ok: true, body: (async function* () { yield Buffer.from(JSON.stringify(bigManifest)); })() }; }
      contentAsked = true;
      return { ok: true, body: (async function* () { yield Buffer.alloc(10); })() };
    };
    const files2 = setupJointFiles({
      host: { still() {}, pushEvent() {}, on() {}, data: { peers: {} } }, store, hub,
      guestConnection: () => ({ host: 'https://host.ts.net', roomId: 'room1', nodeId: 'node-b', token: 'tok' }), self: 'node-b',
    });
    try {
      await files2.onGuestEvent(connRoom2, { type: 'file.ready', transferId: 'B'.repeat(22), name: 'big.bin' });
    } catch { /* 超限错误往外抛（retryable 语义）也算对 */ }
    assert.equal(manifestAsked, true); // 确实请求过 manifest，不是空过
    assert.equal(contentAsked, false); // 大小不对连内容都不拉
    assert.equal(fs.existsSync(path.join(HOME, 'joint-inbox', connRoom2)), false);
    store.getRoom = oldGetRoom;
    delete globalThis.fetch;
  });

  test('断流重试两条路径（复核反例）：manifest 中途断开、content 提前结束都标 retryable；等长哈希错不标', async () => {
    const connRoom3 = 'mirror3';
    const room3 = { id: connRoom3, joint: { role: 'guest' } };
    const oldGetRoom = store.getRoom;
    store.getRoom = (id) => (id === connRoom3 ? room3 : oldGetRoom(id));
    const files3 = setupJointFiles({
      host: { still() {}, pushEvent() {}, on() {}, data: { peers: {} } }, store, hub,
      guestConnection: () => ({ host: 'https://host.ts.net', roomId: 'room1', nodeId: 'node-b', token: 'tok' }), self: 'node-b',
    });
    const goodManifest = (size) => ({ name: 'f.bin', size, hash: 'x', risk: 'normal', fromNode: 'node-a' });
    // 1) manifest 传到一半断开 → retryable
    globalThis.fetch = async () => ({ ok: true, body: (async function* () { yield Buffer.from('{'); throw new Error('连接断了'); })() });
    let err1 = null;
    try { await files3.onGuestEvent(connRoom3, { type: 'file.ready', transferId: 'M'.repeat(22), name: 'f.bin' }); } catch (e) { err1 = e; }
    assert.ok(err1?.retryable, 'manifest 断流应标 retryable');
    assert.equal(fs.existsSync(path.join(HOME, 'joint-inbox', connRoom3)), false);
    // 2) content 声明 10 字节只到 2 字节就 EOF → 清掉半份、标 retryable
    const short = Buffer.from('ab');
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/manifest')) return { ok: true, body: (async function* () { yield Buffer.from(JSON.stringify(goodManifest(10))); })() };
      return { ok: true, body: (async function* () { yield short; })() };
    };
    let err2 = null;
    try { await files3.onGuestEvent(connRoom3, { type: 'file.ready', transferId: 'N'.repeat(22), name: 'f.bin' }); } catch (e) { err2 = e; }
    assert.ok(err2?.retryable, 'content 提前结束应标 retryable');
    assert.equal(fs.existsSync(path.join(HOME, 'joint-inbox', connRoom3, 'N'.repeat(22))), false);
    // 3) 字节数够但哈希对不上 → 终止错误（不标 retryable）
    const wrong = Buffer.from('0123456789');
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/manifest')) return { ok: true, body: (async function* () { yield Buffer.from(JSON.stringify({ ...goodManifest(10), hash: 'zz' })); })() };
      return { ok: true, body: (async function* () { yield wrong; })() };
    };
    let err3 = null;
    try { await files3.onGuestEvent(connRoom3, { type: 'file.ready', transferId: 'O'.repeat(22), name: 'f.bin' }); } catch (e) { err3 = e; }
    assert.ok(err3 && !err3.retryable, '等长但哈希错是终止错误');
    store.getRoom = oldGetRoom;
    delete globalThis.fetch;
  });

  test('对方拉文件：只给 meta.toNode 指的节点；别人的节点 404', async () => {
    // 主持方发一份出去
    const src = makeFile('给小王的文件');
    const s = await api(['snapshot'], { path: src });
    const a = await api(['approve'], { roomId: 'room1', staging: s.obj.staging, hash: s.obj.hash, size: s.obj.size, name: s.obj.name, toNode: 'node-b' });
    const tid = a.obj.transferId;
    const m = await peerReq([tid, 'manifest'], { method: 'GET', peer });
    assert.equal(m.status, 200);
    assert.equal(m.obj.name, 'a.txt');
    assert.equal(m.obj.risk, 'normal');
    const c = await peerReq([tid, 'content'], { method: 'GET', peer });
    assert.equal(c.status, 200);
    assert.equal(c.raw ? c.raw.toString() : '', '给小王的文件');
    const other = await peerReq([tid, 'manifest'], { method: 'GET', peer: { nodeId: 'node-x', ownerName: '别人' } });
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
      if (String(url).endsWith('/manifest')) return { ok: true, body: (async function* () { yield Buffer.from(JSON.stringify(manifest)); })() };
      if (String(url).endsWith('/content')) return { ok: true, body: (async function* () { yield fileData; })() };
      throw new Error('意外请求');
    };
    const connRoom = 'mirror1';
    const files2 = setupJointFiles({
      host, store, hub,
      guestConnection: (id) => ({ host: 'https://host.ts.net', roomId: 'room1', nodeId: 'node-b', token: 'tok' }),
      self: 'node-b',
    });
    await files2.onGuestEvent(connRoom, { type: 'file.ready', transferId: 'P'.repeat(22), name: '收到.txt' });
    const meta = JSON.parse(fs.readFileSync(path.join(HOME, 'joint-inbox', connRoom, 'P'.repeat(22), 'meta.json'), 'utf8'));
    assert.equal(meta.done, true);
    assert.equal(fs.readFileSync(path.join(HOME, 'joint-inbox', connRoom, 'P'.repeat(22), meta.stored)).toString(), fileData.toString());
    assert.ok(hubEvents.some((e) => e.type === 'joint-file-arrived' && e.roomId === connRoom));
    delete globalThis.fetch;
  });
});
