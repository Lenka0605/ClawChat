'use strict';

const $ = (s) => document.querySelector(s);
const STEP_ICON = { run: '$', edit: '✎', read: '📄', search: '🔍', web: '🌐', say: '💬', think: '💭', todo: '☑', task: '🤖', tool: '🔧' };
const PERM_LABEL = { project: '项目内放手干', full: '完全放开', readonly: '只读讨论' };
const IMAGE_EXT_TYPES = { heic: 'image/heic', heif: 'image/heif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp' };

// 会话：每个群/单聊是 g:<roomId>；群里和某位的私聊是 d:<roomId>:<agent>
const S = {
  rooms: [],
  current: null, // 当前会话 key
  messages: new Map(), // roomId -> message[]
  early: new Map(), // 消息列表还没加载完时收到的新消息
  runs: [],
  live: new Map(), // `${roomId}:${agent}` -> 这一轮到目前为止的过程步骤
  liveOpen: new Set(), // 展开了过程的那几个
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

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
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

const AGENT_ENGINE = { claude: 'claude', gpt: 'codex' };

// 某位可选的模型：第一项是「默认」（跟随 Claude Code / Codex 自己的设置）
function modelOptions(agent) {
  const e = S.engines[AGENT_ENGINE[agent]] || {};
  const label = e.defaultLabel || (e.defaultModel ? modelLabel(e.defaultModel) : '');
  const def = { id: '', name: `默认${label ? ` · ${label}` : ''}`, description: agent === 'claude' ? '跟随 Claude Code 的设置' : '跟随 Codex 的设置' };
  return [def, ...(e.models || [])];
}

// 模型的规范写法：claude-opus-5-5 → Opus 5.5，opus → Opus 5.5（当前对应的版本），gpt-6.1-sol → GPT-6.1-Sol
function modelLabel(id) {
  const m = String(id || '').match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  const known = [...(S.engines.claude?.models || []), ...(S.engines.codex?.models || [])].find((x) => x.id === id);
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
  const def = e.defaultEffort ? `默认 · ${EFFORT_LABEL[e.defaultEffort] || e.defaultEffort}` : '默认';
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
        .map((seg, j) => (j % 2 === 1 ? seg : seg.replace(/(^|[^A-Za-z0-9_.])@(Claude|GPT|Codex|ChatGPT|所有人|全体成员|全体|大家)/gi, '$1<span class="mention">@$2</span>')))
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
function toggleCollapsed(roomId) {
  if (collapsed.has(roomId)) collapsed.delete(roomId);
  else collapsed.add(roomId);
  storeSet('clawchat.collapsed', JSON.stringify([...collapsed]));
  renderConvs();
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
];

function engineState(e) {
  return e ? (e.ok ? esc(e.version || '已就绪') : '没找到，请先安装并登录') : '检测中…';
}

// 程序状态：侧栏底部两个小点、欢迎页一行字、设置里的「程序与模型」
function renderEngines() {
  // 侧栏底部：一切正常时什么都不显示，哪个程序找不到才亮一个黄色提醒
  const missing = ENGINE_INFO.filter(({ key }) => S.engines[key] && !S.engines[key].ok).map(({ name }) => name);
  const warn = $('#engine-warn');
  warn.hidden = !missing.length;
  warn.textContent = missing.length ? `${missing.join('、')} 没找到` : '';
  warn.title = missing.length ? '请先安装并登录，打开设置看详情' : '';
  $('#welcome-engines').innerHTML = ENGINE_INFO.map(({ key, name }) => {
    const e = S.engines[key];
    return `<div class="engine"><span class="dot ${e ? (e.ok ? 'ok' : 'bad') : ''}"></span>${name}：${engineState(e)}</div>`;
  }).join('');
  const maker = { claude: 'Anthropic', codex: 'OpenAI' };
  $('#set-engines').innerHTML = ENGINE_INFO.map(({ key, name, agent }) => {
    const e = S.engines[key];
    const status = e ? (e.ok ? '<span class="status ok">已就绪</span>' : '<span class="status bad">没找到</span>') : '<span class="status">检测中…</span>';
    return `<div class="list-row">${avatarHtml(agent)}<span class="row-text"><b>${name}</b><small>${maker[key]} · ${engineState(e)}</small></span>${status}${
      e?.ok ? `<button class="secondary engine-update" data-engine="${key}">更新</button>` : ''
    }</div>`;
  }).join('');
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
  return `<div class="conv-avatar stack">${c.room.members.map((a) => avatarHtml(a)).join('')}</div>`;
}

function convItemHtml(c, extra = {}) {
  const busy = S.runs
    .filter((x) => x.roomId === c.room.id && (c.dm ? x.dm && x.agent === c.dm : !x.dm))
    .map((x) => agentName(x.agent))
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
  $('#room-folder').title = `在访达中打开：${room.cwd}`;
  const perm = $('#room-perm');
  perm.textContent = PERM_LABEL[room.permission] || room.permission;
  perm.className = `badge ${room.permission}`;
  // 顶部的模型切换：群里显示所有成员，私聊只显示对方
  setHtml($('#model-switch'), (dm ? [dm] : room.members)
    .map(
      (a) => `<span class="model-chip" title="切换 ${esc(agentName(a))} 的模型和思考强度，下一轮生效">${avatarHtml(a)}${modelSelectHtml(
        a,
        room.models?.[a],
        `data-agent="${esc(a)}" aria-label="${esc(agentName(a))} 的模型"`,
        true,
      )}<span class="chip-sep"></span><span class="chip-label">思考</span>${effortSelectHtml(
        a,
        room.models?.[a],
        room.efforts?.[a],
        `data-effort="${esc(a)}" class="effort-select" aria-label="${esc(agentName(a))} 的思考强度"`,
      )}</span>`,
    )
    .join(''));
  const entry = $('#dm-entry');
  entry.hidden = dm || !group;
  entry.innerHTML = group && !dm ? `<span class="muted">私聊</span>${room.members.map((a) => `<button class="dm-btn" data-dm="${esc(a)}" title="私聊 ${esc(agentLabel(a))}">${avatarHtml(a)}</button>`).join('')}` : '';
  $('#group-tools').hidden = !!dm || !group;
  document.querySelectorAll('[data-mention]').forEach((b) => {
    const id = { Claude: 'claude', GPT: 'gpt' }[b.dataset.mention];
    b.hidden = id ? !room.members.includes(id) : false;
  });
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
  if (m.from === 'system') return `${sep}<div class="notice"><span>${esc(m.text)}</span></div>`;
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
  return `${sep}<div class="msg agent" data-seq="${m.seq}">${avatar}<div class="msg-body"><div class="msg-name">${esc(agentLabel(m.from))}${model}</div>${imagesHtml(roomId, m.images)}<div class="bubble">${md(
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

function convRuns(conv) {
  return S.runs.filter((r) => r.roomId === conv.roomId && (conv.dm ? r.dm && r.agent === conv.dm : !r.dm));
}

function renderLive() {
  const conv = currentConv();
  const runs = conv ? convRuns(conv) : [];
  $('#live').innerHTML = runs
    .map((r) => {
      const key = `${r.roomId}:${r.agent}`;
      const all = S.live.get(key) || [];
      const open = S.liveOpen.has(key);
      const shown = open ? all : all.slice(-3);
      const toggle = all.length
        ? `<button class="live-toggle${open ? ' open' : ''}" data-live-toggle="${esc(key)}">${open ? '收起' : '展开'}过程 · ${all.length} 步
            <svg viewBox="0 0 10 10" width="8" height="8"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
        : '';
      return `<div class="msg agent live">${avatarHtml(r.agent)}<div class="msg-body"><div class="msg-name">${esc(agentLabel(r.agent))}</div>
        <div class="bubble"><div class="live-head"><span class="typing"><i></i><i></i><i></i></span>
        <span>正在干活 · <span class="elapsed" data-start="${r.startedAt}">${fmtDur(Date.now() - r.startedAt)}</span></span>
        ${toggle}<button class="live-stop" data-agent="${esc(r.agent)}">停止</button></div>
        ${shown.length ? `<ol class="live-steps${open ? ' open' : ''}" data-live-list="${esc(key)}">${shown.map(stepHtml).join('')}</ol>` : ''}
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
    (r) => `<button class="chip danger" data-stop="${esc(r.agent)}">${avatarHtml(r.agent)}停止 ${esc(agentName(r.agent))}${r.dm ? '（私聊）' : ''}</button>`,
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
  const keys = new Set(runs.map((r) => `${r.roomId}:${r.agent}`));
  for (const k of [...S.live.keys()]) if (!keys.has(k)) S.live.delete(k);
  for (const k of [...S.liveOpen]) if (!keys.has(k)) S.liveOpen.delete(k);
  for (const r of runs) {
    const k = `${r.roomId}:${r.agent}`;
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
    $('#messages').insertAdjacentHTML('beforeend', messageHtml(roomId, m, shown[shown.length - 2], conv));
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
      const k = `${ev.roomId}:${ev.agent}`;
      const arr = S.live.get(k) || [];
      arr.push(ev.step);
      if (arr.length > 300) arr.splice(0, arr.length - 300);
      S.live.set(k, arr);
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
      break;
    case 'engines':
      S.engines = ev.engines || {};
      renderEngines();
      renderShell(); // 模型列表可能多了新模型
      break;
    case 'restarting':
      showRestarting();
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
      (a, i) => `<div class="att ${a.status}">
        <img src="${a.url}" alt="">
        ${a.status === 'uploading' ? '<span class="att-state">上传中…</span>' : a.status === 'error' ? `<span class="att-state" title="${esc(a.error)}">失败</span>` : ''}
        <button class="att-remove" data-i="${i}" title="移除">×</button>
      </div>`,
    )
    .join('');
  updateSendButton();
}

function clearAttachments() {
  for (const a of S.attachments) URL.revokeObjectURL(a.url);
  S.attachments = [];
  renderAttachments();
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
    const att = { url: URL.createObjectURL(file), status: 'uploading', id: null, error: '', roomId: conv.roomId };
    S.attachments.push(att);
    fetch(`/api/rooms/${conv.roomId}/uploads`, { method: 'POST', headers: { 'content-type': imageType(file), 'x-clawchat': '1' }, body: file })
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
  { id: 'all', label: '所有人', sub: '两位一起', insert: '所有人', keys: ['所有人', 'all', 'everyone', '大家', '全体', 'suoyouren'] },
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
  const icon = (it) => (it.id === 'all' ? `<span class="mention-all">${avatarHtml('claude')}${avatarHtml('gpt')}</span>` : avatarHtml(it.id));
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
  $('#custom-model-hint').textContent =
    agent === 'gpt' ? '填 Codex 里的模型名，比如 gpt-7.0。' : '填 Claude Code 能用的模型名，比如 claude-opus-6-0，或者 opus、fable 这样的别名。';
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
    dlg.close();
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
  document.querySelectorAll('#settings-tabs [data-tab]').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    if (on) $('#prefs-title').textContent = b.dataset.title;
  });
  document.querySelectorAll('#dlg-settings [data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  if (tab === 'engines') refreshEngines(true);
}

async function openSettings(tab = 'general') {
  const dlg = $('#dlg-settings');
  if (!dlg.open) dlg.showModal();
  reportDragRegions();
  showSettingsTab(tab);
  renderEngines();
  try {
    const info = await api('GET', '/api/app');
    S.app = info;
    const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~'); // 像访达一样把个人目录写成 ~
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
  $('#update-status').textContent = '升级好了，正在重新打包并重启，稍等十几秒…';
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

let lastEngineRefresh = 0;
function refreshEngines(force = false) {
  if (!force && Date.now() - lastEngineRefresh < 60 * 1000) return;
  lastEngineRefresh = Date.now();
  api('POST', '/api/engines/refresh').catch(() => {}); // 有变化会通过事件推回来
}

function formField(name) {
  return $('#room-form').elements.namedItem(name);
}

function fillModelOptions(room) {
  const models = room?.models || S.defaults.models || {};
  const efforts = room?.efforts || S.defaults.efforts || {};
  formField('modelClaude').outerHTML = modelSelectHtml('claude', models.claude, 'name="modelClaude" data-pair="claude"');
  formField('modelGpt').outerHTML = modelSelectHtml('gpt', models.gpt, 'name="modelGpt" data-pair="gpt"');
  formField('effortClaude').outerHTML = effortSelectHtml('claude', models.claude, efforts.claude, 'name="effortClaude"');
  formField('effortGpt').outerHTML = effortSelectHtml('gpt', models.gpt, efforts.gpt, 'name="effortGpt"');
}

// 设置弹窗里换了模型：思考强度的选项跟着换（新模型不支持原来的强度就退回默认）
function refreshEffortField(agent) {
  const name = agent === 'claude' ? 'effortClaude' : 'effortGpt';
  const model = formField(agent === 'claude' ? 'modelClaude' : 'modelGpt').value;
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
  const members = ['claude', 'gpt'].filter((a) => formField(a === 'claude' ? 'memberClaude' : 'memberGpt').checked);
  $('#group-fields').hidden = members.length < 2;
  $('#field-model-claude').hidden = !members.includes('claude');
  $('#field-model-gpt').hidden = !members.includes('gpt');
  formField('name').placeholder = members.length === 1 ? `留空就叫「${agentLabel(members[0])}」` : '比如：今天争取不加班';
  return members;
}

function openDialog(room, preset = null) {
  S.editing = room ? room.id : null;
  const d = room || { ...S.defaults, name: '', cwd: '', members: preset || ['claude', 'gpt'] };
  const solo = d.members.length === 1;
  $('#dlg-title').textContent = room ? (solo ? '聊天设置' : '群设置') : '新建聊天';
  $('#btn-save').textContent = room ? '保存' : '创建';
  const del = $('#btn-delete');
  del.hidden = !room;
  del.dataset.armed = '';
  del.textContent = solo ? '删除聊天' : '删除群聊';
  formField('memberClaude').checked = d.members.includes('claude');
  formField('memberGpt').checked = d.members.includes('gpt');
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
    models: { claude: formField('modelClaude').value, gpt: formField('modelGpt').value },
    efforts: { claude: formField('effortClaude').value, gpt: formField('effortGpt').value },
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
    $('#dlg-room').close();
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
    $('#dlg-room').close();
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
  $('#lightbox').hidden = true;
  reportDragRegions();
}

function bind() {
  $('#btn-new').onclick = () => openDialog(null);
  $('#btn-welcome-new').onclick = () => openDialog(null);
  document.querySelectorAll('[data-solo]').forEach((b) => (b.onclick = () => openDialog(null, [b.dataset.solo])));
  $('#btn-settings').onclick = () => currentConv() && openDialog(currentConv().room);
  $('#btn-cancel').onclick = () => $('#dlg-room').close();
  $('#btn-delete').onclick = deleteRoom;
  $('#room-form').addEventListener('submit', submitDialog);
  $('#room-form').addEventListener('change', (e) => {
    if (e.target.name === 'memberClaude' || e.target.name === 'memberGpt') syncMemberFields();
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
      toggleCollapsed(toggle.dataset.toggle); // 只展开收起，不切换会话
      return;
    }
    const li = e.target.closest('.conv-item');
    if (li) openConv(li.dataset.key);
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
  $('#btn-app-settings').onclick = () => openSettings();
  $('#btn-settings-close').onclick = () => $('#dlg-settings').close();
  // 像 macOS 的设置窗口一样，点窗口外面也能关
  $('#dlg-settings').addEventListener('click', (e) => {
    if (e.target === $('#dlg-settings')) $('#dlg-settings').close();
  });
  $('#dlg-settings').addEventListener('close', reportDragRegions);
  document.querySelectorAll('#settings-tabs [data-tab]').forEach((b) => (b.onclick = () => openSettings(b.dataset.tab)));
  $('#btn-check-update').onclick = () => checkForUpdate(true);
  $('#btn-do-update').onclick = doUpdate;
  $('#btn-open-data').onclick = () => api('POST', '/api/app/open-data').catch((err) => toast(err.message));
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
  $('#btn-custom-cancel').onclick = () => $('#dlg-model').close();
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
    api('POST', `/api/rooms/${conv.roomId}/stop`, b.dataset.stop ? { agent: b.dataset.stop } : {}).catch((err) => toast(err.message));
  });
  $('#live').addEventListener('click', (e) => {
    const t = e.target.closest('[data-live-toggle]');
    if (t) {
      const k = t.dataset.liveToggle;
      if (S.liveOpen.has(k)) S.liveOpen.delete(k);
      else S.liveOpen.add(k);
      renderLive();
      return;
    }
    const b = e.target.closest('.live-stop');
    const conv = currentConv();
    if (b && conv) api('POST', `/api/rooms/${conv.roomId}/stop`, { agent: b.dataset.agent }).catch((err) => toast(err.message));
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
  }, 1000);
}

async function init() {
  bind();
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
