// 联合群传文件的 Touch ID 确认（第二期）：
// Mac 外壳用钥匙串里一把「必须按指纹才能使用」的 Secure Enclave 私钥给确认串签名，
// 服务端第一次见到公钥时记下，之后每次核对签名。私钥签不出来，本机 AI 调接口也冒充不了老板。
// 外壳太旧或没有指纹能力的，前端退回「再输一遍文件名」的方案。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';
import { tr } from './i18n.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const KEY_FILE = path.join(DATA_DIR, 'joint-biometric.json');
const CHALLENGE_TTL = 5 * 60 * 1000;

const challenges = new Map(); // challenge → { hash, toNode, at }

// 服务端出确认串：绑定这次的文件哈希、收件节点，5 分钟内一次性
export function makeBiometricChallenge({ fileHash, toNode, now = Date.now } = {}) {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const message = `clawchat-file-auth\n${fileHash}\n${toNode}\n${nonce}`;
  const entry = { hash: fileHash, toNode, at: now() };
  challenges.set(message, entry);
  for (const [k, v] of challenges) if (now() - v.at > CHALLENGE_TTL) challenges.delete(k);
  return { message };
}

// 核对一次 Touch ID 签名：串没过期、没被用过、公钥和登记的一致（首次登记除外）、验签通过
export function verifyBiometric({ message, pub, sig }, { fileHash, toNode, now = Date.now } = {}) {
  const entry = challenges.get(String(message || ''));
  if (!entry) throw fail(400, tr('确认串无效或已用过，请重新确认'));
  if (entry.hash !== fileHash || entry.toNode !== toNode) throw fail(400, tr('确认串和这次的文件对不上'));
  if (now() - entry.at > CHALLENGE_TTL) { challenges.delete(String(message)); throw fail(400, tr('确认已超时，请重新按指纹')); }
  challenges.delete(String(message)); // 一次性
  if (typeof pub !== 'string' || typeof sig !== 'string' || pub.length < 40 || sig.length < 40)
    throw fail(400, tr('指纹确认的数据不完整'));
  // 公钥登记：第一次记下；之后必须同一把钥匙（换钥匙要老板亲手删记录文件，防止 AI 悄悄换上自己的）
  const saved = registeredPub();
  if (saved && saved !== pub) throw fail(403, tr('指纹钥匙变了，请在设置里确认后重新登记'));
  const raw = Buffer.from(pub, 'base64url');
  const signature = Buffer.from(sig, 'base64url');
  // 原始点（0x04||X||Y）转成 JWK 验签（外壳给的是 SecKeyCopyExternalRepresentation 的 65 字节）
  if (raw.length !== 65 || raw[0] !== 0x04) throw fail(400, tr('指纹钥匙的格式不对'));
  const key = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  const ok = crypto.verify('sha256', Buffer.from(String(message), 'utf8'), key, signature);
  if (!ok) throw fail(403, tr('指纹签名验不过'));
  if (!saved) writePub(pub);
  return true;
}

// 登记状态三态：'none' 从没登记过（可以走第一期的输文件名）；'ok' 已登记（secret 必须按指纹）；
// 'corrupt' 记录读不出来或格式坏了——这时不能悄悄退回输文件名，要关掉敏感发送让老板处理
export function biometricPubState() {
  if (!fs.existsSync(KEY_FILE)) return 'none';
  let pub;
  try { pub = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).pub; } catch { return 'corrupt'; }
  if (typeof pub === 'string' && pub.length >= 40) return 'ok';
  return 'corrupt';
}

// 兼容旧调用：登记过（包括损坏）都算「有登记」
export function hasRegisteredPub() { return biometricPubState() !== 'none'; }
export function registeredPub() {
  if (biometricPubState() !== 'ok') return null;
  try { return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).pub || null; } catch { return null; }
}

// 登记（外壳启动时主动来登记，把「谁先登记认谁的钥匙」的空档压到最短）：
// 同一把钥匙重复登记幂等成功（外壳每次启动都来）；换了一把钥匙才拒绝；
// 记录损坏时也拒绝，别让坏记录被悄悄覆盖。
// 返回 true = 这次是新登记（界面要提示老板）；false = 同一把钥匙重复登记
export function enrollPub(pub) {
  if (typeof pub !== 'string' || pub.length < 40) throw fail(400, tr('公钥的格式不对'));
  const raw = Buffer.from(pub, 'base64url');
  if (raw.length !== 65 || raw[0] !== 0x04) throw fail(400, tr('公钥的格式不对'));
  const state = biometricPubState();
  if (state === 'corrupt') throw fail(500, tr('指纹钥匙记录读不出来，请删除 ~/.clawchat/joint-biometric.json 后重启 ClawChat'));
  const saved = registeredPub();
  if (saved) {
    if (saved === pub) return false; // 同一把钥匙：外壳每次启动都来，幂等成功，但不算新登记（不弹提示）
    throw fail(409, tr('这台电脑的 Touch ID 钥匙已被登记过，不是这次登记的；如果不是你自己做的，请删除 ~/.clawchat/joint-biometric.json 后重启 ClawChat'));
  }
  writePub(pub);
  return true;
}
function writePub(pub) {
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${KEY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pub }), { mode: 0o600 });
  fs.renameSync(tmp, KEY_FILE);
}
