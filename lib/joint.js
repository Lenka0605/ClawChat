// 联合群：主持方这一侧（协议见 docs/joint-protocol.md）。
// 主持方存公开聊天记录、算轮到谁；对方的 AI 在对方电脑上跑：主持方把任务放进队列，对方的 ClawChat 主动来领、交结果。
// 认人三道：Tailscale 登录名（server 那边核对）、设备令牌（这里只存哈希）、令牌只绑定一个群。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DATA_DIR } from './store.js';
import { AGENTS } from './agents.js';
import { tr } from './i18n.js';

const DIR = path.join(DATA_DIR, 'joint');
const HOST_FILE = path.join(DIR, 'host.json');
const NODE_FILE = path.join(DIR, 'node.json');
const INVITE_TTL = 10 * 60 * 1000;
const PAIR_TTL = 15 * 60 * 1000;
const LEASE_MS = 90 * 1000;
const QUEUE_TIMEOUT = 2 * 60 * 1000; // 对方一直没来领（不在线）：两分钟后这一轮算失败，免得群里一直「正在干」
const WAIT_MAX = 25 * 1000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_ID = /^[a-z][a-z0-9]{0,31}$/;

const rand = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 本机节点编号：第一次用时生成，之后不变
export function nodeId() {
  const saved = readJson(NODE_FILE, null);
  if (saved && /^[a-f0-9]{12}$/.test(saved.nodeId)) return saved.nodeId;
  const id = crypto.randomBytes(6).toString('hex');
  writeJson(NODE_FILE, { nodeId: id });
  return id;
}

// 拆回复：<私聊…> 里的（可以嵌套、没写结束标签的算到结尾）一律留在本机，只有外面的能公开。
// 和 worker 的 splitJointReply 同一套按层数数的拆法：非贪婪正则遇到嵌套会把外层的尾巴漏到公开里
export function splitPrivate(text) {
  const source = String(text || '');
  let depth = 0;
  let offset = 0;
  let pub = '';
  let priv = '';
  for (const m of source.matchAll(/<(\/?)(私聊[^<>]*|群聊)>/gu)) {
    const chunk = source.slice(offset, m.index);
    if (depth) priv += chunk;
    else pub += chunk;
    if (m[2].startsWith('私聊')) depth = m[1] ? Math.max(0, depth - 1) : depth + 1;
    offset = m.index + m[0].length;
  }
  if (depth) priv += source.slice(offset);
  else pub += source.slice(offset);
  return { pub: pub.trim(), priv: priv.trim() };
}

// 公开出口一律再剥一次（第二道防线）
export const publicPart = (text) => splitPrivate(text).pub;

// 线上成员 key：<nodeId>_<agentId>（Windows 文件名里不能有冒号，所以用下划线）
export const memberKey = (node, agent) => `${node}_${agent}`;
export function splitKey(key) {
  const m = /^([a-f0-9]{12})_([a-z][a-z0-9]{0,31})$/.exec(String(key || ''));
  return m ? { node: m[1], agent: m[2] } : null;
}

// 联合群里每位 AI 的名字都带上主人：两边老板、两边 AI 看到的是同一套名字，单写 @Claude 才不会叫错人
export const ownedName = (name, owner) => (owner ? `${name}·${owner}` : name);

export class JointHost extends EventEmitter {
  constructor(store, hub, { now = Date.now } = {}) {
    super();
    this.store = store;
    this.hub = hub;
    this.now = now;
    this.data = readJson(HOST_FILE, { invites: {}, peers: {} });
    this.data.invites ||= {};
    this.data.peers ||= {};
    this.pairs = new Map(); // pairId -> 待确认 / 已同意待领令牌的配对（只在内存里：重启后对方重新用邀请码加入）
    this.jobs = new Map(); // jobId -> 任务
    this.logs = new Map(); // roomId -> { seq, list }
    this.waiters = new Set(); // 长轮询在等的请求
    this.self = nodeId();
    for (const room of this.store.listRooms()) if (room.joint?.role === 'host') this.registerRoom(room);
  }

  save() {
    writeJson(HOST_FILE, this.data);
  }

  wake() {
    for (const w of [...this.waiters]) w();
  }

  // ---- 建群、邀请 ----

