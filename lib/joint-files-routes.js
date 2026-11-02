// 联合群传文件的路由：peer 接口（对方的 ClawChat 调）+ 本机界面接口（老板的浏览器调）。
// 原则（协议文档「传文件」一节）：授权永远在发送方本机完成；主持方只是中转存储，
// 存的是发送方老板确认过的快照；secret 类按老板拍板的第一期方案：本机电脑确认 + 亲手重输文件名（WebAuthn 留到第二期）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';
import { tr } from './i18n.js';
import { createSnapshot, classifyRisk, MAX_FILE_BYTES, Receiver } from './joint-files.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
// 双实例联调（run-pair.sh）时的测试登录名，和生产里的 Tailscale 身份头对应
const TEST = process.env.CLAWCHAT_JOINT_TEST === '1';
const TEST_LOGIN = () => (TEST && process.env.CLAWCHAT_JOINT_TEST_LOGIN ? { 'x-clawchat-test-login': process.env.CLAWCHAT_JOINT_TEST_LOGIN } : {});
const READY_TTL_MS = 24 * 60 * 60 * 1000; // 待取区文件 24 小时没人拉就清掉
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000; // 收到的文件在收件箱里的保留期（过期清目录，含没拉完的）

// 本机待取区：主持方发出去的、等对方拉走的文件
const TRANSFER_DIR = path.join(DATA_DIR, 'joint-transfer');
// 收件箱：对方发来的、落到本机的文件（协议定的 ~/.clawchat/joint-inbox/）
const INBOX_DIR = path.join(DATA_DIR, 'joint-inbox');
// 发送方本机的快照暂存（确认框和 approve 之间的那一小段时间）
const STAGING_DIR = path.join(DATA_DIR, 'joint-staging');

const idOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
function* iterateFile(file) {
  const fh = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = fs.readSync(fh, buf, 0, buf.length, null);
      if (!n) return;
      yield buf.subarray(0, n);
    }
  } finally { fs.closeSync(fh); }
}
const cleanName = (v) => String(v || '').replace(/[/\\\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
};
// 路径必须还在指定根下面（防止拼接出来的意外落点，Windows 的两种分隔符都考虑）
const inside = (root, p) => {
  const r = path.resolve(root) + path.sep;
  const q = path.resolve(p);
  return q === path.resolve(root) || q.startsWith(r);
};

// 加入方拉文件用的二进制请求：和 jointRequest 一样不跟随重定向。
// 传 onChunk 时流式接收（先核声明大小，边收边数，超限就停），不传时返回 Buffer。
async function jointFetch(host, route, { token, method = 'GET', body, timeout = 60_000, maxBytes, onChunk } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    let res;
    try {
      res = await fetch(`${host}${route}`, {
        method, body, signal: ctrl.signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', ...TEST_LOGIN() },
        redirect: 'manual',
      });
    } catch (err) {
      // 网络断、超时这类一时的问题：标上 retryable，事件游标不推进，重连后重试这一条
      throw Object.assign(new Error(tr('暂时连不上主持方：{err}', { err: err.message })), { retryable: true });
    }
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      throw Object.assign(new Error(tr('拉取文件失败（{status}）', { status: res.status })), { status: res.status, retryable });
    }
    if (!onChunk) return Buffer.from(await res.arrayBuffer());
    let total = 0;
    for await (const c of res.body) {
      total += c.length;
      if (maxBytes && total > maxBytes) { ctrl.abort(); throw fail(413, tr('文件超过 {limit} 的单文件上限', { limit: '100 MiB' })); }
      await onChunk(c);
    }
    return total;
  } finally { clearTimeout(timer); }
}

