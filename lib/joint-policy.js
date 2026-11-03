// 联合群第二期：每位老板给自己这边的 AI 定权限档，对方叫它动手前先问老板。
// 档位存在本机的群设置里（room.joint.policy），不发给对方；每位老板只管自己这边的 AI。
//   discuss：只能讨论（第一期的样子，默认）
//   folder ：只能在老板指定的那个文件夹里读写、跑命令；哪家 AI 验收过了才开放（folderEngines）
// 真正的限制在 runAgent 里（room.jointMode === 'folder' + room.jointFolder），这里只决定给哪一档、要不要先问老板。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AGENTS } from './agents.js';
import { tr } from './i18n.js';
import { JOINT_FOLDER_ENGINES, jointFolderProblem } from './joint-discussion.js';

const APPROVAL_TTL = 10 * 60 * 1000; // 老板十分钟没点：当成不同意，这一轮只讨论
const fail = (status, message) => Object.assign(new Error(message), { status });

// 「指定文件夹」档验收过的引擎，以 ChatGPT 的验收结果为准（joint-discussion.js 的 JOINT_FOLDER_ENGINES）
export const folderEngines = () => [...JOINT_FOLDER_ENGINES];
const engineOf = (agentId) => AGENTS[agentId]?.engine;

// 能不能拿来当「指定文件夹」：必须是已有的文件夹，不能是根目录、家目录本身（或它的上级）、ClawChat 自己的数据目录、
// 也不能是装着登录凭据的那些目录
export function checkFolder(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw fail(400, tr('请选一个文件夹'));
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    throw fail(400, tr('找不到这个文件夹'));
  }
  if (!fs.statSync(real).isDirectory()) throw fail(400, tr('请选一个文件夹'));
  const bad = jointFolderProblem(real);
  if (bad) throw fail(400, bad);
  return real;
}