  // 本机这边成员在联合群里的名字带上本机老板的称呼（只多认一种写法，别的群不受影响）
  aliasLocal(room) {
    for (const a of room.members) {
      const agent = AGENTS[a];
      if (!agent || agent.remote) continue;
      const alias = ownedName(agent.name, room.joint.selfName).toLowerCase();
      const list = agent.aliases || [agent.id];
      if (!list.includes(alias)) agent.aliases = [...list, alias];
    }
  }

  // 对方的成员注册成「远程成员」：hub 照常把它当成员轮流叫，真正跑的时候走任务队列
  registerRemote(room, peer) {
    for (const a of peer.agents) {
      const id = memberKey(peer.nodeId, a.id);
      const name = ownedName(a.name, peer.ownerName);
      AGENTS[id] = {
        id,
        name,
        label: name,
        fullName: tr('{name}（{owner} 电脑上的 AI）', { name, owner: peer.ownerName }),
        engine: 'joint',
        remote: true,
        node: peer.nodeId,
        remoteAgent: a.id,
        base: undefined,
        aliases: [name.toLowerCase()],
      };
    }
  }

  registerRoom(room) {
    this.aliasLocal(room);
    const peer = this.data.peers[room.id];
    if (peer) this.registerRemote(room, peer);
  }

  createRoom({ name, members, ownerName, cwd }) {
    const locals = [...new Set((members || []).filter((a) => AGENTS[a] && !AGENTS[a].remote))];
    if (!locals.length) throw Object.assign(new Error(tr('至少选一位自己这边的 AI')), { status: 400 });
    const selfName = clip(ownerName, 20) || tr('我');
    const room = this.store.createRoom({
      name: clip(name, 60) || tr('联合群'),
      cwd,
      members: locals,
      permission: 'readonly', // 第一期一律讨论档；真正的限制在 runAgent 的 jointDiscussion 里
      jointDiscussion: true,
      collab: true,
      joint: { role: 'host', selfNode: this.self, selfName, permission: 'discuss', protocol: 1 },
    });
    this.aliasLocal(room);
    return room;
  }

  invite(roomId, publicHost) {
    const room = this.store.getRoom(roomId);
    if (room?.joint?.role !== 'host') throw Object.assign(new Error(tr('只有自己建的联合群才能邀请')), { status: 400 });
    if (this.data.peers[roomId]) throw Object.assign(new Error(tr('这个联合群已经有同事加入了')), { status: 400 });
    if (!publicHost) throw Object.assign(new Error(tr('先在「设置 → 通用」里打开手机访问（Tailscale），同事才连得进来')), { status: 400 });
    const secret = rand();
    const exp = this.now() + INVITE_TTL;
    for (const [k, v] of Object.entries(this.data.invites)) if (v.exp < this.now() || v.roomId === roomId) delete this.data.invites[k];
    this.data.invites[hash(secret)] = { roomId, exp };
    this.save();
    const code = `clawchat-join:${Buffer.from(JSON.stringify({ v: 1, host: publicHost, room: roomId, secret, exp })).toString('base64url')}`;
    return { code, expiresAt: exp };
  }

  // ---- 配对（peer 接口） ----

  pairRequest(login, body) {
    const secret = String(body?.secret || '');
    const key = hash(secret);
    const inv = this.data.invites[key];
    if (!inv || inv.exp < this.now()) throw Object.assign(new Error(tr('邀请码已失效，请让对方重新生成')), { status: 410 });
    if (body?.protocol !== 1) throw Object.assign(new Error(tr('对方的 ClawChat 版本不同，请双方都升级到最新版')), { status: 409 });
    if (!ID.test(body.nodeId || '') || !/^[a-f0-9]{12}$/.test(body.nodeId) || body.nodeId === this.self) throw Object.assign(new Error('bad node'), { status: 400 });
    const agents = (Array.isArray(body.agents) ? body.agents : [])
      .slice(0, 12)
      .filter((a) => AGENT_ID.test(a?.id || ''))
      .map((a) => ({ id: a.id, name: clip(a.name, 30) || a.id, engine: clip(a.engine, 20) }));
    if (!agents.length) throw Object.assign(new Error(tr('对方没有派 AI 进来')), { status: 400 });
    delete this.data.invites[key]; // 一次性：用过就作废
    this.save();
    const pairId = rand(12);
    const check = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const pair = {
      pairId,
      roomId: inv.roomId,
      login,
      secretHash: key,
      nodeId: body.nodeId,
      nodeName: clip(body.nodeName, 60),
      ownerName: clip(body.ownerName, 20) || clip(String(login).split('@')[0], 20),
      agents,
      check,
      status: 'waiting',
      at: this.now(),
    };
    this.pairs.set(pairId, pair);
    this.emit('pair', this.pairView(pair));
    return { pairId, code: check };
  }

