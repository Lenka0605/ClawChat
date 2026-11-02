import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tr } from './i18n.js';

// 联合群传文件（第一期）：快照、危险文件判定、一次性授权、分块接收、WebAuthn 校验。
// 原则照 ChatGPT 安全方案第 4 节：只传确认过的精确快照（按哈希绑定），一次授权只对应
// 一次传输、一个收件节点；文件字节不进 AI 的对话、不进日志。
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

const fail = (msg, code) => Object.assign(new Error(msg), { code });
const readJsonSafe = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// ---------------- 快照 ----------------

// 路径里有符号链接就拒绝快照（方案 F4：检查完再按原路径重开是不够的）。
// 系统级的合法链接（macOS 的 /tmp 这类）按 realpath 消解到真实位置后打开；
// 消解和打开之间父段再被换的窗口要 openat 才能关死，Node 给不了，这里如实接受：
// 打开之后全部走 fd，「确认过的快照」和「发出去的字节」始终是同一份，这条不受影响。
async function resolveRealPath(srcPath) {
  const st = await fs.promises.lstat(srcPath);
  if (st.isSymbolicLink()) throw fail(tr('文件路径里有符号链接，已拒绝快照'), 'EJOINT_SYMLINK');
  return fs.promises.realpath(srcPath); // 最终分量已在上面拒绝，这里消解的是父目录里的合法链接
}

// 打开文件做冻结快照：最终分量 O_NOFOLLOW、打开后全部经 fd 读取（检查和读取是同一个文件对象，
// 之后源文件被换掉也不影响这一份快照），内容拷到暂存目录并算 SHA-256。
export async function createSnapshot(srcPath, stagingDir, { maxBytes = MAX_FILE_BYTES } = {}) {
  const real = await resolveRealPath(srcPath);
  let fh;
  try {
    fh = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ELOOP') throw fail(tr('文件路径里有符号链接，已拒绝快照'), 'EJOINT_SYMLINK');
    throw err;
  }
  const stagePath = path.join(stagingDir, `${crypto.randomUUID()}.snap`);
  await fs.promises.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const out = await fs.promises.open(stagePath, 'wx', 0o600);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw fail(tr('只能传普通文件'), 'EJOINT_NOT_FILE');
    if (st.size > maxBytes) throw fail(tr('文件超过 {limit} 的单文件上限', { limit: '100 MiB' }), 'EJOINT_TOO_BIG');
    const hash = crypto.createHash('sha256');
    let size = 0;
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) throw fail(tr('文件超过 {limit} 的单文件上限', { limit: '100 MiB' }), 'EJOINT_TOO_BIG');
      hash.update(buf.subarray(0, bytesRead));
      await out.write(buf.subarray(0, bytesRead));
    }
    return { path: stagePath, hash: hash.digest('hex'), size, name: path.basename(srcPath) };
  } catch (err) {
    await fs.promises.rm(stagePath, { force: true }).catch(() => {});
    throw err;
  } finally {
    await fh.close().catch(() => {});
    await out.close().catch(() => {});
  }
}

// ---------------- 危险文件判定 ----------------
// 确定性代码规则，不交给 AI 判断。后缀只是初筛，内容嗅探兜底（.pem 可能是私钥也可能是公钥）。
const SECRET_SUFFIX = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdb', '.kdbx', '.env', '.ppk', '.keychain', '.keychain-db']);
const SSH_KEY_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'identity']);
// 凭据与账号数据的常见文件名（安全方案里列的敏感类型；标红只是要求额外确认，宁可保守）
const SECRET_NAMES = new Set(['key4.db', 'logins.json', 'signons.sqlite', 'login data', 'cookies', 'cookies.sqlite', 'cookies.sqlite-wal',
  '.git-credentials', '.netrc', '.npmrc', '.htpasswd', 'secring.gpg', 'credentials', 'credentials.json', '.aws', '.kube', 'data.safe.bin']);
const PUBLIC_SUFFIX = new Set(['.pub', '.crt', '.cer', '.csr', '.spc', '.der']);
const KDBX_MAGIC = Buffer.from([0x03, 0xd9, 0xa2, 0x9a]);
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