export class JointPolicy extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.pending = new Map(); // approvalId -> 等老板点的审批
  }

  // 某位本机 AI 在这个联合群里的档位（没设过就是讨论档）
  of(room, agentId) {
    const p = room?.joint?.policy?.[agentId];
    if (!p || p.level !== 'folder' || !p.folder || !folderEngines().includes(engineOf(agentId))) return { level: 'discuss' };
    return { level: 'folder', folder: p.folder, confirm: p.confirm !== false };
  }

  view(room) {
    const mine = room.members.filter((a) => AGENTS[a] && !AGENTS[a].remote);
    return {
      engines: folderEngines(),
      // 这台电脑的系统上一家都没验收过（现在只有 Mac 验收了）：界面上说清楚是系统的原因，不是这家 AI 的
      platformReady: process.platform === 'darwin',
      agents: Object.fromEntries(mine.map((a) => {
        const p = room.joint?.policy?.[a] || {};
        return [a, { level: p.level === 'folder' ? 'folder' : 'discuss', folder: p.folder || '', confirm: p.confirm !== false, available: folderEngines().includes(engineOf(a)) }];
      })),
    };
  }

  set(room, body) {
    const next = { ...(room.joint.policy || {}) };
    for (const [a, v] of Object.entries(body?.agents || {})) {
      if (!room.members.includes(a) || !AGENTS[a] || AGENTS[a].remote) continue;
      if (v?.level === 'folder') {
        if (!folderEngines().includes(engineOf(a))) throw fail(400, tr('{name} 还不能在联合群里动手（这家 AI 还没验收过），只能讨论', { name: AGENTS[a].name }));
        next[a] = { level: 'folder', folder: checkFolder(v.folder), confirm: v.confirm !== false };
      } else {
        next[a] = { level: 'discuss', confirm: v?.confirm !== false }; // 讨论档也记住开关，以后切到文件夹档时照样生效
      }
    }
    this.store.updateRoom(room.id, { joint: { ...room.joint, policy: next } });
    return this.view(this.store.getRoom(room.id));
  }

  // 这一轮要不要先问老板：只要这一轮看到的消息里有不是本机老板发的（对方老板、对方 AI、或者被对方带起来的接力），就要问
  // 没拿到这一轮的消息（调用方漏传、空数组）一律当成要问：宁可多问一次，不能当成「全是老板自己发的」
  needsApproval(room, messages) {
    // 系统提示不算谁发的话，不参与判断；去掉之后一条都不剩的，也当成要问
    const said = Array.isArray(messages) ? messages.filter((m) => m && m.from !== 'system') : [];
    if (!said.length) return true;
    return said.some((m) => !this.isOwnBoss(room, m));
  }

  isOwnBoss(room, m) {
    const self = room.joint?.selfNode;
    return m.from === 'user' && (!m.node || m.node === self);
  }

  // 等老板点：同意 → 'folder'；不同意、十分钟没点、或者中途被停了 → 'discuss'
  ask(room, agentId, folder, messages, signal) {
    const approvalId = crypto.randomBytes(9).toString('base64url');
    // 弹框里给老板看的，是这一轮里最后一条「不是本机老板发的」消息——这才是要问老板的原因。
    // 比如对方 AI 说「把 xx 删了」、老板接着回一句「@Claude 好的」：要让老板看到的是前一句，不是「好的」
    const said = [...(Array.isArray(messages) ? messages : [])].reverse().filter((m) => m && m.from !== 'system' && m.text);
    const last = said.find((m) => !this.isOwnBoss(room, m)) || said[0];
    const who = !last ? ''
      : last.from === 'user' ? (this.isOwnBoss(room, last) ? room.joint.selfName || '' : last.fromName || room.joint.peerName || '')
      : AGENTS[last.from]?.name || last.fromName || '';
    const item = {
      approvalId,
      roomId: room.id,
      agentId,
      name: AGENTS[agentId]?.name || agentId,
      folder,
      from: who,
      text: String(last?.text || '').slice(0, 300),
      at: Date.now(),
    };
    return new Promise((resolve) => {
      const done = (ok) => {
        if (!this.pending.has(approvalId)) return;
        this.pending.delete(approvalId);
        clearTimeout(timer);
        this.emit('event', { type: 'joint-approval-done', approvalId, roomId: room.id, approved: ok });
        resolve(ok ? 'folder' : 'discuss');
      };
      const timer = setTimeout(() => done(false), APPROVAL_TTL);
      timer.unref?.();
      signal?.addEventListener('abort', () => done(false), { once: true });
      this.pending.set(approvalId, { ...item, done });
      this.emit('event', { type: 'joint-approval', ...item });
    });
  }

  list() {
    return [...this.pending.values()].map(({ done, ...rest }) => rest);
  }

  decide(approvalId, approve) {
    const p = this.pending.get(approvalId);
    if (!p) throw fail(410, tr('这个请求已经过期了'));
    p.done(!!approve);
    return { ok: true };
  }

  // 包一层 runAgent：按档位给这一轮的 room 加上 jointMode / jointFolder；要问老板的先等老板点，再开工。
  // 返回值和 runAgent 一样是 { done, kill, steer? }，等审批的这段时间里按停止也能停。
  // opts.jointRemoteTask：加入方 worker 领到的任务。消息是主持方转来的，里面的 from/node 是对方自报的，
  // 不能凭它认定「是我老板自己发的」，所以只要开着「动手前先问我」就一律问。
  guard(runAgent, room, agentId, opts, messages) {
    const policy = this.of(room, agentId);
    let killed = false;
    let approved = false;
    // 真正启动前（运行器在版本预检、建临时目录之后同步调用）再核对一遍：没被停、群还在、
    // 档位和文件夹没变；当初没问老板就开工的，「先问我」也不能在这期间被打开。
    const stillAllowed = () => {
      if (killed) return false;
      const now = this.store.getRoom(room.id);
      if (!now?.joint || now.joint.left) return false;
      const cur = this.of(now, agentId);
      if (cur.level !== 'folder' || cur.folder !== policy.folder) return false;
      return approved || !cur.confirm;
    };
    const start = (mode) => {
      const r = mode === 'folder' ? { ...opts.room, jointDiscussion: true, jointMode: 'folder', jointFolder: policy.folder } : { ...opts.room, jointDiscussion: true, jointMode: 'discuss' };
      return runAgent(agentId, { ...opts, room: r, ...(mode === 'folder' ? { jointBeforeStart: stillAllowed } : {}) });
    };
    // 分身（本体在忙时先回一句的那个）在联合群里一律只讨论：它和本体共用会话，不能借它开一个能改文件的回合
    if (policy.level !== 'folder' || opts.side) return start('discuss');
    const mustAsk = policy.confirm && (opts.jointRemoteTask === true || this.needsApproval(room, messages));
    if (!mustAsk) {
      // 开着「先问我」但这轮全是本机老板自己发的：老板本人就是批准。
      // 没开「先问我」的：不算批准，启动前要是被老板打开了，stillAllowed 会拦下
      approved = policy.confirm;
      return start('folder');
    }
    const abort = new AbortController();
    let handle = null;
    const done = this.ask(room, agentId, policy.folder, messages, abort.signal).then((mode) => {
      if (killed) return { ok: false, error: tr('已停止') };
      approved = mode === 'folder';
      handle = start(mode);
      return handle.done;
    });
    return {
      done,
      kill: async () => {
        killed = true;
        abort.abort();
        return handle ? handle.kill() : true;
      },
    };
  }
}
