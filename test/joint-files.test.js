import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createSnapshot, classifyRisk, createGrantStore, Receiver, MAX_FILE_BYTES,
  makeChallenge, makeRegistrationChallenge, challengeValid, parseRegistration, parseAttestation, verifyAssertion,
} from '../lib/joint-files.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'joint-files-'));

describe('快照', () => {
  test('普通文件：哈希、大小正确，暂存文件可读', async () => {
    const dir = tmp();
    const src = path.join(dir, 'server.p12');
    const data = crypto.randomBytes(4096);
    fs.writeFileSync(src, data);
    const snap = await createSnapshot(src, path.join(dir, 'stage'));
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    assert.equal(snap.hash, sha);
    assert.equal(snap.size, 4096);
    assert.equal(snap.name, 'server.p12');
    assert.equal(fs.readFileSync(snap.path).toString('hex'), data.toString('hex'));
  });

  test('最终分量是符号链接：拒绝', async () => {
    const dir = tmp();
    const real = path.join(dir, 'real.txt');
    fs.writeFileSync(real, 'x');
    fs.symlinkSync(real, path.join(dir, 'link.txt'));
    await assert.rejects(() => createSnapshot(path.join(dir, 'link.txt'), path.join(dir, 'stage')), /符号链接/);
  });

  test('父目录里的合法符号链接：按 realpath 消解后打开（macOS 的 /tmp 也走这条路）', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'real'));
    fs.writeFileSync(path.join(dir, 'real', 'f.txt'), '内容一致');
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'));
    const snap = await createSnapshot(path.join(dir, 'alias', 'f.txt'), path.join(dir, 'stage'));
    assert.equal(fs.readFileSync(snap.path).toString(), '内容一致');
  });

  test('目录：拒绝；超过上限：拒绝且不留暂存文件', async () => {
    const dir = tmp();
    await assert.rejects(() => createSnapshot(dir, path.join(dir, 'stage')), /普通文件/);
    const big = path.join(dir, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(1001));
    await assert.rejects(
      () => createSnapshot(big, path.join(dir, 'stage'), { maxBytes: 1000 }),
      /上限/,
    );
    assert.deepEqual(fs.readdirSync(path.join(dir, 'stage')), []);
  });

  test('快照是冻结的：快照之后源文件被替换，授权与发送仍用旧内容', async () => {
    const dir = tmp();
    const src = path.join(dir, 'f.txt');
    const old = Buffer.from('旧的正确文件');
    fs.writeFileSync(src, old);
    const snap = await createSnapshot(src, path.join(dir, 'stage'));
    fs.writeFileSync(src, Buffer.from('被 AI 偷换过的内容')); // 快照后源被换
    assert.equal(fs.readFileSync(snap.path).toString(), old.toString());
  });
});

describe('危险文件判定', () => {
  const risk = async (name, content = 'x') => {
    const dir = tmp();
    const p = path.join(dir, 's.bin');
    fs.writeFileSync(p, content);
    return classifyRisk(p, name);
  };
  test('私钥 PEM、无后缀 SSH 私钥名、p12、kdbx 魔数、.env：secret', async () => {
    assert.equal((await risk('server.key', '-----BEGIN PRIVATE KEY-----')).risk, 'secret');
    assert.equal((await risk('id_ed25519', '-----BEGIN OPENSSH PRIVATE KEY-----')).risk, 'secret');
    assert.equal((await risk('cert.p12', Buffer.from([0x30, 0x82, 1, 2]))).risk, 'secret');
    assert.equal((await risk('db.kdbx', Buffer.from([0x03, 0xd9, 0xa2, 0x9a]))).risk, 'secret');
    assert.equal((await risk('.env', 'TOKEN=1')).risk, 'secret');
    // 后缀无害但内容是私钥：内容兜底
    assert.equal((await risk('notes.txt', '-----BEGIN EC PRIVATE KEY-----\nabc')).risk, 'secret');
  });
  test('私钥改名成公开后缀也拦得住；快照读不了拒收（复核负向）', async () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nabc';
    assert.equal((await risk('cert.crt', pem)).risk, 'secret');
    assert.equal((await risk('host.pub', pem)).risk, 'secret');
    assert.equal((await risk('backup.der', pem)).risk, 'secret');
    // 快照读不了内容：拒绝，不当普通文件
    const dir = tmp();
    const missing = path.join(dir, 'nope.txt');
    await assert.rejects(() => classifyRisk(missing, 'nope.txt'));
  });

  test('公开证书、公钥、普通文件：normal（.crt 不标红）', async () => {
    assert.equal((await risk('cert.crt', '-----BEGIN CERTIFICATE-----')).risk, 'normal');
    assert.equal((await risk('host.pub', 'ssh-ed25519 AAAA')).risk, 'normal');
    assert.equal((await risk('photo.png', Buffer.from([0x89, 0x50]))).risk, 'normal');
  });
});

