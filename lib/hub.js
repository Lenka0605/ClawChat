import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, IS_WIN, runAgent, canSeeImages } from './agents.js';

const HISTORY_ON_FRESH = 40; // 新会话（或会话丢失）时，带上最近多少条群聊记录
const MAX_IMAGES_PER_TURN = 8; // 一轮最多直接附几张图，更早的只给文件路径
const MODEL_ERROR_RE = /model/i;
const MODEL_ERROR_DETAIL_RE = /not supported|not found|does not exist|invalid|unknown/i;
const SESSION_LOST_RE = /no conversation found|session.*not found|thread.*not found|no rollout|unknown (session|thread)/i;
// 上下文满了：Claude 报 "Prompt is too long"，Codex 报 "ran out of room in the model's context window" 之类
// （文字是从两边程序里实际取出来核对过的）
const CONTEXT_FULL_RE =
  /prompt is too long|input is too long|too many tokens|ran out of room in the model'?s context window|exceeded the maximum context budget|context[_ ]?(window|length)[_ ]?(exceeded|limit|is full)|exceeds? (the )?(model'?s )?(maximum )?context|maximum context length|context_length_exceeded|ContextWindowExceeded|上下文.{0,6}(超|满)/i;

function stamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const MENTION_RE = /(?<![A-Za-z0-9_.])@\s?(claude|克劳德|gpt|codex|chatgpt|deepseek|深度求索|所有人|全体成员|全体|大家|all|everyone)/gi;
const MENTION_IDS = { claude: 'claude', 克劳德: 'claude', gpt: 'gpt', codex: 'gpt', chatgpt: 'gpt', deepseek: 'deepseek', 深度求索: 'deepseek' };
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
    const ids = MENTION_IDS[w] ? [MENTION_IDS[w]] : Object.keys(AGENTS); // @所有人：群里有谁就叫谁（调用方会按成员过滤）
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
  // Windows 上 Claude Code 没有沙盒，命令没法被限制住，只能靠自觉
  projectWin: '权限：你可以读写项目文件夹里的文件、运行命令。这台电脑是 Windows，命令没有沙盒限制，所以请只在项目文件夹里动手，不要改、删项目文件夹外面的东西。',
};

function permissionText(room, agentId) {
  const p = room.permission || 'project';
  if (p === 'project' && IS_WIN && AGENTS[agentId]?.engine !== 'codex') return PERMISSION_TEXT.projectWin;
  return PERMISSION_TEXT[p] || PERMISSION_TEXT.project;
}

function speaker(m, selfId) {
  if (m.from === 'user') return m.dm ? (m.sideHandling ? '老板（私聊你，你的分身正在回）' : '老板（私聊你）') : '老板';
  if (m.from === selfId && m.side) return '你的分身（私聊老板）';
  if (m.from === selfId) return m.dm ? '你（私聊老板）' : `你（${AGENTS[selfId].name}）`;
  return AGENTS[m.from]?.name || m.from;
}

function clock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export // Codex 看图会把原图整张存进会话，每轮都要重发；几 MB 的图多看几次，会话就重到发不出去、卡住不动
const IMAGE_TIP = '看图片时（包括你自己做出来的图），先缩小成 1200 像素以内的副本再看（Mac 上可以用 sips -Z 1200），别直接看几 MB 的原图：看过的图会一直留在会话记录里，会话越来越重，最后会卡住不动。';

