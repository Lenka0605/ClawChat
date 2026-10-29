import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, IS_WIN, runAgent, canSeeImages, sessionImageBytes } from './agents.js';

const HISTORY_ON_FRESH = 40; // 新会话（或会话丢失）时，带上最近多少条群聊记录
// GPT 会话里存的图片到这么多就提醒老板换新会话（实测：11.6MB 时还正常，过了 17MB 就慢到像卡住）
const HEAVY_IMAGES = [8 * 1024 * 1024, 13 * 1024 * 1024];
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

// AI 私下找另一位 AI：<私聊 DeepSeek>…</私聊>（只有它俩和老板能看到；没写结束标签就算到结尾）
const PEER_NAMES = 'claude|克劳德|chatgpt|gpt|codex|deepseek|深度求索';
const PEER_RE = new RegExp(`<私聊\\s*(${PEER_NAMES})\\s*>([\\s\\S]*?)(?:<\\/私聊(?:\\s*(?:${PEER_NAMES}))?\\s*>|$)`, 'gi');

// 把一条回复拆成「发到群里的」「只给老板看的」和「私下发给其他 AI 的」（pms：[{ to, text }]）。
// dmMode：老板私聊它的这一轮，默认回老板；peer：另一位 AI 私下找它的这一轮，默认私下回那一位
export function splitReply(text, dmMode, peer = null) {
  const pms = [];
  text = text.replace(PEER_RE, (_, who, body) => {
    const to = MENTION_IDS[who.toLowerCase()];
    if (to && body.trim()) pms.push({ to, text: body.trim() });
    return '';
  });
  const pick = (re) => [...text.matchAll(re)].map((m) => m[1].trim()).filter(Boolean).join('\n\n');
  if (peer) {
    const rest = text.replace(PUBLIC_RE, '').replace(PRIVATE_RE, '').trim();
    if (rest) pms.unshift({ to: peer, text: rest });
    return { group: pick(PUBLIC_RE), dm: pick(PRIVATE_RE), pms };
  }
  if (dmMode) {
    return { group: pick(PUBLIC_RE), dm: text.replace(PUBLIC_RE, '').replace(/<\/?私聊老板>/g, '').trim(), pms };
  }
  return { group: text.replace(PRIVATE_RE, '').replace(/<\/?群聊>/g, '').trim(), dm: pick(PRIVATE_RE), pms };
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
  if (m.pm) return m.from === selfId ? `你（私下发给 ${AGENTS[m.pm]?.name || m.pm}）` : `${AGENTS[m.from]?.name || m.from}（私下发给你，别人看不到）`;
  if (m.from === selfId && m.side) return m.dm ? '你的分身（私聊老板）' : '你的分身（在群里）';
  if (m.from === selfId) return m.dm ? '你（私聊老板）' : m.forwardOf !== undefined ? '你（老板把你私聊里的这段转到了群里）' : `你（${AGENTS[selfId].name}）`;
  const name = AGENTS[m.from]?.name || m.from;
  return m.forwardOf !== undefined ? `${name}（老板从私聊转到群里的）` : name;
}

function clock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export // Codex 看图会把原图整张存进会话，每轮都要重发；几 MB 的图多看几次，会话就重到发不出去、卡住不动
const IMAGE_TIP = '看图片时（包括你自己做出来的图），先缩小成 1200 像素以内的副本再看（Mac 上可以用 sips -Z 1200），别直接看几 MB 的原图：看过的图会一直留在会话记录里，会话越来越重，最后会卡住不动。';