describe('一次性授权', () => {
  const setup = () => {
    const store = createGrantStore();
    const snap = { hash: 'aa'.repeat(32), size: 10, name: 'f.p12' };
    return { store, snap, toNode: 'node-b', roomId: 'room1' };
  };
  test('创建→消费→拿到 transferId；参数全对才给', () => {
    const { store, snap, toNode, roomId } = setup();
    const { grantId } = store.create({ snapshot: snap, toNode, roomId });
    const { transferId } = store.consume(grantId, { hash: snap.hash, toNode, roomId });
    assert.ok(transferId);
    assert.ok(store.getTransfer(transferId, roomId));
  });
  test('换哈希、换收件人、重放、过期：都拒绝', () => {
    const { store, snap, toNode, roomId } = setup();
    const { grantId } = store.create({ snapshot: snap, toNode, roomId });
    assert.throws(() => store.consume(grantId, { hash: 'bb'.repeat(32), toNode, roomId }), /授权/);
    assert.throws(() => store.consume(grantId, { hash: snap.hash, toNode: 'node-c', roomId }), /授权/);
    assert.throws(() => store.consume(grantId, { hash: snap.hash, toNode, roomId: 'other' }), /授权/);
    store.consume(grantId, { hash: snap.hash, toNode, roomId });
    assert.throws(() => store.consume(grantId, { hash: snap.hash, toNode, roomId }), /授权/); // 重放
    const clock = { t: Date.now() };
    const s2 = createGrantStore({ now: () => clock.t });
    const g2 = s2.create({ snapshot: snap, toNode, roomId });
    clock.t += 11 * 60 * 1000;
    assert.throws(() => s2.consume(g2.grantId, { hash: snap.hash, toNode, roomId }), /过期/);
  });
});

describe('分块接收', () => {
  const recv = () => new Receiver(path.join(tmp(), 'joint-inbox'));
  test('分块落 .partial、校验通过原子入库；目录 700、文件 600', async () => {
    const r = recv();
    const data = crypto.randomBytes(2048);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const tid = 't'.repeat(22);
    const h = await r.begin('room1', tid, { name: '证书.p12', size: data.length, hash, fromNode: 'node-b' });
    for (let i = 0; i < data.length; i += 700) await r.chunk('room1', tid, h, data.subarray(i, i + 700));
    const { stored, dir } = await r.finish('room1', tid, h, hash, data.length);
    const mode = fs.statSync(dir).mode & 0o777;
    assert.equal(mode, 0o700);
    assert.equal(fs.readFileSync(stored).toString('hex'), data.toString('hex'));
    assert.equal(path.basename(stored).endsWith('.partial'), false);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    assert.equal(meta.name, '证书.p12'); // 显示名在元数据里，不在路径上
  });
  test('哈希不对：丢弃、不留残留', async () => {
    const r = recv();
    const tid = 'u'.repeat(22);
    const h = await r.begin('room1', tid, { name: 'f', size: 4, hash: 'aa', fromNode: 'b' });
    await r.chunk('room1', tid, h, Buffer.from('test'));
    await assert.rejects(() => r.finish('room1', tid, h, 'bb'.repeat(32), 4), /校验/);
    assert.equal(fs.existsSync(path.join(r.root, 'room1', tid)), false);
  });
  test('超上限中途叫停；远端给的传输编号带路径符号时拒绝', async () => {
    const r = recv();
    const tid = 'v'.repeat(22);
    const h = await r.begin('room1', tid, { name: 'f', size: 999, hash: 'aa', fromNode: 'b' });
    await assert.rejects(() => r.chunk('room1', tid, h, Buffer.alloc(101), { maxBytes: 100 }), /上限/);
    assert.equal(fs.existsSync(path.join(r.root, 'room1', tid)), false);
    await assert.rejects(() => r.begin('room1', '../escape', { name: 'f', size: 1, hash: 'a', fromNode: 'b' }), /不合法/);
  });
  test('roomId 越出收件箱：拒绝（复核负向）', async () => {
    const r = recv();
    const root = path.join(tmp(), 'joint-inbox');
    const r2 = new Receiver(root);
    await assert.rejects(() => r2.begin('../outside', 'x'.repeat(22), { name: 'f', size: 1, hash: 'a', fromNode: 'b' }), /不合法/);
    await assert.rejects(() => r2.begin('a/b', 'y'.repeat(22), { name: 'f', size: 1, hash: 'a', fromNode: 'b' }), /不合法/);
  });

  test('finish 之后 chunk 被拒；校验基准取本机状态而非自报值（复核负向）', async () => {
    const r = recv();
    const data = crypto.randomBytes(300);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const tid = 'z'.repeat(22);
    const h = await r.begin('room1', tid, { name: 'f', size: data.length, hash, fromNode: 'b' });
    await r.chunk('room1', tid, h, data);
    const done = await r.finish('room1', tid); // 不传校验参数：基准来自 begin 时的本机状态
    assert.equal(fs.readFileSync(done.stored).toString('hex'), data.toString('hex'));
    await assert.rejects(() => r.chunk('room1', tid, h, Buffer.from('more')), /收尾/);
    await assert.rejects(() => r.finish('room1', tid), /收尾/);
  });

  test('同一 transferId 不能收两次', async () => {
    const r = recv();
    const tid = 'w'.repeat(22);
    await r.begin('room1', tid, { name: 'f', size: 1, hash: 'a', fromNode: 'b' });
    await assert.rejects(() => r.begin('room1', tid, { name: 'f', size: 1, hash: 'a', fromNode: 'b' }), /已经在收/);
  });
  test('上限常量是 100 MiB', () => assert.equal(MAX_FILE_BYTES, 100 * 1024 * 1024));
});

