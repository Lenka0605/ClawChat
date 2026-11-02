// 联合群接进服务端：peer 接口（/joint/v1/，对方的 ClawChat 调）、本机界面接口（/api/joint/…）、加入方的镜像群。
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AGENTS } from './agents.js';
import { DATA_DIR } from './store.js';
import { tr } from './i18n.js';
import { JointHost, nodeId, memberKey, splitKey, ownedName, publicPart } from './joint.js';
import { beginJointPair, finishJointPair, JointWorker, storedJointConnections } from './joint-worker.js';
import { parseMentions } from './hub.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const TEST = process.env.CLAWCHAT_JOINT_TEST === '1'; // 一台电脑上模拟两位老板（scripts/fake/run-pair.sh）才打开

export function setupJoint({ store, hub, runAgent, port, appVersion, publicHost }) {
  const host = new JointHost(store, hub);
  const self = host.self;
  const guests = new Map(); // roomId -> { worker, conn }
  const joining = new Map(); // pairId -> 加入中的申请（含邀请秘密，只在内存里，绝不发给界面）

  // ---- 给界面看的样子 ----
  const isRemote = (a) => !!AGENTS[a]?.remote;
  const agentsView = () => Object.fromEntries(Object.entries(AGENTS).filter(([, a]) => !a.remote));
  function roomView(room) {
    if (!room.joint) return room;
    const members = room.members.filter((a) => !isRemote(a));
    if (room.joint.role === 'host') return { ...room, members, jointMembers: host.membersView(room).map(markMine(self)) };
    return { ...room, members, jointMembers: (room.joint.members || []).map(markMine(self)) };
  }
  const markMine = (node) => (m) => ({ ...m, mine: m.node === node, online: m.node === node ? true : undefined });
  hub.roomsView = (rooms) => rooms.map(roomView);

  host.on('pair', (p) => hub.emit('event', { type: 'joint-pair', ...p }));
  host.on('rooms', () => hub.emitRooms());
  hub.on('event', (ev) => {
    if (ev.type === 'message') host.onMessage(ev.roomId, ev.message);
  });
  // 传文件：API 写的 lib/joint-files-routes.js（接口见 docs/joint-protocol.md「传文件」）
  let files = null;
  import('./joint-files-routes.js')
    .then((m) => {
      files = m.setupJointFiles({ host, store, hub, guestConnection: (roomId) => guests.get(roomId)?.conn || null, self });
    })
    .catch((err) => {
      if (err.code !== 'ERR_MODULE_NOT_FOUND') console.error('[clawchat] 联合群传文件没能加载', err.message);
    });
  const sweep = setInterval(() => host.sweep(), 30 * 1000);
  sweep.unref?.();

  // 远程成员交回来的回复：悄悄话部分去掉
  const origResult = host.result.bind(host);
  host.result = (room, peer, jobId, body) => origResult(room, peer, jobId, body?.ok ? { ...body, text: publicPart(body.text) || '[PASS]' } : body);

  // ---- 加入方：镜像群 ----

  function registerHostMembers(room, members) {
    for (const m of members || []) {
      if (m.node === self) continue;
      const k = splitKey(m.key);
      if (!k) continue;
      const name = ownedName(String(m.name || k.agent).slice(0, 30), String(m.owner || '').slice(0, 20));
      AGENTS[m.key] = { id: m.key, name, label: name, fullName: name, engine: 'joint', remote: true, node: k.node, remoteAgent: k.agent, aliases: [name.toLowerCase()] };
    }
    const mine = room.members.filter((a) => !isRemote(a));
    const owner = room.joint.selfName;
    for (const a of mine) {
      const ag = AGENTS[a];
      if (!ag) continue;
      const alias = ownedName(ag.name, owner).toLowerCase();
      if (!(ag.aliases || [ag.id]).includes(alias)) ag.aliases = [...(ag.aliases || [ag.id]), alias];
    }
  }

  // 主持方事件 → 本机镜像群（hub.post 只是记下、推给界面，镜像群从不在本机调度 AI）
  function mirror(roomId) {
    return async (events) => {
      const room = store.getRoom(roomId);
      if (!room) return;
      for (const ev of events) {
        if (ev.type === 'room' && ev.members) {
          const r = store.getRoom(roomId);
          const members = ev.members.slice(0, 24).map((m) => ({ key: String(m.key), agentId: String(m.agentId), name: String(m.name).slice(0, 30), owner: String(m.owner || '').slice(0, 20), node: String(m.node), engine: String(m.engine || '').slice(0, 20) })).filter((m) => splitKey(m.key));
          const peerName = String(ev.room?.hostOwner || '').slice(0, 20);
          store.updateRoom(roomId, { name: r.joint.named ? r.name : String(ev.room?.name || r.name).slice(0, 60), joint: { ...r.joint, members, peerName, peerNode: String(ev.room?.hostNode || '') } });
          registerHostMembers(store.getRoom(roomId), members);
          hub.emitRooms();
          continue;
        }
        if (String(ev.type).startsWith('file.')) {
          try {
            await files?.onGuestEvent?.(roomId, ev);
          } catch (err) {
            console.error('[clawchat] 联合群文件事件没处理好', err.message);
          }
          continue;
        }
        if (ev.type !== 'message' || !ev.msg) continue;
        const w = ev.msg;
        const list = store.getMessages(roomId);
        if (list.some((m) => m.jointId === w.id)) continue; // 重连后重复的
        let from = 'system';
        if (w.from === 'user') from = 'user';
        else if (w.from !== 'system') {
          const k = splitKey(w.from);
          if (!k) continue;
          from = k.node === self ? k.agent : w.from;
          if (from === w.from && !AGENTS[w.from]) {
            const name = String(w.fromName || k.agent).slice(0, 60);
            AGENTS[w.from] = { id: w.from, name, label: name, fullName: name, engine: 'joint', remote: true, node: k.node, remoteAgent: k.agent, aliases: [name.toLowerCase()] };
          }
        }
        const msg = { from, text: String(w.text || ''), jointId: w.id, joint: true };
        if (from === 'user') msg.node = w.node;
        if (w.fromName) msg.fromName = String(w.fromName).slice(0, 60);
        if (w.replyTo) {
          const target = list.find((m) => m.jointId === w.replyTo.id);
          if (target) msg.replyTo = { seq: target.seq, from: target.from, text: String(target.text || '').slice(0, 140) };
        }
        hub.post(roomId, msg);
      }
    };
  }

  function startGuest(room, conn) {
    const mine = room.members.filter((a) => !isRemote(a) && AGENTS[a]);
    const worker = new JointWorker({
      connection: conn,
      agents: mine,
      runAgent,
      room,
      ownerName: room.joint.selfName,
      onEvents: mirror(room.id),
      onStatus: (st) => {
        const r = store.getRoom(room.id);
        if (!r?.joint || r.joint.peerOnline === !!st.online) return;
        store.updateRoom(room.id, { joint: { ...r.joint, peerOnline: !!st.online } });
        hub.emitRooms();
      },
    });
    guests.set(room.id, { worker, conn });
    worker.start();
  }

  // 启动时：恢复以前加入过的联合群
  for (const conn of storedJointConnections()) {
    // 退出过的不恢复（哪怕当时没能通知到主持方）
    const room = store.listRooms().find((r) => r.joint?.role === 'guest' && !r.joint.left && r.joint.hostUrl === conn.host && r.joint.hostRoom === conn.roomId);
    if (!room) continue;
    registerHostMembers(room, room.joint.members);
    try {
      startGuest(room, conn);
    } catch (err) {
      console.error('[clawchat] 联合群连接没恢复', err.message);
    }
  }

  // ---- peer 接口：/joint/v1/… ----

  async function peer(req, res, url, login, { send, readBody }) {
    const parts = url.pathname.split('/').filter(Boolean).slice(2); // 去掉 joint、v1
    const method = req.method;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    try {
      if (parts[0] === 'pair' && !parts[1] && method === 'POST') return send(res, 202, host.pairRequest(login, await readBody(req)));
      if (parts[0] === 'pair' && parts[1] && method === 'GET') {
        const r = host.pairStatus(login, parts[1], bearer);
        return send(res, r.status, r.body);
      }
      if (parts[0] !== 'rooms' || !parts[1]) return send(res, 404, { error: 'not found' });
      if (parts[2] === 'files') {
        const pre = host.authorize(login, parts[1], bearer);
        if (!pre || !files) {
          console.error('[clawchat] 文件接口没放行', parts.join('/'), '授权?', !!pre, '模块?', !!files, 'login?', login || '(空)');
          return send(res, 404, { error: 'not found' });
        }
        // 分块是二进制，由传文件模块自己读；它读完正文、动手之前必须再 host.still(room, peer) 核对一次授权
        return await files.peer(req, res, { room: pre.room, peer: pre.peer, parts: parts.slice(3), method, send });
      }
      // 先把正文读完再验权：对方可以故意慢慢传正文，等这边撤了权再补齐，验权必须在这之后
      const body = method === 'POST' ? await readBody(req) : undefined;
      const auth = host.authorize(login, parts[1], bearer);
      if (!auth) return send(res, 404, { error: 'not found' });
      const { room, peer: p } = auth;
      const sub = parts[2];
      const wait = Math.min(Number(url.searchParams.get('wait')) || 0, 25) * 1000;
      if (sub === 'events' && method === 'GET') {
        host.presence(room, p);
        const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
        const out = await host.events(room, after, wait, p);
        return send(res, 200, { ...out, room: { name: room.name, hostOwner: room.joint.selfName, hostNode: self } });
      }
      if (sub === 'jobs' && !parts[3] && method === 'GET') return send(res, 200, await host.claim(room, p, wait));
      if (sub === 'jobs' && parts[3] && parts[4] === 'heartbeat' && method === 'POST') return send(res, 200, host.heartbeat(room, p, parts[3], body));
      if (sub === 'jobs' && parts[3] && parts[4] === 'result' && method === 'POST') return send(res, 200, host.result(room, p, parts[3], body));
      if (sub === 'messages' && method === 'POST') return send(res, 200, host.peerMessage(room, p, body));
      if (sub === 'stop' && method === 'POST') return send(res, 200, host.peerStop(room, p, body));
      if (sub === 'presence' && method === 'POST') return send(res, 200, host.presence(room, p));
      if (sub === 'leave' && method === 'POST') {
        host.removePeer(room.id, tr('{owner} 退出了联合群', { owner: p.ownerName }));
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (!err.status) console.error('[clawchat] 联合群接口出错', err.stack || err.message);
      return send(res, err.status || 500, { error: err.status ? err.message : 'error' });
    }
  }

  // 这个请求是不是对方的 ClawChat：经 Tailscale 进来、账号不是老板本人（server 的 requestAccess 给的 'peer'）；
  // 测试模式下，本机直接来的请求可以用 x-clawchat-test-login 冒充一个账号（只在 run-pair.sh 里打开）
  function peerLogin(req, access, decodeLogin) {
    if (access === 'peer') return decodeLogin(req.headers['tailscale-user-login']);
    if (TEST && access === 'local' && req.headers['x-clawchat-test-login']) return String(req.headers['x-clawchat-test-login']);
    return null;
  }

  // ---- 本机界面接口：/api/joint/… 和 /api/rooms/:id/joint/… ----

  async function api(req, res, parts, method, { send, readBody, defaultCwd }) {
    if (parts[1] === 'files') {
      if (!files) return send(res, 404, { error: 'not found' });
      return await files.api(req, res, { parts: parts.slice(2), method, send, readBody });
    }
    // POST /api/joint/rooms：新建联合群（主持方）
    if (parts[1] === 'rooms' && method === 'POST') {
      const body = await readBody(req);
      const room = host.createRoom({ name: body.name, members: body.members, ownerName: body.ownerName, cwd: defaultCwd() });
      hub.emitRooms();
      return send(res, 200, { room: roomView(room) });
    }
    if (parts[1] === 'pairs' && method === 'GET') return send(res, 200, { pairs: host.pendingPairs() });
    // 主持方老板同意 / 拒绝
    if (parts[1] === 'pair' && parts[2] && ['approve', 'reject'].includes(parts[3]) && method === 'POST') {
      return send(res, 200, host.decide(parts[2], parts[3] === 'approve'));
    }
    // POST /api/joint/join：加入方提交邀请码
    if (parts[1] === 'join' && !parts[2] && method === 'POST') {
      const body = await readBody(req);
      const mine = [...new Set((body.members || []).filter((a) => AGENTS[a] && !AGENTS[a].remote))];
      if (!mine.length) throw fail(400, tr('至少派一位自己这边的 AI 进去'));
      const ownerName = String(body.ownerName || '').trim().slice(0, 20) || tr('我');
      const code = String(body.code || '').trim();
      const opts = { nodeId: self, nodeName: os.hostname().slice(0, 60), ownerName, agents: mine.map((a) => ({ id: a, name: AGENTS[a].name, engine: AGENTS[a].engine })), appVersion };
      let pending;
      try {
        pending = await beginJointPair(code, opts);
      } catch (err) {
        throw fail(err.status || 400, err.message);
      }
      joining.set(pending.pairId, { pending, mine, ownerName });
      return send(res, 200, { pairId: pending.pairId, check: pending.code });
    }
    if (parts[1] === 'join' && parts[2] && method === 'GET') {
      const j = joining.get(parts[2]);
      if (!j) return send(res, 200, { status: 'expired' });
      let conn;
      try {
        conn = await finishJointPair(j.pending);
      } catch (err) {
        if (err.status === 403) {
          joining.delete(parts[2]);
          return send(res, 200, { status: 'rejected' });
        }
        if (err.status === 410 || /失效|过期/.test(err.message)) {
          joining.delete(parts[2]);
          return send(res, 200, { status: 'expired' });
        }
        return send(res, 200, { status: 'waiting', error: err.message });
      }
      if (!conn) return send(res, 200, { status: 'waiting' });
      joining.delete(parts[2]);
      const room = store.createRoom({
        name: tr('联合群'),
        cwd: defaultCwd(),
        members: j.mine,
        permission: 'readonly',
        jointDiscussion: true,
        collab: true,
        joint: { role: 'guest', selfNode: self, selfName: j.ownerName, permission: 'discuss', protocol: 1, hostUrl: conn.host, hostRoom: conn.roomId, members: [], peerOnline: true },
      });
      startGuest(room, conn);
      hub.emitRooms();
      return send(res, 200, { status: 'approved', roomId: room.id });
    }
    return send(res, 404, { error: 'not found' });
  }

  // 群里的联合群操作：邀请、退出 / 解散
  async function roomApi(req, res, room, sub2, method, { send }) {
    if (sub2 === 'invite' && method === 'POST') {
      const url = TEST ? `http://127.0.0.1:${port}` : publicHost();
      return send(res, 200, host.invite(room.id, url));
    }
    if (sub2 === 'leave' && method === 'POST') {
      if (room.joint.role === 'host') {
        host.removePeer(room.id, tr('联合群已解散，对方的 AI 不再参加'));
        return send(res, 200, { ok: true });
      }
      // 先在本机记下「已退出」、停掉 worker，再去通知主持方：通知失败也不能留着本机继续干活
      store.updateRoom(room.id, { joint: { ...room.joint, left: true, peerOnline: false } });
      const g = guests.get(room.id);
      guests.delete(room.id);
      if (g) {
        try {
          await g.worker.leave();
        } catch {
          // 网络不通：主持方那边过一会儿会把我们标成离线；本机已经不再领任务
        } finally {
          await g.worker.close().catch(() => {});
        }
      }
      hub.notice(room.id, tr('你已经退出了这个联合群，聊天记录留在本机'));
      hub.emitRooms();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  }

  // 加入方老板在镜像群里发言：交给主持方，等事件流把它送回来再显示
  async function guestMessage(room, body) {
    // 第一期联合群里没有私聊：私聊绝不能被当成群消息发给对方
    if (body.dm || body.pm) throw fail(400, tr('联合群里暂时不能私聊'));
    const g = guests.get(room.id);
    if (!g || room.joint.left) throw fail(400, tr('联合群已经断开，发不出去'));
    const text = String(body.text || '').trim();
    if (!text) throw fail(400, tr('消息是空的'));
    const wanted = Array.isArray(body.mentions) ? body.mentions : [];
    const parsed = parseMentions(text).map((a) => (isRemote(a) ? a : AGENTS[a] && room.members.includes(a) ? memberKey(self, a) : null));
    const mentions = [...new Set([...wanted.filter((k) => splitKey(k)), ...parsed.filter(Boolean)])];
    let replyTo;
    if (body.replyTo !== undefined && body.replyTo !== null) {
      const target = store.getMessages(room.id)[Number(body.replyTo)];
      if (target?.jointId) replyTo = { id: target.jointId };
    }
    await g.worker.sendMessage({ clientId: crypto.randomBytes(12).toString('base64url'), text, mentions, replyTo });
  }

  async function guestStop(room, agent) {
    const g = guests.get(room.id);
    if (!g) return;
    const mine = room.members.filter((a) => !isRemote(a));
    await g.worker.stop(agent && mine.includes(agent) ? [agent] : mine).catch(() => {});
  }

  function close() {
    clearInterval(sweep);
    for (const g of guests.values()) g.worker.close().catch(() => {});
  }

  return { host, peer, peerLogin, api, roomApi, roomView, agentsView, guestMessage, guestStop, close, isGuest: (room) => room?.joint?.role === 'guest' };
}