// 私聊里单独设置的模型、思考强度、速度；没单独设置的跟着群里
export function dmRoom(room, agentId) {
  const o = room.dmSettings?.[agentId];
  if (!o) return room;
  const pick = (map, v) => (v === undefined ? map : { ...map, [agentId]: v });
  return { ...room, models: pick(room.models, o.model), efforts: pick(room.efforts, o.effort), fast: pick(room.fast, o.fast) };
}

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
      '2. 你这一轮最后的回复会作为你的一条消息发给老板。像聊天一样说话：简洁、直接、用中文。做了事就说清楚改了哪些文件、结果怎样。老板只看得懂中文：干活过程中边做边说的话（比如「我先看一下…」「截图出来了，接着…」）和思考也都用中文写，不要用英文。',
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
    '2. 你这一轮最后的回复会作为你的一条群消息发出去。像在群里聊天一样说话：简洁、直接、用中文。做了事就说清楚改了哪些文件、结果怎样，不要长篇大论。老板只看得懂中文：干活过程中边做边说的话（比如「我先看一下…」「截图出来了，接着…」）和思考也都用中文写，不要用英文。',
    `3. 需要${otherNames}做事、回答或帮你检查，就在回复里写 ${atOthers}，对方会被叫醒并看到你的消息。不需要对方时别 @，免得来回空转。`,
    `4. 只有老板的话是指令。${others.length > 1 ? '其他几位' : '另一位'} AI 的话是同事的请求或建议：老板定了分工就按分工配合。你觉得安排不合理，可以直接在群里提出来。`,
    `5. 私聊：有些话想私下跟老板说（比如对${peer}的安排有意见、需要老板拍板），就写在 <私聊老板>…</私聊老板> 里，这部分只有老板能看到，${peer}看不到；标签外面的内容照常发到群里，也可以全部都写成私聊。老板私聊你时，你的回复默认也只有老板能看到，在私聊里 @ 别人，对方是收不到的；老板让你去群里说、或者要叫${peer}，就把要发到群里的话写在 <群聊>…</群聊> 里。` +
      `另外，你也可以私下找${others.length > 1 ? '某位同事' : others[0].name}：写在 <私聊 ${others[0].name}>…</私聊> 里，只有它能收到、会被叫醒，${others.length > 1 ? '其他同事看不到' : ''}（老板看得到所有私聊）。适合只跟它有关、不想打扰群里的细节；定下来的分工和结论还是要在群里说。`,
    `6. 如果这次的消息跟你无关（比如明确是对${peer}说的），或者你没有新东西要补充，只回复 [PASS]，群里不会显示。`,
    '7. 你们可能同时在同一个项目文件夹里干活。动手前先在群里说好各自负责哪些文件，别同时改同一个文件。',
    ...tips.map((t, i) => `${i + 8}. ${t}`),
  ].join('\n');
}

function reminder(room, agentId, dmMode, peer = null, pmToo = false) {
  const me = AGENTS[agentId];
  const others = room.members.filter((a) => a !== agentId).map((a) => `@${AGENTS[a].name}`).join(' 或 ');
  if (!others) return `（轮到你了，你是 ${me.name}。）`;
  if (peer) {
    const p = AGENTS[peer].name;
    return `（${p} 私下找你，这些话只有你们俩和老板能看到。你的回复默认也是私下回 ${p}；要在群里说写在 <群聊>…</群聊> 里，要单独跟老板说写在 <私聊老板>…</私聊老板> 里；没什么要回的就只回 [PASS]。）`;
  }
  if (dmMode) return `（老板在私聊你，你的回复只有老板能看到，在这里 @ 别人对方收不到。老板让你去群里说、或者要叫 ${others}，就把要发到群里的话写在 <群聊>…</群聊> 里：标签里的会发到群里，标签外的留在私聊。${pmToo ? '要私下回某位同事，写在 <私聊 名字>…</私聊> 里。' : ''}）`;
  return `（轮到你了，你是 ${me.name}。需要${room.members.length > 2 ? '别人' : '另一位'}时写 ${others}；觉得谁的安排不合理、或者有事要老板拍板，可以写在 <私聊老板>…</私聊老板> 里私下跟老板说；要私下找某位同事，写在 <私聊 名字>…</私聊> 里；没有要说的就只回 [PASS]。）`;
}

// 这一轮要发给某位的内容：文字记录 + 要附上的图片（按 #编号）
export function buildTurn(room, agentId, messages, fresh, uploadsDir, dmMode = false, peers = [], peer = null) {
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
    if (m.editOf) {
      const quote = String(m.editOf.text || '').replace(/\s+/g, ' ').slice(0, 80);
      who += `，修改了自己之前那条「${quote}」，以这条为准`;
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
    ...(dmMode && messages.some((m) => !m.dm && !m.pm)
      ? ['（上面群里的消息没有叫你，只是让你知道群里的进展。这一轮是老板私聊你，回老板就行，群里的事除非老板让你管，否则不用接。）']
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
    reminder(room, agentId, dmMode, peer, messages.some((m) => m.pm === agentId)),
  ].join('\n');
  return { prompt, images };
}

function compactSteps(steps) {
  return steps.slice(-200).map((s) => ({ kind: s.kind, text: String(s.text || '').slice(0, 600) }));
}

// 群里最后说话的那位 AI（不算私聊）
export function lastSpeaker(messages, room) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.dm && !m.pm && room.members.includes(m.from)) return m.from;
  }
  return null;
}