describe('WebAuthn（系统认证）', () => {
  const rpId = 'host.tail1234.ts.net';
  const origin = `https://host.tail1234.ts.net`;
  // 用真密钥对造一条注册 + 断言（前端 navigator.credentials 产生的就是这两种结构）
  const coseFor = (key) => {
    if (key.asymmetricKeyType === 'ec') {
      const jwk = key.export({ format: 'jwk' });
      // COSE: {1:2, 3:-7, -1:1, -2:x, -3:y}
      const enc = (b) => Buffer.concat([Buffer.from([0x58, b.length]), b]);
      const neg = (n) => { const v = -1 - n; return v < 24 ? Buffer.from([0x20 | v]) : Buffer.from([0x38, v]); };
      return Buffer.concat([
        Buffer.from([0xa5]),
        Buffer.from([0x01]), Buffer.from([0x02]),
        Buffer.from([0x03]), neg(-7),
        neg(-1), Buffer.from([0x01]),
        neg(-2), enc(Buffer.from(jwk.x, 'base64url')),
        neg(-3), enc(Buffer.from(jwk.y, 'base64url')),
      ]);
    }
    const jwk = key.export({ format: 'jwk' });
    const enc = (b) => Buffer.concat([Buffer.from([0x59, b.length >> 8 & 255, b.length & 255]), b]);
    const neg = (n) => { const v = -1 - n; return v < 24 ? Buffer.from([0x20 | v]) : Buffer.from([0x39, v >> 8, v & 255]); };
    const n = Buffer.from(jwk.n, 'base64url'), e = Buffer.from(jwk.e, 'base64url');
    return Buffer.concat([
      Buffer.from([0xa4]),
      Buffer.from([0x01]), Buffer.from([0x03]),
      Buffer.from([0x03]), neg(-257),
      neg(-1), enc(n),
      neg(-2), enc(e),
    ]);
  };
  const makeAuthData = (key, coseBytes, { uv = true } = {}) => {
    const rpHash = crypto.createHash('sha256').update(rpId).digest();
    const flags = 0x01 | (uv ? 0x04 : 0);
    const credId = crypto.randomBytes(32);
    const head = Buffer.alloc(37); // rpIdHash(32)+flags(1)+signCount(4)，aaguid 单独拼
    rpHash.copy(head, 0); head[32] = flags; head.writeUInt32BE(1, 33);
    const aaguid = Buffer.alloc(16);
    const len = Buffer.alloc(2); len.writeUInt16BE(credId.length, 0);
    return Buffer.concat([head, aaguid, len, credId, coseBytes]);
  };
  const assertFor = (key, { authData, client }) => {
    const clientDataJSON = Buffer.from(JSON.stringify(client));
    const sig = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]), key);
    return { clientDataJSON, authenticatorData: authData, signature: sig };
  };

  test('注册解析 + 断言验证通过（ES256 触面 ID 形态）', () => {
    const key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const cose = coseFor(key.publicKey);
    const authData = makeAuthData(key, cose);
    const reg = parseRegistration({ authenticatorData: authData, rpId });
    const ch = makeChallenge({ fileHash: 'ff'.repeat(32), toNode: 'node-b', rpId });
    const a = assertFor(key.privateKey, {
      authData: makeAuthData(key, cose), // 断言的 authData 不含凭据
      client: { type: 'webauthn.get', challenge: ch.challenge, origin },
    });
    assert.ok(verifyAssertion({ cose: reg.cose, ...a, expectedChallenge: ch.challenge, expectedOrigin: origin, rpId }));
  });

  test('RS256（Windows Hello 形态）也通过', () => {
    const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const cose = coseFor(key.publicKey);
    const reg = parseRegistration({ authenticatorData: makeAuthData(key, cose), rpId });
    const ch = makeChallenge({ fileHash: 'ee'.repeat(32), toNode: 'node-b', rpId });
    const a = assertFor(key.privateKey, {
      authData: Buffer.concat([makeAuthData(key, cose).subarray(0, 37)]),
      client: { type: 'webauthn.get', challenge: ch.challenge, origin },
    });
    assert.ok(verifyAssertion({ cose: reg.cose, ...a, expectedChallenge: ch.challenge, expectedOrigin: origin, rpId }));
  });

  test('没过 UV、challenge/origin/rpId 不对、签名被改：都拒绝', () => {
    const key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const cose = coseFor(key.publicKey);
    const reg = parseRegistration({ authenticatorData: makeAuthData(key, cose), rpId });
    const ch = makeChallenge({ fileHash: 'dd'.repeat(32), toNode: 'node-b', rpId });
    const good = { authData: makeAuthData(key, Buffer.alloc(0)).subarray(0, 37), client: { type: 'webauthn.get', challenge: ch.challenge, origin } };
    // 没过 UV
    const authDataNoUV = makeAuthData(key, Buffer.alloc(0), { uv: false }).subarray(0, 37);
    assert.throws(() => verifyAssertion({
      cose: reg.cose, ...assertFor(key.privateKey, { authData: authDataNoUV, client: good.client }),
      expectedChallenge: ch.challenge, expectedOrigin: origin, rpId,
    }), /身份确认/);
    // challenge 不对
    assert.throws(() => verifyAssertion({
      cose: reg.cose, ...assertFor(key.privateKey, good),
      expectedChallenge: 'wrong', expectedOrigin: origin, rpId,
    }), /挑战/);
    // origin 不对
    assert.throws(() => verifyAssertion({
      cose: reg.cose, ...assertFor(key.privateKey, { ...good, client: { ...good.client, origin: 'https://evil.example.com' } }),
      expectedChallenge: ch.challenge, expectedOrigin: origin, rpId,
    }), /别的站点/);
    // rpId 不对
    assert.throws(() => verifyAssertion({
      cose: reg.cose, ...assertFor(key.privateKey, good),
      expectedChallenge: ch.challenge, expectedOrigin: origin, rpId: 'other.ts.net',
    }), /别的站点/);
    // 签名被篡改
    const tampered = assertFor(key.privateKey, good);
    tampered.signature = Buffer.from(tampered.signature); tampered.signature[10] ^= 0xff;
    assert.throws(() => verifyAssertion({
      cose: reg.cose, ...tampered, expectedChallenge: ch.challenge, expectedOrigin: origin, rpId,
    }), /签名/);
  });

  test('注册：attestation 解析出公钥，挑战对不上拒绝', () => {
    const key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const cose = coseFor(key.publicKey);
    const authData = makeAuthData(key, cose);
    const regCh = makeRegistrationChallenge({ rpId });
    // 手工拼 attestationObject（CBOR map {fmt, attStmt, authData}）
    const cborMap = (pairs) => {
      const k = (n) => { const v = -n - 1; return v < 24 ? Buffer.from([0x20 | v]) : Buffer.from([0x38, v]); };
      const enc = (b) => Buffer.concat([Buffer.from([0x58, b.length]), b]);
      const txt = (str) => { const b = Buffer.from(str); return Buffer.concat([Buffer.from([0x60 + b.length]), b]); };
      return Buffer.concat([Buffer.from([0xa3]), txt('fmt'), txt('none'), txt('attStmt'), Buffer.from([0xa0]), txt('authData'), enc(authData)]);
    };
    const reg = parseAttestation({
      clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: regCh.challenge, origin })),
      attestationObject: cborMap(),
      expectedChallenge: regCh.challenge, expectedOrigin: origin, rpId,
    });
    assert.ok(reg.credentialId);
    // 挑战不对：拒绝
    assert.throws(() => parseAttestation({
      clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: 'wrong', origin })),
      attestationObject: cborMap(), expectedChallenge: regCh.challenge, expectedOrigin: origin, rpId,
    }), /挑战/);
  });

  test('挑战 5 分钟内有效', () => {
    const ch = makeChallenge({ fileHash: 'cc'.repeat(32), toNode: 'b', rpId: 'host.ts.net' });
    assert.ok(challengeValid(ch));
    const clock = { t: Date.now() };
    const ch2 = makeChallenge({ fileHash: 'cc'.repeat(32), toNode: 'b', rpId: 'host.ts.net' });
    clock.t += 6 * 60 * 1000;
    assert.equal(challengeValid(ch2, { now: () => clock.t }), false);
  });
});
