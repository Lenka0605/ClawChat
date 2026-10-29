'use strict';

const $ = (s) => document.querySelector(s);
const STEP_ICON = { run: '$', edit: '✎', read: '📄', search: '🔍', web: '🌐', say: '💬', think: '💭', todo: '☑', task: '🤖', tool: '🔧' };
const PERM_LABEL = { project: '项目内放手干', full: '完全放开', readonly: '只读讨论' };
const IS_WIN = document.documentElement.classList.contains('win');
const AGENT_IDS = ['claude', 'gpt', 'deepseek'];
const IMAGE_EXT_TYPES = { heic: 'image/heic', heif: 'image/heif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp' };

// 会话：每个群/单聊是 g:<roomId>；群里和某位的私聊是 d:<roomId>:<agent>
const S = {
  rooms: [],
  current: null, // 当前会话 key
  messages: new Map(), // roomId -> message[]
  early: new Map(), // 消息列表还没加载完时收到的新消息
  runs: [],
  live: new Map(), // `${roomId}:${agent}` -> 这一轮到目前为止的过程步骤
  liveAt: new Map(), // 同上 -> 最后一次有动静的时间（判断是不是卡住了）
  liveOpen: new Set(), // 展开了过程的那几个
  liveSeen: new Set(), // 已经播过进场动画的「正在干活」气泡
  replyTo: null, // 正在回复哪条消息
  unread: new Map(), // 会话 key -> 未读数
  openedDms: new Map(), // 打开过但还没消息的私聊，key -> 打开时间
  attachments: [], // 待发送的图片
  engines: {},
  agents: {},
  defaults: {},
  projectsDir: '',
  editing: null,
  filter: '',
};

function storeGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function storeSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-clawchat': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

// 在 ClawChat.app 窗口里运行时，和原生外壳通信（Dock 角标、选文件夹）
function native(msg) {
  try {
    window.webkit?.messageHandlers?.clawchat?.postMessage(msg);
  } catch {}
}
const hasNative = () => !!window.webkit?.messageHandlers?.clawchat;

// ---------------- 外观（浅色 / 深色 / 跟随系统） ----------------

function currentTheme() {
  const t = storeGet('clawchat.theme');
  return t === 'light' || t === 'dark' ? t : 'system';
}

function applyTheme(mode) {
  const root = document.documentElement;
  if (applyTheme.ready && !reduceMotion()) {
    root.classList.add('theme-switching');
    clearTimeout(applyTheme.timer);
    applyTheme.timer = setTimeout(() => root.classList.remove('theme-switching'), 450);
  }
  applyTheme.ready = true;
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  storeSet('clawchat.theme', mode);
  native({ type: 'theme', value: mode }); // 让窗口的毛玻璃和系统控件也跟着变
  document.querySelectorAll('#theme-switch [data-theme-value]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeValue === mode)));
}

// 原生窗口没有标题栏：告诉外壳哪些区域可以拖动窗口（按钮等可点的地方除外）
function reportDragRegions() {
  if (!hasNative()) return;
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  };
  const shown = (el) => el.getClientRects().length > 0;
  const blocked = document.querySelector('dialog[open]') || !$('#lightbox').hidden;
  const drag = blocked ? [] : [...document.querySelectorAll('[data-drag]')].filter(shown).map(rect);
  const nodrag = [...document.querySelectorAll('[data-drag] :is(button, select, input, a, label, textarea)')].filter(shown).map(rect);
  native({ type: 'dragRegions', drag, nodrag });
}

// ---------------- 动画小工具 ----------------

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// 先播放一段 CSS 动画（加 class），播完再执行 done；系统开了「减少动态效果」就直接执行
function animateThen(el, cls, ms, done) {
  if (!el || reduceMotion()) return done();
  el.classList.add(cls);
  setTimeout(() => {
    el.classList.remove(cls);
    done();
  }, ms);
}

// 关弹窗：先淡出缩小，再真正关掉
function closeDialog(dlg) {
  if (!dlg?.open || dlg.classList.contains('closing')) return;
  animateThen(dlg, 'closing', 160, () => dlg.close());
}

// 重新播放一次进场动画
function replay(el, cls) {
  if (!el || reduceMotion()) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('leaving');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => animateThen(t, 'leaving', 200, () => (t.hidden = true)), ms);
}

// ---------------- 格式化 ----------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const pad = (n) => String(n).padStart(2, '0');

function sameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, now)) return hm;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function fmtShort(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${pad(s % 60)}秒`;
  return `${Math.floor(m / 60)}小时${m % 60}分`;
}

function firstLine(s) {
  return String(s || '').split('\n')[0].slice(0, 200);
}

function agentLabel(id) {
  return S.agents[id]?.label || id;
}

function agentName(id) {
  return S.agents[id]?.name || id;
}

const AGENT_ENGINE = { claude: 'claude', gpt: 'codex', deepseek: 'deepseek' };
const DEFAULT_HINT = { claude: '跟随 Claude Code 的设置', gpt: '跟随 Codex 的设置', deepseek: '又快又便宜，能看图' };

// 某位可选的模型：第一项是「默认」（跟随 Claude Code / Codex 自己的设置；DeepSeek 默认用 Flash）
function modelOptions(agent) {
  const e = S.engines[AGENT_ENGINE[agent]] || {};
  const label = e.defaultLabel || (e.defaultModel ? modelLabel(e.defaultModel) : '');
  const def = { id: '', name: `默认${label ? ` · ${label}` : ''}`, description: DEFAULT_HINT[agent] || '' };
  return [def, ...(e.models || [])];
}

// 模型的规范写法：claude-opus-5-5 → Opus 5.5，opus → Opus 5.5（当前对应的版本），gpt-6.1-sol → GPT-6.1-Sol
function modelLabel(id) {
  id = String(id || '').replace(/\[1m\]$/i, ''); // DeepSeek 的 1M 上下文标记
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  const known = Object.values(AGENT_ENGINE).flatMap((k) => S.engines[k]?.models || []).find((x) => x.id === id);
  if (known) return known.name;
  return String(id || '').replace(/^gpt-/i, 'GPT-').replace(/-([a-z])/g, (_, c) => `-${c.toUpperCase()}`);
}

// 思考强度：Claude 固定五档；Codex 每个模型支持的不一样（Luna 没有「极限」）
const EFFORT_LABEL = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极限' };
const EFFORT_HINT = {
  low: '最快，适合简单的事',
  medium: '速度和深度兼顾',
  high: '想得更深，适合复杂问题',
  xhigh: '比「高」再深一档',
  max: '最深，最难的问题用',
  ultra: '最深，还会自动把任务拆给帮手',
};

function effortsFor(agent, modelId) {
  const e = S.engines[AGENT_ENGINE[agent]] || {};
  if (agent === 'claude') return e.efforts || [];
  return e.models?.find((m) => m.id === (modelId || e.defaultModel))?.efforts || [];
}

function effortSelectHtml(agent, modelId, current, attrs = '') {
  const e = S.engines[AGENT_ENGINE[agent]] || {};
  const list = effortsFor(agent, modelId);
  // 没在设置里指定时，用的是模型自己的默认强度（Codex、DeepSeek 的模型目录里带着）
  const fallback = e.defaultEffort || e.models?.find((m) => m.id === (modelId || e.defaultModel))?.defaultEffort || '';
  const def = fallback ? `默认 · ${EFFORT_LABEL[fallback] || fallback}` : '默认';
  const opts = [{ id: '', name: def, hint: '跟随自己的设置' }, ...list.map((id) => ({ id, name: EFFORT_LABEL[id] || id, hint: EFFORT_HINT[id] || '' }))];
  return `<select ${attrs}>${opts
    .map((o) => `<option value="${esc(o.id)}"${o.id === (current || '') ? ' selected' : ''} title="${esc(o.hint)}">${esc(o.name)}</option>`)
    .join('')}</select>`;
}

const CUSTOM_MODEL = '__custom__';

function modelSelectHtml(agent, current, attrs = '', allowCustom = false) {
  const opts = modelOptions(agent);
  // 列表外的（手动填过的新模型）也显示出来
  const extra = current && !opts.some((o) => o.id === current) ? [{ id: current, name: `${current}（自定义）` }] : [];
  const custom = allowCustom ? `<option value="${CUSTOM_MODEL}">自定义模型…</option>` : '';
  return `<select ${attrs}>${[...opts, ...extra]
    .map((o) => `<option value="${esc(o.id)}"${o.id === (current || '') ? ' selected' : ''} title="${esc(o.description || '')}">${esc(o.name)}</option>`)
    .join('')}${custom}</select>`;
}

function avatarHtml(who, extra = '') {
  return who === 'user' ? '<span class="avatar av-user">我</span>' : `<span class="avatar av-${esc(who)}" ${extra}></span>`;
}

// 让路径在「从右往左截断」的样式里保持原顺序
const ltr = (s) => `‎${s}‎`;

// ---------------- Markdown（够聊天用的精简版） ----------------

function inline(s) {
  return String(s)
    .split(/(`[^`\n]+`)/g)
    .map((part, idx) => {
      if (idx % 2 === 1) return `<code>${esc(part.slice(1, -1))}</code>`;
      let h = esc(part);
      h = h.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      h = h.replace(/(^|[\s(（：:])(https?:\/\/[^\s<>()（）]*[^\s<>()（）.,;:!?。，；：！？'"])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
      h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      // 只在标签外面高亮 @，免得改坏链接地址
      return h
        .split(/(<[^>]+>)/g)
        .map((seg, j) => (j % 2 === 1 ? seg : seg.replace(/(^|[^A-Za-z0-9_.])@(Claude|GPT|Codex|ChatGPT|DeepSeek|深度求索|所有人|全体成员|全体|大家)/gi, '$1<span class="mention">@$2</span>')))
        .join('');
    })
    .join('');
}

function md(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const isFence = (l) => /^\s*```/.test(l);
  const isList = (l) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(l);
  const isRule = (l) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l || '');
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l || '');
  const isBlockStart = (l, next) =>
    isFence(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || isList(l) || isRule(l) || (isTableRow(l) && isTableSep(next));
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isFence(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = Math.min(h[1].length + 2, 6);
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }
    if (isRule(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${md(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (isTableRow(line) && isTableSep(lines[i + 1])) {
      const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const body = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) body.push(cells(lines[i++]));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    if (isList(line)) {
      const num = line.match(/^\s*(\d+)[.)]/);
      const items = [];
      while (i < lines.length && (isList(lines[i]) || (items.length && /^\s{2,}\S/.test(lines[i])))) {
        const l = lines[i++];
        if (isList(l)) items.push(l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
        else items[items.length - 1] += '\n' + l.trim();
      }
      const lis = items.map((t) => `<li>${t.split('\n').map(inline).join('<br>')}</li>`).join('');
      out.push(num ? `<ol start="${Number(num[1])}">${lis}</ol>` : `<ul>${lis}</ul>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (!para.length || !isBlockStart(lines[i], lines[i + 1]))) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

// ---------------- 会话 ----------------

function roomById(id) {
  return S.rooms.find((r) => r.id === id) || null;
}

function parseKey(key) {
  const [kind, roomId, dm] = String(key || '').split(':');
  if (kind === 'g') return { key, roomId, dm: null };
  if (kind === 'd' && dm) return { key, roomId, dm };
  return null;
}

function convOf(roomId, m) {
  return m.dm ? `d:${roomId}:${m.dm}` : `g:${roomId}`;
}

function currentConv() {
  const c = parseKey(S.current);
  const room = c && roomById(c.roomId);
  if (!room) return null;
  if (c.dm && (!room.members.includes(c.dm) || room.members.length < 2)) return null;
  return { ...c, room };
}

function inConv(conv, m) {
  return conv.dm ? m.dm === conv.dm : !m.dm;
}

// 侧栏结构：每个群一项，群里的私聊挂在群下面（可以展开收起）；群按最近动静排序，群和它的私聊一起算
function groupedConversations() {
  const groups = S.rooms.map((r) => {
    const group = { key: `g:${r.id}`, room: r, dm: null, last: r.last, ts: r.last?.ts || r.createdAt };
    const dms = [];
    if (r.members.length > 1) {
      for (const a of r.members) {
        const key = `d:${r.id}:${a}`;
        const last = r.dmLast?.[a];
        if (last || S.openedDms.has(key)) dms.push({ key, room: r, dm: a, last, ts: last?.ts || S.openedDms.get(key) });
      }
    }
    dms.sort((a, b) => b.ts - a.ts);
    return { group, dms, ts: Math.max(group.ts, ...dms.map((d) => d.ts)) };
  });
  return groups.sort((a, b) => b.ts - a.ts);
}

function conversations() {
  return groupedConversations().flatMap((g) => [g.group, ...g.dms]);
}

const collapsed = new Set((() => {
  try {
    return JSON.parse(storeGet('clawchat.collapsed') || '[]');
  } catch {
    return [];
  }
})());
// 私聊项滑开 / 收起：高度、上下留白、透明度一起变，下面的项跟着平滑移动，不会一下子跳过去
function slideItem(li, opening) {
  const cs = getComputedStyle(li);
  const full = { height: `${li.offsetHeight}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginBottom: cs.marginBottom, opacity: 1, transform: 'none' };
  const zero = { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginBottom: '0px', opacity: 0, transform: 'translateY(-6px)' };
  li.style.overflow = 'hidden';
  const anim = li.animate(opening ? [zero, full] : [full, zero], {
    duration: opening ? 260 : 200,
    easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)',
    fill: opening ? 'none' : 'forwards', // 收起的最后一帧停在 0 高度，等列表重画
  });
  anim.finished.then(() => (li.style.overflow = '')).catch(() => {});
  return anim.finished.catch(() => {});
}

function toggleCollapsed(roomId) {
  if (toggleCollapsed.busy) return; // 动画没放完又点了一下：忽略，免得抖
  const closing = !collapsed.has(roomId);
  document.querySelector(`[data-toggle="${CSS.escape(roomId)}"]`)?.classList.toggle('open', !closing);
  const childrenOf = () => [...document.querySelectorAll('.conv-item.child')].filter((li) => li.dataset.key.startsWith(`d:${roomId}:`));
  const apply = () => {
    if (closing) collapsed.add(roomId);
    else collapsed.delete(roomId);
    storeSet('clawchat.collapsed', JSON.stringify([...collapsed]));
    renderConvs();
  };
  if (reduceMotion()) return apply();
  toggleCollapsed.busy = true;
  const done = () => (toggleCollapsed.busy = false);
  if (closing) {
    Promise.all(childrenOf().map((li) => slideItem(li, false))).then(apply).finally(done);
  } else {
    apply();
    // 列表重画后小三角是新的，补一段转过来的动画
    document.querySelector(`[data-toggle="${CSS.escape(roomId)}"] svg`)?.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(90deg)' }], {
      duration: 220,
      easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)',
    });
    Promise.all(childrenOf().map((li) => slideItem(li, true))).finally(done);
  }
}

function convTitle(c) {
  return c.dm ? agentLabel(c.dm) : c.room.name;
}

// ---------------- 渲染 ----------------

function updateBadge() {
  const n = [...S.unread.values()].reduce((a, b) => a + b, 0);
  document.title = n ? `(${n}) ClawChat` : 'ClawChat';
  native({ type: 'badge', count: n });
}

const ENGINE_INFO = [
  { key: 'claude', name: 'Claude Code', agent: 'claude' },
  { key: 'codex', name: 'Codex', agent: 'gpt' },
  { key: 'deepseek', name: 'DeepSeek', agent: 'deepseek' },
];

function engineState(e, key) {
  if (!e) return '检测中…';
  if (key === 'deepseek') return !e.path ? '要先装 Claude Code' : !e.hasKey ? '还没填 API Key' : e.ok ? `API Key 已填（${esc(e.keyHint)}）` : 'API Key 不对';
  return e.ok ? esc(e.version || '已就绪') : '没找到，请先安装并登录';
}

// 程序状态：侧栏底部两个小点、欢迎页一行字、设置里的「程序与模型」
function renderEngines() {
  // 侧栏底部：一切正常时什么都不显示；有聊天用到的程序找不到（或者 DeepSeek 没填 Key）才亮一个黄色提醒
  const used = new Set(S.rooms.flatMap((r) => r.members));
  const missing = ENGINE_INFO.filter(({ key, agent }) => S.engines[key] && !S.engines[key].ok && used.has(agent)).map(({ name }) => name);
  const warn = $('#engine-warn');
  warn.hidden = !missing.length;
  warn.textContent = missing.length ? `${missing.join('、')} 还不能用` : '';
  warn.title = missing.length ? '打开设置看详情' : '';
  $('#welcome-engines').innerHTML = ENGINE_INFO.map(({ key, name }) => {
    const e = S.engines[key];
    return `<div class="engine"><span class="dot ${e ? (e.ok ? 'ok' : 'bad') : ''}"></span>${name}：${engineState(e, key)}</div>`;
  }).join('');
  const maker = { claude: 'Anthropic', codex: 'OpenAI', deepseek: '深度求索 · 借 Claude Code 干活' };
  $('#set-engines').innerHTML = ENGINE_INFO.map(({ key, name, agent }) => {
    const e = S.engines[key];
    const bad = key === 'deepseek' ? (!e?.path ? '缺 Claude Code' : !e?.hasKey ? '没填 Key' : 'Key 不对') : '没找到';
    const status = e ? (e.ok ? '<span class="status ok">已就绪</span>' : `<span class="status bad">${bad}</span>`) : '<span class="status">检测中…</span>';
    // DeepSeek 用的就是 Claude Code，更新放在 Claude Code 那一行
    return `<div class="list-row">${avatarHtml(agent)}<span class="row-text"><b>${name}</b><small>${maker[key]} · ${engineState(e, key)}</small></span>${status}${
      e?.ok && key !== 'deepseek' ? `<button class="secondary engine-update" data-engine="${key}">更新</button>` : ''
    }</div>`;
  }).join('');
  const ds = S.engines.deepseek;
  const dsStatus = $('#ds-status');
  dsStatus.className = `hint${ds?.keyError && ds.hasKey ? ' error' : ''}`;
  dsStatus.textContent = !ds
    ? ''
    : ds.hasKey
      ? `已填：${ds.keyHint}${ds.keyError ? `（${ds.keyError}）` : ''}。要换就填新的再点保存；清空后保存就是删掉。`
      : '还没填。填好后，新建聊天时勾上 DeepSeek 就能用了。';
  $('#set-models').innerHTML = ENGINE_INFO.map(({ agent }) => {
    const opts = modelOptions(agent).filter((o) => o.id); // 「默认」单独说明，这里只列模型
    const def = modelOptions(agent)[0].name.replace(/^默认 · /, '');
    return `<div class="list-row top">${avatarHtml(agent)}<span class="row-text"><b>${agentName(agent)}</b><small>默认用 ${esc(def)}</small>
      <span class="model-list">${opts.map((o) => `<span class="model-pill" title="${esc(o.description || '')}">${esc(o.name)}</span>`).join('')}</span></span></div>`;
  }).join('');
}

function convAvatar(c) {
  if (c.dm) return `<div class="conv-avatar">${avatarHtml(c.dm)}</div>`;
  if (c.room.members.length === 1) return `<div class="conv-avatar">${avatarHtml(c.room.members[0])}</div>`;
  return `<div class="conv-avatar stack${c.room.members.length > 2 ? ' three' : ''}">${c.room.members.map((a) => avatarHtml(a)).join('')}</div>`;
}

function convItemHtml(c, extra = {}) {
  const busy = S.runs
    .filter((x) => x.roomId === c.room.id && (c.dm ? x.dm && x.agent === c.dm : !x.dm))
    .map((x) => `${agentName(x.agent)}${x.side ? ' 分身' : ''}`)
    .join('、');
  const last = c.last;
  const lastText = last ? (last.from === 'user' || c.dm || c.room.members.length === 1 ? '' : `${agentName(last.from)}：`) + last.text.replace(/\s+/g, ' ') : '';
  const preview = busy ? `<span class="busy">${esc(busy)} 正在干活…</span>` : last ? esc(lastText) : c.dm ? '私聊' : '还没有消息';
  const unread = (S.unread.get(c.key) || 0) + (extra.hiddenUnread || 0);
  const toggle = extra.dmCount
    ? `<button class="disclosure${extra.open ? ' open' : ''}" data-toggle="${esc(c.room.id)}" title="${extra.open ? '收起' : '展开'}私聊（${extra.dmCount}）" aria-label="${extra.open ? '收起' : '展开'}私聊">
        <svg viewBox="0 0 10 10" width="9" height="9"><path d="M3.2 1.8 6.6 5 3.2 8.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
    : '';
  const name = c.dm ? `${agentLabel(c.dm)}<span class="dm-tag">私聊</span>` : esc(convTitle(c));
  return `<li class="conv-item${c.dm ? ' child' : ''}${extra.dmCount ? ' has-children' : ''}${c.key === S.current ? ' active' : ''}" data-key="${esc(c.key)}">
    ${toggle}${convAvatar(c)}
    <div class="conv-meta">
      <div class="conv-line"><span class="name">${name}</span><span class="time">${last ? fmtShort(last.ts) : ''}</span></div>
      <div class="conv-line"><span class="conv-preview">${preview}</span>${unread ? `<span class="unread">${unread > 99 ? '99+' : unread}</span>` : ''}</div>
    </div></li>`;
}

function renderConvs() {
  const q = S.filter.trim().toLowerCase();
  const html = [];
  for (const { group, dms } of groupedConversations()) {
    const groupHit = !q || group.room.name.toLowerCase().includes(q);
    const dmHits = dms.filter((d) => groupHit || agentLabel(d.dm).toLowerCase().includes(q));
    if (!groupHit && !dmHits.length) continue;
    // 搜索时、或者正在看其中一个私聊时，自动展开
    const open = !!q || !collapsed.has(group.room.id) || dms.some((d) => d.key === S.current);
    const hiddenUnread = open ? 0 : dms.reduce((n, d) => n + (S.unread.get(d.key) || 0), 0);
    html.push(convItemHtml(group, { dmCount: dms.length, open, hiddenUnread }));
    if (open) for (const d of dmHits) html.push(convItemHtml(d));
  }
  $('#conv-list').innerHTML = html.join('');
  updateBadge();
}

// 内容没变就不动它，免得正在打开的下拉框被刷新关掉
function setHtml(el, html) {
  if (el._html === html) return;
  el._html = html;
  el.innerHTML = html;
}

function renderShell() {
  const conv = currentConv();
  $('#welcome').hidden = !!conv;
  $('#chat').hidden = !conv;
  if (!conv) {
    requestAnimationFrame(reportDragRegions);
    return;
  }
  const { room, dm } = conv;
  const group = room.members.length > 1;
  $('#room-name').textContent = dm ? `${agentLabel(dm)}` : room.name;
  $('#room-count').textContent = dm ? '· 私聊' : group ? `(${room.members.length + 1})` : '';
  $('#room-from').textContent = dm ? `来自「${room.name}」` : '';
  $('#room-from').hidden = !dm;
  $('#room-folder').textContent = ltr(room.cwd);
  $('#room-folder').title = `${IS_WIN ? '在资源管理器中打开' : '在访达中打开'}：${room.cwd}`;
  const perm = $('#room-perm');
  perm.textContent = PERM_LABEL[room.permission] || room.permission;
  perm.className = `badge ${room.permission}`;
  // 顶部的模型切换：群里显示所有成员，私聊只显示对方
  $('#model-switch').classList.toggle('many', !dm && room.members.length > 2);
  setHtml($('#model-switch'), (dm ? [dm] : room.members)
    .map((a) => {
      const model = modelSelectHtml(a, room.models?.[a], `data-agent="${esc(a)}" aria-label="${esc(agentName(a))} 的模型"`, true);
      // 模型不支持调思考强度（比如连不上 DeepSeek 时）就不显示这一格
      const effort = effortsFor(a, room.models?.[a]).length || room.efforts?.[a]
        ? `<span class="chip-sep"></span><span class="chip-label">思考</span>${effortSelectHtml(
            a,
            room.models?.[a],
            room.efforts?.[a],
            `data-effort="${esc(a)}" class="effort-select" aria-label="${esc(agentName(a))} 的思考强度"`,
          )}`
        : '';
      return `<span class="model-chip" title="切换 ${esc(agentName(a))} 的模型和思考强度，下一轮生效">${avatarHtml(a)}${model}${effort}</span>`;
    })
    .join(''));
  const entry = $('#dm-entry');
  entry.hidden = dm || !group;
  entry.innerHTML = group && !dm ? `<span class="muted">私聊</span>${room.members.map((a) => `<button class="dm-btn" data-dm="${esc(a)}" title="私聊 ${esc(agentLabel(a))}">${avatarHtml(a)}</button>`).join('')}` : '';
  $('#group-tools').hidden = !!dm || !group;
  document.querySelectorAll('[data-mention]').forEach((b) => {
    const id = { Claude: 'claude', GPT: 'gpt', DeepSeek: 'deepseek' }[b.dataset.mention];
    b.hidden = id ? !room.members.includes(id) : false;
  });
  const who = room.members.length > 2 ? '大家' : '两位';
  const targets = [['all', `${who}同时开工`], ['sequential', `${who}依次回答`], ...room.members.map((a) => [a, `只发给 ${agentName(a)}`])];
  setHtml($('#default-target'), targets.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join(''));
  $('#default-target').value = room.defaultTarget;
  const hint = $('#dm-hint');
  hint.hidden = !dm;
  hint.firstElementChild.textContent = dm
    ? `这里是你和 ${agentName(dm)} 的私聊，${room.members.filter((a) => a !== dm).map(agentName).join('、')} 看不到。${agentName(dm)} 记得群里的所有事。`
    : '';
  $('#input').placeholder = dm ? `私聊 ${agentName(dm)}` : `发送给 ${room.name}`;
  syncToolsRow();
  requestAnimationFrame(reportDragRegions);
}

// 输入框上面那一行：私聊、单聊又没在干活时整行收起来
function syncToolsRow() {
  const row = document.querySelector('.composer-tools');
  row.hidden = $('#group-tools').hidden && $('#stop-controls').hidden;
}

function stepHtml(s) {
  return `<li class="step step-${esc(s.kind)}"><span class="step-icon">${STEP_ICON[s.kind] || '·'}</span><span class="step-text">${esc(s.text)}</span></li>`;
}

function imagesHtml(roomId, images) {
  if (!images?.length) return '';
  return `<div class="msg-images">${images
    .map((img) => `<img src="/api/rooms/${esc(roomId)}/uploads/${esc(img.id)}" loading="lazy" alt="图片" class="zoomable">`)
    .join('')}</div>`;
}

const REPLY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';

function whoLabel(from) {
  return from === 'user' ? '我' : agentLabel(from);
}

function snippet(m) {
  return String(m.text || (m.images?.length ? '[图片]' : '')).replace(/\s+/g, ' ').slice(0, 80);
}

// 引用：回复别人的消息时，气泡上方带一小段原话，点一下跳回原消息
function quoteHtml(q) {
  return `<button class="quote" data-jump="${q.seq}" title="跳到原消息"><b>${esc(whoLabel(q.from))}</b><span>${esc(String(q.text || '').replace(/\s+/g, ' '))}</span></button>`;
}

function messageHtml(roomId, m, prev, conv) {
  const sep = !prev || m.ts - prev.ts > 5 * 60 * 1000 ? `<div class="time-sep">${fmtTime(m.ts)}</div>` : '';
  if (m.from === 'system') {
    const act = m.action?.type === 'fresh' ? `<button class="notice-action" data-fresh="${esc(m.action.agent)}">给 ${esc(agentName(m.action.agent))} 换新会话</button>` : '';
    return `${sep}<div class="notice"><span>${esc(m.text)}</span>${act}</div>`;
  }
  const replyBtn = `<button class="reply-btn" data-reply="${m.seq}" title="回复这条">${REPLY_ICON}</button>`;
  if (m.from === 'user') {
    const text = m.text ? `<div class="bubble">${inline(m.text)}</div>` : '';
    const quote = m.replyTo ? quoteHtml(m.replyTo) : '';
    return `${sep}<div class="msg user" data-seq="${m.seq}">${avatarHtml('user')}<div class="msg-body">${quote}${imagesHtml(roomId, m.images)}${text}${replyBtn}</div></div>`;
  }
  const dur = m.durationMs ? `用时 ${fmtDur(m.durationMs)}` : '';
  const foot = m.steps?.length
    ? `<details class="steps"><summary>过程 · ${m.steps.length} 步${dur ? ` · ${dur}` : ''}</summary><ol>${m.steps.map(stepHtml).join('')}</ol></details>`
    : dur;
  const canDm = !conv.dm && conv.room.members.length > 1;
  const avatar = canDm ? `<button class="dm-btn" data-dm="${esc(m.from)}" title="私聊 ${esc(agentLabel(m.from))}">${avatarHtml(m.from)}</button>` : avatarHtml(m.from);
  const modelText = [m.model ? modelLabel(m.model) : '', m.effort ? `思考 ${EFFORT_LABEL[m.effort] || m.effort}` : ''].filter(Boolean).join(' · ');
  const model = modelText ? `<span class="msg-model">${esc(modelText)}</span>` : '';
  const sideTag = m.side ? '<span class="side-tag" title="本体当时在群里忙，这条是分身先回的">分身</span>' : '';
  return `${sep}<div class="msg agent" data-seq="${m.seq}">${avatar}<div class="msg-body"><div class="msg-name">${esc(agentLabel(m.from))}${sideTag}${model}</div>${imagesHtml(roomId, m.images)}<div class="bubble">${md(
    m.text,
  )}</div>${foot ? `<div class="msg-foot">${foot}</div>` : ''}${replyBtn}</div></div>`;
}

function convMessages(conv) {
  return (S.messages.get(conv.roomId) || []).filter((m) => inConv(conv, m));
}

function renderMessages() {
  const conv = currentConv();
  if (!conv) return;
  const list = convMessages(conv);
  $('#messages').innerHTML = list.map((m, i) => messageHtml(conv.roomId, m, list[i - 1], conv)).join('');
}

function liveKey(r) {
  return `${r.roomId}:${r.agent}${r.side ? ':side' : ''}`;
}

function convRuns(conv) {
  return S.runs.filter((r) => r.roomId === conv.roomId && (conv.dm ? r.dm && r.agent === conv.dm : !r.dm));
}

const IDLE_WARN = 2 * 60 * 1000; // 这么久没有任何动静，就提示可能卡住了

// 「可能卡住了」的提示：本体可以换新会话重来，分身只能停止
function idleText(r, key) {
  const idle = Date.now() - (S.liveAt.get(key) || r.startedAt);
  if (idle < IDLE_WARN) return '';
  const last = (S.live.get(key) || []).at(-1);
  const waiting = last?.kind === 'run' ? '它可能还在等一条命令跑完；' : '';
  return r.side
    ? `分身已经 ${fmtDur(idle)} 没有任何动静了，${waiting}一直这样的话可以点「停止」。`
    : `已经 ${fmtDur(idle)} 没有任何动静了。${waiting}一直这样的话多半是卡住了（比如会话里的大图太多），可以点「换新会话重来」，它会带上最近的聊天记录重新开始。`;
}

function updateIdle() {
  for (const r of S.runs) {
    const key = liveKey(r);
    const box = document.querySelector(`[data-idle="${CSS.escape(key)}"]`);
    if (!box) continue;
    const text = idleText(r, key);
    box.hidden = !text;
    if (text) box.firstElementChild.textContent = text;
  }
}

function renderLive() {
  const conv = currentConv();
  const runs = conv ? convRuns(conv) : [];
  $('#live').innerHTML = runs
    .map((r) => {
      const key = liveKey(r);
      const all = S.live.get(key) || [];
      const open = S.liveOpen.has(key);
      const shown = open ? all : all.slice(-3);
      const toggle = all.length
        ? `<button class="live-toggle${open ? ' open' : ''}" data-live-toggle="${esc(key)}">${open ? '收起' : '展开'}过程 · ${all.length} 步
            <svg viewBox="0 0 10 10" width="8" height="8"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
        : '';
      const sideTag = r.side ? '<span class="side-tag" title="本体在群里忙，分身先来回你的私聊（只能看，不能改）">分身</span>' : '';
      const enter = S.liveSeen.has(key) ? '' : ' enter';
      S.liveSeen.add(key);
      return `<div class="msg agent live${enter}">${avatarHtml(r.agent)}<div class="msg-body"><div class="msg-name">${esc(agentLabel(r.agent))}${sideTag}</div>
        <div class="bubble"><div class="live-head"><span class="typing"><i></i><i></i><i></i></span>
        <span>${r.side ? '正在回复你' : '正在干活'} · <span class="elapsed" data-start="${r.startedAt}">${fmtDur(Date.now() - r.startedAt)}</span></span>
        ${toggle}${
          r.side ? '' : `<button class="live-fresh-mini${S.freshArmed === key ? ' armed' : ''}" data-agent="${esc(r.agent)}" data-key="${esc(key)}" title="会话太重、卡住时用：结束这一轮，换个新会话重来">${S.freshArmed === key ? '确定换？' : '换新会话'}</button>`
        }<button class="live-stop" data-agent="${esc(r.agent)}" data-only="${r.side ? 'side' : 'main'}">停止</button></div>
        <div class="live-idle" data-idle="${esc(key)}"${idleText(r, key) ? '' : ' hidden'}><span>${esc(idleText(r, key))}</span>${
          r.side ? '' : `<button class="live-fresh" data-agent="${esc(r.agent)}">换新会话重来</button>`
        }</div>
        ${shown.length ? `<ol class="live-steps${open ? ' open' : ''}${S.liveAnimate === key ? ' enter' : ''}" data-live-list="${esc(key)}">${shown.map(stepHtml).join('')}</ol>` : ''}
        </div></div></div>`;
    })
    .join('');
  // 展开时滚到最新一步
  document.querySelectorAll('.live-steps.open').forEach((ol) => (ol.scrollTop = ol.scrollHeight));
  renderStopControls(conv);
  syncToolsRow();
}

// 停止按钮：谁在干活就显示「停止 谁」，两位以上同时在干时再加一个「全部停止」
function renderStopControls(conv) {
  const box = $('#stop-controls');
  const runs = conv ? S.runs.filter((r) => r.roomId === conv.roomId) : [];
  box.hidden = runs.length === 0;
  const one = runs.map(
    (r) =>
      `<button class="chip danger" data-stop="${esc(r.agent)}" data-only="${r.side ? 'side' : 'main'}">${avatarHtml(r.agent)}停止 ${esc(agentName(r.agent))}${
        r.side ? '分身' : r.dm ? '（私聊）' : ''
      }</button>`,
  );
  if (runs.length > 1) one.push('<button class="chip danger strong" data-stop="">全部停止</button>');
  setHtml(box, one.join(''));
}

function nearBottom() {
  const s = $('#scroller');
  return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
}

function scrollToBottom() {
  const s = $('#scroller');
  s.scrollTop = s.scrollHeight;
}

function keepBottom(fn) {
  const near = nearBottom();
  fn();
  if (near) scrollToBottom();
}

// ---------------- 状态与事件 ----------------

function applyState(st) {
  S.rooms = st.rooms || [];
  S.agents = st.agents || {};
  S.defaults = st.defaults || {};
  S.engines = st.engines || {};
  S.projectsDir = st.projectsDir || '';
  setRuns(st.runs || []);
}

function setRuns(runs) {
  S.runs = runs;
  const keys = new Set(runs.map(liveKey));
  for (const k of [...S.live.keys()]) if (!keys.has(k)) S.live.delete(k);
  for (const k of [...S.liveOpen]) if (!keys.has(k)) S.liveOpen.delete(k);
  for (const k of [...S.liveSeen]) if (!keys.has(k)) S.liveSeen.delete(k);
  for (const k of [...S.liveAt.keys()]) if (!keys.has(k)) S.liveAt.delete(k);
  for (const r of runs) {
    const k = liveKey(r);
    S.liveAt.set(k, Math.max(S.liveAt.get(k) || 0, r.lastEventAt || r.startedAt));
    if ((r.steps?.length || 0) > (S.live.get(k)?.length || 0)) S.live.set(k, [...r.steps]);
    else if (!S.live.has(k)) S.live.set(k, []);
  }
}

async function loadMessages(roomId) {
  if (S.messages.has(roomId)) return true;
  try {
    const { messages } = await api('GET', `/api/rooms/${roomId}/messages`);
    const seen = new Set(messages.map((m) => m.seq));
    for (const m of S.early.get(roomId) || []) if (!seen.has(m.seq)) messages.push(m);
    S.early.delete(roomId);
    S.messages.set(roomId, messages);
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

async function openConv(key) {
  const c = parseKey(key);
  if (!c || !roomById(c.roomId)) return;
  if (c.dm && !S.openedDms.has(key)) S.openedDms.set(key, Date.now());
  if (S.current !== key) {
    clearAttachments();
    cancelReply();
  }
  S.current = key;
  storeSet('clawchat.current', key);
  S.unread.delete(key);
  renderConvs();
  renderShell();
  if (!S.messages.has(c.roomId)) $('#messages').innerHTML = '';
  if (!(await loadMessages(c.roomId)) || S.current !== key) return;
  renderMessages();
  renderLive();
  scrollToBottom();
  replay($('#scroller'), 'switching');
  $('#input').focus();
}

function onMessage(roomId, m) {
  const list = S.messages.get(roomId);
  if (list) {
    if (list.some((x) => x.seq === m.seq)) return;
    list.push(m);
  } else {
    if (!S.early.has(roomId)) S.early.set(roomId, []);
    S.early.get(roomId).push(m);
  }
  const key = convOf(roomId, m);
  const conv = currentConv();
  if (list && conv && conv.key === key) {
    const near = nearBottom() || m.from === 'user';
    const shown = convMessages(conv);
    const tpl = document.createElement('template');
    tpl.innerHTML = messageHtml(roomId, m, shown[shown.length - 2], conv);
    for (const el of tpl.content.children) el.classList.add('enter');
    $('#messages').appendChild(tpl.content);
    if (near) scrollToBottom();
  }
  if (m.from !== 'user' && m.from !== 'system') {
    const focused = document.hasFocus();
    if (S.current !== key || !focused) {
      S.unread.set(key, (S.unread.get(key) || 0) + 1);
      renderConvs();
    }
    if (!focused || (m.dm && S.current !== key)) native({ type: 'attention' });
    if (m.dm && S.current !== key) toast(`${agentName(m.from)} 私聊你：${firstLine(m.text).slice(0, 40)}`, 4000);
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'message':
      onMessage(ev.roomId, ev.message);
      break;
    case 'step': {
      const k = liveKey(ev);
      const arr = S.live.get(k) || [];
      arr.push(ev.step);
      if (arr.length > 300) arr.splice(0, arr.length - 300);
      S.live.set(k, arr);
      S.liveAt.set(k, Date.now());
      if (currentConv()?.roomId === ev.roomId) keepBottom(renderLive);
      break;
    }
    case 'status':
      setRuns(ev.runs || []);
      renderConvs();
      keepBottom(renderLive);
      break;
    case 'rooms':
      S.rooms = ev.rooms || [];
      if (S.current && !currentConv()) S.current = null;
      renderConvs();
      renderShell();
      renderEngines(); // 侧栏的黄色提醒只管有聊天用到的程序
      break;
    case 'engines':
      S.engines = ev.engines || {};
      renderEngines();
      renderShell(); // 模型列表可能多了新模型
      break;
    case 'restarting':
      showRestarting();
      break;
    case 'quitting':
      showQuit();
      break;
    case 'icons':
      // 服务刚下载好 DeepSeek 的官方头像：换个地址让浏览器重新取（之前取不到的结果可能被记住了）
      document.documentElement.style.setProperty('--ds-icon', `url("/icons/deepseek.png?v=${Date.now()}")`);
      break;
    case 'activity':
      S.liveAt.set(liveKey(ev), ev.at);
      updateIdle();
      break;
  }
}

function connect() {
  const es = new EventSource('/api/events');
  let dropped = false;
  es.onmessage = (e) => {
    try {
      handleEvent(JSON.parse(e.data));
    } catch (err) {
      console.error(err);
    }
  };
  es.onerror = () => {
    dropped = true;
  };
  es.onopen = async () => {
    if (!dropped) return;
    dropped = false;
    // 服务重启过：重新拉一遍状态和消息
    try {
      applyState(await api('GET', '/api/state'));
      S.messages.clear();
      renderEngines();
      renderConvs();
      if (currentConv()) openConv(S.current);
      else renderShell();
    } catch {}
  };
}

// ---------------- 图片 ----------------

function imageType(file) {
  if (file.type && file.type.startsWith('image/')) return file.type;
  return IMAGE_EXT_TYPES[(file.name || '').split('.').pop().toLowerCase()] || '';
}

function renderAttachments() {
  const box = $('#attachments');
  box.hidden = S.attachments.length === 0;
  box.innerHTML = S.attachments
    .map(
      (a, i) => `<div class="att ${a.status}${a.fresh ? ' enter' : ''}">
        <img src="${a.url}" alt="">
        ${a.status === 'uploading' ? '<span class="att-state">上传中…</span>' : a.status === 'error' ? `<span class="att-state" title="${esc(a.error)}">失败</span>` : ''}
        <button class="att-remove" data-i="${i}" title="移除">×</button>
      </div>`,
    )
    .join('');
  for (const a of S.attachments) a.fresh = false; // 进场动画只播一次
  updateSendButton();
}

function clearAttachments() {
  for (const a of S.attachments) URL.revokeObjectURL(a.url);
  S.attachments = [];
  renderAttachments();
}

// Windows 上服务没法转换图片：大图在这里先缩小成 JPG 再上传；认不出的格式（比如 HEIC）直接提示
async function prepareImage(file) {
  const type = imageType(file);
  if (!IS_WIN) return { body: file, type };
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('这种图片格式（比如 HEIC）在这台电脑上打不开，请先另存成 JPG 或 PNG 再发');
  }
  const big = Math.max(bmp.width, bmp.height);
  const direct = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type);
  if (direct && file.size <= 3 * 1024 * 1024 && big <= 4000) {
    bmp.close();
    return { body: file, type };
  }
  const scale = Math.min(1, 2400 / big);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // 透明的地方填白，转成 JPG 后不会变黑
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new Error('这张图片处理不了，换一张试试');
  return { body: blob, type: 'image/jpeg' };
}

function addFiles(files) {
  const conv = currentConv();
  if (!conv) return;
  const images = [...files].filter((f) => imageType(f));
  if (!images.length) {
    if (files.length) toast('只能发图片');
    return;
  }
  for (const file of images.slice(0, 20 - S.attachments.length)) {
    const att = { url: URL.createObjectURL(file), status: 'uploading', id: null, error: '', roomId: conv.roomId, fresh: true };
    S.attachments.push(att);
    prepareImage(file)
      .then(({ body, type }) => fetch(`/api/rooms/${conv.roomId}/uploads`, { method: 'POST', headers: { 'content-type': type, 'x-clawchat': '1' }, body }))
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '上传失败');
        att.id = data.id;
        att.status = 'done';
      })
      .catch((err) => {
        att.status = 'error';
        att.error = err.message;
        toast(err.message);
      })
      .finally(renderAttachments);
  }
  renderAttachments();
  $('#input').focus();
}

// ---------------- 输入与操作 ----------------

function updateSendButton() {
  const hasText = !!$('#input').value.trim();
  const uploading = S.attachments.some((a) => a.status === 'uploading');
  const ready = S.attachments.some((a) => a.status === 'done');
  $('#btn-send').disabled = uploading || (!hasText && !ready);
}

function autoGrow() {
  const el = $('#input');
  el.style.height = 'auto';
  const full = el.scrollHeight + 2; // scrollHeight 不含上下边框
  el.style.height = `${Math.min(full, 240)}px`;
  el.style.overflowY = full > 240 ? 'auto' : 'hidden';
  updateSendButton();
}

async function sendMessage() {
  const conv = currentConv();
  const el = $('#input');
  if (!conv || $('#btn-send').disabled) return;
  const text = el.value.trim();
  const sent = S.attachments.filter((a) => a.status === 'done' && a.roomId === conv.roomId);
  if (!text && !sent.length) return;
  el.value = '';
  const kept = S.attachments;
  const reply = S.replyTo;
  S.attachments = [];
  renderAttachments();
  cancelReply();
  autoGrow();
  try {
    await api('POST', `/api/rooms/${conv.roomId}/messages`, { text, images: sent.map((a) => a.id), dm: conv.dm || undefined, replyTo: reply?.seq });
    for (const a of kept) URL.revokeObjectURL(a.url);
  } catch (err) {
    el.value = text;
    S.attachments = kept;
    renderAttachments();
    if (reply) startReply(reply.seq);
    autoGrow();
    toast(err.message);
  }
}

// ---------------- 输入 @ 时弹出的成员菜单 ----------------

const MENTION_ITEMS = [
  { id: 'claude', label: 'Claude', sub: 'Anthropic', insert: 'Claude', keys: ['claude', '克劳德'] },
  { id: 'gpt', label: 'GPT', sub: 'OpenAI Codex', insert: 'GPT', keys: ['gpt', 'codex', 'chatgpt', 'openai'] },
  { id: 'deepseek', label: 'DeepSeek', sub: '深度求索', insert: 'DeepSeek', keys: ['deepseek', 'ds', '深度求索', 'shendu'] },
  { id: 'all', label: '所有人', sub: '大家一起', insert: '所有人', keys: ['所有人', 'all', 'everyone', '大家', '全体', 'suoyouren'] },
];

// 光标前面是不是正在打「@xxx」：返回 @ 的位置和已经打的字
function mentionQuery() {
  const el = $('#input');
  if (el.selectionStart !== el.selectionEnd) return null;
  const before = el.value.slice(0, el.selectionStart);
  const m = before.match(/(?:^|[\s(（，。,.!?！？:：])@([^\s@]{0,20})$/);
  return m ? { start: el.selectionStart - m[1].length - 1, q: m[1].toLowerCase() } : null;
}

function hideMentionMenu() {
  S.mention = null;
  $('#mention-menu').hidden = true;
}

function updateMentionMenu() {
  const conv = currentConv();
  const mq = conv && !conv.dm && conv.room.members.length > 1 ? mentionQuery() : null;
  if (!mq) return hideMentionMenu();
  const items = MENTION_ITEMS.filter(
    (it) => (it.id === 'all' || conv.room.members.includes(it.id)) && (!mq.q || [it.label.toLowerCase(), ...it.keys].some((k) => k.startsWith(mq.q))),
  );
  if (!items.length) return hideMentionMenu();
  const keepIndex = S.mention && S.mention.q === mq.q ? S.mention.index : 0;
  S.mention = { ...mq, items, index: Math.min(keepIndex, items.length - 1) };
  const all = conv.room.members;
  const icon = (it) => (it.id === 'all' ? `<span class="mention-all${all.length > 2 ? ' three' : ''}">${all.map((a) => avatarHtml(a)).join('')}</span>` : avatarHtml(it.id));
  $('#mention-menu').innerHTML = items
    .map(
      (it, i) => `<div class="mention-item${i === S.mention.index ? ' active' : ''}" role="option" data-mention-pick="${i}">
        ${icon(it)}<span class="mention-label"><b>${esc(it.label)}</b><small>${esc(it.sub)}</small></span>${i === S.mention.index ? '<kbd>↩</kbd>' : ''}</div>`,
    )
    .join('');
  $('#mention-menu').hidden = false;
}

function pickMention(i) {
  const el = $('#input');
  const it = S.mention?.items[i];
  if (!it) return;
  const start = S.mention.start;
  const tail = el.value.slice(el.selectionStart);
  const token = `@${it.insert} `;
  el.value = el.value.slice(0, start) + token + tail.replace(/^\S*/, '').replace(/^ /, '');
  el.selectionStart = el.selectionEnd = start + token.length;
  hideMentionMenu();
  el.focus();
  autoGrow();
}

// 菜单开着时，↑↓ 选、Enter / Tab 填进去、Esc 关掉；返回 true 表示这个按键被菜单用掉了
function mentionKeydown(e) {
  if (!S.mention || e.isComposing || e.keyCode === 229) return false;
  const n = S.mention.items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    S.mention.index = (S.mention.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    updateMentionMenu();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    pickMention(S.mention.index);
  } else if (e.key === 'Escape') {
    hideMentionMenu();
  } else {
    return false;
  }
  e.preventDefault();
  return true;
}

// ---------------- 回复 ----------------

function startReply(seq) {
  const conv = currentConv();
  const m = conv && (S.messages.get(conv.roomId) || []).find((x) => x.seq === seq);
  if (!m) return;
  S.replyTo = { seq: m.seq, from: m.from };
  $('#reply-who').textContent = `回复 ${whoLabel(m.from)}`;
  $('#reply-snippet').textContent = snippet(m);
  // 回复某位 AI：只有它会回答（又 @ 了别人的话，就按 @ 的来）
  const solo = conv.dm || conv.room.members.length < 2;
  $('#reply-hint').textContent = m.from !== 'user' && !solo ? `只有 ${agentName(m.from)} 会回复` : '';
  $('#reply-bar').hidden = false;
  $('#input').focus();
}

function cancelReply() {
  S.replyTo = null;
  $('#reply-bar').hidden = true;
}

function jumpTo(seq) {
  const el = document.querySelector(`#messages .msg[data-seq="${seq}"]`);
  if (!el) return toast('原消息不在这个会话里了');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth; // 重新触发闪一下的动画
  el.classList.add('flash');
}

function insertMention(name) {
  const el = $('#input');
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, start);
  const token = `${before && !/\s$/.test(before) ? ' ' : ''}@${name} `;
  el.value = before + token + el.value.slice(end);
  el.selectionStart = el.selectionEnd = start + token.length;
  el.focus();
  autoGrow();
}

const pickResolvers = new Map();
window.__clawchatPicked = (id, path) => {
  const resolve = pickResolvers.get(id);
  if (resolve) {
    pickResolvers.delete(id);
    resolve(path || null);
  }
};

async function pickFolder() {
  if (hasNative()) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      pickResolvers.set(id, resolve);
      native({ type: 'pickFolder', id });
    });
  }
  const { path } = await api('POST', '/api/pick-folder');
  return path;
}

async function switchEffort(agent, id) {
  const conv = currentConv();
  if (!conv) return;
  try {
    const { room } = await api('PATCH', `/api/rooms/${conv.roomId}`, { efforts: { ...conv.room.efforts, [agent]: id } });
    S.rooms = S.rooms.map((r) => (r.id === room.id ? room : r));
    toast(`${agentName(agent)} 的思考强度换成了「${id ? EFFORT_LABEL[id] || id : '默认'}」，下一轮生效`);
  } catch (err) {
    toast(err.message);
  }
  $('#model-switch')._html = null;
  renderShell();
}

// 自定义模型：先用一句话试一下能不能用，能用才换
function openCustomModel(agent) {
  const dlg = $('#dlg-model');
  dlg.dataset.agent = agent;
  $('#custom-model-title').textContent = `给 ${agentName(agent)} 换一个列表里没有的模型`;
  $('#custom-model-hint').textContent = {
    gpt: '填 Codex 里的模型名，比如 gpt-7.0。',
    deepseek: '填 DeepSeek 的模型名，比如 deepseek-v5-pro。',
  }[agent] || '填 Claude Code 能用的模型名，比如 claude-opus-6-0，或者 opus、fable 这样的别名。';
  $('#custom-model-input').value = '';
  $('#custom-model-status').textContent = '';
  $('#btn-custom-ok').disabled = false;
  dlg.showModal();
  reportDragRegions();
  $('#custom-model-input').focus();
}

async function submitCustomModel(e) {
  e.preventDefault();
  const dlg = $('#dlg-model');
  const agent = dlg.dataset.agent;
  const id = $('#custom-model-input').value.trim();
  if (!id) return;
  const status = $('#custom-model-status');
  const btn = $('#btn-custom-ok');
  btn.disabled = true;
  status.className = 'muted';
  status.textContent = `正在用 ${id} 试着回一句话，最多等一分半…`;
  try {
    const res = await api('POST', '/api/models/check', { agent, id });
    if (!res.ok) {
      status.className = 'error';
      status.textContent = `用不了：${res.error}`;
      return;
    }
    closeDialog(dlg);
    await switchModel(agent, id, true);
    if (res.model && res.model !== id) toast(`${agentName(agent)} 已切换到 ${id}（实际是 ${modelLabel(res.model)}），下一轮生效`);
  } catch (err) {
    status.className = 'error';
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// 一键更新 Claude Code / Codex：新模型常常要新版本才看得到
async function updateEngine(engine, btn) {
  const name = engine === 'codex' ? 'Codex' : 'Claude Code';
  btn.disabled = true;
  btn.textContent = '更新中…';
  try {
    const res = await api('POST', '/api/engines/update', { engine });
    S.engines = res.engines || S.engines;
    toast(res.ok ? `${name} 已是最新：${S.engines[engine]?.version || ''}` : `${name} 更新失败：${res.output}`, 5000);
  } catch (err) {
    toast(err.message);
  }
  renderEngines();
  renderShell();
}

// ---------------- 应用设置 ----------------

function showSettingsTab(tab) {
  const win = document.querySelector('.prefs-window');
  const panel = document.querySelector(`#dlg-settings [data-panel="${tab}"]`);
  const changed = panel && panel.hidden;
  const from = win.offsetHeight;
  document.querySelectorAll('#settings-tabs [data-tab]').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    if (on) $('#prefs-title').textContent = b.dataset.title;
  });
  document.querySelectorAll('#dlg-settings [data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  if (changed && from && $('#dlg-settings').open && !reduceMotion()) {
    replay(panel, 'enter');
    win.style.height = 'auto';
    const to = win.offsetHeight;
    win.style.height = `${from}px`;
    void win.offsetHeight;
    win.classList.add('resizing');
    win.style.height = `${to}px`;
    clearTimeout(showSettingsTab.timer);
    showSettingsTab.timer = setTimeout(() => {
      win.classList.remove('resizing');
      win.style.height = '';
    }, 300);
  }
  if (tab === 'engines') refreshEngines(true);
}

async function openSettings(tab = 'general') {
  const dlg = $('#dlg-settings');
  $('#quit-section').hidden = hasNative(); // Mac 应用按 ⌘Q 退出；Windows 和浏览器里在这里退出
  if (!dlg.open) dlg.showModal();
  reportDragRegions();
  showSettingsTab(tab);
  renderEngines();
  try {
    const info = await api('GET', '/api/app');
    S.app = info;
    const tilde = (p) => (IS_WIN ? String(p || '') : String(p || '').replace(/^\/Users\/[^/]+/, '~')); // 像访达一样把个人目录写成 ~
    $('#set-data-dir').textContent = tilde(info.dataDir);
    $('#set-data-dir').title = info.dataDir;
    $('#set-projects-dir').textContent = tilde(info.projectsDir);
    $('#set-projects-dir').title = info.projectsDir;
    const ver = `${info.version}${info.commit ? `（${info.commit}）` : ''}`;
    $('#set-version').textContent = ver;
    $('#about-version').textContent = `版本 ${ver}`;
    $('#upd-title').textContent = `ClawChat ${info.version}`;
    const repo = info.repo ? `<a href="${esc(info.repo)}" target="_blank" rel="noopener">${esc(info.repo.replace(/^https:\/\//, ''))}</a>` : '还没关联 GitHub 仓库';
    $('#set-repo').innerHTML = repo;
    $('#about-repo').textContent = info.repo ? info.repo.replace(/^https:\/\//, '') : '';
    $('#about-repo').href = info.repo || '#';
  } catch (err) {
    toast(err.message);
  }
  if (tab === 'update') checkForUpdate(true);
}
window.__clawchatOpenSettings = (tab) => openSettings(tab || 'general');

function setUpdateDot(on) {
  document.querySelectorAll('.update-dot').forEach((d) => (d.hidden = !on));
}

// 检查更新：show=true 时把结果显示在设置页里；启动时也会悄悄查一次，有新版就在「设置」上亮个小点
async function checkForUpdate(show = false) {
  const status = $('#update-status');
  const list = $('#update-changes');
  const box = $('#update-changes-box');
  const btn = $('#btn-do-update');
  if (show) {
    status.textContent = '正在检查…';
    box.hidden = true;
    btn.hidden = true;
  }
  let res;
  try {
    res = await api('POST', '/api/app/check-update');
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  setUpdateDot(res.ok && (res.behind > 0 || res.needsRestart));
  if (!show) return;
  if (!res.ok) {
    status.innerHTML = `<span class="error">${esc(res.error)}</span>`;
    return;
  }
  if (!res.behind && res.needsRestart) {
    // 代码已经是新的了，只是还没重启
    status.innerHTML = `<span class="new-text">新版本 ${esc(res.current)} 已经装好，重启 ClawChat 后生效</span>`;
    btn.hidden = false;
    btn.disabled = false;
    btn.textContent = '立即重启';
    btn.dataset.mode = 'restart';
    return;
  }
  btn.textContent = '立即升级';
  btn.dataset.mode = 'update';
  if (!res.behind) {
    status.innerHTML = `<span class="ok-text">已是最新版本</span>`;
    return;
  }
  status.innerHTML = `<span class="new-text">有新版本 ${esc(res.latest)} 可以升级</span><span class="muted"> · ${res.behind} 处更新</span>`;
  list.innerHTML = res.changes.map((c) => `<li><span>${esc(c.subject)}</span><span class="muted">${esc(c.when)}</span></li>`).join('');
  box.hidden = !res.changes.length;
  btn.hidden = false;
  btn.disabled = !!res.dirty;
  if (res.dirty) status.insertAdjacentHTML('beforeend', '<br><span class="error">本地有没提交的改动，先处理掉才能升级。</span>');
}

async function doUpdate() {
  const btn = $('#btn-do-update');
  const busy = S.runs.length;
  if (busy && btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = `有 ${busy} 位正在干活，再点一次确认升级`;
    return;
  }
  btn.dataset.armed = '';
  btn.disabled = true;
  if (btn.dataset.mode === 'restart') {
    btn.textContent = '正在重启…';
    try {
      await api('POST', '/api/app/restart');
      showRestarting();
    } catch (err) {
      $('#update-status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
      btn.disabled = false;
      btn.textContent = '立即重启';
    }
    return;
  }
  btn.textContent = '正在升级…';
  $('#update-status').textContent = '正在从 GitHub 拉取最新代码…';
  try {
    const res = await api('POST', '/api/app/update');
    if (!res.ok) throw new Error(res.error);
    if (!res.updated) {
      $('#update-status').textContent = '已经是最新版';
      return;
    }
    showRestarting();
  } catch (err) {
    $('#update-status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '立即升级';
  }
}

// 升级后服务会重启：在应用里会自动重开窗口；在浏览器里等服务回来就刷新
function showRestarting() {
  $('#update-status').textContent = '升级好了，正在重启，稍等十几秒…';
  toast('ClawChat 正在重启升级…', 20000);
  if (hasNative()) return;
  const wait = setInterval(async () => {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok) {
        clearInterval(wait);
        location.reload();
      }
    } catch {}
  }, 1500);
}

// 给某位换新会话：正在干活就把这一轮换个新会话重来；空着就直接换。有 AI 给它派过活的，会先请那位重新交代情况
async function freshAgent(agent, btn, roomId = currentConv()?.roomId) {
  if (!roomId) return;
  if (btn) btn.disabled = true;
  try {
    const { result } = await api('POST', `/api/rooms/${roomId}/fresh`, { agent });
    const name = agentName(agent);
    toast(
      {
        restarted: `${name} 正在换新会话`,
        briefing: `${name} 换成了新会话，先请上一个给它派活的同事把情况交代给它`,
        reset: `${name} 换成了新会话，下次叫它时生效`,
        none: `${name} 现在没有会话，下次叫它本来就是新开的`,
      }[result] || '换好了',
      3500,
    );
  } catch (err) {
    toast(err.message);
    if (btn) btn.disabled = false;
  }
  if (S.editing === roomId && $('#dlg-room').open) setTimeout(() => loadSessions(roomById(roomId)), 600);
}

// 群设置里的「会话（记忆）」：每位有没有会话、GPT 的会话里存了多少图片，随时可以手动换
async function loadSessions(room) {
  const box = $('#session-list');
  if (!room) return;
  try {
    const { sessions } = await api('GET', `/api/rooms/${room.id}/sessions`);
    box.innerHTML = room.members
      .map((a) => {
        const s = sessions[a] || {};
        const mb = s.images ? `会话里存了约 ${(s.images / 1048576).toFixed(1)}MB 图片` : '';
        const state = s.busy ? '正在干活' : s.has ? '有会话' : '还没有会话，下次叫它会新开一个';
        const heavy = s.images >= 8 * 1048576;
        return `<div class="list-row">${avatarHtml(a)}<span class="row-text"><b>${esc(agentName(a))}</b><small${heavy ? ' class="warn-text"' : ''}>${esc(
          [state, mb].filter(Boolean).join(' · '),
        )}${heavy ? '，建议换新会话' : ''}</small></span><button type="button" class="secondary" data-fresh="${esc(a)}"${s.has || s.busy ? '' : ' disabled'}>换新会话</button></div>`;
      })
      .join('');
  } catch (err) {
    box.innerHTML = `<div class="list-row"><span class="row-text"><small class="error">${esc(err.message)}</small></span></div>`;
  }
}

// DeepSeek 的 API Key：服务那边先试一下能不能用，能用才存
async function saveDeepseekKey() {
  const input = $('#ds-key');
  const btn = $('#btn-ds-save');
  btn.disabled = true;
  btn.textContent = '检查中…';
  try {
    const res = await api('POST', '/api/deepseek/key', { key: input.value.trim() });
    S.engines = res.engines || S.engines;
    input.value = '';
    toast(res.warning || (S.engines.deepseek?.hasKey ? 'DeepSeek 的 API Key 已保存，可以用了' : '已删掉 DeepSeek 的 API Key'), 4000);
  } catch (err) {
    toast(err.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
  renderEngines();
  $('#model-switch')._html = null; // 模型列表可能变了
  renderShell();
}

// 彻底退出（Windows 和浏览器里用）：后台服务也停掉
async function quitApp() {
  const btn = $('#btn-quit');
  const busy = S.runs.length;
  if (busy && btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = `有 ${busy} 位正在干活，再点一次确认退出`;
    return;
  }
  try {
    await api('POST', '/api/app/quit');
  } catch {}
  showQuit();
}

function showQuit() {
  const again = IS_WIN ? '下次双击桌面上的 ClawChat 就能打开。' : '下次运行 npm start 就能打开。';
  document.body.innerHTML = `<div class="quit-screen"><h2>ClawChat 已退出</h2><p>可以关掉这个窗口了。${again}</p></div>`;
}

let lastEngineRefresh = 0;
function refreshEngines(force = false) {
  if (!force && Date.now() - lastEngineRefresh < 60 * 1000) return;
  lastEngineRefresh = Date.now();
  api('POST', '/api/engines/refresh').catch(() => {}); // 有变化会通过事件推回来
}

function formField(name) {
  return $('#room-form').elements.namedItem(name);
}

// 表单里每位的字段名：memberClaude、modelGpt、effortDeepseek…
const fieldName = (prefix, agent) => `${prefix}${agent[0].toUpperCase()}${agent.slice(1)}`;

function fillModelOptions(room) {
  const models = room?.models || S.defaults.models || {};
  const efforts = room?.efforts || S.defaults.efforts || {};
  for (const a of AGENT_IDS) {
    formField(fieldName('model', a)).outerHTML = modelSelectHtml(a, models[a], `name="${fieldName('model', a)}" data-pair="${a}"`);
    formField(fieldName('effort', a)).outerHTML = effortSelectHtml(a, models[a], efforts[a], `name="${fieldName('effort', a)}"`);
  }
}

// 设置弹窗里换了模型：思考强度的选项跟着换（新模型不支持原来的强度就退回默认）
function refreshEffortField(agent) {
  const name = fieldName('effort', agent);
  const model = formField(fieldName('model', agent)).value;
  const current = formField(name).value;
  const keep = effortsFor(agent, model).includes(current) ? current : '';
  formField(name).outerHTML = effortSelectHtml(agent, model, keep, `name="${name}"`);
}

async function switchModel(agent, id, custom = false) {
  const conv = currentConv();
  if (!conv) return;
  if (id === CUSTOM_MODEL) {
    $('#model-switch')._html = null;
    renderShell(); // 下拉框先退回当前模型，等自定义的试用通过再换
    openCustomModel(agent);
    return;
  }
  const models = { ...conv.room.models, [agent]: id };
  try {
    const { room } = await api('PATCH', `/api/rooms/${conv.roomId}`, { models, custom: custom ? [agent] : [] });
    S.rooms = S.rooms.map((r) => (r.id === room.id ? room : r));
    const name = modelOptions(agent).find((o) => o.id === id)?.name || id;
    toast(`${agentName(agent)} 已切换到 ${name}，下一轮生效`);
  } catch (err) {
    toast(err.message);
  }
  $('#model-switch')._html = null; // 切换失败时让下拉框退回原来的选项
  renderShell();
}

function syncMemberFields() {
  const members = AGENT_IDS.filter((a) => formField(fieldName('member', a)).checked);
  $('#group-fields').hidden = members.length < 2;
  for (const a of AGENT_IDS) $(`#field-model-${a}`).hidden = !members.includes(a);
  formField('name').placeholder = members.length === 1 ? `留空就叫「${agentLabel(members[0])}」` : '比如：今天争取不加班';
  // 勾了还不能用的成员，提前说一声（不拦着，先建好也行）
  const ds = S.engines.deepseek;
  const hint = $('#member-hint');
  hint.textContent = !members.includes('deepseek') || !ds || ds.ok
    ? ''
    : !ds.path
      ? 'DeepSeek 要借 Claude Code 干活，这台电脑还没装 Claude Code。'
      : 'DeepSeek 还没填 API Key：建好后点左下角「设置 → 程序与模型」填一下就能用。';
  hint.hidden = !hint.textContent;
  return members;
}

// 新建聊天时默认勾上能用的成员；一个都不能用（比如还在检测）就勾 Claude 和 GPT
function defaultMembers() {
  const ready = AGENT_IDS.filter((a) => S.engines[AGENT_ENGINE[a]]?.ok);
  return ready.length ? ready : ['claude', 'gpt'];
}

function openDialog(room, preset = null) {
  S.editing = room ? room.id : null;
  const d = room || { ...S.defaults, name: '', cwd: '', members: preset || defaultMembers() };
  const solo = d.members.length === 1;
  $('#dlg-title').textContent = room ? (solo ? '聊天设置' : '群设置') : '新建聊天';
  $('#btn-save').textContent = room ? '保存' : '创建';
  const del = $('#btn-delete');
  del.hidden = !room;
  del.dataset.armed = '';
  del.textContent = solo ? '删除聊天' : '删除群聊';
  for (const a of AGENT_IDS) formField(fieldName('member', a)).checked = d.members.includes(a);
  $('#perm-win-hint').hidden = !IS_WIN;
  $('#session-fields').hidden = !room;
  if (room) {
    $('#session-list').innerHTML = '<div class="list-row"><span class="row-text"><small>读取中…</small></span></div>';
    loadSessions(room);
  }
  formField('name').value = d.name || '';
  formField('cwd').value = d.cwd || '';
  formField('cwd').placeholder = room ? '' : `留空就自动新建：${S.projectsDir}/名字`;
  formField('permission').value = d.permission || 'project';
  formField('collab').checked = d.collab !== false;
  formField('maxAutoTurns').value = d.maxAutoTurns || 8;
  fillModelOptions(room);
  syncMemberFields();
  $('#form-error').hidden = true;
  $('#dlg-room').showModal();
  reportDragRegions();
  formField('name').focus();
}

async function submitDialog(e) {
  e.preventDefault();
  const members = syncMemberFields();
  const body = {
    members,
    name: formField('name').value,
    cwd: formField('cwd').value,
    permission: formField('permission').value,
    collab: formField('collab').checked,
    maxAutoTurns: Number(formField('maxAutoTurns').value),
    models: Object.fromEntries(AGENT_IDS.map((a) => [a, formField(fieldName('model', a)).value])),
    efforts: Object.fromEntries(AGENT_IDS.map((a) => [a, formField(fieldName('effort', a)).value])),
  };
  const btn = $('#btn-save');
  btn.disabled = true;
  try {
    if (S.editing) {
      const { room } = await api('PATCH', `/api/rooms/${S.editing}`, body);
      S.rooms = S.rooms.map((r) => (r.id === room.id ? room : r));
      if (!currentConv()) S.current = `g:${room.id}`;
      renderConvs();
      renderShell();
      renderMessages();
    } else {
      const { room } = await api('POST', '/api/rooms', body);
      if (!roomById(room.id)) S.rooms.unshift(room);
      await openConv(`g:${room.id}`);
    }
    closeDialog($('#dlg-room'));
  } catch (err) {
    $('#form-error').textContent = err.message;
    $('#form-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function deleteRoom() {
  const del = $('#btn-delete');
  if (!del.dataset.armed) {
    del.dataset.armed = '1';
    del.textContent = '再点一次确认删除（聊天记录和私聊都会清空，项目文件夹不动）';
    return;
  }
  try {
    await api('DELETE', `/api/rooms/${S.editing}`);
    S.rooms = S.rooms.filter((r) => r.id !== S.editing);
    S.messages.delete(S.editing);
    closeDialog($('#dlg-room'));
    const next = conversations()[0];
    S.current = next?.key || null;
    renderConvs();
    if (S.current) openConv(S.current);
    else renderShell();
  } catch (err) {
    toast(err.message);
  }
}

function openLightbox(src) {
  const box = $('#lightbox');
  box.firstElementChild.src = src;
  box.hidden = false;
  reportDragRegions();
}

function closeLightbox() {
  const box = $('#lightbox');
  if (box.hidden) return;
  animateThen(box, 'leaving', 180, () => {
    box.hidden = true;
    reportDragRegions();
  });
}

function bind() {
  $('#btn-new').onclick = () => openDialog(null);
  $('#btn-welcome-new').onclick = () => openDialog(null);
  document.querySelectorAll('[data-solo]').forEach((b) => (b.onclick = () => openDialog(null, [b.dataset.solo])));
  $('#btn-settings').onclick = () => currentConv() && openDialog(currentConv().room);
  $('#btn-cancel').onclick = () => closeDialog($('#dlg-room'));
  $('#btn-delete').onclick = deleteRoom;
  $('#room-form').addEventListener('submit', submitDialog);
  $('#room-form').addEventListener('change', (e) => {
    if (/^member/.test(e.target.name)) syncMemberFields();
    if (e.target.dataset.pair) refreshEffortField(e.target.dataset.pair);
  });
  $('#btn-pick').onclick = async () => {
    try {
      const p = await pickFolder();
      if (p) formField('cwd').value = p;
    } catch (err) {
      toast(err.message);
    }
  };
  $('#conv-list').addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      toggleCollapsed(toggle.dataset.toggle); // 小三角：只展开收起，不切换会话
      return;
    }
    const li = e.target.closest('.conv-item');
    if (!li) return;
    // 点有私聊的群这一整项：正在看这个群，就展开 / 收起它的私聊；没在看就打开它，私聊收着的话顺便展开
    const roomId = parseKey(li.dataset.key)?.roomId;
    if (li.classList.contains('has-children') && S.current === li.dataset.key) {
      toggleCollapsed(roomId);
      return;
    }
    openConv(li.dataset.key);
    if (li.classList.contains('has-children') && collapsed.has(roomId)) toggleCollapsed(roomId);
  });
  $('#search').addEventListener('input', (e) => {
    S.filter = e.target.value;
    renderConvs();
  });
  // 点群里的头像（或右上角的头像）就去私聊
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.dm-btn');
    const conv = currentConv();
    if (b && conv) openConv(`d:${conv.roomId}:${b.dataset.dm}`);
    const img = e.target.closest('img.zoomable');
    if (img) openLightbox(img.src);
    const reply = e.target.closest('[data-reply]');
    if (reply) startReply(Number(reply.dataset.reply));
    const jump = e.target.closest('[data-jump]');
    if (jump) jumpTo(Number(jump.dataset.jump));
    const fresh = e.target.closest('[data-fresh]');
    if (fresh) freshAgent(fresh.dataset.fresh, fresh, $('#dlg-room').open ? S.editing : currentConv()?.roomId);
  });
  $('#btn-reply-cancel').onclick = cancelReply;
  $('#lightbox').onclick = closeLightbox;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#lightbox').hidden) closeLightbox();
  });
  document.querySelectorAll('#theme-switch [data-theme-value]').forEach((b) => (b.onclick = () => applyTheme(b.dataset.themeValue)));
  $('#dlg-room').addEventListener('close', reportDragRegions);
  window.addEventListener('resize', () => {
    clearTimeout(reportDragRegions.timer);
    reportDragRegions.timer = setTimeout(reportDragRegions, 100);
  });
  // 按 Esc 关弹窗时也走淡出动画（默认是直接消失）
  document.querySelectorAll('dialog').forEach((dlg) =>
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      closeDialog(dlg);
    }),
  );
  $('#btn-app-settings').onclick = () => openSettings();
  $('#btn-settings-close').onclick = () => closeDialog($('#dlg-settings'));
  // 像 macOS 的设置窗口一样，点窗口外面也能关
  $('#dlg-settings').addEventListener('click', (e) => {
    if (e.target === $('#dlg-settings')) closeDialog($('#dlg-settings'));
  });
  $('#dlg-settings').addEventListener('close', reportDragRegions);
  document.querySelectorAll('#settings-tabs [data-tab]').forEach((b) => (b.onclick = () => openSettings(b.dataset.tab)));
  $('#btn-check-update').onclick = () => checkForUpdate(true);
  $('#btn-do-update').onclick = doUpdate;
  $('#btn-open-data').onclick = () => api('POST', '/api/app/open-data').catch((err) => toast(err.message));
  $('#btn-ds-save').onclick = saveDeepseekKey;
  $('#ds-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) saveDeepseekKey();
  });
  $('#btn-quit').onclick = quitApp;
  document.addEventListener('keydown', (e) => {
    if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openSettings();
    }
  });
  $('#set-engines').addEventListener('click', (e) => {
    const b = e.target.closest('.engine-update');
    if (b) updateEngine(b.dataset.engine, b);
  });
  $('#custom-model-form').addEventListener('submit', submitCustomModel);
  $('#btn-custom-cancel').onclick = () => closeDialog($('#dlg-model'));
  $('#dlg-model').addEventListener('close', reportDragRegions);
  $('#model-switch').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-agent]');
    if (sel) switchModel(sel.dataset.agent, sel.value);
    const eff = e.target.closest('select[data-effort]');
    if (eff) switchEffort(eff.dataset.effort, eff.value);
  });
  $('#room-folder').onclick = () => {
    const conv = currentConv();
    if (conv) api('POST', `/api/rooms/${conv.roomId}/open-folder`).catch((err) => toast(err.message));
  };
  $('#default-target').onchange = async (e) => {
    const conv = currentConv();
    try {
      const { room } = await api('PATCH', `/api/rooms/${conv.roomId}`, { defaultTarget: e.target.value });
      S.rooms = S.rooms.map((r) => (r.id === room.id ? room : r));
    } catch (err) {
      toast(err.message);
    }
  };
  $('#stop-controls').addEventListener('click', (e) => {
    const b = e.target.closest('[data-stop]');
    const conv = currentConv();
    if (!b || !conv) return;
    b.disabled = true;
    // data-stop 为空就是全部停止
    api('POST', `/api/rooms/${conv.roomId}/stop`, b.dataset.stop ? { agent: b.dataset.stop, only: b.dataset.only } : {}).catch((err) => toast(err.message));
  });
  $('#live').addEventListener('click', (e) => {
    const t = e.target.closest('[data-live-toggle]');
    if (t) {
      const k = t.dataset.liveToggle;
      if (S.liveOpen.has(k)) S.liveOpen.delete(k);
      else S.liveOpen.add(k);
      S.liveAnimate = k;
      renderLive();
      S.liveAnimate = null;
      return;
    }
    const b = e.target.closest('.live-stop');
    const conv = currentConv();
    if (b && conv) api('POST', `/api/rooms/${conv.roomId}/stop`, { agent: b.dataset.agent, only: b.dataset.only }).catch((err) => toast(err.message));
    const fresh = e.target.closest('.live-fresh');
    if (fresh) freshAgent(fresh.dataset.agent, fresh);
    // 气泡上方的「换新会话」：会结束手上这一轮，点第一下先变成「确定换？」，3 秒内再点才算
    const mini = e.target.closest('.live-fresh-mini');
    if (mini) {
      if (S.freshArmed !== mini.dataset.key) {
        S.freshArmed = mini.dataset.key;
        renderLive();
        clearTimeout(S.freshTimer);
        S.freshTimer = setTimeout(() => {
          S.freshArmed = null;
          renderLive();
        }, 3000);
        return;
      }
      S.freshArmed = null;
      freshAgent(mini.dataset.agent, mini);
    }
  });
  document.querySelectorAll('[data-mention]').forEach((b) => (b.onclick = () => insertMention(b.dataset.mention)));

  // 图片：按钮选择、粘贴、拖进来
  $('#btn-image').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  };
  $('#attachments').addEventListener('click', (e) => {
    const b = e.target.closest('.att-remove');
    if (!b) return;
    const [a] = S.attachments.splice(Number(b.dataset.i), 1);
    if (a) URL.revokeObjectURL(a.url);
    renderAttachments();
  });
  const input = $('#input');
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => imageType(f));
    if (!files.length) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    addFiles(files);
  });
  let dragDepth = 0;
  const chat = $('#chat');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  chat.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    $('#drop-overlay').hidden = false;
  });
  chat.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#drop-overlay').hidden = true;
  });
  chat.addEventListener('drop', (e) => {
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  // 别让拖进窗口的文件把整个页面换掉
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  input.addEventListener('input', autoGrow);
  input.addEventListener('input', updateMentionMenu);
  input.addEventListener('click', updateMentionMenu);
  input.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateMentionMenu();
  });
  input.addEventListener('blur', () => setTimeout(hideMentionMenu, 150));
  $('#mention-menu').addEventListener('mousemove', (e) => {
    const item = e.target.closest('[data-mention-pick]');
    if (!item || !S.mention) return;
    const i = Number(item.dataset.mentionPick);
    if (i === S.mention.index) return;
    S.mention.index = i;
    updateMentionMenu();
  });
  $('#mention-menu').addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-mention-pick]');
    if (!item) return;
    e.preventDefault(); // 不让输入框失去焦点
    pickMention(Number(item.dataset.mentionPick));
  });
  input.addEventListener('keydown', (e) => {
    if (mentionKeydown(e)) return;
    if (e.key === 'Escape' && S.replyTo && !e.isComposing) {
      e.preventDefault();
      cancelReply();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendMessage();
    }
  });
  $('#btn-send').onclick = sendMessage;
  window.addEventListener('focus', () => {
    refreshEngines(); // 切回窗口时顺便看看有没有新模型
    if (S.current && S.unread.get(S.current)) {
      S.unread.delete(S.current);
      renderConvs();
    }
  });
  setInterval(() => {
    document.querySelectorAll('.elapsed').forEach((el) => (el.textContent = fmtDur(Date.now() - Number(el.dataset.start))));
    updateIdle();
  }, 1000);
}

// Windows：快捷键和「访达」这些说法换成 Windows 的
function applyPlatformText() {
  if (!IS_WIN) return;
  $('#btn-app-settings').title = '设置（Ctrl+,）';
  $('#btn-open-data').textContent = '在资源管理器中显示';
}

async function init() {
  bind();
  applyPlatformText();
  applyTheme(currentTheme());
  try {
    applyState(await api('GET', '/api/state'));
  } catch {
    toast('连不上 ClawChat 服务', 6000);
  }
  renderEngines();
  let saved = storeGet('clawchat.current');
  if (saved && !saved.includes(':')) saved = `g:${saved}`; // 旧版本存的是群 id
  const list = conversations();
  const first = parseKey(saved) && roomById(parseKey(saved).roomId) ? saved : list[0]?.key;
  renderConvs();
  if (first) openConv(first);
  else renderShell();
  connect();
  // 启动后悄悄查一次有没有新版本，之后每 6 小时查一次
  setTimeout(() => checkForUpdate(false), 5000);
  setInterval(() => checkForUpdate(false), 6 * 60 * 60 * 1000);
}

init();