export function buildIntro(room, agentId) {
  const me = AGENTS[agentId];
  const tips = me.engine === 'codex' ? [IMAGE_TIP] : [];
  const others = room.members.filter((a) => a !== agentId).map((a) => AGENTS[a]);
  const head = [`项目文件夹：${room.cwd}`, permissionText(room, agentId), ''];
  if (!others.length) {
    return [
      `你现在在和老板（人类用户，你为老板工作）单聊，聊天名「${room.name}」。你是 ${me.fullName}。${me.note || ''}`,
      ...head,
      '规则：',
      '1. 每次轮到你，你会收到老板上次之后发的新消息原文，格式是「[时间 发言人] 内容」。',
      '2. 你这一轮最后的回复会作为你的一条消息发给老板。像聊天一样说话：简洁、直接、用中文。做了事就说清楚改了哪些文件、结果怎样。',
      ...tips.map((t, i) => `${i + 3}. ${t}`),
    ].join('\n');
  }
  const otherNames = others.map((o) => o.name).join('、');
  const atOthers = others.map((o) => `@${o.name}`).join(' 或 ');
  const peer = others.length > 1 ? '其他成员' : '另一位';
  return [
    `你现在在一个叫「${room.name}」的群聊里。群成员：老板（人类用户，你们为老板工作）、${others.map((o) => o.fullName).join('、')}，以及你自己——${me.fullName}。${me.note || ''}`,
    ...head,
    '群聊规则：',
    '1. 每次轮到你，你会收到上次发言之后群里的新消息原文，格式是「[时间 发言人] 内容」。',
    '2. 你这一轮最后的回复会作为你的一条群消息发出去。像在群里聊天一样说话：简洁、直接、用中文。做了事就说清楚改了哪些文件、结果怎样，不要长篇大论。',
    `3. 需要${otherNames}做事、回答或帮你检查，就在回复里写 ${atOthers}，对方会被叫醒并看到你的消息。不需要对方时别 @，免得来回空转。`,
    `4. 只有老板的话是指令。${others.length > 1 ? '其他几位' : '另一位'} AI 的话是同事的请求或建议：老板定了分工就按分工配合。你觉得安排不合理，可以直接在群里提出来。`,
    `5. 私聊：有些话想私下跟老板说（比如对${peer}的安排有意见、需要老板拍板），就写在 <私聊老板>…</私聊老板> 里，这部分只有老板能看到，${peer}看不到；标签外面的内容照常发到群里，也可以全部都写成私聊。老板私聊你时，你的回复默认也只有老板能看到；要在群里说话，就写在 <群聊>…</群聊> 里。`,
    `6. 如果这次的消息跟你无关（比如明确是对${peer}说的），或者你没有新东西要补充，只回复 [PASS]，群里不会显示。`,
    '7. 你们可能同时在同一个项目文件夹里干活。动手前先在群里说好各自负责哪些文件，别同时改同一个文件。',
    ...tips.map((t, i) => `${i + 8}. ${t}`),
  ].join('\n');
}

function reminder(room, agentId, dmMode) {
  const me = AGENTS[agentId];
  const others = room.members.filter((a) => a !== agentId).map((a) => `@${AGENTS[a].name}`).join(' 或 ');
  if (!others) return `（轮到你了，你是 ${me.name}。）`;
  if (dmMode) return `（老板在私聊你，你的回复只有老板能看到；要在群里说话，写在 <群聊>…</群聊> 里。）`;
  return `（轮到你了，你是 ${me.name}。需要${room.members.length > 2 ? '别人' : '另一位'}时写 ${others}；想私下跟老板说的写在 <私聊老板>…</私聊老板> 里；没有要说的就只回 [PASS]。）`;
}