  pairView(p) {
    return { pairId: p.pairId, roomId: p.roomId, login: p.login, nodeName: p.nodeName, ownerName: p.ownerName, check: p.check, agents: p.agents.map((a) => ({ id: a.id, name: a.name, engine: a.engine })), status: p.status };
  }

  pendingPairs() {
    return [...this.pairs.values()].filter((p) => p.status === 'waiting' && this.now() - p.at < PAIR_TTL).map((p) => this.pairView(p));
  }

  // 主持方老板点同意 / 拒绝
  decide(pairId, approve) {
    const p = this.pairs.get(pairId);
    if (!p || p.status !== 'waiting' || this.now() - p.at > PAIR_TTL) throw Object.assign(new Error(tr('这个加入申请已经失效了')), { status: 410 });
    const room = this.store.getRoom(p.roomId);
    if (!room) throw Object.assign(new Error(tr('这个联合群已经删掉了')), { status: 410 });
    if (!approve) {
      p.status = 'rejected';
      return { ok: true };
    }
    const token = rand();
    p.status = 'approved';
    p.token = token; // 只在内存里放到对方来领为止
    // epoch：这一次配对的代次。换人、重新配对、撤权以后都不一样，传文件等能力要绑它（不能只认节点号）
    this.data.peers[room.id] = { login: p.login, nodeId: p.nodeId, nodeName: p.nodeName, ownerName: p.ownerName, agents: p.agents, tokenHash: hash(token), pairedAt: this.now(), epoch: rand(12) };
    this.save();
    this.wake();
    this.registerRemote(room, this.data.peers[room.id]);
    const ids = p.agents.map((a) => memberKey(p.nodeId, a.id));
    this.store.updateRoom(room.id, { members: [...room.members.filter((a) => !ids.includes(a)), ...ids], joint: { ...room.joint, peerNode: p.nodeId, peerName: p.ownerName, peerLogin: p.login } });
    this.pushRoom(room.id);
    this.hub.notice(room.id, tr('{owner} 加入了联合群，带来了 {names}', { owner: p.ownerName, names: p.agents.map((a) => ownedName(a.name, p.ownerName)).join('、') }));
    this.emit('rooms');
    return { ok: true };
  }

  // 对方来领令牌：要带邀请秘密，还得是同一个 Tailscale 账号
  pairStatus(login, pairId, bearer) {
    const p = this.pairs.get(pairId);
    if (!p || !same(hash(bearer), p.secretHash) || p.login !== login) throw Object.assign(new Error('not found'), { status: 404 });
    if (p.status === 'rejected') throw Object.assign(new Error(tr('对方拒绝了加入申请')), { status: 403 });
    if (p.status === 'waiting') {
      if (this.now() - p.at > PAIR_TTL) throw Object.assign(new Error(tr('加入申请已过期')), { status: 410 });
      return { status: 202, body: { status: 'waiting' } };
    }
    if (!p.token) throw Object.assign(new Error('gone'), { status: 410 });
    const token = p.token;
    this.pairs.delete(pairId); // 令牌只发这一次
    const room = this.store.getRoom(p.roomId);
    return { status: 200, body: { token, room: { id: room.id, name: room.name, members: this.membersView(room) } } };
  }

  // ---- 认证 peer 请求 ----

  // 返回这个请求能访问的联合群（对不上一律 null）
  authorize(login, roomId, bearer) {
    const peer = this.data.peers[roomId];
    if (!peer || !bearer || peer.login !== login || !same(hash(bearer), peer.tokenHash)) return null;
    const room = this.store.getRoom(roomId);
    return room?.joint?.role === 'host' ? { room, peer } : null;
  }

  // ---- 公开内容（发给对方的都从这里过：只有这个联合群的公开消息） ----

  wireFrom(room, from) {
    if (from === 'user' || from === 'system') return from;
    if (AGENTS[from]?.remote) return from;
    return memberKey(this.self, from);
  }