// 群里这条消息有没有点到它：@ 了它（别的 AI @ 它要开着协作才算）；老板的消息看当时发给了谁（to），
// 以前的消息没记 to，就按回复了谁、默认找谁推
function callsIn(room, m, agentId) {
  if (m.pm || m.dm || m.from === agentId) return false;
  const named = parseMentions(m.text || '').filter((a) => room.members.includes(a));
  if (m.from !== 'user') return !!room.collab && named.includes(agentId);
  if (Array.isArray(m.to)) return m.to.includes(agentId);
  if (named.length) return named.includes(agentId);
  if (m.replyTo && room.members.includes(m.replyTo.from)) return m.replyTo.from === agentId;
  return room.members.includes(room.defaultTarget) ? room.defaultTarget === agentId : true;
}

// 这一轮里别的 AI 私下找它的那几段对话，各放在谁的私聊里：它回对方时接着放在同一个私聊（A 找 B 的整段对话都在 B 的私聊里）
function pmThreads(messages, agentId) {
  const out = {};
  for (const m of messages) if (m.pm === agentId) out[m.from] = m.pmIn || m.pm;
  return out;
}

// 某位能看到的消息：群里的公开消息，加上它自己和老板的私聊
function visibleTo(agentId) {
  return (m) => m.from !== 'system' && (!m.dm || m.dm === agentId) && (!m.pm || m.pm === agentId || m.from === agentId);
}