// 这一轮要发给某位的内容：文字记录 + 要附上的图片（按 #编号）
export function buildTurn(room, agentId, messages, fresh, uploadsDir, dmMode = false, peers = []) {
  const vision = canSeeImages(agentId, room); // 现在用的模型看不了图（比如 deepseek-v4-pro）：图片只给文件路径
  const all = messages.flatMap((m) => (m.from === agentId || !vision ? [] : (m.images || []).map((img) => img.id)));
  const attach = new Set(all.slice(-MAX_IMAGES_PER_TURN));
  const images = [];
  const lines = messages.map((m) => {
    let who = speaker(m, agentId);
    if (m.replyTo) {
      // 回复了哪句话也带上，被回复的那位能看出「这是在回我」
      const target = m.replyTo.from === agentId ? '你' : m.replyTo.from === 'user' ? '老板' : AGENTS[m.replyTo.from]?.name || m.replyTo.from;
      const quote = String(m.replyTo.text || '').replace(/\s+/g, ' ').slice(0, 80);
      who += `，回复${target}的「${quote}」`;
    }
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
    ...(!vision && messages.some((m) => m.from !== agentId && m.images?.length)
      ? ['', '（你现在用的模型看不了图片，只知道发了图、文件放在哪。别用读文件的工具去打开图片，会出错；要看图的活交给能看图的成员，或者请老板描述一下。）']
      : []),
    '',
    ...(!dmMode && messages.some((m) => m.from === 'user' && m.dm && !m.sideHandling)
      ? ['（标了「私聊你」的是老板私下跟你说的，回应那部分请写在 <私聊老板>…</私聊老板> 里，别让其他成员看到。）']
      : []),
    ...(messages.some((m) => m.sideHandling)
      ? ['（标着「你的分身正在回」的私聊，分身正在替你回复，你这一轮不用回，也别在群里提；等分身回完，你会看到它说了什么。）']
      : []),
    ...(messages.some((m) => m.from === agentId && m.side)
      ? ['（标着「你的分身」的，是你忙的时候分身替你回老板的私聊。分身答应要做的事现在去做；没有要补充的就只回 [PASS]，别把分身说过的话再说一遍。）']
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
    this.sideRuns = new Map(); // `${roomId}:${agent}` -> 正在回私聊的分身（本体在忙时开）
    this.sideWanted = new Set(); // 分身忙的时候又来了私聊
    this.wanted = new Map(); // 忙的时候又被叫到：干完再来一轮，{ then: [...] }
    this.hops = new Map(); // 老板上次发言后，两位自动接力了几轮
    this.pauseNoticed = new Set();
  }

  key(roomId, agent) {
    return `${roomId}:${agent}`;
  }

  // full：带上这一轮到目前为止的全部过程（刷新页面时用）；平时广播只带最后几步
  status(full = false) {
    return [...this.runs.values(), ...this.sideRuns.values()].map((r) => ({
      roomId: r.roomId,
      agent: r.agent,
      dm: r.dmMode,
      side: !!r.side,
      startedAt: r.startedAt,
      lastEventAt: r.lastEventAt || r.startedAt,
      steps: full ? r.steps.slice(-300) : r.steps.slice(-4),
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

  // replyTo：老板在回复哪条消息 { seq, from, text }；回复某位 AI 的话，就只叫这一位
  postUserMessage(roomId, text, images = [], dm = null, replyTo = null) {
    const room = this.store.getRoom(roomId);
    if (!room) return;
    if (dm && (!room.members.includes(dm) || room.members.length === 1)) dm = null; // 单聊本来就是私聊
    const msg = { from: 'user', text };
    if (images.length) msg.images = images;
    if (dm) msg.dm = dm;
    if (replyTo) msg.replyTo = replyTo;
    this.post(roomId, msg);
    this.hops.set(roomId, 0);
    this.pauseNoticed.delete(roomId);
    if (dm) {
      const busy = this.runs.has(this.key(roomId, dm));
      this.wake(roomId, dm); // 本体干完后会看一眼分身聊了什么（没事就 [PASS]）
      if (busy) this.startSide(roomId, dm);
      return;
    }
    let targets = parseMentions(text).filter((a) => room.members.includes(a));
    // 没有 @ 人、但在回复某位 AI 的消息：只叫被回复的那一位
    if (!targets.length && replyTo && room.members.includes(replyTo.from)) targets = [replyTo.from];
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

  // 分身在回私聊的时候，本体有没有别的活要干：群里的新消息、别人 @ 它之类。老板发给它的私聊归分身管，不算
  hasMainWork(roomId, agentId) {
    const cursor = this.store.getState(roomId).cursors[agentId] ?? -1;
    const visible = visibleTo(agentId);
    return this.store
      .getMessages(roomId)
      .slice(cursor + 1)
      .some((m) => visible(m) && m.from !== agentId && !(m.from === 'user' && m.dm === agentId));
  }

  // peers：和它同时开工的其他成员（会在消息里告诉它）
  wake(roomId, agent, then = [], peers = []) {
    const k = this.key(roomId, agent);
    // 本体在忙就排队；分身在回私聊时，本体有别的活照常开工（分身卡住也不会把群里的活堵住）
    if (this.runs.has(k) || (this.sideRuns.has(k) && !this.hasMainWork(roomId, agent))) {
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
    const unseen = msgs.slice(cursor + 1).filter((m) => (m.from !== agentId || m.side) && visible(m));
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
    const run = { roomId, agent: agentId, dmMode, prevCursor, startedAt: Date.now(), lastEventAt: Date.now(), steps: [], then, stopped: false, kill: null };
    this.runs.set(k, run);
    this.emitStatus();

    const uploadsDir = this.store.uploadsDir(roomId);
    // 分身正在回的私聊：本体也能看到，但标出来，免得两边都回
    const sideHandling = this.sideRuns.has(k) ? new Set(unseen.filter((m) => m.from === 'user' && m.dm === agentId).map((m) => m.seq)) : new Set();
    const shown = sideHandling.size ? context.map((m) => (sideHandling.has(m.seq) ? { ...m, sideHandling: true } : m)) : context;
    const turn = buildTurn(room, agentId, shown, !session, uploadsDir, dmMode, retry ? retry.peers : peers);
    if (interrupted) turn.prompt = `（上次 ClawChat 退出时，你正在做的那一轮被打断了。下面包含当时没做完的消息，请先检查一下做到哪了，再接着处理。）\n${turn.prompt}`;
    if (retry?.contextReset) {
      const file = this.writeTranscript(roomId, agentId);
      const why = retry.stuck ? '你原来的会话卡住不动了（多半是记录里的大图太多，会话太重）' : '你原来的会话上下文满了';
      turn.prompt =
        `（${why}，已经换成一个新会话，之前聊过的细节你可能不记得了。下面是最近的聊天记录；更早的完整记录在 ${file}，需要时可以读。` +
        '项目文件夹里的东西都还在。先弄清楚手上的事做到哪了，再接着做完。）\n' +
        turn.prompt;
    }
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
      onActivity: () => this.activity(run),
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
    if (run.fresh) {
      // 老板点了「换新会话重来」：丢掉卡住的会话，带上最近的聊天记录把这一轮重来
      state.sessions[agentId] = null;
      this.store.saveState(roomId);
      this.notice(roomId, `${name} 换成了新会话，带上最近的聊天记录重新开始`, dmTag);
      return this.startTurn(roomId, agentId, run.then, { dmMode, prevCursor, peers, contextReset: true, stuck: true });
    }
    if (run.stopped) {
      this.notice(roomId, `已停止 ${name}`, dmTag);
      this.emitStatus();
      this.chain(roomId, run.then); // 只停这一位时，排在它后面的照常开工；「全部停止」会清空 then
      return;
    }
    if (!res.ok && session && !retry && CONTEXT_FULL_RE.test(res.error || '')) {
      state.sessions[agentId] = null;
      this.store.saveState(roomId);
      this.notice(roomId, `${name} 的上下文满了，已经自动换成新会话，带上最近的聊天记录接着干`, dmTag);
      return this.startTurn(roomId, agentId, run.then, { dmMode, prevCursor, peers, contextReset: true });
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
      if (res.effort) meta.effort = res.effort;
      this.deliver(roomId, agentId, res.text.trim(), dmMode, meta);
    } else {
      const error = res.error || '未知错误';
      const hint = CONTEXT_FULL_RE.test(error)
        ? '（这次的内容太大了，比如一次发了很多图片或很长的文字，可以分几次发）'
        : MODEL_ERROR_RE.test(error) && MODEL_ERROR_DETAIL_RE.test(error)
          ? '（可以在右上角「…」→ 模型 里换一个）'
          : '';
      this.notice(roomId, `${name} 出错了：${error}${hint}`, dmTag);
    }
    this.emitStatus();
    this.chain(roomId, run.then);
    const w = this.wanted.get(k);
    if (w) {
      // 分身还在回私聊、又没有别的活的话，wake 会接着排队，等分身回完再叫本体
      this.wanted.delete(k);
      this.wake(roomId, agentId, w.then);
    }
  }

  // 进程有任何输出都算有动静：界面用它判断是不是卡住了（最多 15 秒推一次）
  activity(run) {
    const now = Date.now();
    run.lastEventAt = now;
    if (now - (run.activityEmittedAt || 0) < 15000) return;
    run.activityEmittedAt = now;
    this.emit('event', { type: 'activity', roomId: run.roomId, agent: run.agent, side: !!run.side, at: now });
  }

  // 卡住了：结束这一轮，换一个新会话，带上最近的聊天记录重来（会话太重、一直没有回应时用）
  restartFresh(roomId, agentId) {
    const run = this.runs.get(this.key(roomId, agentId));
    if (!run) return false;
    run.fresh = true;
    run.kill?.();
    return true;
  }

  // 分身：本体在群里忙的时候，复制一份本体当前的记忆来回老板的私聊。只读，不写回本体的会话
  async startSide(roomId, agentId) {
    const room = this.store.getRoom(roomId);
    const k = this.key(roomId, agentId);
    const main = this.runs.get(k);
    if (!room || !main) return;
    if (this.sideRuns.has(k)) {
      this.sideWanted.add(k);
      return;
    }
    const state = this.store.getState(roomId);
    const msgs = this.store.getMessages(roomId);
    const from = Math.max(state.cursors[agentId] ?? -1, state.sideCursors?.[agentId] ?? -1);
    const visible = visibleTo(agentId);
    const context = msgs.slice(from + 1).filter((m) => (m.from !== agentId || m.side) && visible(m));
    if (!context.some((m) => m.from === 'user' && m.dm === agentId)) return;
    state.sideCursors = { ...state.sideCursors, [agentId]: msgs.length - 1 };
    this.store.saveState(roomId);
    const session = state.sessions[agentId] || null;
    const uploadsDir = this.store.uploadsDir(roomId);
    const turn = buildTurn(room, agentId, session ? context : msgs.filter(visible).slice(-HISTORY_ON_FRESH), !session, uploadsDir, true);
    const progress = main.steps.slice(-8).map((s) => `- ${String(s.text || '').split('\n')[0].slice(0, 120)}`).join('\n');
    turn.prompt =
      '（你现在正在群里忙另一件事，那边还没做完。你是本体的分身，专门先回老板的私聊：只能看，不能改文件，也不能跑会改东西的命令。' +
      '能直接回答就直接回答；需要动手的，告诉老板手上的活一做完就去做。' +
      '注意：本体手上的命令可能还在跑，复制给你的记录里会显示成「还没结果」或「被打断」，这不代表真的中断了，以下面「最近的进度」为准，别下「中断了」的结论。）\n' +
      (progress ? `[你手上那件事最近的进度]\n${progress}\n\n` : '') +
      turn.prompt;
    const run = { roomId, agent: agentId, side: true, dmMode: true, startedAt: Date.now(), lastEventAt: Date.now(), steps: [], stopped: false, kill: null };
    this.sideRuns.set(k, run);
    this.emitStatus();
    const handle = this.run(agentId, {
      room,
      session,
      side: true,
      prompt: turn.prompt,
      images: turn.images,
      uploadsDir,
      systemPrompt: buildIntro(room, agentId),
      onStep: (step) => {
        run.steps.push(step);
        this.emit('event', { type: 'step', roomId, agent: agentId, dm: true, side: true, step });
      },
      onActivity: () => this.activity(run),
    });
    run.kill = handle.kill;
    const res = await handle.done;
    this.sideRuns.delete(k);
    if (this.closing || !this.store.getRoom(roomId)) return;
    const name = AGENTS[agentId].name;
    if (run.stopped) {
      this.notice(roomId, `已停止 ${name} 的分身`, agentId);
    } else if (res.ok) {
      // 分身只回私聊：把 <群聊> 之类的标签去掉，整段发给老板
      const text = res.text.replace(/<\/?(群聊|私聊老板)>/g, '').trim();
      if (text && !isPass(text)) {
        const meta = { steps: compactSteps(res.steps), durationMs: Date.now() - run.startedAt };
        if (res.model) meta.model = res.model;
        if (res.effort) meta.effort = res.effort;
        this.post(roomId, { from: agentId, dm: agentId, side: true, text, ...meta });
      }
    } else {
      this.notice(roomId, `${name} 的分身出错了：${res.error || '未知错误'}`, agentId);
    }
    this.emitStatus();
    // 分身忙的时候又来了私聊：本体还在忙就再开一次分身；本体已经空了，就交给本体
    if (this.sideWanted.delete(k) && this.runs.has(k)) return this.startSide(roomId, agentId);
    const w = this.wanted.get(k);
    if (w && !this.runs.has(k)) {
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
    // 两条都标上用的模型和思考强度，过程记录只挂在主要那条上
    const model = { ...(meta.model ? { model: meta.model } : {}), ...(meta.effort ? { effort: meta.effort } : {}) };
    if (dm) this.post(roomId, { from: agentId, dm: agentId, text: dm, ...model, ...(metaOnDm ? meta : {}) });
    if (group) {
      this.post(roomId, { from: agentId, text: group, ...model, ...(metaOnDm ? {} : meta) });
      this.routeReply(roomId, agentId, group);
    }
  }

  writeTranscript(roomId, agentId) {
    const room = this.store.getRoom(roomId);
    const dir = path.join(this.store.roomDir(roomId), 'transcripts');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${agentId}.md`);
    const uploadsDir = this.store.uploadsDir(roomId);
    const lines = this.store
      .getMessages(roomId)
      .filter(visibleTo(agentId))
      .map((m) => {
        const pics = (m.images || []).map((img) => `〔图片：${path.join(uploadsDir, img.id)}〕`);
        return `[${stamp(m.ts)} ${speaker(m, agentId)}] ${[m.text, ...pics].filter(Boolean).join(' ')}`;
      });
    const head = `# 「${room?.name || ''}」的完整聊天记录（${AGENTS[agentId].name} 能看到的部分，按时间顺序）\n\n`;
    fs.writeFileSync(file, head + lines.join('\n') + '\n');
    return file;
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
        this.notice(roomId, `${room.members.length > 2 ? '大家' : '两位'}已经连续自动接力 ${room.maxAutoTurns} 轮，先停一下，等你发话再继续。`);
      }
      return;
    }
    this.hops.set(roomId, hops);
    for (const t of targets) this.wake(roomId, t);
  }

  // only：'side' 只停分身，'main' 只停本体；不传就都停
  stop(roomId, agent, only = null) {
    for (const run of only === 'main' ? [] : this.sideRuns.values()) {
      if (run.roomId === roomId && (!agent || run.agent === agent)) {
        run.stopped = true;
        run.kill?.();
      }
    }
    for (const k of [...this.sideWanted]) if (k.startsWith(`${roomId}:`) && (!agent || k === this.key(roomId, agent))) this.sideWanted.delete(k);
    if (only === 'side') return;
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
    for (const run of this.sideRuns.values()) run.kill?.();
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