  membersView(room) {
    const peer = this.data.peers[room.id];
    return room.members.map((a) => {
      const agent = AGENTS[a];
      const remote = !!agent?.remote;
      const base = remote ? peer?.agents.find((x) => x.id === agent.remoteAgent) : null;
      return {
        key: remote ? a : memberKey(this.self, a),
        agentId: remote ? agent.remoteAgent : a,
        name: remote ? base?.name || agent.name : agent?.name || a,
        owner: remote ? peer?.ownerName || '' : room.joint.selfName,
        node: remote ? agent.node : this.self,
        engine: remote ? base?.engine || '' : agent?.engine || '',
      };
    });
  }

  publicMessage(room, m) {
    if (!m || m.dm || m.pm || m.lost) return null;
    if (m.from === 'system' && !m.text) return null;
    const from = this.wireFrom(room, m.from);
    const out = { id: String(m.seq), from, ts: m.ts, text: publicPart(m.text).slice(0, 64 * 1024) };
    if (from === 'user') out.node = m.node || this.self;
    if (from !== 'user' && from !== 'system') out.fromName = AGENTS[m.from]?.remote ? AGENTS[m.from].name : ownedName(AGENTS[m.from]?.name || m.from, room.joint.selfName);
    else if (from === 'user') out.fromName = out.node === this.self ? room.joint.selfName : this.data.peers[room.id]?.ownerName || '';
    if (m.replyTo) out.replyTo = { id: String(m.replyTo.seq), from: this.wireFrom(room, m.replyTo.from) };
    if (m.images?.length) out.images = m.images.length; // 第一期不传图片本身，只告诉对方有几张
    return out;
  }

  eventLog(roomId) {
    if (!this.logs.has(roomId)) {
      const file = path.join(DIR, 'events', `${roomId}.json`);
      this.logs.set(roomId, readJson(file, { seq: 0, list: [] }));
    }
    return this.logs.get(roomId);
  }

  pushEvent(roomId, event) {
    const log = this.eventLog(roomId);
    log.seq += 1;
    log.list.push({ seq: log.seq, ...event });
    if (log.list.length > 5000) log.list = log.list.slice(-5000);
    writeJson(path.join(DIR, 'events', `${roomId}.json`), log);
    this.wake();
  }

  // 群名、成员变了：告诉对方（对方的镜像群靠它显示名字和成员）
  pushRoom(roomId) {
    const room = this.store.getRoom(roomId);
    if (room?.joint?.role !== 'host') return;
    this.pushEvent(roomId, { type: 'room', room: { name: room.name, hostOwner: room.joint.selfName, hostNode: this.self }, members: this.membersView(room) });
  }

  // hub 每发一条消息都会到这里：联合群的公开消息记进事件流
  onMessage(roomId, message) {
    const room = this.store.getRoom(roomId);
    if (room?.joint?.role !== 'host') return;
    const msg = this.publicMessage(room, message);
    if (msg) this.pushEvent(roomId, { type: 'message', msg });
  }

  // 等的时候对方可能被撤权、换了令牌：等完以后还得是同一份授权，不然这次请求作废
  still(room, peer) {
    if (this.data.peers[room.id] !== peer || this.store.getRoom(room.id)?.joint?.role !== 'host') throw Object.assign(new Error('not found'), { status: 404 });
  }

  async events(room, after, wait, peer) {
    const pick = () => this.eventLog(room.id).list.filter((e) => e.seq > after);
    let list = pick();
    if (!list.length && wait) {
      await this.waitFor(() => pick().length > 0 || this.data.peers[room.id] !== peer, wait);
      this.still(room, peer);
      list = pick();
    }
    // 第一次连上（游标 0）：先给群名和成员，再把已有的公开历史补上
    if (after === 0 && !this.eventLog(room.id).list.some((e) => e.type === 'room')) {
      this.pushRoom(room.id);
      for (const m of this.store.getMessages(room.id)) this.onMessage(room.id, m);
      list = pick();
    }
    return { events: list.slice(0, 500), members: this.membersView(room), online: true };
  }

