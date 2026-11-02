import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// 数据目录重定向到临时目录，不碰老板的 ~/.clawchat
process.env.CLAWCHAT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'joint-bio-'));
const { makeBiometricChallenge, verifyBiometric, enrollPub, hasRegisteredPub } = await import('../lib/joint-biometric.js');

// 模拟外壳：软件里造一把 P-256（真机上是 Secure Enclave，验签逻辑相同）
const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pubRaw = (() => {
  const jwk = kp.publicKey.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
})();
const sign = (message) => crypto.sign('sha256', Buffer.from(message, 'utf8'), kp.privateKey);

describe('Touch ID 确认（服务端）', () => {
  test('登记：首次成功；同一把钥匙幂等成功（外壳每次启动都来）；换钥匙才拒绝；记录损坏拒绝登记', () => {
    assert.equal(hasRegisteredPub(), false);
    assert.throws(() => enrollPub('short'), /格式/);
    assert.equal(enrollPub(pubRaw), true, '第一次登记：返回 true（界面要提示老板）');
    assert.equal(hasRegisteredPub(), true);
    // 外壳每次启动都来：不抛错（不报「被抢注」），但返回 false，不算新登记、不再弹提示
    assert.equal(enrollPub(pubRaw), false, '同一把钥匙重复登记：幂等成功但不算新登记');
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const j = other.publicKey.export({ format: 'jwk' });
    assert.throws(() => enrollPub(Buffer.concat([Buffer.from([0x04]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url')), /已被登记过/);
    // 记录损坏：登记和确认都拒绝，不悄悄降级
    fs.writeFileSync(path.join(process.env.CLAWCHAT_HOME, 'joint-biometric.json'), '{坏掉的');
    assert.throws(() => enrollPub(pubRaw), /读不出来/);
  });


  test('正常流程：出挑战 → 签名 → 验过，公钥首次登记', () => {
    const { message } = makeBiometricChallenge({ fileHash: 'aa'.repeat(32), toNode: 'node-b' });
    assert.ok(verifyBiometric({ message, pub: pubRaw, sig: sign(message).toString('base64url') }, { fileHash: 'aa'.repeat(32), toNode: 'node-b' }));
    // 登记的公钥落在数据目录里
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.CLAWCHAT_HOME, 'joint-biometric.json'), 'utf8'));
    assert.equal(saved.pub, pubRaw);
  });

  test('挑战只能用一次；和别的文件对不上；公钥被换掉拒绝（复核要点）', () => {
    const { message } = makeBiometricChallenge({ fileHash: 'bb'.repeat(32), toNode: 'node-b' });
    assert.ok(verifyBiometric({ message, pub: pubRaw, sig: sign(message).toString('base64url') }, { fileHash: 'bb'.repeat(32), toNode: 'node-b' }));
    assert.throws(() => verifyBiometric({ message, pub: pubRaw, sig: sign(message).toString('base64url') }, { fileHash: 'bb'.repeat(32), toNode: 'node-b' }), /无效或已用过/);
    const ch2 = makeBiometricChallenge({ fileHash: 'cc'.repeat(32), toNode: 'node-b' });
    assert.throws(() => verifyBiometric({ message: ch2.message, pub: pubRaw, sig: sign(ch2.message).toString('base64url') }, { fileHash: 'dd'.repeat(32), toNode: 'node-b' }), /对不上/);
    // AI 悄悄换上自己的钥匙：拒绝
    const attacker = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const attackerPub = (() => {
      const jwk = attacker.publicKey.export({ format: 'jwk' });
      return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
    })();
    const ch3 = makeBiometricChallenge({ fileHash: 'ee'.repeat(32), toNode: 'node-b' });
    assert.throws(() => verifyBiometric({ message: ch3.message, pub: attackerPub, sig: crypto.sign('sha256', Buffer.from(ch3.message, 'utf8'), attacker.privateKey).toString('base64url') }, { fileHash: 'ee'.repeat(32), toNode: 'node-b' }), /钥匙变了/);
  });

  test('签名被改、格式不对：拒绝', () => {
    const { message } = makeBiometricChallenge({ fileHash: 'ff'.repeat(32), toNode: 'node-b' });
    const sig = sign(message);
    sig[5] ^= 0xff;
    assert.throws(() => verifyBiometric({ message, pub: pubRaw, sig: sig.toString('base64url') }, { fileHash: 'ff'.repeat(32), toNode: 'node-b' }), /验不过/);
    const ch2 = makeBiometricChallenge({ fileHash: 'ab'.repeat(32), toNode: 'node-b' });
    assert.throws(() => verifyBiometric({ message: ch2.message, pub: 'short', sig: sign(ch2.message).toString('base64url') }, { fileHash: 'ab'.repeat(32), toNode: 'node-b' }), /不完整/);
  });

  test('挑战过期：拒绝', () => {
    let t = Date.now();
    const { message } = makeBiometricChallenge({ fileHash: 'cd'.repeat(32), toNode: 'node-b', now: () => t });
    t += 6 * 60 * 1000;
    assert.throws(() => verifyBiometric({ message, pub: pubRaw, sig: sign(message).toString('base64url') }, { fileHash: 'cd'.repeat(32), toNode: 'node-b', now: () => t }), /超时/);
  });
});