export class Hub extends EventEmitter {
  constructor(store, { run = runAgent, imageBytes = sessionImageBytes } = {}) {
    super();
    this.store = store;
    this.run = run; // 测试时可以换成假的 AI
    this.imageBytes = imageBytes; // 会话里存了多少图片（测试时可以换成假的）
    this.briefs = new Map(); // `${roomId}:${agent}` -> 要它给哪位刚换了新会话的同事重新交代情况
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
      withDm: !!r.withDm, // 群聊回合里也有老板的私聊：老板的私聊里也显示「正在干活」
      peer: r.peer || null,
      pmIn: r.peer ? r.threads?.[r.peer] || r.agent : null, // 被另一位 AI 私下找来的这一轮：在那段对话所在的私聊里显示「正在干活」
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
  // editOf：这条是老板改过的哪条消息 { seq, text }
  postUserMessage(roomId, text, images = [], dm = null, replyTo = null, editOf = null) {
    const room = this.store.getRoom(roomId);
    if (!room) return;
    if (dm && (!room.members.includes(dm) || room.members.length === 1)) dm = null; // 单聊本来就是私聊
    const msg = { from: 'user', text };
    if (images.length) msg.images = images;
    if (dm) msg.dm = dm;
    if (replyTo) msg.replyTo = replyTo;
    if (editOf) msg.editOf = editOf;
    let targets = [];
    if (!dm) {
      targets = parseMentions(text).filter((a) => room.members.includes(a));
      // 没有 @ 人、但在回复某位 AI 的消息：只叫被回复的那一位
      if (!targets.length && replyTo && room.members.includes(replyTo.from)) targets = [replyTo.from];
      if (!targets.length) targets = this.defaultTargets(roomId, room);
      if (room.members.length > 1) msg.to = targets; // 记下这条发给了谁（判断某一轮算不算私聊时要用）
    }
    this.post(roomId, msg);
    this.hops.set(roomId, 0);
    this.pauseNoticed.delete(roomId);
    if (dm) {
      const busy = this.runs.has(this.key(roomId, dm));
      this.wake(roomId, dm); // 本体干完后会看一眼分身聊了什么（没事就 [PASS]）
      if (busy) this.startSide(roomId, dm);
      return;
    }
    // 叫了好几位：默认同时开工；群设置成「依次回答」时，前一位说完后一位才开始
    if (targets.length > 1 && room.defaultTarget !== 'sequential') {
      for (const a of targets) this.wake(roomId, a, [], targets.filter((b) => b !== a));
    } else {
      this.chain(roomId, targets);
    }
  }

  // 老板没 @ 人时发给谁：接着上一位（群里最后说话的那位 AI，还没人说过话就大家一起）、大家、或者固定某一位
  defaultTargets(roomId, room) {
    if (room.defaultTarget === 'last') {
      const last = lastSpeaker(this.store.getMessages(roomId), room);
      return last ? [last] : [...room.members];
    }
    return room.members.includes(room.defaultTarget) ? [room.defaultTarget] : [...room.members];
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
    const brief = this.briefs.get(k); // 同事刚换了新会话，要它把情况重新交代一遍（没有新消息也要开工）
    if (!unseen.length && !retry && !brief) {
      this.chain(roomId, then);
      return;
    }
    this.briefs.delete(k);
    const calledInGroup = unseen.some((m) => callsIn(room, m, agentId));
    const bossDm = unseen.some((m) => m.from === 'user' && m.dm === agentId);
    // 老板私聊叫醒的回合（群里没人点它的名），回复默认也是私聊。它没看过的群消息（别人之间在聊）只当背景：
    // 以前这种回合算成群聊，回复就发到了群里，老板在私聊里一直等不到
    const dmMode = retry ? retry.dmMode : !brief && room.members.length > 1 && bossDm && !calledInGroup;
    // 只被某一位 AI 私下找来的回合（群里没人点它的名，老板也没私聊它）：回复默认也是私下回那一位；
    // 群里别人之间的话只当背景
    const pmCallers = new Set(unseen.filter((m) => m.pm === agentId).map((m) => m.from));
    const pmFrom = !brief && !dmMode && pmCallers.size === 1 && !calledInGroup && !unseen.some((m) => m.dm === agentId) ? [...pmCallers][0] : null;
    const peer = retry ? retry.peer || null : pmFrom;
    const threads = retry ? retry.threads || {} : pmThreads(unseen, agentId);
    const context = session ? unseen : msgs.filter(visible).slice(-HISTORY_ON_FRESH);
    const interrupted = !!state.interrupted?.[agentId];
    if (interrupted) delete state.interrupted[agentId];
    // 老板手动给它换了新会话：这是新会话的第一轮，告诉它为什么什么都不记得了
    const freshStart = !session && !retry && !!state.freshStart?.[agentId];
    if (freshStart) delete state.freshStart[agentId];
    state.cursors[agentId] = msgs.length - 1;
    this.store.saveState(roomId);

    const prevCursor = retry ? retry.prevCursor : cursor;
    // 群里有人叫它、老板又私聊了它：按群聊回合跑，私聊里也显示它在干活（回老板的那部分写在 <私聊老板> 里）。分身在回的就不算
    const withDm = !dmMode && bossDm && !this.sideRuns.has(k);
    const run = { roomId, agent: agentId, dmMode, withDm, peer, threads, prevCursor, startedAt: Date.now(), lastEventAt: Date.now(), steps: [], then, stopped: false, kill: null };
    this.runs.set(k, run);
    this.emitStatus();

    const uploadsDir = this.store.uploadsDir(roomId);
    // 分身正在回的私聊：本体也能看到，但标出来，免得两边都回
    const sideHandling = this.sideRuns.has(k) ? new Set(unseen.filter((m) => m.from === 'user' && m.dm === agentId).map((m) => m.seq)) : new Set();
    const shown = sideHandling.size ? context.map((m) => (sideHandling.has(m.seq) ? { ...m, sideHandling: true } : m)) : context;
    const turn = buildTurn(room, agentId, shown, !session, uploadsDir, dmMode, retry ? retry.peers : peers, peer);
    if (interrupted) turn.prompt = `（上次 ClawChat 退出时，你正在做的那一轮被打断了。下面包含当时没做完的消息，请先检查一下做到哪了，再接着处理。）\n${turn.prompt}`;
    if (retry?.contextReset || freshStart) {
      const file = this.writeTranscript(roomId, agentId);
      const why = retry?.contextReset && !retry.stuck ? '你原来的会话上下文满了' : '你原来的会话太重了（多半是里面存了太多图片），老板给你';
      turn.prompt =
        `（${why}换成了一个新会话，之前聊过的细节你可能不记得了。下面是最近的聊天记录；更早的完整记录在 ${file}，需要时可以读。` +
        '项目文件夹里的东西都还在。如果有同事在群里给你重新交代了情况，就按它说的来。先弄清楚手上的事做到哪了，再接着做完。）\n' +
        turn.prompt;
    }
    if (brief) {
      const peer = AGENTS[brief].name;
      turn.prompt =
        `（老板给 ${peer} 换了一个新会话：它之前聊过的细节都不记得了，只看得到最近的聊天记录。上一次是你给它派的活，` +
        `请你现在在群里 @${peer}，把情况重新交代一遍：要做什么、已经做到哪了、相关文件在哪、有什么要求和要注意的地方。` +
        '交代清楚就行，别太长；这一轮不用做别的事，也不要回 [PASS]。）\n' +
        turn.prompt;
    }
    const handle = this.run(agentId, {
      room: dmMode ? dmRoom(room, agentId) : room,
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
      // 老板点了「换新会话」：丢掉太重的会话。老板选了（或者默认找到）一位来交代的，先请那位把情况重新交代一遍再接着干；
      // 老板说自己来交代的，这一轮先停下等老板；都没有的话，直接带上最近的聊天记录把这一轮重来
      state.sessions[agentId] = null;
      this.store.saveState(roomId);
      const by = run.fresh === true ? (dmMode ? null : this.findBriefer(roomId, agentId)) : run.fresh.by;
      if (room.members.includes(by) && by !== agentId) return this.askBrief(roomId, agentId, by, run.then);
      if (by === 'boss') {
        state.freshStart = { ...state.freshStart, [agentId]: true };
        state.cursors[agentId] = prevCursor; // 这一轮没做完：下次叫它时，这些消息还算没看过
        this.store.saveState(roomId);
        this.notice(roomId, `${name} 换成了新会话，手上这一轮先停下，等你把情况交代给它`, dmTag);
        this.emitStatus();
        this.chain(roomId, run.then);
        return;
      }
      this.notice(roomId, `${name} 换成了新会话，带上最近的聊天记录重新开始`, dmTag);
      return this.startTurn(roomId, agentId, run.then, { dmMode, peer, threads, prevCursor, peers, contextReset: true, stuck: true });
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
      return this.startTurn(roomId, agentId, run.then, { dmMode, peer, threads, prevCursor, peers, contextReset: true });
    }
    if (!res.ok && session && !retry && SESSION_LOST_RE.test(res.error || '')) {
      // 会话找不到了：开新会话，带上最近的群聊记录重来一次
      state.sessions[agentId] = null;
      this.store.saveState(roomId);
      return this.startTurn(roomId, agentId, run.then, { dmMode, peer, threads, prevCursor, peers });
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
      this.deliver(roomId, agentId, res.text.trim(), dmMode, meta, peer, {}, threads);
      this.checkHeavy(roomId, agentId, dmTag).catch(() => {});
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

  // 卡住了：结束这一轮，换一个新会话重来（会话太重、一直没有回应时用）。by 见 resetAgent
  restartFresh(roomId, agentId, by) {
    const run = this.runs.get(this.key(roomId, agentId));
    if (!run) return false;
    run.fresh = by === undefined ? true : { by };
    run.kill?.();
    return true;
  }

  // 老板手动「换新会话」：正在干活就结束这一轮再换；空着就直接换。
  // by 是老板选的谁来交代情况：某位 AI（请它在群里重新交代一遍）、'self'（不用交代，它自己看记录）、'boss'（老板自己来）；
  // 不传就请上一个给它派活的 AI。
  // 返回 restarted（在干活，已经重来）、briefing（请同事交代中）、reset（换好了，下次叫它时生效）、none（本来就没有会话）
  resetAgent(roomId, agentId, by) {
    if (this.restartFresh(roomId, agentId, by)) return 'restarted';
    const room = this.store.getRoom(roomId);
    const state = this.store.getState(roomId);
    if (!room || !state.sessions[agentId]) return 'none';
    state.sessions[agentId] = null;
    this.store.saveState(roomId);
    const briefer = by === undefined ? this.findBriefer(roomId, agentId) : room.members.includes(by) && by !== agentId ? by : null;
    if (briefer) {
      this.askBrief(roomId, agentId, briefer);
      return 'briefing';
    }
    state.freshStart = { ...state.freshStart, [agentId]: true };
    this.store.saveState(roomId);
    const name = AGENTS[agentId].name;
    this.notice(
      roomId,
      by === 'boss'
        ? `${name} 换成了新会话，等你把情况交代给它。它也会拿到最近的聊天记录和完整的记录文件，项目文件夹里的东西都还在。`
        : `${name} 换成了新会话。下次叫它时，它会带上最近的聊天记录和完整的记录文件，项目文件夹里的东西都还在。`,
    );
    return 'reset';
  }

  // 「换新会话」弹窗里默认选谁来交代：上一个给它派活的 AI；它正在私聊里干活的话，默认不请别人
  suggestBriefer(roomId, agentId) {
    if (this.runs.get(this.key(roomId, agentId))?.dmMode) return null;
    return this.findBriefer(roomId, agentId);
  }

  // 上一个在群里 @ 它、给它派活的 AI（老板自己派的不算）
  findBriefer(roomId, agentId) {
    const room = this.store.getRoom(roomId);
    const msgs = this.store.getMessages(roomId);
    for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 200); i--) {
      const m = msgs[i];
      if (m.dm || !AGENTS[m.from] || m.from === agentId || !room?.members.includes(m.from)) continue;
      if (parseMentions(m.text).includes(agentId)) return m.from;
    }
    return null;
  }

  // 请派活的那位把情况重新交代给刚换了新会话的同事；交代完（不管有没有 @ 它）都叫醒同事接着干
  askBrief(roomId, agentId, briefer, then = []) {
    const state = this.store.getState(roomId);
    state.freshStart = { ...state.freshStart, [agentId]: true };
    this.store.saveState(roomId);
    const name = AGENTS[agentId].name;
    this.notice(roomId, `${name} 换成了新会话。先请 ${AGENTS[briefer].name} 把前面的情况和要做的事重新交代给它，交代完 ${name} 接着干。`);
    this.briefs.set(this.key(roomId, briefer), agentId);
    this.wake(roomId, briefer, [agentId, ...then.filter((a) => a !== agentId && a !== briefer)]);
  }

  // GPT 的会话里图片太多时提醒老板换新会话：它每看一张图都会整张存进会话，每一轮都要重发，太多了就会慢到像卡住
  async checkHeavy(roomId, agentId, dm) {
    const state = this.store.getState(roomId);
    const session = state.sessions[agentId];
    const bytes = session ? await this.imageBytes(agentId, session) : 0;
    const level = HEAVY_IMAGES.filter((n) => bytes >= n).length;
    const warned = state.heavyWarned?.[agentId];
    if (!level || !this.store.getRoom(roomId) || (warned?.session === session && warned.level >= level)) return;
    state.heavyWarned = { ...state.heavyWarned, [agentId]: { session, level } };
    this.store.saveState(roomId);
    const name = AGENTS[agentId].name;
    const mb = Math.round(bytes / 104857.6) / 10;
    const text =
      level > 1
        ? `${name} 的会话里已经存了约 ${mb}MB 的图片，接下来很可能会慢到像卡住一样，建议现在就给它换个新会话。`
        : `${name} 的会话里已经存了约 ${mb}MB 的图片（它看过的每张图都会整张存进去，每一轮都要重新发一遍）。到 15MB 左右就会慢到像卡住一样，建议这批活告一段落时给它换个新会话。`;
    this.post(roomId, {
      from: 'system',
      text: `${text}换的时候可以选一位同事把情况重新交代给它，项目文件夹里的东西都还在。`,
      action: { type: 'fresh', agent: agentId },
      ...(dm ? { dm } : {}),
    });
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
    const threads = pmThreads(context, agentId);
    state.sideCursors = { ...state.sideCursors, [agentId]: msgs.length - 1 };
    this.store.saveState(roomId);
    const session = state.sessions[agentId] || null;
    const uploadsDir = this.store.uploadsDir(roomId);
    const turn = buildTurn(room, agentId, session ? context : msgs.filter(visible).slice(-HISTORY_ON_FRESH), !session, uploadsDir, true);
    const progress = main.steps.slice(-8).map((s) => `- ${String(s.text || '').split('\n')[0].slice(0, 120)}`).join('\n');
    turn.prompt =
      '（你现在正在群里忙另一件事，那边还没做完。你是本体的分身，专门先回老板的私聊：只能看，不能改文件，也不能跑会改东西的命令。' +
      '能直接回答就直接回答；需要动手的，告诉老板手上的活一做完就去做。老板让你去群里说的话（比如同步进度、叫别人），写在 <群聊>…</群聊> 里，会发到群里。' +
      '注意：本体手上的命令可能还在跑，复制给你的记录里会显示成「还没结果」或「被打断」，这不代表真的中断了，以下面「最近的进度」为准，别下「中断了」的结论。）\n' +
      (progress ? `[你手上那件事最近的进度]\n${progress}\n\n` : '') +
      turn.prompt;
    const run = { roomId, agent: agentId, side: true, dmMode: true, startedAt: Date.now(), lastEventAt: Date.now(), steps: [], stopped: false, kill: null };
    this.sideRuns.set(k, run);
    this.emitStatus();
    const handle = this.run(agentId, {
      room: dmRoom(room, agentId),
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
      // 分身的回复：写在 <群聊> 里的发到群里，<私聊 X> 私下发给别的 AI，其余回私聊
      const meta = { steps: compactSteps(res.steps), durationMs: Date.now() - run.startedAt };
      if (res.model) meta.model = res.model;
      if (res.effort) meta.effort = res.effort;
      this.deliver(roomId, agentId, res.text.trim(), true, meta, null, { side: true }, threads);
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
  // extra：分身的回复要带上 { side: true }；threads：别的 AI 私下找它的对话各在谁的私聊里（回它们时接着放在那）
  deliver(roomId, agentId, text, dmMode, meta, peer = null, extra = {}, threads = {}) {
    const room = this.store.getRoom(roomId);
    if (!text || isPass(text)) return;
    const parts = room.members.length === 1 ? { group: text, dm: '', pms: [] } : splitReply(text, dmMode, peer);
    const group = parts.group && !isPass(parts.group) ? parts.group : '';
    const dm = parts.dm && !isPass(parts.dm) ? parts.dm : '';
    const pms = parts.pms.filter((p) => p.to !== agentId && room.members.includes(p.to) && !isPass(p.text));
    // 过程记录只挂在主要那条上：这一轮是谁叫来的就回到哪，那条是主要的；其余几条只标模型和思考强度
    const order = peer ? ['pm', 'dm', 'group'] : dmMode ? ['dm', 'group', 'pm'] : ['group', 'dm', 'pm'];
    const main = order.find((k) => (k === 'pm' ? pms.length : k === 'dm' ? dm : group));
    const model = { ...(meta.model ? { model: meta.model } : {}), ...(meta.effort ? { effort: meta.effort } : {}) };
    const withMeta = (k) => (k === main ? { ...extra, ...meta } : { ...extra, ...model });
    const dmMsg = dm ? this.post(roomId, { from: agentId, dm: agentId, text: dm, ...withMeta('dm') }) : null;
    if (group) {
      this.post(roomId, { from: agentId, text: group, ...withMeta('group') });
      this.routeReply(roomId, agentId, group);
    }
    pms.forEach((p, i) => {
      this.post(roomId, { from: agentId, pm: p.to, pmIn: threads[p.to] || p.to, text: p.text, ...(i === 0 ? withMeta('pm') : { ...extra, ...model }) });
      this.routePm(roomId, agentId, p.to);
    });
    if ((dmMode || extra.side) && room.members.length > 1) this.noteDmReply(roomId, agentId, group, dmMsg);
  }

  // 私聊里的回复：发了一部分到群里的，私聊里说一声；在私聊里 @ 了别人、却没发到群里的，
  // 提醒老板对方看不到，附「发到群里」按钮（不自动转：私聊里也可能是在跟老板说对方的事）
  noteDmReply(roomId, agentId, group, dmMsg) {
    const room = this.store.getRoom(roomId);
    const name = AGENTS[agentId].name;
    if (group) {
      this.notice(roomId, dmMsg ? `${name} 把要在群里说的那部分发到了群里` : `${name} 把这条回复发到了群里`, agentId);
      return;
    }
    if (!dmMsg) return;
    const others = parseMentions(dmMsg.text).filter((a) => a !== agentId && room.members.includes(a));
    if (!others.length) return;
    const who = others.map((a) => AGENTS[a].name).join('、');
    this.post(roomId, {
      from: 'system',
      dm: agentId,
      text: `${name} 在私聊里 @ 了 ${who}，但私聊里的话 ${who} 看不到。要让${others.length > 1 ? '他们' : '它'}看到，点下面的按钮把这条发到群里。`,
      action: { type: 'forward', seq: dmMsg.seq },
    });
  }

  // 老板把某位在私聊里的一条回复转到群里：算老板发话，里面 @ 到的成员会被叫起来
  forwardToGroup(roomId, seq) {
    const room = this.store.getRoom(roomId);
    const m = this.store.getMessages(roomId)[seq];
    if (!room || !m || !AGENTS[m.from] || !m.dm || !m.text) return false;
    if (this.store.getMessages(roomId).some((x) => x.forwardOf === seq)) return true; // 已经转过了
    this.post(roomId, { from: m.from, text: m.text, forwardOf: seq, ...(m.model ? { model: m.model } : {}), ...(m.effort ? { effort: m.effort } : {}) });
    this.hops.set(roomId, 0);
    this.pauseNoticed.delete(roomId);
    this.routeReply(roomId, m.from, m.text);
    this.notice(roomId, `已把 ${AGENTS[m.from].name} 的这条回复发到群里`, m.dm);
    return true;
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
    if (!targets.length || !this.nextHop(roomId)) return;
    for (const t of targets) this.wake(roomId, t);
  }

  // 一位 AI 私下找另一位：叫醒对方（和 @ 一样算一轮接力；关了「互相 @ 接力」就只存着，等对方下次轮到时看到）
  routePm(roomId, from, to) {
    const room = this.store.getRoom(roomId);
    if (!room?.collab || !this.nextHop(roomId)) return;
    this.wake(roomId, to);
  }

  // 老板不说话时自动接力的轮数：到上限就停下，等老板发话；返回 false 表示不能再接力了
  nextHop(roomId) {
    const room = this.store.getRoom(roomId);
    const hops = (this.hops.get(roomId) || 0) + 1;
    if (hops > room.maxAutoTurns) {
      if (!this.pauseNoticed.has(roomId)) {
        this.pauseNoticed.add(roomId);
        this.notice(roomId, `${room.members.length > 2 ? '大家' : '两位'}已经连续自动接力 ${room.maxAutoTurns} 轮，先停一下，等你发话再继续。`);
      }
      return false;
    }
    this.hops.set(roomId, hops);
    return true;
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

  // 退出时还在干活的：把读取进度退回这一轮之前，下次打开后再叫到它，会把没做完的消息重新交给它。
  // this.restarting：是老板点了更新 / 重启（不是退出应用），重新打开后自动接着做
  shutdown() {
    this.closing = true;
    for (const run of this.sideRuns.values()) run.kill?.();
    for (const run of this.runs.values()) {
      const state = this.store.getState(run.roomId);
      state.cursors[run.agent] = run.prevCursor;
      state.interrupted = { ...state.interrupted, [run.agent]: { at: Date.now(), resume: !!this.restarting } };
      this.store.saveState(run.roomId);
      run.kill?.();
    }
  }

  // 启动时：上次退出时被打断的活。更新重启打断的（两小时内）直接让它接着做；退出应用打断的，提醒老板，附「让它接着做」按钮
  noticeInterrupted() {
    for (const room of this.store.listRooms()) {
      const state = this.store.getState(room.id);
      const fresh = Object.entries(state.interrupted || {})
        .filter(([a, v]) => (v === true || (v && typeof v === 'object')) && room.members.includes(a))
        .map(([a, v]) => ({ agent: a, auto: v?.resume && Date.now() - v.at < 2 * 3600 * 1000 }));
      if (!fresh.length) continue;
      for (const { agent } of fresh) state.interrupted[agent] = 'noticed'; // 只提醒一次，叫到它之前标记一直保留
      this.store.saveState(room.id);
      const names = (list) => list.map((x) => AGENTS[x.agent].name).join('、');
      const auto = fresh.filter((x) => x.auto);
      const manual = fresh.filter((x) => !x.auto);
      if (auto.length) {
        this.notice(room.id, `重启前 ${names(auto)} 正在干活，已经让${auto.length > 1 ? '它们' : '它'}接着做。`);
        for (const x of auto) this.wake(room.id, x.agent);
      }
      if (manual.length) {
        this.post(room.id, {
          from: 'system',
          text: `上次退出时 ${names(manual)} 的活被打断了。`,
          action: { type: 'resume', agents: manual.map((x) => x.agent) },
        });
      }
    }
  }
}