  waitFor(ready, ms) {
    return new Promise((resolve) => {
      if (ready()) return resolve();
      const done = () => {
        if (!ready()) return;
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve();
      }, Math.min(ms, WAIT_MAX));
      timer.unref?.();
      this.waiters.add(done);
    });
  }

  // ---- 对方老板发言 ----

  peerMessage(room, peer, body) {
    const clientId = String(body?.clientId || '');
    if (!ID.test(clientId)) throw Object.assign(new Error('bad clientId'), { status: 400 });
    peer.seen ||= [];
    if (peer.seen.includes(clientId)) return { ok: true, duplicate: true };
    const text = String(body?.text || '').slice(0, 32 * 1024);
    if (!text.trim()) throw Object.assign(new Error('empty'), { status: 400 });
    // @ 以对方传来的成员 key 为准（不靠解析正文：两边对「@Claude」理解不一样）
    const mentions = (Array.isArray(body.mentions) ? body.mentions : [])
      .map((k) => {
        const s = splitKey(k);
        if (!s) return null;
        if (s.node === this.self) return room.members.includes(s.agent) ? s.agent : null;
        return room.members.includes(k) ? k : null;
      })
      .filter(Boolean);
    let replyTo = null;
    if (body.replyTo?.id !== undefined) {
      const m = this.store.getMessages(room.id)[Number(body.replyTo.id)];
      if (m && !m.dm && !m.pm) replyTo = { seq: m.seq, from: m.from, text: String(m.text || '').slice(0, 200) };
    }
    peer.seen = [...peer.seen.slice(-199), clientId];
    this.save();
    this.hub.postPeerMessage(room.id, { text, node: peer.nodeId, mentions, replyTo });
    return { ok: true };
  }

  // ---- 任务队列 ----

  // hub 叫远程成员干活时走这里（和 runAgent 一样返回 { done, kill }）
  run(agentId, opts) {
    const agent = AGENTS[agentId];
    const room = opts.room;
    const jobId = rand(16);
    let resolve;
    const done = new Promise((r) => (resolve = r));
    const job = {
      jobId,
      roomId: room.id,
      node: agent.node,
      agentId: agent.remoteAgent,
      member: agentId,
      status: 'queued',
      lease: null,
      leaseExp: 0,
      createdAt: this.now(),
      context: this.jobContext(room, agentId, opts.messages || []),
      onActivity: opts.onActivity,
      finish: (res) => {
        if (job.status === 'closed') return;
        job.status = 'closed';
        clearTimeout(job.timer);
        setTimeout(() => this.jobs.delete(jobId), 10 * 60 * 1000).unref?.();
        resolve(res);
      },
    };
    job.timer = setTimeout(() => this.expire(job), QUEUE_TIMEOUT);
    job.timer.unref?.();
    this.jobs.set(jobId, job);
    this.wake();
    return {
      done,
      kill: async () => {
        if (job.status === 'closed') return true;
        if (job.status === 'leased') this.pushEvent(job.roomId, { type: 'job.cancelled', jobId });
        job.finish({ ok: false, error: tr('已停止') });
        return true;
      },
    };
  }

  jobContext(room, agentId, messages) {
    const peer = this.data.peers[room.id];
    return {
      room: { name: room.name },
      self: { key: agentId, name: AGENTS[agentId]?.name },
      hostOwner: room.joint.selfName,
      peerOwner: peer?.ownerName || '',
      members: this.membersView(room).map((m) => ({ key: m.key, name: ownedName(m.name, m.owner), mine: m.node === peer?.nodeId })),
      messages: messages.map((m) => this.publicMessage(room, m)).filter(Boolean),
    };
  }

  expire(job) {
    if (job.status === 'closed') return;
    if (job.status === 'leased' && job.leaseExp > this.now()) {
      job.timer = setTimeout(() => this.expire(job), job.leaseExp - this.now() + 50);
      job.timer.unref?.();
      return;
    }
    const peer = this.data.peers[job.roomId];
    const who = peer?.ownerName || tr('对方');
    job.finish({ ok: false, error: job.status === 'queued' ? tr('{owner} 的 ClawChat 不在线，这一轮没法回话', { owner: who }) : tr('{owner} 的 ClawChat 没回应（可能断线了），这一轮先算了', { owner: who }) });
  }

  // alive：这个请求的连接还在不在。对方重启时，旧连接留下的长轮询主持方不一定马上知道；
  // 连接已经断了还把任务派给它，任务就丢了（要等租约过期才知道），所以派之前先看一眼
  async claim(room, peer, wait, alive = () => true) {
    const find = () => [...this.jobs.values()].find((j) => j.roomId === room.id && j.node === peer.nodeId && j.status === 'queued');
    let job = find();
    if (!job && wait) {
      await this.waitFor(() => !!find() || this.data.peers[room.id] !== peer || !alive(), wait);
      this.still(room, peer);
      job = find();
    }
    if (!job || !alive()) return { job: null };
    job.status = 'leased';
    job.lease = rand();
    job.leaseExp = this.now() + LEASE_MS;
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.expire(job), LEASE_MS + 50);
    job.timer.unref?.();
    job.onActivity?.();
    return { job: { jobId: job.jobId, agentId: job.agentId, nodeId: job.node, roomId: job.roomId, lease: job.lease, context: job.context } };
  }

  ownJob(room, peer, jobId, lease) {
    const job = this.jobs.get(jobId);
    if (!job || job.roomId !== room.id || job.node !== peer.nodeId) throw Object.assign(new Error('not found'), { status: 410 });
    if (!job.lease || !same(String(lease || ''), job.lease)) throw Object.assign(new Error('lease'), { status: 409 });
    // 定时器可能还没轮到：按实际时间算，过期了就当场关掉，不收这份结果、也不续租
    if (job.status === 'leased' && this.now() > job.leaseExp) {
      this.expire(job);
      throw Object.assign(new Error('expired'), { status: 410 });
    }
    return job;
  }

  heartbeat(room, peer, jobId, body) {
    const job = this.ownJob(room, peer, jobId, body?.lease);
    if (job.status === 'closed') return { cancelled: true };
    job.leaseExp = this.now() + LEASE_MS;
    job.onActivity?.();
    return { cancelled: false };
  }

  result(room, peer, jobId, body) {
    const job = this.ownJob(room, peer, jobId, body?.lease);
    if (job.status === 'closed') {
      if (job.delivered) return { ok: true, duplicate: true };
      throw Object.assign(new Error('closed'), { status: 410 });
    }
    job.delivered = true;
    const ok = !!body?.ok;
    job.finish(ok ? { ok: true, text: String(body.text || '').slice(0, 512 * 1024), steps: [], session: null } : { ok: false, error: clip(body?.error, 300) || tr('对方的 AI 没能回话') });
    return { ok: true };
  }

  // 对方老板按停止：只能停对方自己的成员
  peerStop(room, peer, body) {
    const keys = Array.isArray(body?.agents) ? body.agents : [];
    for (const k of keys) {
      const s = splitKey(k);
      if (!s || s.node !== peer.nodeId || !room.members.includes(k)) continue;
      this.hub.stop(room.id, k);
    }
    return { ok: true };
  }

  presence(room, peer) {
    peer.lastSeen = this.now();
    const was = room.joint.peerOnline;
    if (!was) {
      this.store.updateRoom(room.id, { joint: { ...room.joint, peerOnline: true } });
      this.emit('rooms');
    }
    return { ok: true };
  }

  // 对方三分钟没心跳：标成离线
  sweep() {
    for (const room of this.store.listRooms()) {
      const peer = this.data.peers[room.id];
      if (room.joint?.role !== 'host' || !peer || !room.joint.peerOnline) continue;
      if (this.now() - (peer.lastSeen || 0) > 3 * 60 * 1000) {
        this.store.updateRoom(room.id, { joint: { ...room.joint, peerOnline: false } });
        this.emit('rooms');
      }
    }
  }

  // 对方退出 / 主持方解散：对方的成员从群里拿掉，令牌作废
  removePeer(roomId, why) {
    const peer = this.data.peers[roomId];
    if (!peer) return;
    const room = this.store.getRoom(roomId);
    const ids = peer.agents.map((a) => memberKey(peer.nodeId, a.id));
    for (const id of ids) this.hub.stop(roomId, id);
    for (const j of this.jobs.values()) if (j.roomId === roomId) j.finish({ ok: false, error: tr('对方已经退出联合群') });
    delete this.data.peers[roomId];
    this.save();
    this.wake(); // 正在等的长轮询马上作废
    this.emit('peer-removed', { roomId, epoch: peer.epoch, nodeId: peer.nodeId }); // 传文件那边据此作废这位的待取文件
    if (room) {
      this.store.updateRoom(roomId, { members: room.members.filter((a) => !ids.includes(a)), joint: { role: 'host', selfNode: room.joint.selfNode, selfName: room.joint.selfName, permission: 'discuss', protocol: 1 } });
      if (why) this.hub.notice(roomId, why);
    }
    for (const id of ids) if (!this.store.listRooms().some((r) => r.members.includes(id))) delete AGENTS[id];
    this.emit('rooms');
  }

  // 给界面的样子：令牌、秘密一概不带
  roomView(room) {
    if (!room.joint) return null;
    return { ...room.joint, members: this.membersView(room) };
  }
}