export async function classifyRisk(stagingPath, displayName = stagingPath) {
  // 内容优先：私钥改名成 .crt/.pub 也照样拦住；快照读不出来就拒收，绝不按普通文件放行。
  // 注意这不是万能的秘密识别器（二进制密钥容器没有稳定魔数），所以风险判定只是
  // 「额外确认」的触发条件，普通文件的逐次明确确认并不依赖它。
  const ext = path.extname(displayName).toLowerCase();
  const base = path.basename(displayName);
  const fh = await fs.promises.open(stagingPath, 'r'); // 打不开就让它抛，读不了内容的文件不放行
  let secret;
  try {
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(4096), 0, 4096, 0);
    const head = buffer.subarray(0, bytesRead).toString('latin1');
    secret = PRIVATE_KEY_RE.test(head) || buffer.subarray(0, 4).equals(KDBX_MAGIC)
      || SECRET_SUFFIX.has(ext) || SSH_KEY_NAMES.has(base) || SECRET_NAMES.has(base.toLowerCase())
      || base === '.env' || base.startsWith('.env.');
  } finally { await fh.close(); }
  // 真正的公开证书/公钥（.crt/.cer/.csr/.pub/.der，且内容不是私钥）不标红吓人。
  if (secret) return { risk: 'secret', reason: tr('看起来是私钥、证书库或凭据文件，泄露后别人可以冒充你') };
  return { risk: 'normal' };
}

// ---------------- 一次性授权 ----------------
// grantId → consume（校验哈希/收件节点/群全匹配）→ transferId。grant 只能转一次，重放拒绝。
const GRANT_TTL_MS = 10 * 60 * 1000;
const token = () => crypto.randomBytes(16).toString('base64url');

export function createGrantStore({ now = Date.now, maxBytes = MAX_FILE_BYTES } = {}) {
  const grants = new Map(); // grantId → { hash, size, name, toNode, roomId, exp, used }
  const transfers = new Map(); // transferId → 接收/发送状态
  return {
    create({ snapshot, toNode, roomId }) {
      const grantId = token();
      grants.set(grantId, { hash: snapshot.hash, size: snapshot.size, name: snapshot.name, toNode, roomId, exp: now() + GRANT_TTL_MS, used: false });
      return { grantId, exp: grants.get(grantId).exp };
    },
    // 授权转传输：五个条件全对得上才发 transferId；对不上按「无此授权」回答，不泄露原因细节。
    consume(grantId, { hash, toNode, roomId }) {
      const g = grants.get(grantId);
      if (!g || g.used) throw fail(tr('没有这份授权'), 'EJOINT_NO_GRANT');
      if (g.exp < now()) { grants.delete(grantId); throw fail(tr('授权已过期，请重新确认'), 'EJOINT_GRANT_EXPIRED'); }
      if (g.hash !== hash || g.toNode !== toNode || g.roomId !== roomId) throw fail(tr('没有这份授权'), 'EJOINT_NO_GRANT');
      g.used = true;
      grants.delete(grantId);
      const transferId = token();
      transfers.set(transferId, { hash: g.hash, size: g.size, name: g.name, toNode, roomId, state: 'pending' });
      return { transferId };
    },
    getTransfer(transferId, roomId) {
      const t = transfers.get(transferId);
      return t && t.roomId === roomId ? t : null;
    },
    drop(transferId) { transfers.delete(transferId); },
    revokeGrant(grantId) { grants.delete(grantId); },
  };
}