export function setupJointFiles({ host, store, hub, guestConnection, self }) {
  const inbox = new Receiver(INBOX_DIR);
  const ready = new Map(); // transferId → { roomId, toNode, name, size, hash, risk, dir, fromNode }
  const pulled = new Map(); // 加入方：已经拉完/在拉的 transferId（防重复拉）

  // ---- 收件箱视图（本机老板看） ----
  function inboxList(roomId) {
    const root = path.join(INBOX_DIR, roomId);
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).flatMap((tid) => {
      const meta = readJson(path.join(root, tid, 'meta.json'));
      if (!meta || !meta.done) return [];
      const stored = meta.stored && inside(path.join(root, tid), meta.stored) ? meta.stored : null;
      if (!stored || !fs.existsSync(stored)) return [];
      return [{ transferId: tid, name: cleanName(meta.name), size: meta.size, fromNode: meta.fromNode, at: meta.at }];
    });
  }

  host.on?.('peer-removed', ({ roomId, epoch }) => {
    const root = path.join(TRANSFER_DIR, roomId);
    if (!fs.existsSync(root)) return;
    for (const tid of fs.readdirSync(root)) {
      const dir = path.join(root, tid);
      const meta = readJson(path.join(dir, 'meta.json'));
      if (meta && meta.toEpoch === epoch) { fs.rmSync(dir, { recursive: true, force: true }); ready.delete(tid); }
    }
  });

  // ---- 主持方：把快照放进待取区（approve 时本机一步完成，不需要 HTTP 分块） ----
  function stageTransfer(roomId, { name, size, hash, toNode, risk, fromNode }) {
    const tid = crypto.randomBytes(16).toString('base64url');
    const dir = path.join(TRANSFER_DIR, roomId, tid);
    if (!inside(TRANSFER_DIR, dir)) throw fail(400, tr('传输编号不合法'));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { tid, dir };
  }

  function metaOf(roomId, tid, root) {
    if (!idOk(tid)) throw fail(404, tr('没有这个传输'));
    const dir = path.join(root, roomId, tid);
    if (!inside(root, dir)) throw fail(404, tr('没有这个传输'));
    const meta = readJson(path.join(dir, 'meta.json'));
    if (!meta) throw fail(404, tr('没有这个传输'));
    return { meta, dir };
  }

  // ---- 定期清理：过期的待取区文件和收件箱暂存 ----
  const sweep = () => {
    for (const root of [TRANSFER_DIR, INBOX_DIR]) {
      if (!fs.existsSync(root)) continue;
      for (const roomDir of fs.readdirSync(root)) {
        const roomPath = path.join(root, roomDir);
        if (!inside(root, roomPath)) continue;
        for (const tid of fs.readdirSync(roomPath)) {
          const dir = path.join(roomPath, tid);
          if (!inside(roomPath, dir)) continue;
          const meta = readJson(path.join(dir, 'meta.json'));
          if (!meta) { fs.rmSync(dir, { recursive: true, force: true }); continue; } // 没收完的暂存直接清
          if (root === INBOX_DIR && meta.done) continue; // 已收好的文件一直留着，等老板自己删
          const age = Date.now() - (meta.at || 0);
          if (root === TRANSFER_DIR && age > READY_TTL_MS) { fs.rmSync(dir, { recursive: true, force: true }); ready.delete(tid); }
        }
      }
    }
  };
  const sweeper = setInterval(sweep, 30 * 60 * 1000);
  sweeper.unref?.();

  // 加入方老板确认发送：本机快照已经选好，把这份快照推给主持方（主持方按节点身份接收、转存待取区）。
  // secret 在上面已经按「电脑确认 + 重输文件名」核过；路径不出本机，meta 里只有名字。
  async function approveAsGuest(req, res, { send, body, room }) {
    const conn = guestConnection(room.id);
    if (!conn) throw fail(503, tr('还没有连上主持方，稍后再试'));
    const stagingFile = path.join(STAGING_DIR, `${String(body.staging || '')}.snap`);
    if (!idOk(String(body.staging || '')) || !inside(STAGING_DIR, stagingFile) || !fs.existsSync(stagingFile)) throw fail(400, tr('请重新选择要发的文件'));
    // 冻结记录说了算：改名、改大小都绕不开快照时的判定
    const sidecar = readJson(`${stagingFile}.name`) || {};
    if (!sidecar.name || sidecar.size == null || !sidecar.hash) throw fail(400, tr('请重新选择要发的文件'));
    if (String(body.name || '') !== sidecar.name || Number(body.size) !== sidecar.size)
      throw fail(400, tr('文件和刚选的不一致，请重新选择'));
    await classifyRisk(stagingFile, sidecar.name); // 快照之后被换内容的话这里会重判拦住（secret 会触发下面的确认检查）
    if (sidecar.risk === 'secret') {
      // 和主持方同一条规矩：本机电脑 + 亲手重输文件名
      const hostName = String(req.headers?.host || '').split(':')[0].toLowerCase();
      const forwarded = Object.keys(req.headers || {}).some((h) => h.startsWith('x-forwarded-'));
      if (forwarded || (hostName !== '127.0.0.1' && hostName !== 'localhost'))
        throw fail(403, tr('私钥类文件请到电脑上确认'));
      if (String(body.confirmName || '') !== sidecar.name)
        throw fail(400, tr('文件名没对上，请重新输入要发送的文件名'));
    }
    const hasher = crypto.createHash('sha256');
    for (const buf of iterateFile(stagingFile)) hasher.update(buf);
    const hash = hasher.digest('hex');
    if (hash !== sidecar.hash) throw fail(400, tr('文件在这段时间被改过，请重新选择'));
    const transferId = crypto.randomBytes(16).toString('base64url');
    const name = cleanName(sidecar.name);
    const size = sidecar.size;
    const base = `/joint/v1/rooms/${conn.roomId}/files`;
    const post = (route, bodyBuf, method = 'POST') => jointFetch(conn.host, `${base}${route}`, { token: conn.token, method, body: bodyBuf });
    await post('/uploads', Buffer.from(JSON.stringify({ transferId, name, size, hash, toNode: room.joint.peerNode || '', fromNode: self })));
    // 分块上传：把暂存文件按 1MiB 切开逐块 PUT
    let offset = 0;
    const fh = fs.openSync(stagingFile, 'r');
    try {
      const buf = Buffer.alloc(1 << 20);
      while (offset < size) {
        const n = fs.readSync(fh, buf, 0, Math.min(buf.length, size - offset), offset);
        if (!n) break;
        await post(`/uploads/${transferId}/chunks`, buf.subarray(0, n), 'PUT');
        offset += n;
      }
    } finally { fs.closeSync(fh); }
    await post(`/uploads/${transferId}/finish`, Buffer.alloc(0));
    fs.rmSync(stagingFile, { force: true });
    fs.rmSync(`${stagingFile}.name`, { force: true });
    return send(res, 200, { transferId, risk: sidecar.risk });
  }

  return {
    // ---- peer：/joint/v1/rooms/:id/files/...（Tailscale 账号、令牌、群范围已由 joint-server 核对） ----
    async peer(req, res, { room, peer, parts, method, send }) {
      const roomId = room.id;
      // 路径形状：/request、/uploads、/uploads/:tid/chunks|finish、/:tid/manifest|content
      const [seg0, seg1, seg2] = parts;
      const sub = seg2 || ((seg0 === 'request' || seg0 === 'uploads') ? seg0 : seg1);
      const tid = seg2 ? seg1 : seg0; // 动作在 seg2 时编号在 seg1，其余编号在 seg0
      // 有正文的接口：先把正文/分块读完，动手之前再核对一遍授权（撤权即作废）
      const readRaw = () => new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', (c) => { total += c.length; if (total > MAX_FILE_BYTES) { reject(fail(413, tr('文件超过 {limit} 的单文件上限', { limit: '100 MiB' }))); req.destroy(); } else chunks.push(c); });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });

      if (sub === 'request' && method === 'POST') {
        const raw = await readRaw();
        host.still(room, peer);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const name = cleanName(body.name);
        const size = Math.min(Number(body.size) || 0, MAX_FILE_BYTES);
        const purpose = String(body.purpose || '').slice(0, 500);
        // 只进主持方老板的界面，不进 AI 的上下文、不进事件流里的公开正文
        hub.emit('event', { type: 'joint-file-request', roomId, from: peer.ownerName, node: peer.nodeId, name, size, purpose });
        return send(res, 200, { ok: true });
      }

      // 对方发文件给主持方：登记收件、按序分块、收尾校验后进收件箱
      if (seg0 === 'uploads' && !seg1 && method === 'POST') {
        const raw = await readRaw();
        host.still(room, peer);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        if (body.toNode !== self) throw fail(400, tr('这份文件不是发给这台电脑的'));
        const handle = await inbox.begin(roomId, String(body.transferId || ''), {
          name: cleanName(body.name), size: Number(body.size) || 0, hash: String(body.hash || ''), fromNode: peer.nodeId,
        });
        return send(res, 200, { ok: true, chunkSize: 1 << 20 });
      }
      if (seg0 === 'uploads' && seg2 === 'chunks' && method === 'PUT') {
        const buf = await readRaw();
        host.still(room, peer);
        await inbox.chunk(roomId, seg1, { partial: inbox.transfers.get(seg1)?.partial }, buf);
        return send(res, 200, { ok: true });
      }
      if (seg0 === 'uploads' && seg2 === 'finish' && method === 'POST') {
        await readRaw();
        host.still(room, peer);
        const { stored } = await inbox.finish(roomId, seg1);
        const meta = readJson(path.join(INBOX_DIR, roomId, seg1, 'meta.json')) || {};
        meta.done = true; meta.stored = path.basename(stored); meta.at = Date.now();
        writeJson(path.join(INBOX_DIR, roomId, seg1, 'meta.json'), meta);
        hub.emit('event', { type: 'joint-file-arrived', roomId, name: cleanName(meta.name), size: meta.size, from: peer.ownerName, transferId: seg1 });
        return send(res, 200, { ok: true });
      }

      // 对方来拉主持方发出去的文件：以落盘的 meta.json 为准（主持方重启后仍能拉），
      // 且只给 meta.toNode 指的那台节点
      if ((sub === 'manifest' || sub === 'content') && tid) {
        await readRaw();
        host.still(room, peer);
        const tid = seg0;
        const { meta, dir } = metaOf(roomId, tid, TRANSFER_DIR);
        if (!meta.ready || meta.toNode !== peer.nodeId) throw fail(404, tr('没有这个传输'));
        if (meta.toEpoch && peer.epoch && meta.toEpoch !== peer.epoch) throw fail(404, tr('没有这个传输')); // 撤权重配过：旧文件对新身份不存在
        if (Date.now() - (meta.at || 0) > READY_TTL_MS) throw fail(410, tr('这份文件已经过期，请对方重新发送')); // 下载入口自己核有效期，不等清扫
        if (sub === 'manifest') return send(res, 200, { name: meta.name, size: meta.size, hash: meta.hash, risk: meta.risk, fromNode: self, transferId: tid });
        const file = path.join(dir, meta.stored || '');
        if (!meta.stored || !inside(dir, file) || !fs.existsSync(file)) throw fail(404, tr('没有这个传输'));
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(fs.readFileSync(file));
        return;
      }
      return send(res, 404, { error: 'not found' });
    },

    // ---- 本机界面：/api/joint/files/...（老板的浏览器；server 已核过本机请求头） ----
    async api(req, res, { parts, method, send, readBody }) {
      const [sub, tid] = parts;

      // 选好文件先在本机做快照和危险判定；路径只在这里出现，不进日志、不进 AI
      if (sub === 'snapshot' && method === 'POST') {
        const body = await readBody(req);
        const snap = await createSnapshot(String(body.path || ''), STAGING_DIR);
        const risk = await classifyRisk(snap.path, snap.name);
        // 冻结记录：风险、文件名、大小、哈希都在快照时定死，approve 只核对不采信请求
        fs.writeFileSync(`${snap.path}.name`, JSON.stringify({ name: snap.name, risk: risk.risk, size: snap.size, hash: snap.hash }), { mode: 0o600 });
        return send(res, 200, { hash: snap.hash, size: snap.size, name: snap.name, staging: path.basename(snap.path, '.snap'), risk });
      }

      // 确认发送：secret 类按「本机电脑确认 + 重输文件名」放行（老板拍板的第一期方案，WebAuthn 留到第二期）。
      // 主持方：快照直接进本机待取区；加入方：本机确认后把这份快照推给主持方中转。
      if (sub === 'approve' && method === 'POST') {
        const body = await readBody(req);
        const room = store.getRoom(String(body.roomId || ''));
        if (!room?.joint) throw fail(404, tr('只有联合群里能传文件'));
        if (room.joint.role === 'guest') return await approveAsGuest(req, res, { send, body, room });
        const stagingFile = path.join(STAGING_DIR, `${String(body.staging || '')}.snap`);
        if (!idOk(String(body.staging || '')) || !inside(STAGING_DIR, stagingFile) || !fs.existsSync(stagingFile)) throw fail(400, tr('请重新选择要发的文件'));
        // 冻结记录说了算：请求里的 name/size 改成什么都绕不开快照时的判定
        const sidecar = readJson(`${stagingFile}.name`) || {};
        if (!sidecar.name || sidecar.size == null || !sidecar.hash) throw fail(400, tr('请重新选择要发的文件'));
        if (String(body.name || '') !== sidecar.name || Number(body.size) !== sidecar.size)
          throw fail(400, tr('文件和刚选的不一致，请重新选择'));
        if (sidecar.risk === 'secret') {
          // 老板定的第一期方案：不用 WebAuthn，改成本机电脑确认 + 老板亲手再输一遍文件名。
          // 手机上（经 Tailscale 进来的都带 x-forwarded-*）一律拒绝；重输的文件名和快照里记的比对。
          const hostName = String(req.headers?.host || '').split(':')[0].toLowerCase();
          const forwarded = Object.keys(req.headers || {}).some((h) => h.startsWith('x-forwarded-'));
          if (forwarded || (hostName !== '127.0.0.1' && hostName !== 'localhost'))
            throw fail(403, tr('私钥类文件请到电脑上确认'));
          if (String(body.confirmName || '') !== sidecar.name)
            throw fail(400, tr('文件名没对上，请重新输入要发送的文件名'));
        }
        const hasher = crypto.createHash('sha256');
        for (const buf of iterateFile(stagingFile)) hasher.update(buf);
        const snapHash = hasher.digest('hex');
        if (snapHash !== sidecar.hash) throw fail(400, tr('文件在这段时间被改过，请重新选择'));
        const { tid: transferId, dir } = stageTransfer(room.id, { toNode: body.toNode });
        const toEpoch = host.data?.peers?.[room.id]?.epoch || '';
        if (!toEpoch) throw fail(400, tr('对方还没有加入，没有可接收的人'));
        const meta = { name: cleanName(sidecar.name), size: sidecar.size, hash: snapHash, toNode: String(body.toNode || ''), toEpoch, risk: sidecar.risk, fromNode: self, at: Date.now(), stored: '' };
        // 快照移进待取区（随机存储名，显示名在 meta 里）
        const stored = path.join(dir, crypto.randomUUID());
        fs.renameSync(stagingFile, stored);
        meta.stored = path.basename(stored);
        meta.ready = true;
        writeJson(path.join(dir, 'meta.json'), meta);
        ready.set(transferId, { roomId: room.id, toNode: meta.toNode, name: meta.name, size: meta.size, hash: meta.hash, risk: sidecar.risk, dir });
        host.pushEvent(room.id, { type: 'file.ready', transferId, name: meta.name, size: meta.size, from: room.joint.selfName });
        return send(res, 200, { transferId, risk: sidecar.risk });
      }

      // 收件箱
      if (sub === 'inbox' && !tid && method === 'GET') {
        const url = new URL(req.url, 'http://local');
        const roomId = url.searchParams.get('roomId') || '';
        if (!store.getRoom(roomId)) throw fail(404, tr('没有这个群'));
        return send(res, 200, { items: inboxList(roomId) });
      }
      if (sub === 'inbox' && tid === 'reveal' && method === 'POST') {
        const body = await readBody(req);
        const roomId = String(body.roomId || '');
        const { dir } = metaOf(roomId, String(body.transferId || ''), INBOX_DIR);
        const meta = readJson(path.join(dir, 'meta.json')) || {};
        const file = meta.stored && inside(dir, path.join(dir, meta.stored)) ? path.join(dir, meta.stored) : null;
        if (!file || !fs.existsSync(file)) throw fail(404, tr('文件不在了'));
        const { spawn } = await import('node:child_process');
        // 只在访达/资源管理器里选中，绝不直接执行
        if (process.platform === 'darwin') spawn('open', ['-R', file], { stdio: 'ignore', detached: true }).unref();
        else if (process.platform === 'win32') spawn('explorer', ['/select,', file], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
        else spawn('xdg-open', [path.dirname(file)], { stdio: 'ignore', detached: true }).unref();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    },

    // ---- 加入方：收到主持方推来的 file.* 事件 ----
    async onGuestEvent(roomId, ev) {
      const conn = guestConnection(roomId);
      const room = store.getRoom(roomId);
      if (!conn || !room) return;
      if (ev.type === 'file.ready') return pullIncoming(roomId, ev);

      if (ev.type === 'file.request') {
        // 对方想要一个文件：只提醒本机老板，内容不进 AI
        hub.emit('event', { type: 'joint-file-request', roomId, from: ev.from, node: ev.node, name: ev.name, size: ev.size, purpose: ev.purpose });
        return;
      }
    },
  };

  // 加入方拉一份文件：manifest 先核大小，content 流式落盘（边收边数，超限就停）
  async function pullIncoming(roomId, ev) {
    const conn = guestConnection(roomId);
    const room = store.getRoom(roomId);
    if (!conn || !room) throw fail(503, tr('还没有连上主持方'));
    const transferId = String(ev.transferId || '');
    if (!idOk(transferId) || pulled.has(transferId)) return;
    pulled.set(transferId, { at: Date.now() });
    const base = `/joint/v1/rooms/${conn.roomId}/files`;
    try {
      const manifestBody = await jointFetch(conn.host, `${base}/${transferId}/manifest`, { token: conn.token });
      const manifest = JSON.parse(manifestBody.toString('utf8'));
      // 先核声明大小再拉内容
      const size = Number(manifest.size) || 0;
      if (size > MAX_FILE_BYTES) throw fail(413, tr('文件超过 {limit} 的单文件上限', { limit: '100 MiB' }));
      // secret 类发送方本机已按「电脑确认 + 重输文件名」核过；收件箱默认不给 AI、不自动打开
      const risk = manifest.risk === 'secret' ? 'secret' : 'normal';
      const handle = await inbox.begin(roomId, transferId, { name: cleanName(manifest.name), size, hash: String(manifest.hash || ''), fromNode: manifest.fromNode || '' });
      try {
        await jointFetch(conn.host, `${base}/${transferId}/content`, {
          token: conn.token, maxBytes: MAX_FILE_BYTES,
          onChunk: (c) => inbox.chunk(roomId, transferId, handle, c),
        });
      } catch (err) {
        await inbox.cancel(roomId, transferId).catch(() => {});
        throw err;
      }
      const { stored } = await inbox.finish(roomId, transferId);
      const meta = readJson(path.join(INBOX_DIR, roomId, transferId, 'meta.json')) || {};
      meta.done = true; meta.stored = path.basename(stored); meta.at = Date.now();
      writeJson(path.join(INBOX_DIR, roomId, transferId, 'meta.json'), meta);
      hub.emit('event', { type: 'joint-file-arrived', roomId, name: cleanName(manifest.name), size, from: ev.from || '', transferId });
    } catch (err) {
      pulled.delete(transferId);
      throw err;
    }
  }
}
