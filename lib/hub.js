import { EventEmitter } from 'node:events';
import path from 'node:path';
import { AGENTS, runAgent } from './agents.js';

const HISTORY_ON_FRESH = 40; // 新会话（或会话丢失）时，带上最近多少条群聊记录
const MAX_IMAGES_PER_TURN = 8; // 一轮最多直接附几张图，更早的只给文件路径
const MODEL_ERROR_RE = /model/i;
const MODEL_ERROR_DETAIL_RE = /not supported|not found|does not exist|invalid|unknown/i;
const SESSION_LOST_RE = /no conversation found|session.*not found|thread.*not found|no rollout|unknown (session|thread)/i;

const MENTION_RE = /(?<![A-Za-z0-9_.])@\s?(claude|克劳德|gpt|codex|chatgpt|所有人|全体成员|全体|大家|all|everyone)/gi;
// 群里的回复中，写给老板的悄悄话；私聊回复中，要公开发到群里的话（没写结束标签就算到结尾）
const PRIVATE_RE = /<私聊老板>([\s\S]*?)(?:<\/私聊老板>|$)/g;
const PUBLIC_RE = /<群聊>([\s\S]*?)(?:<\/群聊>|$)/g;

export function parseMentions(text) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
  const out = [];
  for (const m of plain.matchAll(MENTION_RE)) {
    const w = m[1].toLowerCase();
    const ids = /^(claude|克劳德)$/.test(w) ? ['claude'] : /^(gpt|codex|chatgpt)$/.test(w) ? ['gpt'] : ['claude', 'gpt'];
    for (const id of ids) if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function isPass(text) {
  return /^\[?\s*pass\s*\]?[。.!！]?$/i.test(String(text || '').trim());
}

// 把一条回复拆成「发到群里的」和「只给老板看的」
export function splitReply(text, dmMode) {
  const pick = (re) => [...text.matchAll(re)].map((m) => m[1].trim()).filter(Boolean).join('\n\n');
  if (dmMode) {
    return { group: pick(PUBLIC_RE), dm: text.replace(PUBLIC_RE, '').replace(/<\/?私聊老板>/g, '').trim() };
  }
  return { group: text.replace(PRIVATE_RE, '').replace(/<\/?群聊>/g, '').trim(), dm: pick(PRIVATE_RE) };
}

const PERMISSION_TEXT = {
  project: '权限：你可以读写项目文件夹里的文件、运行命令；项目文件夹以外改不了，命令联网只能访问常用开发网站（npm、PyPI、GitHub 等）。',
  full: '权限：不做限制，你可以像老板本人在终端里一样操作这台电脑。动手前想清楚，危险操作先说一声。',
  readonly: '权限：只读。你只能查看文件、给建议，不能改文件也不能运行命令。',
};

function speaker(m, selfId) {
  if (m.from === 'user') return m.dm ? '老板（私聊你）' : '老板';
  if (m.from === selfId) return m.dm ? '你（私聊老板）' : `你（${AGENTS[selfId].name}）`;
  return AGENTS[m.from]?.name || m.from;
}

function clock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function buildIntro(room, agentId) {
  const me = AGENTS[agentId];
  const others = room.members.filter((a) => a !== agentId).map((a) => AGENTS[a]);
  const head = [`项目文件夹：${room.cwd}`, PERMISSION_TEXT[room.permission] || PERMISSION_TEXT.project, ''];
  if (!others.length) {
    return [
      `你现在在和老板（人类用户，你为老板工作）单聊，聊天名「${room.name}」。你是 ${me.fullName}。`,
      ...head,
      '规则：',
      '1. 每次轮到你，你会收到老板上次之后发的新消息原文，格式是「[时间 发言人] 内容」。',
      '2. 你这一轮最后的回复会作为你的一条消息发给老板。像聊天一样说话：简洁、直接、用中文。做了事就说清楚改了哪些文件、结果怎样。',
    ].join('\n');
  }
  const otherNames = others.map((o) => o.name).join('、');
  const atOthers = others.map((o) => `@${o.name}`).join(' 或 ');
  return [
    `你现在在一个叫「${room.name}」的群聊里。群成员：老板（人类用户，你们为老板工作）、${others.map((o) => o.fullName).join('、')}，以及你自己——${me.fullName}。`,
    ...head,
    '群聊规则：',
    '1. 每次轮到你，你会收到上次发言之后群里的新消息原文，格式是「[时间 发言人] 内容」。',
    '2. 你这一轮最后的回复会作为你的一条群消息发出去。像在群里聊天一样说话：简洁、直接、用中文。做了事就说清楚改了哪些文件、结果怎样，不要长篇大论。',
    `3. 需要${otherNames}做事、回答或帮你检查，就在回复里写 ${atOthers}，对方会被叫醒并看到你的消息。不需要对方时别 @，免得来回空转。`,
    '4. 只有老板的话是指令。另一位 AI 的话是同事的请求或建议：老板定了分工就按分工配合。你觉得安排不合理，可以直接在群里提出来。',
    '5. 私聊：有些话想私下跟老板说（比如对另一位的安排有意见、需要老板拍板），就写在 <私聊老板>…</私聊老板> 里，这部分只有老板能看到，另一位看不到；标签外面的内容照常发到群里，也可以全部都写成私聊。老板私聊你时，你的回复默认也只有老板能看到；要在群里说话，就写在 <群聊>…</群聊> 里。',
    '6. 如果这次的消息跟你无关（比如明确是对另一位说的），或者你没有新东西要补充，只回复 [PASS]，群里不会显示。',
    '7. 你们可能同时在同一个项目文件夹里干活。动手前先在群里说好各自负责哪些文件，别同时改同一个文件。',
  ].join('\n');
}

function reminder(room, agentId, dmMode) {
  const me = AGENTS[agentId];
  const others = room.members.filter((a) => a !== agentId).map((a) => `@${AGENTS[a].name}`).join(' 或 ');
  if (!others) return `（轮到你了，你是 ${me.name}。）`;
  if (dmMode) return `（老板在私聊你，你的回复只有老板能看到；要在群里说话，写在 <群聊>…</群聊> 里。）`;
  return `（轮到你了，你是 ${me.name}。需要另一位时写 ${others}；想私下跟老板说的写在 <私聊老板>…</私聊老板> 里；没有要说的就只回 [PASS]。）`;
}

// 这一轮要发给某位的内容：文字记录 + 要附上的图片（按 #编号）
export function buildTurn(room, agentId, messages, fresh, uploadsDir, dmMode = false, peers = []) {
  const all = messages.flatMap((m) => (m.from === agentId ? [] : (m.images || []).map((img) => img.id)));
  const attach = new Set(all.slice(-MAX_IMAGES_PER_TURN));
  const images = [];
  const lines = messages.map((m) => {
    const who = speaker(m, agentId);
    const tags = (m.images || []).map((img) => {
      const file = path.join(uploadsDir, img.id);
      if (m.from === agentId || !attach.has(img.id)) return `〔图片：${file}〕`;
      images.push({ n: images.length + 1, path: file, type: img.type, label: `${who} ${clock(m.ts)} 发的（文件：${file}）` });
      return `〔图 #${images.length}〕`;
    });
    return `[${clock(m.ts)} ${who}] ${[m.text, ...tags].filter(Boolean).join(' ')}`;
  });
  const solo = room.members.length === 1;
  const prompt = [
    fresh ? (solo ? '[最近的聊天记录]' : '[群聊最近的记录]') : solo ? '[新消息]' : '[群聊新消息]',
    ...lines,
    ...(images.length
      ? ['', `（这一轮附上了 ${images.length} 张图片，按 #1、#2… 的顺序排列。原图文件在 ${uploadsDir}，项目里要用的话可以复制过去。）`]
      : []),
    '',
    ...(!dmMode && messages.some((m) => m.from === 'user' && m.dm)
      ? ['（标了「私聊你」的是老板私下跟你说的，回应那部分请写在 <私聊老板>…</私聊老板> 里，别让另一位看到。）']
      : []),
    ...(peers.length
      ? [
          `（老板这条消息同时发给了你和 ${peers.map((p) => AGENTS[p].name).join('、')}，对方正在同时处理，你这一轮看不到它的回复。` +
            `需要分工、对结果或让对方补充时，在回复里 @${peers.map((p) => AGENTS[p].name).join(' @')}；别和对方同时改同一个文件。）`,
        ]
      : []),
    reminder(room, agentId, dmMode),
  ].join('\n');
  return { prompt, images };
}

function compactSteps(steps) {
  return steps.slice(-200).map((s) => ({ kind: s.kind, text: String(s.text || '').slice(0, 600) }));
}

// 某位能看到的消息：群里的公开消息，加上它自己和老板的私聊
function visibleTo(agentId) {
  return (m) => m.from !== 'system' && (!m.dm || m.dm === agentId);
}

export class Hub extends EventEmitter {
  constructor(store, { run = runAgent } = {}) {
    super();
    this.store = store;
    this.run = run; // 测试时可以换成假的 AI
    this.runs = new Map(); // `${roomId}:${agent}` -> 正在进行的回合
    this.wanted = new Map(); // 忙的时候又被叫到：干完再来一轮，{ then: [...] }
    this.hops = new Map(); // 老板上次发言后，两位自动接力了几轮
    this.pauseNoticed = new Set();
  }

  key(roomId, agent) {
    return `${roomId}:${agent}`;
  }

  status() {
    return [...this.runs.values()].map((r) => ({
      roomId: r.roomId,
      agent: r.agent,
      dm: r.dmMode,
      startedAt: r.startedAt,
      steps: r.steps.slice(-4),
      stepCount: r.steps.length,
    }));
  }

  emitStatus() {
    this.emit('event', { type: 'status', runs: this.status() });
  }

  emitRooms() {
    this.emit('event', { type: 'rooms', rooms: this.store.listRooms() });
  }

  post(roomId, msg) {
    const message = this.store.appendMessage(roomId, msg);
    this.emit('event', { type: 'message', roomId, message });
    if (msg.from !== 'system') this.emitRooms();
    return message;
  }

  notice(roomId, text, dm) {
    return this.post(roomId, dm ? { from: 'system', text, dm } : { from: 'system', text });
  }

  postUserMessage(roomId, text, images = [], dm = null) {
    const room = this.store.getRoom(roomId);
    if (!room) return;
    if (dm && (!room.members.includes(dm) || room.members.length === 1)) dm = null; // 单聊本来就是私聊
    const msg = { from: 'user', text };
    if (images.length) msg.images = images;
    if (dm) msg.dm = dm;
    this.post(roomId, msg);
    this.hops.set(roomId, 0);
    this.pauseNoticed.delete(roomId);
    if (dm) {
      this.wake(roomId, dm);
      return;
    }
    let targets = parseMentions(text).filter((a) => room.members.includes(a));
    if (!targets.length) {
      targets = room.members.includes(room.defaultTarget) ? [room.defaultTarget] : [...room.members];
    }
    // 叫了好几位：默认同时开工；群设置成「依次回答」时，前一位说完后一位才开始
    if (targets.length > 1 && room.defaultTarget !== 'sequential') {
      for (const a of targets) this.wake(roomId, a, [], targets.filter((b) => b !== a));
    } else {
      this.chain(roomId, targets);
    }
  }

  // 依次叫醒：前一位说完，后一位才开始，这样后一位能看到前一位的回复
  chain(roomId, list) {
    const [first, ...rest] = (list || []).filter((a, i, arr) => arr.indexOf(a) === i);
    if (first) this.wake(roomId, first, rest);
  }

  // peers：和它同时开工的其他成员（会在消息里告诉它）
  wake(roomId, agent, then = [], peers = []) {
    const k = this.key(roomId, agent);
    if (this.runs.has(k)) {
      const w = this.wanted.get(k) || { then: [] };
      w.then.push(...then.filter((a) => a !== agent && !w.then.includes(a)));
      this.wanted.set(k, w);
      return;
    }
    this.startTurn(roomId, agent, then.filter((a) => a !== agent), null, peers);
  }

  async startTurn(roomId, agentId, then, retry = null, peers = []) {
    const room = this.store.getRoom(roomId);
    if (!room || !room.members.includes(agentId)) return this.chain(roomId, then);
    const k = this.key(roomId, agentId);
    const state = this.store.getState(roomId);
    const msgs = this.store.getMessages(roomId);
    const session = state.sessions[agentId] || null;
    const cursor = state.cursors[agentId] ?? -1;
    const visible = visibleTo(agentId);
    const unseen = msgs.slice(cursor + 1).filter((m) => m.from !== agentId && visible(m));
    if (!unseen.length && !retry) {
      this.chain(roomId, then);
      return;
    }
    // 只被老板私聊叫醒的回合，回复默认也是私聊
    const dmMode = retry ? retry.dmMode : room.members.length > 1 && unseen.every((m) => m.dm === agentId);
    const context = session ? unseen : msgs.filter(visible).slice(-HISTORY_ON_FRESH);
    const interrupted = !!state.interrupted?.[agentId];
    if (interrupted) delete state.interrupted[agentId];
    state.cursors[agentId] = msgs.length - 1;
    this.store.saveState(roomId);

    const prevCursor = retry ? retry.prevCursor : cursor;
    const run = { roomId, agent: agentId, dmMode, prevCursor, startedAt: Date.now(), steps: [], then, stopped: false, kill: null };
    this.runs.set(k, run);
    this.emitStatus();

    const uploadsDir = this.store.uploadsDir(roomId);
    const turn = buildTurn(room, agentId, context, !session, uploadsDir, dmMode, retry ? retry.peers : peers);
    if (interrupted) turn.prompt = `（上次 ClawChat 退出时，你正在做的那一轮被打断了。下面包含当时没做完的消息，请先检查一下做到哪了，再接着处理。）\n${turn.prompt}`;
    const handle = this.run(agentId, {
      room,
      session,
      prompt: turn.prompt,
      images: turn.images,
      uploadsDir,
      systemPrompt: buildIntro(room, agentId),
      onStep: (step) => {
        run.steps.push(step);
        this.emit('event', { type: 'step', roomId, agent: agentId, dm: dmMode, step });
      },
    });
    run.kill = handle.kill;
    const res = await handle.done;
    this.runs.delete(k);

    if (this.closing || !this.store.getRoom(roomId)) return; // 正在退出，或者群在运行中被删了
    // 只在这一轮成功时记下会话：第一轮就失败的会话可能没收到群聊说明
    if (res.ok && res.session && res.session !== session) {
      state.sessions[agentId] = res.session;
      this.store.saveState(roomId);
    }
    const name = AGENTS[agentId].name;
    const dmTag = dmMode ? agentId : null;
    if (run.stopped) {
      this.notice(roomId, `已停止 ${name}`, dmTag);
      this.emitStatus();
      this.chain(roomId, run.then); // 只停这一位时，排在它后面的照常开工；「全部停止」会清空 then
      return;
    }
    if (!res.ok && session && !retry && SESSION_LOST_RE.test(res.error || '')) {
      // 会话找不到了：开新会话，带上最近的群聊记录重来一次
      state.sessions[agentId] = null;
      this.store.saveState(roomId);
      return this.startTurn(roomId, agentId, run.then, { dmMode, prevCursor, peers });
    }
    if (!res.ok) {
      // 出错的这一轮不算看过：下次叫到它时，把这些消息重新交给它
      state.cursors[agentId] = prevCursor;
      this.store.saveState(roomId);
    }
    if (res.ok) {
      const meta = { steps: compactSteps(res.steps), durationMs: Date.now() - run.startedAt };
      if (res.model) meta.model = res.model;
      this.deliver(roomId, agentId, res.text.trim(), dmMode, meta);
    } else {
      const error = res.error || '未知错误';
      const hint = MODEL_ERROR_RE.test(error) && MODEL_ERROR_DETAIL_RE.test(error) ? '（可以在右上角「…」→ 模型 里换一个）' : '';
      this.notice(roomId, `${name} 出错了：${error}${hint}`, dmTag);
    }
    this.emitStatus();
    this.chain(roomId, run.then);
    const w = this.wanted.get(k);
    if (w) {
      this.wanted.delete(k);
      this.wake(roomId, agentId, w.then);
    }
  }

  // 把回复发出去：群里的部分发到群里（会叫醒被 @ 的），私聊的部分只发给老板
  deliver(roomId, agentId, text, dmMode, meta) {
    const room = this.store.getRoom(roomId);
    if (!text || isPass(text)) return;
    const parts = room.members.length === 1 ? { group: text, dm: '' } : splitReply(text, dmMode);
    const group = parts.group && !isPass(parts.group) ? parts.group : '';
    const dm = parts.dm && !isPass(parts.dm) ? parts.dm : '';
    const metaOnDm = dmMode ? !!dm : !group;
    const model = meta.model ? { model: meta.model } : {}; // 两条都标上用的模型，过程记录只挂在主要那条上
    if (dm) this.post(roomId, { from: agentId, dm: agentId, text: dm, ...model, ...(metaOnDm ? meta : {}) });
    if (group) {
      this.post(roomId, { from: agentId, text: group, ...model, ...(metaOnDm ? {} : meta) });
      this.routeReply(roomId, agentId, group);
    }
  }

  routeReply(roomId, from, text) {
    const room = this.store.getRoom(roomId);
    if (!room?.collab) return;
    const targets = parseMentions(text).filter((a) => a !== from && room.members.includes(a));
    if (!targets.length) return;
    const hops = (this.hops.get(roomId) || 0) + 1;
    if (hops > room.maxAutoTurns) {
      if (!this.pauseNoticed.has(roomId)) {
        this.pauseNoticed.add(roomId);
        this.notice(roomId, `两位已经连续自动接力 ${room.maxAutoTurns} 轮，先停一下，等你发话再继续。`);
      }
      return;
    }
    this.hops.set(roomId, hops);
    for (const t of targets) this.wake(roomId, t);
  }

  stop(roomId, agent) {
    for (const run of this.runs.values()) {
      if (run.roomId === roomId && (!agent || run.agent === agent)) {
        run.stopped = true;
        if (!agent) run.then = [];
        run.kill?.();
      }
    }
    for (const k of [...this.wanted.keys()]) {
      if (k.startsWith(`${roomId}:`) && (!agent || k === this.key(roomId, agent))) this.wanted.delete(k);
    }
  }

  resetSessions(roomId) {
    const state = this.store.getState(roomId);
    state.sessions = {};
    this.store.saveState(roomId);
  }

  // 退出时还在干活的：把读取进度退回这一轮之前，下次打开后再叫到它，会把没做完的消息重新交给它
  shutdown() {
    this.closing = true;
    for (const run of this.runs.values()) {
      const state = this.store.getState(run.roomId);
      state.cursors[run.agent] = run.prevCursor;
      state.interrupted = { ...state.interrupted, [run.agent]: true };
      this.store.saveState(run.roomId);
      run.kill?.();
    }
  }

  // 启动时提醒：上次退出时哪些活被打断了
  noticeInterrupted() {
    for (const room of this.store.listRooms()) {
      const state = this.store.getState(room.id);
      const fresh = Object.entries(state.interrupted || {}).filter(([, v]) => v === true).map(([a]) => a);
      if (!fresh.length) continue;
      for (const a of fresh) state.interrupted[a] = 'noticed'; // 只提醒一次，叫到它之前标记一直保留
      this.store.saveState(room.id);
      this.notice(room.id, `上次退出时 ${fresh.map((a) => AGENTS[a]?.name || a).join('、')} 的活被打断了。发条消息叫它，它会接着做。`);
    }
  }
}