// ---------------- 分块接收 ----------------
// 收到的字节先写 .partial（随机存储名，0600），finish 时校验哈希与总长，过了才原子落名。
// 显示名只进 meta.json，绝不进路径（远端不能指定落点）。
export class Receiver {
  // 收件箱放在用户数据目录下：Windows 上没有单独的 DACL（Node 的 mode 管不到），
  // 靠用户目录本身的权限兜住；协议文档里已如实写明「Windows 未单独验收」。
  constructor(rootDir) { this.root = rootDir; this.transfers = new Map(); }
  #dir(roomId, transferId) {
    // roomId、transferId 都可能出现在远端给的东西里，同样严格校验，并做包含性检查
    const bad = (v) => !/^[A-Za-z0-9_-]+$/.test(v);
    if (bad(roomId) || bad(transferId)) throw fail(tr('传输编号不合法'), 'EJOINT_BAD_ID');
    const dir = path.resolve(this.root, roomId, transferId);
    if (dir !== this.root && !dir.startsWith(path.resolve(this.root) + path.sep)) throw fail(tr('传输编号不合法'), 'EJOINT_BAD_ID');
    return dir;
  }
  async begin(roomId, transferId, { name, size, hash, fromNode }) {
    if (size > MAX_FILE_BYTES) throw fail(tr('文件超过 {limit} 的单文件上限', { limit: '100 MiB' }), 'EJOINT_TOO_BIG');
    const dir = this.#dir(roomId, transferId);
    if (this.transfers.has(transferId)) throw fail(tr('这个传输已经在收了'), 'EJOINT_DUP_TRANSFER');
    const oldMeta = readJsonSafe(path.join(dir, 'meta.json'));
    if (oldMeta?.done) throw fail(tr('这个文件已经收过了'), 'EJOINT_DUP_TRANSFER');
    // 内存里没有这条（多半是重启过）：旧目录只是半份没校验过的文件，清掉重新收，别让恢复卡死
    await fs.promises.rm(dir, { recursive: true, force: true }); // 旧目录（重启残留的半份）直接清掉重收
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ name, size, hash, fromNode, at: Date.now() }), { mode: 0o600 });
    const partial = path.join(dir, `${crypto.randomUUID()}.partial`);
    await fs.promises.writeFile(partial, '', { mode: 0o600 });
    // 校验基准存在本机状态里，不取 peer 自报值；状态机：receiving → finalizing → done
    this.transfers.set(transferId, { roomId, dir, partial, hash, size, state: 'receiving' });
    return { partial, dir };
  }
  #state(roomId, transferId) {
    const t = this.transfers.get(transferId);
    if (!t || t.roomId !== roomId) throw fail(tr('没有这个传输'), 'EJOINT_BAD_ID');
    return t;
  }
  // 同一个传输上的写操作排成串行：改名封口挡不住已经打开的 fd，锁才能保证 finish 之后没有字节再进去
  #queue(transferId, op) {
    const t = this.transfers.get(transferId);
    if (!t) return Promise.reject(fail(tr('没有这个传输'), 'EJOINT_BAD_ID'));
    t.lock = (t.lock || Promise.resolve()).then(op, op); // 前一个失败也继续排，状态由各操作自己核
    return t.lock;
  }
  chunk(roomId, transferId, handle, buf, { maxBytes = MAX_FILE_BYTES } = {}) {
    return this.#queue(transferId, async () => {
      const t = this.#state(roomId, transferId);
      if (t.state !== 'receiving') throw fail(tr('传输已经在收尾，不能再加分块'), 'EJOINT_SEALED');
      if (t.partial !== handle?.partial) throw fail(tr('传输编号不合法'), 'EJOINT_BAD_ID');
      await fs.promises.appendFile(t.partial, buf);
      const st = await fs.promises.stat(t.partial);
      if (st.size > maxBytes) {
        // 已经在这把锁里，不能再走 cancel 排队（会等自己）；直接清理
        this.transfers.delete(transferId);
        await fs.promises.rm(t.dir, { recursive: true, force: true });
        throw fail(tr('文件超过 {limit} 的单文件上限', { limit: '100 MiB' }), 'EJOINT_TOO_BIG');
      }
      return st.size;
    });
  }
  // 收尾：先把分块文件原子改名成 .sealing——之后的 chunk 会因为找不到 partial 被拒，
  // 「校验的内容」和「落盘的内容」就锁在同一个文件上，不再有并发窗口。
  finish(roomId, transferId) {
    return this.#queue(transferId, async () => {
    const t = this.#state(roomId, transferId);
    if (t.state !== 'receiving') throw fail(tr('这个传输已经收尾过了'), 'EJOINT_SEALED');
    t.state = 'finalizing';
    const sealed = `${t.partial}.sealing`;
    try {
      await fs.promises.rename(t.partial, sealed);
    } catch (err) {
      t.state = 'receiving';
      throw err;
    }
    const hash = crypto.createHash('sha256');
    let size = 0;
    const fh = await fs.promises.open(sealed, 'r');
    try {
      const buf = Buffer.alloc(1 << 20);
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        hash.update(buf.subarray(0, bytesRead));
      }
    } finally { await fh.close(); }
    if (size !== t.size || hash.digest('hex') !== t.hash) {
      // 同上：锁内直接清理
      this.transfers.delete(transferId);
      await fs.promises.rm(t.dir, { recursive: true, force: true });
      throw fail(tr('收到的文件校验不过，已丢弃，请重新发送'), 'EJOINT_HASH_MISMATCH');
    }
    const stored = path.join(t.dir, crypto.randomUUID());
    await fs.promises.rename(sealed, stored);
    t.state = 'done';
    return { stored, dir: t.dir };
    });
  }
  cancel(roomId, transferId) {
    const t = this.transfers.get(transferId);
    const run = async () => {
      const tt = this.transfers.get(transferId);
      const dir = tt && tt.roomId === roomId ? tt.dir : this.#dir(roomId, transferId);
      this.transfers.delete(transferId);
      await fs.promises.rm(dir, { recursive: true, force: true });
    };
    return t ? this.#queue(transferId, run).catch(() => {}) : run();
  }
}

// ---------------- WebAuthn（系统认证：Touch ID / Windows Hello） ----------------
// 只用 Node 自带 crypto。挑战值绑定这次的文件哈希和收件节点；断言必须 UP+UV（userVerification: 'required'）。

// 迷你 CBOR 解码：只解 WebAuthn 用到的类型（整数/字节串/文本串/数组/映射），返回 [值, 消耗字节数]。
function cborDecode(buf, offset = 0) {
  const mt = buf[offset] >> 5, val = buf[offset] & 0x1f; // 高 3 位是 major type，低 5 位是附加信息
  let at = offset + 1;
  const readLen = () => {
    if (val < 24) return val;
    if (val === 24) return buf[at++];
    if (val === 25) { const v = buf.readUInt16BE(at); at += 2; return v; }
    if (val === 26) { const v = buf.readUInt32BE(at); at += 4; return v; }
    const v = Number(buf.readBigUInt64BE(at)); at += 8; return v;
  };
  if (mt === 0) return [readLen(), at - offset];
  if (mt === 1) return [-1 - readLen(), at - offset];
  if (mt === 2 || mt === 3) { const n = readLen(); const v = buf.subarray(at, at + n); at += n; return [mt === 2 ? Buffer.from(v) : v.toString('utf8'), at - offset]; }
  if (mt === 4 || mt === 5) {
    const n = readLen(); const out = mt === 4 ? [] : {}; let used = at - offset;
    for (let i = 0; i < n; i++) {
      if (mt === 4) { const [v, u] = cborDecode(buf, offset + used); out.push(v); used += u; }
      else { const [k, uk] = cborDecode(buf, offset + used); const [v, uv] = cborDecode(buf, offset + used + uk); out[k] = v; used += uk + uv; }
    }
    return [out, used];
  }
  if (mt === 7 && val === 20) return [false, 1];
  if (mt === 7 && val === 21) return [true, 1];
  if (mt === 7 && val === 22) return [null, 1];
  throw fail(tr('WebAuthn 数据解析不了'), 'EJOINT_CBOR');
}

// 注册：第一次用系统认证时，老板本机生成一把永不出机的密钥，我们把公钥登记下来。
// 挑战一样绑定场景（这里绑『注册』这个动作本身），5 分钟内一次性。
export function makeRegistrationChallenge({ rpId }) {
  const nonce = crypto.randomBytes(16);
  const challenge = crypto.createHash('sha256')
    .update(`clawchat-file-reg\0${rpId}\0`).update(nonce).digest('base64url');
  return { challenge, nonce: nonce.toString('base64url'), at: Date.now() };
}

// 解析 navigator.credentials.create 的响应：验 type/challenge/origin/rpId/UV，取出凭据公钥。
// 第一版不验 attestation 签名（Touch ID / Windows Hello 的公钥在本机生成、从未离开，
// attStmt 只证明生成时刻，不增加这台机器上的保证），如实按这个范围用。
export function parseAttestation({ clientDataJSON, attestationObject, expectedChallenge, expectedOrigin, rpId }) {
  let client;
  try { client = JSON.parse(clientDataJSON.toString('utf8')); } catch { throw fail(tr('WebAuthn 数据解析不了'), 'EJOINT_CBOR'); }
  if (client.type !== 'webauthn.create') throw fail(tr('注册类型不对'), 'EJOINT_ATTEST');
  if (client.challenge !== expectedChallenge) throw fail(tr('注册挑战对不上，请重试'), 'EJOINT_CHALLENGE');
  if (client.origin !== expectedOrigin) throw fail(tr('注册来自别的站点，已拒绝'), 'EJOINT_ORIGIN');
  const [att] = cborDecode(Buffer.isBuffer(attestationObject) ? attestationObject : Buffer.from(attestationObject));
  if (!att || !att.authData) throw fail(tr('注册数据不完整'), 'EJOINT_ATTEST');
  const reg = parseRegistration({ authenticatorData: Buffer.from(att.authData), rpId });
  return { credentialId: reg.credentialId, cose: reg.cose };
}

// 从注册响应的 authenticatorData 里取出凭据公钥（COSE 格式），存下来以后每次验证用。
export function parseRegistration({ authenticatorData, rpId }) {
  const need = 37 + 18; // rpIdHash(32)+flags(1)+signCount(4)+aaguid(16)+credIdLen(2)，后面至少还有一段 CBOR
  if (!Buffer.isBuffer(authenticatorData) || authenticatorData.length < need) throw fail(tr('注册数据不完整'), 'EJOINT_ATTEST');
  const flags = authenticatorData[32];
  if ((flags & 0x05) !== 0x05) throw fail(tr('注册时没有通过本机身份确认'), 'EJOINT_UV'); // UP(0x01) 和 UV(0x04) 都要置位
  if (!authenticatorData.subarray(0, 32).equals(crypto.createHash('sha256').update(rpId).digest()))
    throw fail(tr('注册来自别的站点，已拒绝'), 'EJOINT_RPID');
  const credLen = authenticatorData.readUInt16BE(53);
  const credId = authenticatorData.subarray(55, 55 + credLen);
  const [cose] = cborDecode(authenticatorData, 55 + credLen);
  return { credentialId: Buffer.from(credId).toString('base64url'), cose };
}

// COSE 公钥 → Node 公钥对象（支持 ES256 / RS256，Touch ID 和 Windows Hello 都是这两类）。走 JWK 导入。
function coseToPublicKey(cose) {
  if (cose[1] === 2 && cose[3] === -7 && cose[-1] === 1) { // EC2 / ES256 / P-256
    return crypto.createPublicKey({ key: {
      kty: 'EC', crv: 'P-256',
      x: Buffer.from(cose[-2]).toString('base64url'),
      y: Buffer.from(cose[-3]).toString('base64url'),
    }, format: 'jwk' });
  }
  if (cose[1] === 3 && cose[3] === -257) { // RSA / RS256
    return crypto.createPublicKey({ key: {
      kty: 'RSA', n: Buffer.from(cose[-1]).toString('base64url'), e: Buffer.from(cose[-2]).toString('base64url'),
    }, format: 'jwk' });
  }
  throw fail(tr('这种本机认证器我们还不支持'), 'EJOINT_ALG');
}

// 挑战值绑定这次的文件哈希、收件节点和本机来源（rpId），5 分钟内一次性。
// WebAuthn 的凭据本来就绑 rpId：127.0.0.1（电脑窗口）和 ts.net（手机）是两套凭据，
// 第一期私钥类文件只允许在电脑上确认，挑战里带上 rpId 让这一点进到签名的材料里。
export function makeChallenge({ fileHash, toNode, rpId }) {
  const nonce = crypto.randomBytes(16);
  const challenge = crypto.createHash('sha256')
    .update(`clawchat-file-auth\0${fileHash}\0${toNode}\0${rpId}\0`).update(nonce).digest('base64url');
  return { challenge, nonce: nonce.toString('base64url'), at: Date.now() };
}

export function challengeValid(c, { now = Date.now } = {}) { return c && now() - c.at < 5 * 60 * 1000; }

// 验证断言：type/challenge/origin 全对、rpId 对、UP+UV 都在、签名用注册时存下的公钥验得过。
// 返回新的签名计数（防重放可以先不启用，第一期挑战一次性已够）。
export function verifyAssertion({ cose, clientDataJSON, authenticatorData, signature, expectedChallenge, expectedOrigin, rpId }) {
  let client;
  try { client = JSON.parse(clientDataJSON.toString('utf8')); } catch { throw fail(tr('WebAuthn 数据解析不了'), 'EJOINT_CBOR'); }
  if (client.type !== 'webauthn.get') throw fail(tr('认证类型不对'), 'EJOINT_ATTEST');
  if (client.challenge !== expectedChallenge) throw fail(tr('认证挑战对不上，请重试'), 'EJOINT_CHALLENGE');
  if (client.origin !== expectedOrigin) throw fail(tr('认证来自别的站点，已拒绝'), 'EJOINT_ORIGIN');
  if (!Buffer.isBuffer(authenticatorData) || authenticatorData.length < 37) throw fail(tr('认证数据不完整'), 'EJOINT_ATTEST');
  const flags = authenticatorData[32];
  if ((flags & 0x05) !== 0x05) throw fail(tr('没有通过本机身份确认'), 'EJOINT_UV'); // UP(0x01) 和 UV(0x04) 都要置位
  if (!authenticatorData.subarray(0, 32).equals(crypto.createHash('sha256').update(rpId).digest()))
    throw fail(tr('认证来自别的站点，已拒绝'), 'EJOINT_RPID');
  const coseObj = typeof cose === 'string' ? cborDecode(Buffer.from(cose, 'base64url'))[0] : cose;
  const key = coseToPublicKey(coseObj);
  const signed = Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
  const ok = crypto.verify('sha256', signed, key, signature);
  if (!ok) throw fail(tr('本机认证签名验不过'), 'EJOINT_SIGNATURE');
  return authenticatorData.readUInt32BE(33);
}
