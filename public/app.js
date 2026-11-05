'use strict';

const $ = (s) => document.querySelector(s);
const STEP_ICON = { run: '$', edit: '✎', read: '📄', search: '🔍', web: '🌐', say: '💬', think: '💭', todo: '☑', task: '🤖', tool: '🔧', compact: '🗜' };
const PERM_LABEL = { project: tr('项目内放手干'), full: tr('完全放开'), readonly: tr('只读讨论') };
const IS_WIN = document.documentElement.classList.contains('win');
// 「在访达中显示」这类：Windows 上叫资源管理器
const REVEAL_LABEL = IS_WIN ? tr('在资源管理器中显示') : tr('在访达中显示');
// 列举几位时的分隔符：中文用顿号，英文用逗号
const LIST_SEP = tr('、');
// 五位固定成员；AGENT_IDS 还包括多开的（比如 ChatGPT2），按服务端的成员表重算（rebuildMembers）
const BASE_IDS = ['claude', 'gpt', 'deepseek', 'glm', 'gemini', 'grok', 'cursor', 'api'];
let AGENT_IDS = [...BASE_IDS];
// 多开的那位是谁的几号：头像、配色、程序都跟本体一样。已经删掉的（老消息里还有）按 id 认：gpt2 就是 ChatGPT 的 2 号
const cloneInfo = (a) => {
  if (S.agents?.[a]) return S.agents[a].base ? { base: S.agents[a].base, n: S.agents[a].n } : null;
  const m = String(a || '').match(/^(claude|gpt|deepseek|glm|gemini|grok|cursor|api)([2-9])$/);
  return m ? { base: m[1], n: Number(m[2]) } : null;
};
const baseOf = (a) => cloneInfo(a)?.base || a;
// 在群设置里刚点出来、还没保存的多开成员（ChatGPT2 这类）：先当成成员显示，保存时服务端会开出来
let PENDING_CLONES = new Set();
const ALL_WORD = I18N.lang === 'zh' ? '所有人' : 'everyone'; // @所有人：英文界面插 @everyone（服务端两个都认）
const IMAGE_EXT_TYPES = { heic: 'image/heic', heif: 'image/heif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp' };

// 会话：每个群/单聊是 g:<roomId>；群里和某位的私聊是 d:<roomId>:<agent>
const S = {
  rooms: [],
  current: null, // 当前会话 key
  drafts: {}, // 会话 key -> 还没发出去的字（启动时从本机读）
  openSteps: new Set(), // 展开着的「过程」：roomId:seq（重画后保持展开）
  rendered: null, // 当前会话画到了哪：{ key, from }（长对话只画最近一段）
  sessionImages: new Map(), // roomId -> { gpt: 会话里存的图片字节数 }（会话太重时顶部按钮上提醒）
  newBelow: 0, // 往上翻着的时候来了几条新消息（标在「回到最新」按钮上）
  pinned: true, // 是不是贴着最底下（消息列表变高时继续贴着；自己往上翻、跳到某条消息时就不贴了）
  messages: new Map(), // 会话 key（g:群 / d:群:成员）-> message[]，每个会话各存各取，私聊不会被群消息挤掉
  bounds: new Map(), // 会话 key -> { first, last, hasEarlier, hasLater }：这个会话已经取到哪一段
  clearGen: new Map(), // roomId -> 清空过几次：清空之前发出去的取消息请求回来时，按代次丢掉（这个群里所有会话一起作废）
  loadingEarlier: new Set(), // 正在问服务器要更早的一段（连着点、滚动触发两次时别重复取）
  early: new Map(), // 消息列表还没加载完时收到的新消息（会话 key -> message[]）
  runs: [],
  queued: [], // 排着队、要等它在别处那一轮干完的：{ roomId, agent, busy: 'group'|'dm'|'pm', group, dm }
  live: new Map(), // `${roomId}:${agent}` -> 这一轮到目前为止的过程步骤
  liveAt: new Map(), // 同上 -> 最后一次有动静的时间（判断是不是卡住了）
  liveOpen: new Set(), // 展开了过程的那几个
  liveDropped: new Map(), // 过程超过 300 步时前面挤掉了几步（重画后找回老板正在看的那一步用）
  liveSeen: new Set(), // 已经播过进场动画的「正在干活」气泡
  replyTo: null, // 正在回复哪条消息
  unread: new Map(), // 会话 key -> 未读数
  openedDms: new Map(), // 打开过但还没消息的私聊，key -> 打开时间
  attachments: [], // 待发送的图片
  attachDrafts: new Map(), // 别的会话里还没发出去的图片：会话 key -> 那个会话的 attachments（切回去时放回来）
  engines: {},
  installing: {}, // 正在安装的程序：engine -> true（安装过程由服务端跑，完成前会推 installing 事件）
  loggingIn: {}, // 正在等登录的程序：engine -> true
  loginLinks: {}, // 点过登录后官方命令打印出来的登录网址：engine -> { url, code }（浏览器没自动打开时用）
  usage: {}, // 订阅额度最近一次的用量（Claude、ChatGPT）
  agents: {},
  jointMembers: {}, // 联合群里对方成员：key -> { name, owner, base, online }
  jointPolicy: null, // 当前打开的联合群设置：{ roomId, engines, agents }
  jointApproval: null, // 正在等老板点的动手审批
  folders: [], // 侧栏的收纳组：[{ id, name }]，群对象上的 folder 字段记它在哪个组
  defaults: {},
  projectsDir: '',
  editing: null,
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
  if (!res.ok) throw new Error(data.error || tr('请求失败（{status}）', { status: res.status }));
  return data;
}

// 在 ClawChat.app 窗口里运行时，和原生外壳通信（Dock 角标、选文件夹）
function native(msg) {
  try {
    window.webkit?.messageHandlers?.clawchat?.postMessage(msg);
  } catch {}
}
const hasNative = () => !!window.webkit?.messageHandlers?.clawchat;
// 原生外壳会什么：旧版 Mac 外壳没有 pickFile，不能直接发消息等它（会一直没反应），
// 新外壳收到 capabilities 会回一句，前端据此决定用原生面板还是走 /api/pick-file
const nativeCaps = {};
window.__clawchatCapabilities = (caps) => Object.assign(nativeCaps, caps || {});
const biometricResolvers = new Map();
window.__clawchatBiometric = (res) => {
  if (!res?.id) return;
  const done = biometricResolvers.get(res.id);
  if (!done) return;
  biometricResolvers.delete(res.id);
  done(res);
};

// 界面语言告诉服务端（群里的提示、AI 回复用的语言跟着它）和原生外壳（菜单栏）
// manual：老板在设置里亲手换的语言；页面打开时自动报的不带它（手机上自动报的服务端不认，免得把电脑的语言改掉）
function syncLang(lang, manual = false) {
  native({ type: 'lang', value: lang });
  return api('POST', '/api/lang', { lang, manual });
}

// ---------------- 外观（浅色 / 深色 / 跟随系统） ----------------

function currentTheme() {
  const t = storeGet('clawchat.theme');
  return t === 'light' || t === 'dark' ? t : 'system';
}

function applyTheme(mode) {
  const root = document.documentElement;
  const set = () => {
    if (mode === 'light' || mode === 'dark') root.dataset.theme = mode;
    else delete root.dataset.theme;
    const meta = $('#theme-color');
    if (meta) meta.setAttribute('content', root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches) ? '#1c1c1e' : '#f2f2f4');
  };
  // 用「视图过渡」淡过去：只对新旧两张整页画面做一次交叉淡化，交给显卡合成，很流畅
  // （以前是让页面上每个元素各自做颜色过渡，元素一多就掉帧）。老系统不支持就直接切换
  // 过渡拍下的画面里没有背景模糊效果，半透明的顶栏、输入框会露出后面的字，所以过渡期间先把玻璃换成实色
  if (applyTheme.ready && document.startViewTransition && !reduceMotion()) {
    root.classList.add('theme-swap');
    document.startViewTransition(set).finished.finally(() => root.classList.remove('theme-swap'));
  } else set();
  applyTheme.ready = true;
  storeSet('clawchat.theme', mode);
  native({ type: 'theme', value: mode }); // 让窗口的毛玻璃和系统控件也跟着变
  document.querySelectorAll('#theme-switch [data-theme-value]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeValue === mode)));
}

// 官方头像（打包时从本机官方应用里取的、启动时从 DeepSeek 官方 GitHub 下载的）在不在：
// 在就给 <html> 加上 icon-gpt 这样的标记，CSS 用它把头像底色换成透明 / 白色，不然图标圆角外会露出一圈深色底
const ICON_FILE = { claude: 'claude', gpt: 'gpt', deepseek: 'deepseek', glm: 'glm', gemini: 'gemini', grok: 'grok', cursor: 'cursor', api: 'api' };
function detectIcons(bust = '') {
  for (const a of BASE_IDS) {
    const img = new Image();
    img.onload = () => document.documentElement.classList.add(`icon-${a}`);
    img.onerror = () => document.documentElement.classList.remove(`icon-${a}`);
    img.src = `/icons/${ICON_FILE[a]}.png${bust}`;
  }
}

// 顶栏和输入区浮在消息上面（Liquid Glass：消息从它们后面滚过去，透出模糊的内容），
// 所以消息列表上下要留出它们的高度；输入框变高时，原来在最底下的话继续贴着最底下
function trackChrome() {
  const chat = $('#chat');
  const sync = () => {
    const stay = nearBottom();
    chat.style.setProperty('--head-h', `${$('#room-head').offsetHeight}px`);
    chat.style.setProperty('--composer-h', `${$('#composer').offsetHeight}px`);
    if (stay) scrollToBottom();
  };
  const ro = new ResizeObserver(sync);
  ro.observe($('#room-head'));
  ro.observe($('#composer'));
  new ResizeObserver(() => requestAnimationFrame(fitTools)).observe(document.querySelector('.composer-tools'));
}

// ---------------- 文件路径：悬停看缩略图，点击在访达中显示 ----------------

// 同一条消息（或同一段过程）里提到的其他路径：AI 常常先说「图片都在 xx 文件夹里」，后面只写文件名，服务端会先到这些地方找
function nearPaths(el) {
  const box = el.closest('.bubble, .live-steps, .steps, .msg-body') || el.parentElement;
  const out = [];
  for (const r of box?.querySelectorAll('.file-ref') || []) if (r !== el && r.dataset.path && !out.includes(r.dataset.path)) out.push(r.dataset.path);
  return out.slice(0, 20);
}

// 消息里提到的文件，在项目里找不到的就不显示成能点的样子（免得一点就是「找不到这个文件」）。
// 渲染完统一问一次服务端；找得到的记住，找不到的 20 秒后再问（可能是 AI 待会儿才生成的）
const fileChecks = new Map(); // `${roomId}\n${path}\n${near}` -> { ok, at }
function checkFileRefs() {
  clearTimeout(checkFileRefs.timer);
  checkFileRefs.timer = setTimeout(async () => {
    const conv = currentConv();
    if (!conv) return;
    const pending = new Map(); // key -> { item, els }
    for (const el of document.querySelectorAll('#chat .file-ref:not([data-checked])')) {
      const near = nearPaths(el);
      const key = `${conv.roomId}\n${el.dataset.path}\n${near.join('\n')}`;
      const known = fileChecks.get(key);
      if (known && (known.ok || Date.now() - known.at < 20000)) {
        markFileRef(el, known.ok);
        continue;
      }
      if (!pending.has(key)) pending.set(key, { item: { path: el.dataset.path, near }, els: [] });
      pending.get(key).els.push(el);
    }
    if (!pending.size) return syncRefThumbs();
    const list = [...pending.entries()].slice(0, 400);
    try {
      const { found } = await api('POST', `/api/rooms/${conv.roomId}/exists`, { items: list.map(([, v]) => v.item) });
      list.forEach(([key, v], i) => {
        fileChecks.set(key, { ok: !!found[i], at: Date.now() });
        for (const el of v.els) markFileRef(el, !!found[i]);
      });
    } catch {}
    syncRefThumbs();
  }, 120);
}

// 能不能点：确定找不到的不能点；说不准是不是路径的，要确认过找得到才能点
const fileRefLive = (el) => !el.classList.contains('missing') && (!el.classList.contains('maybe') || el.dataset.checked === '1');

function markFileRef(el, ok) {
  el.dataset.checked = '1';
  el.classList.toggle('missing', !ok);
  if (ok && el.classList.contains('maybe')) el.title = REVEAL_LABEL;
  else if (!ok && !el.classList.contains('maybe')) el.title = tr('项目文件夹里找不到这个文件');
}

function showFilePreview(el) {
  const conv = currentConv();
  const file = el.dataset.path;
  if (!conv || !fileRefLive(el) || !IMAGE_EXT_RE.test(file)) return;
  clearTimeout(showFilePreview.timer);
  showFilePreview.timer = setTimeout(() => {
    const box = $('#file-preview');
    const img = box.querySelector('img');
    box.querySelector('.fp-name').textContent = file.split('/').pop();
    box.dataset.for = file;
    img.onload = () => {
      if (box.dataset.for !== file) return;
      // 「正在干活」气泡每来一步就重画一次，悬停的那个元素可能已经被换掉了：找现在画着的同一个路径
      const at = el.isConnected ? el : [...document.querySelectorAll('#scroller .file-ref')].find((r) => r.dataset.path === file);
      if (!at) return hideFilePreview();
      box.hidden = false;
      // 放在路径下面；下面放不下就放上面，左右不超出窗口
      const r = at.getBoundingClientRect();
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      const below = r.bottom + 8 + h < window.innerHeight - 8;
      box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
      box.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - h - 8)}px`;
    };
    img.onerror = () => hideFilePreview();
    img.src = `/api/rooms/${conv.roomId}/preview?path=${encodeURIComponent(file)}${nearPaths(el).map((p) => `&near=${encodeURIComponent(p)}`).join('')}`;
  }, 150);
}

function hideFilePreview() {
  clearTimeout(showFilePreview.timer);
  const box = $('#file-preview');
  box.hidden = true;
  delete box.dataset.for;
}

async function revealFile(file, near = []) {
  const conv = currentConv();
  if (!conv) return;
  try {
    await api('POST', `/api/rooms/${conv.roomId}/reveal`, { path: file, near });
  } catch (err) {
    toast(err.message);
  }
}

// ---------------- 手机上看电脑里的文件 ----------------
// 人不在这台电脑前（手机、平板，或者从别的电脑经 Tailscale 打开）时，点路径「在访达里显示」是在家里那台 Mac 上弹，
// 这边什么也看不到：图片就地全屏看，PDF、音视频新开一页看。电脑上照旧在访达里显示。
const VIEW_IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico|heic|heif|tiff?|psd|dng|cr2|nef|arw)$/i;
const VIEW_MEDIA_RE = /\.(pdf|mp4|mov|m4v|webm|mp3|m4a|wav)$/i;
const viewHere = () => !isLocalHost() || !finePointer();

function viewUrl(roomId, file, near = []) {
  return `/api/rooms/${roomId}/view?path=${encodeURIComponent(file)}${near.map((p) => `&near=${encodeURIComponent(p)}`).join('')}`;
}

// 接口出错时返回 { error }（中文的原因：敏感位置、找不到、太大、类型不支持），读出来给老板看
async function viewError(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    if (r.ok) return '';
    return (await r.json().catch(() => null))?.error || tr('打不开这个文件');
  } catch {
    return tr('连不上电脑，请检查网络');
  }
}

function openFileRef(ref) {
  const conv = currentConv();
  if (!conv) return;
  const file = ref.dataset.path;
  const near = nearPaths(ref);
  if (!viewHere()) return revealFile(file, near);
  const url = viewUrl(conv.roomId, file, near);
  const name = file.split('/').pop();
  if (VIEW_IMAGE_RE.test(file)) return openLightbox(url, { name, check: true });
  if (VIEW_MEDIA_RE.test(file)) {
    // 新页要在点的这一下就开（晚了会被浏览器当成弹窗拦掉），先确认能打开再跳过去，打不开就关掉、说原因
    const w = window.open('', '_blank');
    viewError(url).then((err) => {
      if (!err) {
        if (w) w.location.href = url;
        else location.href = url;
        return;
      }
      w?.close();
      toast(err, 5000);
    });
    return;
  }
  toast(tr('这个文件在电脑上，手机上只能看图片、PDF 和音视频'), 5000);
}

// AI 回复里提到的图片：手机上在气泡下面直接排一行小图（最多 4 张），不用去点路径。过程里的路径不加
function syncRefThumbs() {
  const conv = currentConv();
  for (const bubble of document.querySelectorAll('#chat .msg.agent:not(.live) > .msg-body > .bubble')) {
    const old = bubble.nextElementSibling?.classList.contains('ref-thumbs') ? bubble.nextElementSibling : null;
    const refs = [];
    if (conv && viewHere()) {
      for (const r of bubble.querySelectorAll('.file-ref[data-checked="1"]:not(.missing)')) {
        if (VIEW_IMAGE_RE.test(r.dataset.path) && !refs.some((x) => x.dataset.path === r.dataset.path)) refs.push(r);
      }
    }
    const list = refs.slice(0, 4);
    const key = list.map((r) => r.dataset.path).join('\n');
    if (old && old.dataset.key === key) continue;
    old?.remove();
    if (!list.length) continue;
    const box = document.createElement('div');
    box.className = 'ref-thumbs';
    box.dataset.key = key;
    for (const r of list) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = r.dataset.path.split('/').pop();
      img.title = img.alt;
      img.dataset.view = viewUrl(conv.roomId, r.dataset.path, nearPaths(r));
      img.src = img.dataset.view;
      img.onerror = () => {
        img.remove();
        if (!box.children.length) box.remove();
      };
      box.append(img);
    }
    bubble.after(box);
  }
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
  const nodrag = [...document.querySelectorAll('[data-drag] :is(button, select, input, a, label, textarea), #model-menu')].filter(shown).map(rect);
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
  // 放在聊天区上方、顶栏下面，按聊天区居中（不算侧栏）
  const main = $('#main').getBoundingClientRect();
  const head = $('#chat').hidden ? 0 : $('#room-head').offsetHeight;
  const find = $('#find');
  // 群里的搜索条也在顶栏下面：它开着的时候把提示再往下让一让，免得盖住搜索框
  const findBox = find && !find.hidden ? find.offsetHeight + 8 : 0;
  if (main.width > 40) {
    t.style.left = `${main.left + main.width / 2}px`;
    t.style.top = `${main.top + head + 12 + findBox}px`;
  } else {
    // 手机上正在看会话列表时，聊天区是隐藏的（量出来全是 0）：
    // 还按它定位会把提示推到屏幕左缘外、盖住顶栏标题——清掉内联值，让样式表里的居中定位接管
    t.style.left = '';
    t.style.top = '';
  }
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

// 日期：中文写「10月30日」，英文写「Oct 30」；withYear 时带上年份
function fmtDate(d, withYear) {
  if (I18N.lang === 'zh') return `${withYear ? `${d.getFullYear()}年` : ''}${d.getMonth() + 1}月${d.getDate()}日`;
  return d.toLocaleDateString('en-US', withYear ? { year: 'numeric', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, now)) return hm;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return tr('昨天 {time}', { time: hm });
  return `${fmtDate(d)} ${hm}`;
}

// AI 之间私聊的时间：一直显示在名字旁边（今天的只写时分，不是今天的带上日期）
function fmtPmTime(ts) {
  const d = new Date(ts);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, new Date())) return tr('今天 {time}', { time: hm });
  return fmtTime(ts);
}

// 鼠标移到消息上显示的发送时间：24 小时制，精确到秒；不是今天的带上日期
function fmtExact(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (sameDay(d, now)) return hms;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return tr('昨天 {time}', { time: hms });
  return `${fmtDate(d, d.getFullYear() !== now.getFullYear())} ${hms}`;
}

function fmtShort(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return tr('昨天');
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return tr('{s}秒', { s });
  const m = Math.floor(s / 60);
  if (m < 60) return tr('{m}分{s}秒', { m, s: pad(s % 60) });
  return tr('{h}小时{m}分', { h: Math.floor(m / 60), m: pad(m % 60) });
}

// 消息底部右边的「多久前」：一小时以上写成「1 小时 01 分钟前」，超过一天写天数；页面上每 30 秒刷新一次
function msgAgo(ts) {
  const min = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (min < 1) return tr('刚刚');
  if (min < 60) return tr('{n} 分钟前', { n: min });
  if (min < 24 * 60) return tr('{h} 小时 {m} 分钟前', hourMin(min));
  return tr('{n} 天前', { n: Math.floor(min / 60 / 24) });
}

// 一小时以上的「多久前 / 多久后」：写成「1 小时 01 分钟」，不再四舍五入成整小时（老板定的：61 分钟就是 1 小时 01 分钟）
function hourMin(min) {
  return { h: Math.floor(min / 60), m: pad(min % 60) };
}

function firstLine(s) {
  return String(s || '').split('\n')[0].slice(0, 200);
}

function jointMemberDisplay(m) {
  const name = m?.name || '';
  return m?.owner ? `${name}·${m.owner}` : name;
}

function jointMemberOf(room, id) {
  return (room?.jointMembers || []).find((m) => m.key === id || (m.mine && m.agentId === id)) || null;
}

function jointDisplayFor(room, id) {
  const m = jointMemberOf(room, id);
  return m ? jointMemberDisplay(m) : agentName(id);
}

function agentLabel(id) {
  const j = S.jointMembers?.[id];
  if (j) return jointMemberDisplay(j);
  const c = !S.agents[id] && cloneInfo(id);
  return S.agents[id]?.label || (c ? `${agentLabel(c.base)}${c.n}` : id);
}

function agentName(id) {
  const j = S.jointMembers?.[id];
  if (j) return jointMemberDisplay(j);
  const c = !S.agents[id] && cloneInfo(id);
  return S.agents[id]?.name || (c ? `${agentName(c.base)}${c.n}` : id);
}

// 每位用哪个程序；多开的（gpt2）查不到就用本体的
const byBase = (map) => new Proxy(map, { get: (t, k) => (k in t ? t[k] : t[baseOf(k)]) });
const AGENT_ENGINE = byBase({ claude: 'claude', gpt: 'codex', deepseek: 'deepseek', glm: 'glm', gemini: 'gemini', grok: 'grok', cursor: 'cursor', api: 'api' });
const DEFAULT_HINT = byBase({ claude: tr('跟随 Claude Code 的设置'), gpt: tr('跟随 Codex 的设置'), deepseek: tr('又快又便宜，能看图'), glm: tr('智谱的 GLM'), gemini: tr('跟随当前 CLI 的设置'), grok: tr('跟随 Grok Build 的设置'), cursor: tr('跟随 Cursor CLI 的设置'), api: tr('跟随平台的默认模型') });
// 这几位是自己填 API Key、借 Claude Code 干活的（不是本机装好的命令行）
const BYOK = { deepseek: true, glm: true };
// 设置里要填 API Key 的几位（Gemini 的 Key 是可选的：不填就用 Gemini CLI 自己的登录）
const KEY_TARGETS = ['deepseek', 'glm', 'gemini'];

// 某位可选的模型：第一项是「默认」（跟随 Claude Code / Codex 自己的设置；DeepSeek 默认用 Flash）
function modelOptions(agent) {
  const e = S.engines[AGENT_ENGINE[agent]] || {};
  const label = e.defaultLabel || (e.defaultModel ? modelLabel(e.defaultModel) : '');
  const defModel = (e.models || []).find((m) => m.id === (e.defaultModel || e.models?.[0]?.id));
  // 「默认」那项也带上能不能看图，菜单里才不会少一个图标
  const def = { id: '', name: label ? tr('默认 · {label}', { label }) : tr('默认'), description: DEFAULT_HINT[agent] || '', vision: defModel?.vision };
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
const EFFORT_LABEL = { low: tr('低'), medium: tr('中'), high: tr('高'), xhigh: tr('超高'), max: tr('最高'), ultra: tr('极限') };
const EFFORT_HINT = {
  low: tr('最快，适合简单的事'),
  medium: tr('速度和深度兼顾'),
  high: tr('想得更深，适合复杂问题'),
  xhigh: tr('比「高」再深一档'),
  max: tr('最深，最难的问题用'),
  ultra: tr('最深，还会自动把任务拆给帮手'),
};

function effortsFor(agent, modelId) {
  const e = S.engines[AGENT_ENGINE[agent]] || {};
  if (baseOf(agent) === 'claude') return e.efforts || [];
  return e.models?.find((m) => m.id === (modelId || e.defaultModel))?.efforts || [];
}

function effortSelectHtml(agent, modelId, current, attrs = '') {
  const e = S.engines[AGENT_ENGINE[agent]] || {};
  const list = effortsFor(agent, modelId);
  // 没在设置里指定时，用的是模型自己的默认强度（Codex、DeepSeek 的模型目录里带着）
  const fallback = e.defaultEffort || e.models?.find((m) => m.id === (modelId || e.defaultModel))?.defaultEffort || '';
  const def = fallback ? tr('默认 · {label}', { label: EFFORT_LABEL[fallback] || fallback }) : tr('默认');
  const opts = [{ id: '', name: def, hint: tr('跟随自己的设置') }, ...list.map((id) => ({ id, name: EFFORT_LABEL[id] || id, hint: EFFORT_HINT[id] || '' }))];
  return `<select ${attrs}>${opts
    .map((o) => `<option value="${esc(o.id)}"${o.id === (current || '') ? ' selected' : ''} title="${esc(o.hint)}">${esc(o.name)}</option>`)
    .join('')}</select>`;
}

const CUSTOM_MODEL = '__custom__';

// ---------------- GPT 快速模式 ----------------
// Codex 的 Fast：官方文档（developers.openai.com/codex/speed）写的是按标准速度的 2.5 倍消耗订阅额度，另买的点数按 2 倍。
// 返回这个模型快多少倍（模型目录里写着「2x speed」这样的说明，没写倍数就是空字符串）；不支持快速模式返回 null
const BOLT_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M13.2 2.5 5.4 13.1c-.3.4 0 .9.5.9h5l-1.1 7.2c-.1.6.6.9 1 .4l7.8-10.6c.3-.4 0-.9-.5-.9h-5l1.1-7.2c.1-.6-.6-.9-1-.4z"/></svg>';
function fastSpeed(agent, modelId) {
  if (baseOf(agent) !== 'gpt') return null;
  const e = S.engines.codex || {};
  const desc = e.models?.find((m) => m.id === (modelId || e.defaultModel))?.fast;
  return desc ? desc.match(/([\d.]+)x speed/i)?.[1] || '' : null;
}

function confirmFast(speed) {
  return askConfirm({
    title: tr('打开 ChatGPT 快速模式？'),
    text: speed
      ? tr('快速模式下 ChatGPT 大约快 {speed} 倍，但会按标准速度的 2.5 倍消耗你 ChatGPT 订阅里的额度（另外买的点数按 2 倍算），额度会用得快很多。\n\n适合赶时间时临时打开，忙完记得切回「标准」。只对这个群的 ChatGPT 生效。', { speed })
      : tr('快速模式下 ChatGPT 会快一些，但会按标准速度的 2.5 倍消耗你 ChatGPT 订阅里的额度（另外买的点数按 2 倍算），额度会用得快很多。\n\n适合赶时间时临时打开，忙完记得切回「标准」。只对这个群的 ChatGPT 生效。'),
    ok: tr('打开快速模式'),
  });
}

// 通用的确认弹窗：点确认返回 true，取消、按 Esc 都返回 false
// 确认框：点主按钮返回 true，点 alt（第二个选择，可以不给）返回 'alt'，取消返回 false
function askConfirm({ title, text, ok, alt = '' }) {
  const dlg = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#btn-confirm-ok').textContent = ok;
  const altBtn = $('#btn-confirm-alt');
  altBtn.hidden = !alt;
  altBtn.textContent = alt;
  let answer = false;
  $('#btn-confirm-ok').onclick = (e) => {
    e.preventDefault();
    answer = true;
    closeDialog(dlg);
  };
  altBtn.onclick = () => {
    answer = 'alt';
    closeDialog(dlg);
  };
  $('#btn-confirm-cancel').onclick = () => closeDialog(dlg);
  dlg.showModal();
  reportDragRegions();
  return new Promise((resolve) =>
    dlg.addEventListener('close', () => {
      reportDragRegions();
      resolve(answer);
    }, { once: true }),
  );
}

// 带一个输入框的小弹窗（新建 / 重命名收纳组）：点确定返回输入的文字，取消、Esc 返回 null
function askText({ title, label, value = '', ok }) {
  const dlg = $('#dlg-text');
  $('#text-title').textContent = title;
  $('#text-label').textContent = label;
  $('#text-input').value = value;
  $('#btn-text-ok').textContent = ok;
  let answer = null;
  dlg.querySelector('form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#text-input').value.trim();
    if (!v) return void $('#text-input').focus();
    answer = v;
    closeDialog(dlg);
  };
  $('#btn-text-cancel').onclick = () => closeDialog(dlg);
  dlg.showModal();
  reportDragRegions();
  setTimeout(() => $('#text-input').select(), 30);
  return new Promise((resolve) =>
    dlg.addEventListener('close', () => {
      reportDragRegions();
      resolve(answer);
    }, { once: true }),
  );
}

function modelSelectHtml(agent, current, attrs = '', allowCustom = false) {
  const opts = modelOptions(agent);
  // 列表外的（手动填过的新模型）也显示出来
  const extra = current && !opts.some((o) => o.id === current) ? [{ id: current, name: tr('{name}（自定义）', { name: current }) }] : [];
  const custom = allowCustom ? `<option value="${CUSTOM_MODEL}">${tr('自定义模型…')}</option>` : '';
  return `<select ${attrs}>${[...opts, ...extra]
    .map((o) => `<option value="${esc(o.id)}"${o.id === (current || '') ? ' selected' : ''} title="${esc(o.description || '')}">${esc(o.name)}</option>`)
    .join('')}${custom}</select>`;
}

function avatarHtml(who, extra = '') {
  if (who === 'user') return `<span class="avatar av-user">${tr('我')}</span>`;
  const j = S.jointMembers?.[who]; // 联合群成员：对方成员右下角标对方老板
  if (j) {
    // 协议里给的是 agentId / engine，base 是旧字段；Codex 的 engine 叫 codex，头像用 gpt
    const base = j.agentId || j.base || (j.engine === 'codex' ? 'gpt' : j.engine) || 'claude';
    return j.mine
      ? `<span class="avatar av-${esc(baseOf(base))}" ${extra}></span>`
      : `<span class="avatar av-${esc(baseOf(base))} joint" data-owner="${esc(String(j.owner || '?').slice(0, 1))}" ${extra}></span>`;
  }
  const n = cloneInfo(who)?.n; // 多开的：用本体的头像，右下角标上几号
  return n ? `<span class="avatar av-${esc(baseOf(who))} clone" data-n="${n}" ${extra}></span>` : `<span class="avatar av-${esc(who)}" ${extra}></span>`;
}

// 让路径在「从右往左截断」的样式里保持原顺序
const ltr = (s) => `‎${s}‎`;

// ---------------- Markdown（够聊天用的精简版） ----------------

// 看起来像文件路径的：带 / 的，或者是常见的文件类型。这样的「`路径`」点一下在访达里显示，图片还能悬停看缩略图
const FILE_EXT = 'png|jpe?g|gif|webp|bmp|heic|svg|psd|ai|fig|sketch|pdf|md|txt|json|csv|tsv|xlsx?|docx?|pptx?|key|numbers|pages|html?|css|js|mjs|ts|tsx|jsx|vue|py|sh|swift|go|rs|java|kt|rb|php|sql|ya?ml|toml|xml|zip|mp4|mov|mp3|wav|log';
const FILE_RE = new RegExp(`^(?:~?/|\\.{1,2}/)?(?:[^\\s\`<>|*?"]+/)*[^\\s\`<>|*?"/]+\\.(?:${FILE_EXT}|[A-Za-z0-9]{1,6})$`, 'i');
const KNOWN_EXT_RE = new RegExp(`\\.(?:${FILE_EXT})$`, 'i');
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
// 文件夹：以 / 或 ~/ 开头、至少两级的绝对路径（比如 /Users/me/项目），或者以 / 结尾的相对路径（比如 output/）。
// 不带扩展名的相对路径不算，免得把 fix/web-download 这种分支名也当成路径
const ABS_PATH_RE = /^~?\/[^\s`<>|*?"]+\/[^\s`<>|*?"]*$/;
const REL_DIR_RE = /^[^\s`<>|*?"/]+(?:\/[^\s`<>|*?"/]+)*\/$/;
function looksLikeFile(s) {
  s = String(s || '').trim();
  return (FILE_RE.test(s) && (s.includes('/') || KNOWN_EXT_RE.test(s))) || ABS_PATH_RE.test(s) || REL_DIR_RE.test(s);
}

// 说不准是不是路径的：带 / 但没有扩展名（design-requests/dark-mode-art，也可能是分支名 fix/xxx），或者带中文的名字（现有图片(白底)）。
// 先按普通代码显示，问过服务端、项目里真有才变成能点的
const MAYBE_PATH_RE = /^[^\s`<>|*?"]{1,200}$/;
// 带中文的也当文件名（现有图片(白底)），但要长得像文件名：有斜杠、扩展名或者括号。
// 以前只要带中文就去问一遍，行内代码里的「代码」「参数」这种普通词也会被当成路径（每次问答都白花一次请求）
const NAMEY_RE = /[\\/._()（）]/;
function codeHtml(code) {
  const c = code.trim();
  if (looksLikeFile(c)) return `<code class="file-ref" data-path="${esc(c)}" title="${REVEAL_LABEL}">${esc(code)}</code>`;
  if (MAYBE_PATH_RE.test(c) && (c.includes('/') || NAMEY_RE.test(c)) && !/^[a-z]+:/i.test(c)) return `<code class="file-ref maybe" data-path="${esc(c)}">${esc(code)}</code>`;
  return `<code>${esc(code)}</code>`;
}

function inline(s) {
  // 行内代码先换成占位符，处理完别的再放回去：这样 **`文件名`** 这种粗体包着代码的也能认出来
  const codes = [];
  let h = esc(String(s).replace(/`[^`\n]+`/g, (m) => `\uE000${codes.push(m.slice(1, -1)) - 1}\uE001`));
  // 指向本机文件的链接，比如 [中文版](/Users/…/海报.png)：显示成文件链接，点一下在访达中显示，图片悬停看缩略图
  // （h 已经转义过：先还原成原文再解开 %20 这类编码，最后重新转义，免得 %22 解出来的引号跑进属性里）
  h = h.replace(/\[([^\]\n]+)\]\((?:file:\/\/)?((?:~|\.{1,2})?\/[^\s)\uE000]+|[^\s:/)\uE000]+\/[^\s)\uE000]+)\)/g, (_, text, p) => {
    let file = p.replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
    try {
      file = decodeURI(file);
    } catch {}
    return `<span class="file-ref" data-path="${esc(file)}" title="${tr('{label}：{file}', { label: REVEAL_LABEL, file: esc(file) })}">${text}</span>`;
  });
  h = h.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)\uE000]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/(^|[\s(（：:])(https?:\/\/[^\s<>()（）\uE000]*[^\s<>()（）.,;:!?。，；：！？'"\uE000])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // 只在标签外面高亮 @，免得改坏链接地址。@ 某一位：和输入框里一样，换成它的图标 + 名字；@所有人 照旧
  h = h
    .split(/(<[^>]+>)/g)
    .map((seg, j) =>
      j % 2 === 1
        ? seg
        : seg.replace(MENTION_MSG_RE, (_, pre, name) => {
            const who = MENTION_WHO[name.toLowerCase()];
            // 头像前面藏一个看不见的「@」：选中复制出去还是「@Claude」，不会只剩「Claude」
            return `${pre}<span class="mention${who ? ' has-icon' : ''}" data-who="${who || 'all'}">${who ? `<span class="mention-at-text">@</span>${avatarHtml(who)}` : '@'}${name}</span>`;
          }),
    )
    .join('');
  return h.replace(/\uE000(\d+)\uE001/g, (_, i) => codeHtml(codes[i]));
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

// AI 之间的私聊放在谁的私聊里：A 主动找 B 的整段对话（含 B 的回复）都在 B 的私聊里
function pmHome(m) {
  return m.pmIn || m.pm;
}

// 一条消息的「主场」（未读数、通知、搜索结果都记在这里）
function convOf(roomId, m) {
  return m.dm ? `d:${roomId}:${m.dm}` : m.pm ? `d:${roomId}:${pmHome(m)}` : `g:${roomId}`;
}

// 「Claude 私下找 DeepSeek」/ 被找的那位回话时是「DeepSeek 私下回 Claude」
function pmVerb(m) {
  return pmHome(m) === m.pm ? tr('私下找') : tr('私下回');
}

function currentConv() {
  const c = parseKey(S.current);
  const room = c && roomById(c.roomId);
  if (!room) return null;
  if (c.dm && (!room.members.includes(c.dm) || room.members.length < 2)) return null;
  return { ...c, room };
}

// 这条消息显示在不在这个会话里：AI 之间的私聊只显示在被找的那一位的私聊里
function inConv(conv, m) {
  if (m.pm) return !!conv.dm && pmHome(m) === conv.dm;
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
  { key: 'glm', name: 'GLM', agent: 'glm' },
  { key: 'gemini', name: 'Gemini', agent: 'gemini' },
  { key: 'grok', name: 'Grok Build', agent: 'grok' },
  { key: 'cursor', name: 'Cursor', agent: 'cursor' },
  { key: 'api', name: 'API', agent: 'api' },
];

function engineState(e, key) {
  if (!e) return tr('检测中…');
  if (key === 'gemini') {
    const cli = e.cli === 'agy' ? 'Antigravity CLI' : 'Gemini CLI';
    if (!e.path) return tr('要先装 {cli}', { cli });
    if (!e.ok) return e.error ? esc(e.error) : tr('没找到，请先安装');
    return `${esc(e.version || tr('已就绪'))}${e.authMode === 'api' ? tr(' · API Key 已填（{hint}）', { hint: esc(e.keyHint) }) : tr(' · 用 Antigravity 订阅')}`;
  }
  if (key === 'grok') {
    // Grok 用的是账号登录：没登录、或者配置里给模型单独配了 API Key（运行时会隔离，不会拿它计费）都要说清楚
    if (!e.path) return tr('没找到，请先安装 Grok Build');
    if (!e.ok && e.error) return esc(e.error);
    const v = esc(e.version || tr('已就绪'));
    if (e.loggedIn === false) return `${v} · ${tr('没登录 Grok 账号（在终端运行 grok login）')}`;
    return `${v}${e.apiKeyWarning ? ` · ${tr('API 配置已隔离')}` : ''}`;
  }
  if (key === 'cursor') {
    // Cursor 也是账号登录：装好、登录以后才有模型列表
    if (!e.path) return tr('没找到，请先安装 Cursor CLI');
    if (e.loggedIn === false) return `${e.version ? `${esc(e.version)} · ` : ''}${tr('没登录 Cursor 账号（在终端运行 cursor-agent login）')}`;
    if (!e.ok) return e.error ? esc(e.error) : tr('没找到，请先安装 Cursor CLI');
    return esc(e.version || tr('已就绪'));
  }
  if (key === 'api') {
    // API 是「填一个 OpenAI 兼容平台的地址和 Key」：两样都填好、平台也连得上才算能用
    if (!e.hasKey) {
      if (S.engines.claude && !S.engines.claude.path) return tr('要先装 Claude Code，再填接口地址和 API Key');
      return e.base ? tr('地址已填，还差 API Key') : tr('还没填接口地址和 API Key');
    }
    if (!e.base) return tr('还没填接口地址');
    if (!e.ok) return e.keyError ? esc(e.keyError) : tr('连不上这个平台，检查一下地址和 Key');
    const host = String(e.base || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return `${host ? esc(host) : tr('已填')}${e.models?.length ? ` · ${tr('{n} 个模型', { n: e.models.length })}` : ''}`;
  }
  if (BYOK[key]) return !e.path ? tr('要先装 Claude Code') : !e.hasKey ? tr('还没填 API Key') : e.ok ? tr('API Key 已填（{hint}）', { hint: esc(e.keyHint) }) : tr('API Key 不对');
  if (e.ok && e.loggedIn === false) return `${esc(e.version || '')} · ${key === 'claude' ? tr('没登录 Claude 账号（DeepSeek、GLM 照样能借它干活）') : tr('没登录 ChatGPT 账号')}`;
  if (!e.ok && e.error) return esc(e.error); // 比如 Codex 太旧：说清楚要升级，别写成「没找到」
  return e.ok ? esc(e.version || tr('已就绪')) : tr('没找到，请先安装并登录');
}

// 程序状态：侧栏底部两个小点、欢迎页一行字、设置里的「程序与模型」
// ---------------- 没装 Claude Code：说明哪几位要借它干活，用户点了就帮他装 ----------------
// Claude、DeepSeek、GLM 都要借 Claude Code（DeepSeek、GLM 只借它的工具，不用登录 Claude 账号）
const NEEDS_CLAUDE_CODE = ['claude', 'deepseek', 'glm', 'api'];
const needsClaudeCode = (a) => NEEDS_CLAUDE_CODE.includes(baseOf(a));
const claudeMissing = () => !!S.engines.claude && !S.engines.claude.path;

// 各家的命令行：装的什么、登录要跑什么命令（登录由服务端在电脑上跑，浏览器会自己打开）
const INSTALL_NAMES = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build', cursor: 'Cursor CLI' };
const LOGIN_NAMES = { codex: 'ChatGPT', grok: 'Grok', cursor: 'Cursor' };
const CAN_INSTALL = ['claude', 'codex', 'grok', 'cursor'];
// 登录是在电脑上打开浏览器：手机上点了没用，所以只在电脑上显示登录按钮。
// 判断的是「页面是不是在这台电脑上打开的」（127.0.0.1 / localhost），不按窗口宽度：
// 手机横过来比 600 宽，但它是经 Tailscale 连进来的，地址不是本机，照样不显示。

function installButtonHtml(cls, engine = 'claude') {
  const name = INSTALL_NAMES[engine] || engine;
  const busy = !!S.installing[engine];
  return `<button class="${cls}" data-install="${esc(engine)}"${busy ? ' disabled' : ''}>${busy ? tr('正在安装 {name}…', { name }) : tr('安装 {name}', { name })}</button>`;
}

function refreshInstallButtons() {
  document.querySelectorAll('[data-install]').forEach((b) => (b.outerHTML = installButtonHtml(b.className, b.dataset.install)));
}

// 帮用户装一个程序：用各家官方的安装脚本，装在用户自己的目录里，不用管理员密码
async function installEngineUI(engine) {
  const name = INSTALL_NAMES[engine] || engine;
  if (S.installing[engine] || S.engines[engine]?.path) return;
  S.installing[engine] = true;
  refreshInstallButtons();
  renderEngines();
  toast(tr('正在安装 {name}（官方的安装程序），大概要一两分钟…', { name }), 8000);
  try {
    const res = await api('POST', '/api/engines/install', { engine });
    S.engines = res.engines || S.engines;
    // 刚装好、还没登录时服务端会自动打开一次登录页（只在电脑本机上）：像点了「登录」那样把网址接过来
    const login = res.login;
    if (res.ok && login?.url) S.loginLinks[engine] = { url: login.url, code: login.code || '' };
    toast(
      !res.ok
        ? tr('{name} 没装上：{output}', { name, output: res.output || tr('未知错误') })
        : engine === 'claude'
          ? tr('Claude Code 装好了：DeepSeek、GLM 现在就能干活。要用 Claude 的话，还要在终端运行一次 claude 登录 Claude 账号。')
          : login?.url
            ? tr('{name} 装好了，已经在电脑上打开浏览器：登录以后这里会自动变成已就绪。', { name })
            : login?.ok
              ? tr('{name} 装好了，登录窗口也打开了：按里面的提示操作就行。', { name })
              : login
                ? tr('{name} 装好了，但登录页没能自动打开：{error}。点旁边的「登录」再试一次。', { name, error: login.error || tr('没有说明原因') })
                : tr('{name} 装好了：点旁边的「登录」，在打开的浏览器里登录一下就能用。', { name }),
      res.ok ? 9000 : 12000,
    );
  } catch (err) {
    toast(err.message, 8000);
  } finally {
    S.installing[engine] = false;
    renderEngines();
    renderShell();
    refreshInstallButtons();
    if ($('#dlg-room')?.open) {
      updateMemberStates();
      syncMemberFields(); // 刚装好 / 状态变了，建群提示里的「要装…」跟着更新
    }
  }
}

const installClaudeCode = () => installEngineUI('claude');

// 帮用户登录：服务端在电脑上跑官方的登录命令，它自己会打开浏览器；打印出来的网址我们也记下来，
// 浏览器没自动打开时界面上有链接可以点。凭证由官方命令行自己保存，ClawChat 不经手
async function loginEngineUI(engine) {
  if (S.loggingIn[engine]) return;
  const name = LOGIN_NAMES[engine] || engine;
  S.loggingIn[engine] = true;
  renderEngines();
  try {
    const res = await api('POST', '/api/engines/login', { engine });
    S.engines = res.engines || S.engines;
    if (res.ok && res.url) {
      S.loginLinks[engine] = { url: res.url, code: res.code || '' };
      toast(tr('已经在电脑上打开浏览器：用你的 {name} 账号登录，登完这里会自动变成已就绪。', { name }), 9000);
    } else if (res.ok && res.done) {
      toast(tr('{name} 登录好了。', { name }), 5000);
    } else if (res.ok) {
      toast(tr('已经打开 {name} 的登录窗口，按里面的提示操作就行。', { name }), 9000);
    } else {
      toast(res.error || tr('登录没有开始，可以再点一次。'), 8000);
    }
  } catch (err) {
    toast(err.message, 8000);
  } finally {
    S.loggingIn[engine] = false;
    renderEngines();
  }
}

// 主动问一次要不要装：启动时检测到没装（问过一次、用户说以后再说就不再自动问）；
// 填了 DeepSeek / GLM 的 Key、建了要借它的成员的群时，不管问没问过都再问一次
async function offerClaudeCode(reason = 'start', who = []) {
  if (!claudeMissing() || S.installing.claude || S.offeringInstall) return;
  if (reason === 'start' && storeGet('clawchat.claudeCodeAsked')) return;
  if (reason === 'start' && $('dialog[open]')) return; // 启动时别的窗口开着就先不打扰；填完 Key（设置窗口还开着）、建完群时照样问，确认框盖在上面
  S.offeringInstall = true;
  storeSet('clawchat.claudeCodeAsked', '1');
  const names = (who.length ? who : NEEDS_CLAUDE_CODE).map(agentName).join(LIST_SEP);
  const ok = await askConfirm({
    title: tr('这台电脑还没装 Claude Code'),
    text: tr('Claude Code 是 {names} 干活必需的（DeepSeek、GLM 只借它的工具，不用登录 Claude 账号）。没装的话，在群里就用不了。现在帮你装上吗？会用 Anthropic 官方的安装程序，装在你自己的用户目录里，不用管理员密码，大概一两分钟。', { names }),
    ok: tr('帮我安装'),
  });
  S.offeringInstall = false;
  if (ok === true) installClaudeCode();
}

// 这台电脑上能用的成员：程序装好了、登录了（DeepSeek、GLM 要填 Key）。还在检测时都算能用
function memberReady(a) {
  const b = baseOf(a);
  const E = S.engines;
  if (!Object.keys(E).length) return true;
  if (b === 'claude') return !!E.claude?.path && E.claude.loggedIn !== false;
  if (b === 'gpt') return !!E.codex?.path && E.codex.ok !== false && E.codex.loggedIn !== false;
  if (b === 'grok') return !!E.grok?.path && E.grok.ok !== false && E.grok.loggedIn !== false;
  if (b === 'cursor') return !!E.cursor?.path && E.cursor.ok !== false && E.cursor.loggedIn !== false;
  if (b === 'api') return !!E.api?.ok;
  return !!E[b]?.ok;
}

// 成员表变了（多开了一位、删了一位）：AGENT_IDS、@ 识别、@ 菜单、群设置里的勾选框和模型行跟着变
function rebuildMembers() {
  // 已经开出来的（服务端成员表）加上还在等保存的（群设置里刚点出来的）
  const clones = [...new Set([...Object.keys(S.agents || {}).filter((a) => S.agents[a].base), ...PENDING_CLONES])];
  AGENT_IDS = BASE_IDS.flatMap((b) => [b, ...clones.filter((a) => baseOf(a) === b).sort((x, y) => (cloneInfo(x)?.n || 0) - (cloneInfo(y)?.n || 0))]);
  buildMentionRes();
  buildMentionItems();
  syncCloneFields();
}

// 页面里写死的是五位本体的勾选框、模型行、@ 按钮；多开的按需补在本体后面，删掉的就拿掉
function syncCloneFields() {
  const form = $('#room-form');
  if (!form) return;
  // 已经开出来的、还有等保存的，都留着；其余（被清掉的多开成员）把卡片、模型行、@ 按钮拿掉
  const keep = (id) => !!(S.agents[id] || PENDING_CLONES.has(id));
  form.querySelectorAll('[data-clone]').forEach((el) => !keep(el.dataset.clone) && el.remove());
  document.querySelectorAll('.mention-chip[data-who]').forEach((el) => !keep(el.dataset.who) && el.remove());
  for (const a of AGENT_IDS) {
    const info = S.agents[a] || cloneInfo(a);
    if (!info?.base) continue;
    const name = agentName(a);
    const sub = esc(tr('{name} 的 {n} 号', { name: agentName(info.base), n: info.n }));
    if (!formField(fieldName('member', a))) {
      const after = [...form.querySelectorAll('.members .member')].filter((el) => baseOf(el.dataset.clone || el.querySelector('input').name.slice(6).toLowerCase()) === info.base).at(-1);
      after?.insertAdjacentHTML('afterend', `<label class="member" data-clone="${esc(a)}"><input type="checkbox" name="${fieldName('member', a)}">${avatarHtml(a)}<span class="member-name">${esc(name)}<small>${sub}</small></span><span class="check-mark"></span></label>`);
    }
    if (!$(`#field-model-${a}`)) {
      const after = [...form.querySelectorAll('#model-fields .form-row')].filter((el) => baseOf(el.id.replace('field-model-', '')) === info.base).at(-1);
      after?.insertAdjacentHTML(
        'afterend',
        `<div class="form-row" id="field-model-${esc(a)}" data-clone="${esc(a)}"><span class="with-icon">${avatarHtml(a)}${esc(name)}</span><span class="model-pair"><select name="${fieldName('model', a)}" data-pair="${esc(a)}"></select><span class="pair-sep">${tr('思考')}</span><select name="${fieldName('effort', a)}"></select></span></div>`,
      );
    }
    if (!document.querySelector(`.mention-chip[data-who="${a}"]`)) {
      const after = [...document.querySelectorAll('.mention-chip')].filter((el) => (el.dataset.who ? baseOf(el.dataset.who) : { Claude: 'claude', ChatGPT: 'gpt', DeepSeek: 'deepseek', GLM: 'glm', Gemini: 'gemini', Grok: 'grok', Cursor: 'cursor', API: 'api' }[el.dataset.mention]) === info.base).at(-1);
      after?.insertAdjacentHTML('afterend', `<button class="chip mention-chip" data-mention="${esc(name)}" data-who="${esc(a)}" title="@${esc(name)}">${avatarHtml(a)}<span class="chip-name">@${esc(name)}</span></button>`);
      const chip = document.querySelector(`.mention-chip[data-who="${a}"]`);
      if (chip) chip.onclick = () => insertMention(name);
    }
  }
}

function renderEngines() {
  // 侧栏底部：一切正常时什么都不显示；有聊天用到的程序找不到（或者 DeepSeek 没填 Key）才亮一个黄色提醒
  const used = new Set(S.rooms.flatMap((r) => r.members.map(baseOf)));
  const missing = ENGINE_INFO.filter(({ key, agent }) => S.engines[key] && !S.engines[key].ok && used.has(agent)).map(({ name }) => name);
  const warn = $('#engine-warn');
  warn.hidden = !missing.length;
  warn.textContent = missing.length ? tr('{names} 还不能用', { names: missing.join(LIST_SEP) }) : '';
  warn.title = missing.length ? tr('打开设置看详情') : '';
  $('#welcome-engines').innerHTML = ENGINE_INFO.map(({ key, name }) => {
    const e = S.engines[key];
    return `<div class="engine"><span class="dot ${e ? (e.ok ? 'ok' : 'bad') : ''}"></span>${tr('{name}：{state}', { name, state: engineState(e, key) })}</div>`;
  }).join('');
  const maker = { claude: 'Anthropic', codex: 'OpenAI', deepseek: tr('深度求索 · 借 Claude Code 干活'), glm: tr('智谱 · 借 Claude Code 干活'), gemini: `Google · ${S.engines.gemini?.cli === 'agy' ? 'Antigravity' : 'Gemini CLI'}`, grok: 'xAI', cursor: 'Anysphere', api: tr('API 平台 · 借 Claude Code 干活') };
  // 登录完成了（或者换了程序）：之前留下的登录网址收起来
  for (const k of Object.keys(S.loginLinks)) {
    const en = S.engines[k];
    if (!en?.path || en.loggedIn !== false) delete S.loginLinks[k];
  }
  $('#set-engines').innerHTML = ENGINE_INFO.map(({ key, name, agent }) => {
    const e = S.engines[key];
    const installed = !!e?.path;
    const loggedOut = installed && e?.loggedIn === false;
    const busyLogin = !!S.loggingIn[key];
    const link = S.loginLinks[key];
    const bad = key === 'api'
      ? !e?.hasKey
        ? tr('没填 Key')
        : !e?.base
          ? tr('没填地址')
          : tr('连不上')
      : BYOK[key]
        ? !installed
          ? tr('缺 Claude Code')
          : !e?.hasKey
            ? tr('没填 Key')
            : tr('Key 不对')
        : !installed
        ? tr('没找到')
        : loggedOut
          ? tr('没登录')
          : e?.error
            ? tr('版本太旧')
            : tr('还没配好');
    const status = !e
      ? `<span class="status">${tr('检测中…')}</span>`
      : e.ok && !loggedOut
        ? `<span class="status ok">${tr('已就绪')}</span>`
        : busyLogin || link
          ? `<span class="status wait">${tr('等待登录…')}</span>`
          : `<span class="status bad">${bad}</span>`;
    // 没装：给「安装」；装了没登录：给「登录」（登录是在电脑上开浏览器，手机上不显示）；都好了：给「更新」
    // DeepSeek、GLM 用的是 Claude Code，安装按钮装的是 Claude Code，更新放在 Claude Code 那一行
    let action = '';
    if (CAN_INSTALL.includes(key) && !installed) action = installButtonHtml('secondary', key);
    else if (BYOK[key] && !installed) action = installButtonHtml('secondary', 'claude');
    else if (loggedOut && LOGIN_NAMES[key] && isLocalHost()) action = `<button class="secondary engine-login" data-login="${key}"${busyLogin ? ' disabled' : ''}>${busyLogin ? tr('等待登录…') : tr('登录')}</button>`;
    else if (installed && !loggedOut && !BYOK[key] && key !== 'gemini' && key !== 'api') action = `<button class="secondary engine-update" data-engine="${key}">${tr('更新')}</button>`;
    // 浏览器没自动打开时：官方命令打印出来的登录网址（有验证码的话一起显示）
    const extra = link && loggedOut
      ? `<small class="engine-login-hint">${link.code ? `${tr('验证码 {code} · ', { code: esc(link.code) })}` : ''}<a href="${esc(link.url)}" target="_blank" rel="noopener">${tr('浏览器没打开？点这里')}</a></small>`
      : '';
    return `<div class="list-row">${avatarHtml(agent)}<span class="row-text"><b>${name}</b><small>${maker[key]} · ${engineState(e, key)}</small>${extra}</span>${status}${action}</div>`;
  }).join('');
  // Grok 的登录状态和计费说明：登录过期、配置里有 API Key 都要提醒
  const gnote = $('#grok-note');
  if (gnote) {
    const g = S.engines.grok;
    const lines = [];
    if (g) {
      if (!g.path) lines.push(tr('没找到 Grok Build。装好以后在终端运行 grok login，用你订阅的那个账号登录。'));
      else if (g.loggedIn === false) lines.push(tr('Grok 还没登录：在终端运行 grok login，用你订阅的那个账号登录。'));
      if (g.apiKeyWarning) lines.push(String(g.apiKeyWarning)); // 服务端已经翻好的提示（配置里给模型配了 API Key，运行时已经隔离，不会拿它计费）
      if (g.path) lines.push(tr('Grok 用的是账号自带的免费或订阅额度，不会另外按 API 计费。想确保订阅之外不花钱，到 grok.com 关掉自动充值和额外用量。'));
    }
    gnote.hidden = !lines.length;
    gnote.innerHTML = lines.map((x) => esc(x)).join('<br>');
  }
  for (const id of KEY_TARGETS) {
    const e = S.engines[id];
    const el = $(`#${id}-status`);
    if (!el) continue;
    el.className = `hint${e?.keyError && e.hasKey ? ' error' : ''}`;
    el.textContent = !e
      ? ''
      : e.hasKey
        ? e.keyError
          ? tr('已填：{hint}（{error}）。要换就填新的再点保存；清空后保存就是删掉。', { hint: e.keyHint, error: e.keyError })
          : tr('已填：{hint}。要换就填新的再点保存；清空后保存就是删掉。', { hint: e.keyHint })
        : id === 'gemini'
          ? e.path
            ? tr('没填 Key：正在用 Antigravity 订阅，消耗的是订阅额度，用完要等恢复。想改用 API 就填 Gemini API Key。')
            : tr('没填 Key：走订阅要先装 Antigravity CLI（agy）；也可以在这里填 Gemini API Key，按用量计费。')
          : tr('还没填。填好后，新建聊天时勾上 {name} 就能用了。', { name: agentName(id) });
  }
  // API：地址 + Key，单独一节
  const api = S.engines.api;
  const apiStatus = $('#api-status');
  if (apiStatus) {
    apiStatus.className = `hint${api?.hasKey && !api.ok ? ' error' : ''}`;
    apiStatus.textContent = !api
      ? ''
      : !api.hasKey
        ? api.base
          ? tr('地址已填：{base}。还差 API Key，填好再点保存。', { base: api.base })
          : tr('还没填。填好后，新建聊天时勾上 API 就能用了。')
        : !api.ok
          ? !api.base
            ? tr('还没填接口地址：填好再点保存。')
            : tr('Key 不对或者连不上：{error}。检查一下接口地址和 Key，再点保存。', { error: api.keyError || tr('没有说明原因') })
          : tr('已填：{base}（{n} 个模型）。要换地址或 Key，改完再点保存；清空接口地址后保存就是删掉。', { base: api.base || '', n: (api.models || []).length });
    const baseEl = $('#api-base');
    if (baseEl && document.activeElement !== baseEl) baseEl.value = api?.base || '';
  }
  $('#set-models').innerHTML = ENGINE_INFO.map(({ agent }) => {
    const opts = modelOptions(agent).filter((o) => o.id); // 「默认」单独说明，这里只列模型
    const eng = S.engines[AGENT_ENGINE[agent]] || {};
    const def = eng.defaultLabel || (eng.defaultModel ? modelLabel(eng.defaultModel) : tr('默认'));
    // 模型多的（平台的 API 有二十几个）只列前 12 个，后面收成「+N」，鼠标停上去看全部
    const shown = opts.slice(0, 12);
    const pills = shown.map((o) => `<span class="model-pill" title="${esc(o.description || '')}">${esc(o.name)}</span>`).join('') +
      (opts.length > shown.length ? `<span class="model-pill more" title="${esc(opts.slice(shown.length).map((o) => o.name).join('、'))}">+${opts.length - shown.length}</span>` : '');
    // API 还没填地址和 Key 时模型列表是空的：别显示「默认用 默认」
    const empty = agent === 'api' && !eng.hasKey;
    return `<div class="list-row top">${avatarHtml(agent)}<span class="row-text"><b>${agentName(agent)}</b><small>${empty ? tr('还没填接口地址和 API Key') : tr('默认用 {model}', { model: esc(def) })}</small>
      ${empty ? '' : `<span class="model-list">${pills}</span>`}</span></div>`;
  }).join('');
  // 欢迎页「和 XX 单聊」：这台电脑上用不了的（没装、没登录、没填 Key）不出现
  document.querySelectorAll('[data-solo]').forEach((b) => (b.hidden = !memberReady(b.dataset.solo)));
}

// ---------------- 订阅用量（设置 → 程序与模型最上面） ----------------
// 数据是 Claude Code / Codex 自己带回来的最近一次额度；DeepSeek、GLM 走 API，不显示。
const USAGE_AGENTS = [
  { agent: 'claude', key: 'claude' },
  { agent: 'gpt', key: 'codex' },
  { agent: 'gemini' },
  { agent: 'grok' },
];

function usagePlanName(plan) {
  const known = { plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', free: 'Free', edu: 'Edu', max: 'Max' };
  return known[String(plan || '').toLowerCase()] || String(plan || '');
}

function usageWindowName(w) {
  if (w.key === 'five_hour') return tr('5 小时');
  if (w.key === 'seven_day') return tr('本周');
  if (w.key === 'seven_day_opus') return tr('本周 Opus');
  if (w.key === 'seven_day_sonnet') return tr('本周 Sonnet');
  // Anthropic 后来加的「本周额度（含另外买的超额部分）」
  if (w.key === 'seven_day_overage_included') return tr('本周（含超额）');
  const minutes = Number(w.windowMinutes) || (/^\d+m$/.test(w.key) ? Number(w.key.slice(0, -1)) : 0);
  if (minutes) return tr('{n} 分钟', { n: minutes });
  // 以后官方再加不认识的窗口：别把英文原名直接摆给老板看
  return tr('其他额度');
}

function usagePercentText(pct) {
  const n = Number(pct) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function usageResetText(ms) {
  if (!ms) return '';
  const left = ms - Date.now();
  if (left <= 0) return tr('即将重置');
  const minutes = Math.ceil(left / 60000);
  if (minutes < 60) return tr('{n} 分钟后重置', { n: minutes });
  if (minutes < 24 * 60) return tr('{h} 小时 {m} 分钟后重置', hourMin(minutes));
  return tr('{n} 天后重置', { n: Math.ceil(left / 86400000) });
}

function usageAgo(ms) {
  if (!ms) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (minutes < 1) return tr('刚刚更新');
  if (minutes < 60) return tr('{n} 分钟前更新', { n: minutes });
  return minutes < 24 * 60 ? tr('{h} 小时 {m} 分钟前更新', hourMin(minutes)) : tr('{n} 天前更新', { n: Math.round(minutes / 60 / 24) });
}

function usageRowHtml(agent, key) {
  const d = key ? S.usage?.[key] : null;
  const plan = d?.plan ? `<span class="usage-plan">${esc(usagePlanName(d.plan))}</span>` : '';
  const head = `<div class="list-row top usage-row">${avatarHtml(agent)}<span class="row-text"><span class="usage-name"><b>${esc(agentName(agent))}</b>${plan}</span>`;
  if (!key) return `${head}<small class="usage-empty">${tr('暂时看不到余量')}</small></span></div>`;
  const credits = d?.credits;
  const windows = (Array.isArray(d?.windows) ? [...d.windows] : []).sort((a, b) => {
    const order = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
    const ia = order.indexOf(a.key);
    const ib = order.indexOf(b.key);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  if (!windows.length && !credits) return `${head}<small class="usage-empty">${tr('还没跑过，跑一轮后显示')}</small></span></div>`;
  const bars = windows
    .map((w) => {
      // 重置时间已经过了：下一次跑之前就按 0 显示，别一直挂着「已用 100%」
      const expired = !!w.resetsAt && w.resetsAt <= Date.now();
      const pct = expired ? 0 : Math.max(0, Math.min(100, Number(w.usedPercent) || 0));
      const level = pct >= 100 ? ' bad' : pct >= 80 ? ' warn' : '';
      const reset = expired ? tr('已重置') : usageResetText(w.resetsAt);
      return `<span class="usage-window"><span class="usage-window-head"><span class="usage-label">${esc(usageWindowName(w))}</span><span class="usage-pct${level}">${esc(tr('已用 {pct}%', { pct: usagePercentText(pct) }))}</span>${reset ? `<span class="usage-reset">· ${esc(reset)}</span>` : ''}</span><span class="usage-bar${level}"><i style="width:${pct.toFixed(1)}%"></i></span></span>`;
    })
    .join('');
  let extra = '';
  if (credits) {
    const text = credits.unlimited
      ? tr('额外点数不限')
      : credits.balance !== null && credits.balance !== undefined && Number.isFinite(Number(credits.balance))
        ? tr('额外点数余额 {n}', { n: Math.round(Number(credits.balance)) })
        : credits.hasCredits
          ? tr('还有额外点数')
          : tr('额外点数已用完');
    extra = `<small class="usage-credits">${esc(text)}</small>`;
  }
  const ago = usageAgo(d?.updatedAt);
  return `${head}<span class="usage-windows">${bars}</span>${extra}${ago ? `<small class="usage-updated">${esc(ago)}</small>` : ''}</span></div>`;
}

function renderUsage() {
  const box = $('#usage-list');
  if (!box) return;
  const title = $('#usage-title');
  if (title) title.textContent = tr('订阅用量');
  const hint = $('#usage-hint');
  if (hint) hint.textContent = tr('数字是 AI 最近一次干活时官方工具带回来的；DeepSeek、GLM 按 API 收费，不显示余量。');
  box.innerHTML = USAGE_AGENTS.map(({ agent, key }) => usageRowHtml(agent, key)).join('');
}

async function refreshUsage() {
  try {
    S.usage = (await api('GET', '/api/usage?refresh=1')) || {}; // 打开时顺便现读一次 ChatGPT 的余量
    renderUsage();
  } catch {}
}

function convAvatar(c) {
  if (c.dm) return `<div class="conv-avatar">${avatarHtml(c.dm)}</div>`;
  if (c.room.members.length === 1) return `<div class="conv-avatar">${avatarHtml(c.room.members[0])}</div>`;
  // 两位斜着摆，三位品字形，四位四宫格；五位以上放前三位，第四格写还有几位
  const n = c.room.members.length;
  if (n >= 4) {
    const shown = n > 4 ? c.room.members.slice(0, 3) : c.room.members;
    const more = n > 4 ? `<span class="avatar av-more">+${n - 3}</span>` : '';
    return `<div class="conv-avatar stack quad">${shown.map((a) => avatarHtml(a)).join('')}${more}</div>`;
  }
  return `<div class="conv-avatar stack${n > 2 ? ' three' : ''}">${c.room.members.map((a) => avatarHtml(a)).join('')}</div>`;
}

function convItemHtml(c, extra = {}) {
  const busy = S.runs
    .filter((x) => runInConv(x, c))
    .map((x) => (x.side ? tr('{name} 分身', { name: agentName(x.agent) }) : agentName(x.agent)))
    .join(LIST_SEP);
  const last = c.last;
  const who = last?.pm ? tr('{name}：', { name: `${agentName(last.from)} → ${agentName(last.pm)}` }) : last && !(last.from === 'user' || c.dm || c.room.members.length === 1) ? tr('{name}：', { name: agentName(last.from) }) : '';
  const lastText = last ? who + last.text.replace(/\s+/g, ' ') : '';
  const preview = busy ? `<span class="busy">${esc(tr('{names} 正在干活…', { names: busy }))}</span>` : last ? esc(lastText) : c.dm ? tr('私聊') : tr('还没有消息');
  const unread = (S.unread.get(c.key) || 0) + (extra.hiddenUnread || 0);
  const toggle = extra.dmCount
    ? `<button class="disclosure${extra.open ? ' open' : ''}" data-toggle="${esc(c.room.id)}" title="${extra.open ? tr('收起私聊（{n}）', { n: extra.dmCount }) : tr('展开私聊（{n}）', { n: extra.dmCount })}" aria-label="${extra.open ? tr('收起私聊') : tr('展开私聊')}">
        <svg viewBox="0 0 10 10" width="9" height="9"><path d="M3.2 1.8 6.6 5 3.2 8.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
    : '';
  const name = c.dm ? `${agentLabel(c.dm)}<span class="dm-tag">${tr('私聊')}</span>` : esc(convTitle(c));
  const drag = extra.drag ? ` draggable="true" data-drag-scope="${esc(extra.drag.scope)}" data-drag-key="${esc(extra.drag.key)}"` : '';
  return `<li class="conv-item${c.dm ? ' child' : ''}${extra.dmCount ? ' has-children' : ''}${extra.inFolder ? ' in-folder' : ''}${c.key === S.current ? ' active' : ''}" data-key="${esc(c.key)}"${extra.inFolder ? ` data-parent-folder="${esc(extra.folderId)}"` : ''}${drag}>
    ${toggle}${convAvatar(c)}
    <div class="conv-meta">
      <div class="conv-line"><span class="name">${name}</span><span class="time">${last ? fmtShort(last.ts) : ''}</span></div>
      <div class="conv-line"><span class="conv-preview">${preview}</span>${unread ? `<span class="unread">${unread > 99 ? '99+' : unread}</span>` : ''}</div>
    </div></li>`;
}

// ---------------- 收纳组（侧栏） ----------------
// 收纳组只是把几个群在侧栏里收在一起，群的项目文件夹、成员和记忆都不变。
// 组和群排在同一层，按组里最近的动静排序；展开以后组里的群（连同它们的私聊）缩进显示
const collapsedFolders = new Set((() => {
  try {
    return JSON.parse(storeGet('clawchat.folderCollapsed') || '[]');
  } catch {
    return [];
  }
})());

// 组里最新的一条消息（群消息和群里的私聊都算）
function folderLatest(list) {
  let best = null;
  for (const e of list) {
    const cands = [{ last: e.group.last, conv: e.group }];
    for (const d of e.dms) cands.push({ last: d.last, conv: d });
    for (const c of cands) if (c.last && (!best || c.last.ts > best.last.ts)) best = c;
  }
  return best;
}

// 这条消息在侧栏里怎么写：AI 之间私聊写「A → B：」，群里 AI 说的话前面带名字，老板说的不带
function lastLine(last, conv) {
  if (!last) return '';
  const who = last.pm ? tr('{name}：', { name: `${agentName(last.from)} → ${agentName(last.pm)}` }) : !(last.from === 'user' || conv.dm || conv.room?.members?.length === 1) ? tr('{name}：', { name: agentName(last.from) }) : '';
  return who + String(last.text || '').replace(/\s+/g, ' ');
}

function folderIt(container, open) {
  const { folder, list } = container;
  const unread = list.reduce((n, e) => n + (S.unread.get(e.group.key) || 0) + e.dms.reduce((m, d) => m + (S.unread.get(d.key) || 0), 0), 0);
  // 第二行开头写清楚是组里哪个聊天，免得看成是别的聊天里的：组里只有一个群，就写「群聊」或「私聊 某某」；
  // 好几个群，写群名或「群名 · 私聊 某某」
  const one = list.length === 1;
  const source = (c) =>
    c.dm
      ? one
        ? tr('私聊 {name}', { name: agentName(c.dm) })
        : tr('{room} · 私聊 {name}', { room: c.room.name, name: agentName(c.dm) })
      : one
        ? tr('群聊')
        : c.room.name;
  const busyRuns = S.runs
    .map((x) => ({ run: x, conv: list.flatMap((e) => [e.group, ...e.dms]).find((c) => runInConv(x, c)) }))
    .filter((b) => b.conv);
  const latest = folderLatest(list);
  let tag = '';
  let preview = '';
  if (busyRuns.length) {
    // 好几个聊天都有人在干活：写最先开工的那个聊天，后面的人名照列
    tag = source(busyRuns[0].conv);
    const names = [...new Set(busyRuns.map((b) => (b.run.side ? tr('{name} 分身', { name: agentName(b.run.agent) }) : agentName(b.run.agent))))];
    preview = `<span class="busy">${esc(tr('{names} 正在干活…', { names: names.join(LIST_SEP) }))}</span>`;
  } else if (latest) {
    tag = source(latest.conv);
    preview = esc(lastLine(latest.last, latest.conv));
  }
  return `<li class="conv-item folder has-children${open ? ' open' : ''}" data-folder="${esc(folder.id)}" draggable="true" data-drag-scope="top" data-drag-key="f:${esc(folder.id)}">
    <button class="disclosure${open ? ' open' : ''}" data-folder-toggle="${esc(folder.id)}" title="${open ? tr('收起收纳组') : tr('展开收纳组')}" aria-label="${open ? tr('收起收纳组') : tr('展开收纳组')}">
      <svg viewBox="0 0 10 10" width="9" height="9"><path d="M3.2 1.8 6.6 5 3.2 8.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    ${folderAvatar(folder)}
    <div class="conv-meta">
      <div class="conv-line"><span class="name folder-name">${esc(folder.name)}<span class="folder-count">${list.length}</span></span><span class="time">${latest ? fmtShort(latest.last.ts) : ''}</span></div>
      <div class="conv-line">${tag ? `<span class="tag folder-src" title="${esc(tag)}">${esc(tag)}</span>` : `<span class="conv-preview">${list.length ? tr('还没有消息') : tr('还没有群')}</span>`}<span class="conv-preview">${preview}</span>${unread ? `<span class="unread">${unread > 99 ? '99+' : unread}</span>` : ''}</div>
    </div></li>`;
}

// 一个群连同它的私聊；在收纳组里就缩进
function roomItemsHtml({ group, dms }, inFolder = false, folderId = null) {
  const id = group.room.id;
  const open = !collapsed.has(id); // 正在看其中一个私聊也照样能收起（打开它的时候 openConv 会先展开）
  const hiddenUnread = open ? 0 : dms.reduce((n, d) => n + (S.unread.get(d.key) || 0), 0);
  const drag = inFolder ? { scope: `f:${folderId}`, key: id } : { scope: 'top', key: `r:${id}` };
  const out = [convItemHtml(group, { dmCount: dms.length, open, hiddenUnread, inFolder, folderId, drag })];
  // 私聊只带缩进和拖动的信息：展开收起的箭头是群的，私聊左边不要
  if (open) for (const d of byOrder(dms, (x) => x.dm, SIDE_ORDER.dms[id])) out.push(convItemHtml(d, { inFolder, folderId, drag: { scope: `d:${id}`, key: d.dm } }));
  return out;
}

// ---------------- 侧栏的排序（可以拖） ----------------
// 收纳组和群可以互换位置，组里的群可以互换，同一个群下面的私聊也可以互换。拖过的顺序记在本机；
// 没拖过的（新建的群、新来的私聊）按最近的动静排在最上面
const SIDE_ORDER = (() => {
  try {
    return { top: [], folders: {}, dms: {}, ...JSON.parse(storeGet('clawchat.sideOrder') || '{}') };
  } catch {
    return { top: [], folders: {}, dms: {} };
  }
})();

function byOrder(items, keyOf, saved) {
  if (!saved?.length) return items;
  const pos = new Map(saved.map((k, i) => [k, i]));
  const fresh = items.filter((it) => !pos.has(keyOf(it)));
  const placed = items.filter((it) => pos.has(keyOf(it))).sort((a, b) => pos.get(keyOf(a)) - pos.get(keyOf(b)));
  return [...fresh, ...placed];
}

function saveSideOrder(scope, keys) {
  if (scope === 'top') SIDE_ORDER.top = keys;
  else if (scope.startsWith('f:')) SIDE_ORDER.folders[scope.slice(2)] = keys;
  else if (scope.startsWith('d:')) SIDE_ORDER.dms[scope.slice(2)] = keys;
  storeSet('clawchat.sideOrder', JSON.stringify(SIDE_ORDER));
}

// 收纳组的头像：组名的第一个字（汉字、字母都行），配一个固定的颜色（按组随机分到，同一个组一直是同一个颜色）
const FOLDER_COLORS = [
  ['#6E8EF5', '#4A67D8'],
  ['#9B7CF0', '#7556D6'],
  ['#E9839E', '#C95C7C'],
  ['#F0A35E', '#D9803A'],
  ['#4FB9A8', '#2E9887'],
  ['#5FAEE3', '#3A8CC8'],
  ['#8C9AAE', '#6B7A90'],
  ['#C9A45C', '#A8843E'],
];
// 按「看到的一个字」切：👨‍👩‍👧 这种组合表情算一个字，不会被切成几个
const graphemes = (s) => (window.Intl?.Segmenter ? [...new Intl.Segmenter().segment(s)].map((x) => x.segment) : [...s]);

function folderColor(folder) {
  const pick = folder.avatar?.color;
  if (Number.isInteger(pick) && FOLDER_COLORS[pick]) return pick;
  let h = 0;
  for (const ch of String(folder.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % FOLDER_COLORS.length;
}

// 自定义过的（右键「更换头像…」）优先：图片 > 自己写的字 > 组名的第一个字
// 图片存在服务端，界面上只拿地址（以前是把 data URL 塞在列表里跟着每次推送一起发）
function folderImageUrl(folder) {
  const av = folder.avatar || {};
  if (av.imageV) return `/api/folders/${encodeURIComponent(folder.id)}/avatar?v=${encodeURIComponent(av.imageV)}`;
  return av.image || '';
}
function folderAvatar(folder) {
  const av = folder.avatar || {};
  const image = folderImageUrl(folder);
  if (image) return `<span class="folder-avatar has-image" style="background-image:url('${esc(image)}')"></span>`;
  const [a, b] = FOLDER_COLORS[folderColor(folder)];
  const first = graphemes(String(folder.name || '').trim())[0] || '·';
  const text = av.text || (/[a-z]/.test(first) ? first.toUpperCase() : first);
  // 浅色的头像上白字看不清（尤其是浅色模式），按底色自动换成深色字
  return `<span class="folder-avatar${graphemes(text).length > 1 ? ' two' : ''}" style="background:linear-gradient(160deg,${a},${b});color:${folderInk(a, b)}">${esc(text)}</span>`;
}

// 渐变中间那个颜色上，白字够不够清楚（对比度 3.2 是粗体大字的下限）；不够就用深色字
function folderInk(a, b) {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const mix = (lum(a) + lum(b)) / 2;
  return 1.05 / (mix + 0.05) >= 3.2 ? '#fff' : 'rgba(20, 20, 22, 0.82)';
}

// 更换收纳组头像：颜色、文字、图片，改的时候上面实时预览
async function openAvatarDialog(folderId) {
  const folder = S.folders.find((f) => f.id === folderId);
  if (!folder) return;
  const dlg = $('#dlg-avatar');
  let draft = { ...(folder.avatar || {}) };
  const preview = () => {
    $('#avatar-preview').innerHTML = folderAvatar({ ...folder, avatar: draft });
    $('#btn-avatar-remove').hidden = !draft.image && !draft.imageV;
    const cur = folderColor({ ...folder, avatar: draft });
    $('#avatar-colors').innerHTML = FOLDER_COLORS.map(
      ([a, b], i) => `<button type="button" class="avatar-color${i === cur ? ' on' : ''}" data-color="${i}" style="background:linear-gradient(160deg,${a},${b})" aria-label="${tr('颜色 {n}', { n: i + 1 })}"></button>`,
    ).join('');
  };
  $('#avatar-text').value = draft.text || '';
  $('#avatar-text').placeholder = tr('默认用组名的第一个字');
  preview();
  $('#avatar-text').oninput = (e) => {
    draft.text = graphemes(e.target.value.trim()).slice(0, 2).join('');
    preview();
  };
  $('#avatar-colors').onclick = (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    draft.color = Number(b.dataset.color);
    delete draft.image; // 选了颜色就是不要图片了
    delete draft.imageV;
    preview();
  };
  $('#btn-avatar-upload').onclick = () => $('#avatar-file').click();
  $('#avatar-file').onchange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      draft.image = await squareImage(file, 160);
      delete draft.imageV; // 换新图
      preview();
    } catch {
      toast(tr('这张图片打不开，换一张试试'));
    }
  };
  $('#btn-avatar-remove').onclick = () => {
    delete draft.image;
    delete draft.imageV;
    preview();
  };
  $('#btn-avatar-reset').onclick = () => {
    draft = {};
    $('#avatar-text').value = '';
    preview();
  };
  $('#btn-avatar-cancel').onclick = () => closeDialog(dlg);
  dlg.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const avatar = Object.keys(draft).filter((k) => draft[k] !== undefined && draft[k] !== '').length ? draft : null;
    try {
      const { folder: saved } = await api('PATCH', `/api/folders/${folderId}`, { avatar });
      S.folders = S.folders.map((f) => (f.id === folderId ? saved || { ...f, avatar: avatar || undefined } : f));
      renderConvs();
      closeDialog(dlg);
    } catch (err) {
      toast(err.message);
    }
  };
  dlg.showModal();
  reportDragRegions();
}

// 上传的图片裁成正方形、缩到 size×size（头像用不着大图，存起来也小）
function squareImage(file, size) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      let data = canvas.toDataURL('image/png');
      if (data.length > 380000) data = canvas.toDataURL('image/jpeg', 0.85);
      resolve(data);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('bad image'));
    };
    img.src = url;
  });
}

function renderConvs() {
  const entries = groupedConversations();
  const boxes = new Map(S.folders.map((f) => [f.id, { folder: f, list: [], ts: 0 }]));
  const items = [];
  for (const e of entries) {
    const box = e.group.room.folder && boxes.get(e.group.room.folder);
    if (box) {
      box.list.push(e);
      box.ts = Math.max(box.ts, e.ts || 0);
    } else items.push({ type: 'room', entry: e, ts: e.ts || 0 });
  }
  for (const box of boxes.values()) items.push({ type: 'folder', ...box, list: byOrder(box.list, (e) => e.group.room.id, SIDE_ORDER.folders[box.folder.id]), ts: box.ts || box.folder.createdAt || 0 });
  items.sort((a, b) => b.ts - a.ts); // 组里一直没有动静的放到最后；空组按建组时间
  const html = [];
  for (const it of byOrder(items, (x) => (x.type === 'folder' ? `f:${x.folder.id}` : `r:${x.entry.group.room.id}`), SIDE_ORDER.top)) {
    if (html.length) html.push('<li class="conv-sep" aria-hidden="true"></li>'); // 不同的群 / 收纳组之间一条细线
    if (it.type === 'room') {
      html.push(...roomItemsHtml(it.entry));
      continue;
    }
    // 正在看的群在组里也照样能收起：只在打开它的时候（openConv）把组展开一次，不然点了收起马上又被展开回来
    const open = !collapsedFolders.has(it.folder.id);
    html.push(folderIt(it, open));
    if (open) for (const e of it.list) html.push(...roomItemsHtml(e, true, it.folder.id));
  }
  $('#conv-list').innerHTML = html.join('');
  markSideNav();
  updateBadge();
}

// 键盘在侧栏里停在哪一行（聊天就是打开的那个，收纳组单独标出来）
const SIDE_NAV = { key: null };
function markSideNav() {
  const key = SIDE_NAV.key?.startsWith('f:') ? SIDE_NAV.key : null;
  $('#conv-list').querySelectorAll('.conv-item.kbd').forEach((li) => li.classList.remove('kbd'));
  if (key) $('#conv-list').querySelector(`[data-folder="${CSS.escape(key.slice(2))}"]`)?.classList.add('kbd');
}

// 侧栏滚到某一行（当前打开的聊天、键盘停下的那一行）：群多了以后它可能在下面看不见。
// 每次都按 key 重新找：列表刚重画过，旧的那个元素已经不在页面上了
function revealSideItem(key) {
  if (!key) return;
  const list = $('#conv-list');
  const el = key.startsWith('f:')
    ? list.querySelector(`.conv-item[data-folder="${CSS.escape(key.slice(2))}"]`)
    : list.querySelector(`.conv-item[data-key="${CSS.escape(key)}"]`);
  el?.scrollIntoView({ block: 'nearest' });
}

// 有鼠标（或触控板）的设备：手指点的手机、平板上，别把焦点交给看不见的输入框，不然会弹出键盘
const finePointer = () => matchMedia('(pointer: fine)').matches;

function toggleFolder(id) {
  if (toggleFolder.busy) return; // 动画没放完又点了一下：忽略，免得抖
  const closing = !collapsedFolders.has(id);
  const childrenOf = () => [...document.querySelectorAll(`.conv-item[data-parent-folder="${CSS.escape(id)}"]`)];
  const apply = () => {
    if (closing) collapsedFolders.add(id);
    else collapsedFolders.delete(id);
    storeSet('clawchat.folderCollapsed', JSON.stringify([...collapsedFolders]));
    renderConvs();
  };
  if (reduceMotion()) return apply();
  toggleFolder.busy = true;
  const done = () => (toggleFolder.busy = false);
  if (closing) {
    Promise.all(childrenOf().map((li) => slideItem(li, false))).then(apply).finally(done);
  } else {
    apply();
    Promise.all(childrenOf().map((li) => slideItem(li, true))).finally(done);
  }
}

// ---------------- 收纳组：右键菜单和接口 ----------------
// 群上：「移到收纳组 ▸」「新建收纳组…」，已经在组里的还有「移出收纳组」；组上：「重命名」「解散收纳组」。
// 菜单沿用模型菜单那套 .menu 样式，子菜单在右边展开
function closeMenus() {
  $('#ctx-menu').hidden = true;
  $('#ctx-sub').hidden = true;
}

function placeMenu(el, x, y) {
  el.hidden = false;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`;
}

function ctxItemHtml(label, item) {
  const arrow = item.sub
    ? '<svg class="menu-arrow" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M3.6 2 7 5l-3.4 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '';
  // icon：菜单项前面的小图（比如成员头像），传进来的是现成的 HTML
  const icon = item.icon ? `<span class="menu-icon">${item.icon}</span>` : '';
  return `<button type="button" class="menu-item${item.danger ? ' danger' : ''}"><span class="menu-check"></span>${icon}<span class="menu-text"><span class="menu-label">${esc(label)}</span></span>${arrow}</button>`;
}

function openCtxMenu(items, x, y) {
  delete $('#ctx-menu').dataset.for; // 是哪个按钮打开的：打开的那个按钮再点一下就收起（由调用方在打开后标上）
  const menu = $('#ctx-menu');
  const sub = $('#ctx-sub');
  sub.hidden = true;
  menu.innerHTML = items.map((it) => ctxItemHtml(it.label, it)).join('');
  menu.querySelectorAll('.menu-item').forEach((btn, i) => {
    const it = items[i];
    btn.onmouseenter = () => {
      if (!it.sub) return void (sub.hidden = true);
      sub.innerHTML = it.sub.map((s) => ctxItemHtml(s.label, s)).join('');
      sub.style.left = '-9999px';
      sub.style.top = '0px';
      sub.hidden = false;
      sub.querySelectorAll('.menu-item').forEach((b, j) => (b.onclick = () => {
        closeMenus();
        it.sub[j].act?.();
      }));
      const r = btn.getBoundingClientRect();
      const w = sub.offsetWidth;
      const left = r.right + 2 + w > window.innerWidth - 8 ? r.left - w - 2 : r.right + 2;
      sub.style.left = `${Math.max(8, left)}px`;
      sub.style.top = `${Math.max(8, Math.min(r.top - 5, window.innerHeight - sub.offsetHeight - 8))}px`;
    };
    btn.onclick = () => {
      if (it.sub) return; // 有子菜单的：鼠标移上去展开
      closeMenus();
      it.act?.();
    };
  });
  sub.onmouseleave = () => (sub.hidden = true);
  placeMenu(menu, x, y);
}

async function setRoomFolder(roomId, folderId) {
  try {
    const { room } = await api('PATCH', `/api/rooms/${roomId}`, { folder: folderId });
    S.rooms = S.rooms.map((r) => (r.id === room.id ? room : r));
    if (folderId) collapsedFolders.delete(folderId); // 刚移进去的组要展开，不然看着像「不见了」
    renderConvs();
  } catch (err) {
    toast(err.message);
  }
}

async function createFolder(name, roomId = null) {
  try {
    const { folder } = await api('POST', '/api/folders', roomId ? { name, rooms: [roomId] } : { name });
    // 服务端推过来的收纳组列表可能比这里的回应先到（里面已经有它了）：别再加一遍，不然右键菜单里会出现两个同名的组
    if (!S.folders.some((f) => f.id === folder.id)) S.folders = [...S.folders, folder];
    if (roomId) S.rooms = S.rooms.map((r) => (r.id === roomId ? { ...r, folder: folder.id } : r));
    collapsedFolders.delete(folder.id);
    renderConvs();
    return folder;
  } catch (err) {
    toast(err.message);
    return null;
  }
}

async function renameFolderApi(id, name) {
  try {
    await api('PATCH', `/api/folders/${id}`, { name });
    S.folders = S.folders.map((f) => (f.id === id ? { ...f, name } : f));
    renderConvs();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteFolderApi(id) {
  try {
    await api('DELETE', `/api/folders/${id}`);
    S.folders = S.folders.filter((f) => f.id !== id);
    S.rooms = S.rooms.map((r) => (r.folder === id ? { ...r, folder: undefined } : r));
    renderConvs();
  } catch (err) {
    toast(err.message);
  }
}

function openRoomMenu(roomId, x, y) {
  const room = roomById(roomId);
  if (!room) return;
  const move = S.folders
    .filter((f) => f.id !== room.folder)
    .map((f) => ({ label: f.name, act: () => setRoomFolder(roomId, f.id) }));
  const items = [
    {
      label: tr('移到收纳组'),
      sub: [
        ...move,
        {
          label: tr('新建收纳组…'),
          act: async () => {
            const name = await askText({ title: tr('新建收纳组'), label: tr('名字'), ok: tr('创建') });
            if (name) createFolder(name, roomId);
          },
        },
      ],
    },
  ];
  if (room.folder) items.push({ label: tr('移出收纳组'), act: () => setRoomFolder(roomId, null) });
  openCtxMenu(items, x, y);
}

function openFolderMenu(folderId, x, y) {
  const folder = S.folders.find((f) => f.id === folderId);
  if (!folder) return;
  openCtxMenu(
    [
      {
        label: tr('重命名'),
        act: async () => {
          const name = await askText({ title: tr('重命名收纳组'), label: tr('名字'), value: folder.name, ok: tr('保存') });
          if (name && name !== folder.name) renameFolderApi(folderId, name);
        },
      },
      { label: tr('更换头像…'), act: () => openAvatarDialog(folderId) },
      {
        label: tr('解散收纳组'),
        danger: true,
        act: async () => {
          const ok = await askConfirm({
            title: tr('解散「{name}」？', { name: folder.name }),
            text: tr('里面的群会回到最外层，群本身和聊天记录都不会删掉。'),
            ok: tr('解散'),
          });
          if (ok === true) deleteFolderApi(folderId);
        },
      },
    ],
    x,
    y,
  );
}

// ---------------- 搜索面板 ----------------
// 点侧栏的搜索框（或 ⌘K / Ctrl+K）弹出来：上面是搜索框和筛选（全部 / 消息 / 聊天、谁说的、哪个群），
// 下面一条一条列结果：哪个群、谁说的、命中的那段（关键词标黄）、时间；点一条就打开那个聊天、跳到那条消息

const escRe = (q) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 把文字里的关键词标出来（大小写不分）
function highlight(text, q) {
  const re = new RegExp(escRe(q), 'gi');
  const parts = text.split(re);
  const marks = text.match(re) || [];
  return parts.map((p, i) => esc(p) + (marks[i] ? `<mark>${esc(marks[i])}</mark>` : '')).join('');
}

const plainText = (t) => String(t).replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim();

// 「谁说的」：AI 之间的私聊写成「Claude → DeepSeek」
const speakerOf = (m) => (m.from === 'user' ? tr('我') : m.pm ? `${agentName(m.from)} → ${agentName(m.pm)}` : agentName(m.from));

const SP = { q: '', tab: 'all', from: '', room: '', res: null, active: 0, seq: 0, loading: false };
const SHORT_CONVS = 4; // 「全部」里聊天只列几个，多的点「查看全部」

function openSearch(q = '') {
  const dlg = $('#dlg-search');
  if (!dlg.open) {
    dlg.showModal();
    requestAnimationFrame(reportDragRegions);
  }
  const input = $('#spot-input');
  if (q) input.value = q;
  input.focus();
  input.select();
  runSearch();
}

async function runSearch() {
  const q = $('#spot-input').value.trim();
  SP.q = q;
  SP.active = 0;
  $('#spot-clear').hidden = !q;
  const seq = ++SP.seq;
  if (!q) {
    SP.res = null;
    SP.loading = false;
    $('#spot-body').classList.remove('stale');
    return renderSearch();
  }
  SP.loading = true; // 新结果回来之前，列表上的旧结果不算数（回车、点击都不会打开它们）
  $('#spot-body').classList.add('stale');
  const params = new URLSearchParams({ q });
  if (SP.from) params.set('from', SP.from);
  if (SP.room) params.set('room', SP.room);
  let res;
  try {
    res = await api('GET', `/api/search?${params}`);
  } catch {
    res = { hits: [], total: 0, facets: { from: {}, rooms: {} } };
  }
  if (seq !== SP.seq) return; // 已经又改了关键词或筛选
  SP.res = res;
  SP.loading = false;
  $('#spot-body').classList.remove('stale');
  renderSearch();
}

// 名字对得上的聊天（群名、私聊对象的名字）；选了「谁说的」就只留有它的聊天，选了群就只留那个群
function searchConvs(q) {
  const needle = q.toLowerCase();
  const out = [];
  for (const { group, dms } of groupedConversations()) {
    if (SP.room && group.room.id !== SP.room) continue;
    const nameHit = group.room.name.toLowerCase().includes(needle);
    // 搜成员的名字，也列出有它的群（比如搜「Claude」，有 Claude 的群也出来）
    const member = group.room.members.length > 1 && !nameHit ? group.room.members.find((a) => agentLabel(a).toLowerCase().includes(needle)) : null;
    const groupHit = nameHit || !!member;
    if (member) group.hasMember = member;
    if (groupHit && (!SP.from || SP.from === 'user' || group.room.members.includes(SP.from))) out.push(group);
    for (const d of dms) if ((nameHit || agentLabel(d.dm).toLowerCase().includes(needle)) && (!SP.from || SP.from === 'user' || d.dm === SP.from)) out.push(d);
  }
  return out;
}

// 筛选那一行：全部 / 消息 / 聊天，再加「谁说的」「哪个群」两个下拉（用系统自带的菜单，后面带着各有几条）
function filtersHtml(convs) {
  const res = SP.res || { total: 0, facets: { from: {}, rooms: {} } };
  const tab = (id, label, n) => `<button type="button" class="spot-chip${SP.tab === id ? ' on' : ''}" data-tab="${id}">${esc(label)}${SP.q ? `<small>${n}</small>` : ''}</button>`;
  const opt = (v, label, n, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}${n ? ` · ${n}` : ''}</option>`;
  const known = ['user', ...AGENT_IDS];
  const gone = Object.keys(res.facets.from).filter((a) => !known.includes(a)); // 已经删掉的多开成员：历史消息还在，也能按它筛
  const people = [...known, ...gone].filter((a) => res.facets.from[a] || a === SP.from);
  const fromLabel = SP.from ? (SP.from === 'user' ? tr('我') : agentName(SP.from)) : tr('谁说的');
  const fromSel = `<label class="spot-chip pick${SP.from ? ' on' : ''}"><span>${esc(fromLabel)}</span>${CHEVRON}<select id="spot-from">${opt('', tr('所有人说的'), 0, SP.from)}${people.map((a) => opt(a, a === 'user' ? tr('我') : agentName(a), res.facets.from[a], SP.from)).join('')}</select></label>`;
  const rooms = S.rooms.filter((r) => res.facets.rooms[r.id] || r.id === SP.room);
  const roomLabel = SP.room ? roomById(SP.room)?.name || tr('哪个群') : tr('哪个群');
  const roomSel = `<label class="spot-chip pick${SP.room ? ' on' : ''}"><span>${esc(roomLabel)}</span>${CHEVRON}<select id="spot-room">${opt('', tr('所有聊天'), 0, SP.room)}${rooms.map((r) => opt(r.id, r.name, res.facets.rooms[r.id], SP.room)).join('')}</select></label>`;
  const reset = SP.from || SP.room ? `<button type="button" class="spot-reset" data-reset>${tr('清除筛选')}</button>` : '';
  return `${tab('all', tr('全部'), res.total + convs.length)}${tab('msgs', tr('消息'), res.total)}${tab('convs', tr('聊天'), convs.length)}<span class="spot-sep"></span>${fromSel}${roomSel}${reset}`;
}

const CHEVRON = '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M2.2 3.8 5 6.6l2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GO_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M6.5 9.5 10 6M7 6h3v3"/></svg>';

function convRowHtml(c, i) {
  const name = c.dm ? `${highlight(agentLabel(c.dm), SP.q)}<span class="dm-tag">${tr('私聊')}</span>` : highlight(c.room.name, SP.q);
  const sub = c.dm
    ? tr('来自「{room}」', { room: c.room.name })
    : c.hasMember
      ? tr('群里有 {name}', { name: agentName(c.hasMember) })
      : c.room.members.length > 1
        ? tr('群聊 · 你和 {n} 位 AI', { n: c.room.members.length })
        : tr('单聊');
  return `<li class="spot-row conv${i === SP.active ? ' active' : ''}" data-i="${i}" data-conv-key="${esc(c.key)}">
    <div class="spot-avatar">${convAvatar(c)}</div>
    <div class="spot-main"><div class="spot-name">${name}</div><div class="spot-where">${esc(sub)}</div></div>
    <span class="spot-go">${GO_ICON}</span></li>`;
}

function hitRowHtml(h, i) {
  const room = roomById(h.roomId);
  if (!room) return '';
  const key = convOf(h.roomId, h);
  const dm = parseKey(key).dm && room.members.length > 1 ? parseKey(key).dm : null;
  // 关键词前面只留一小段，免得被挤到两行以外看不见
  let text = plainText(h.text);
  const pos = text.toLowerCase().indexOf(SP.q.toLowerCase());
  const cut = h.cut || pos > 30;
  if (pos > 30) text = text.slice(pos - 30);
  text = `${cut ? '…' : ''}${text}${h.tail ? '…' : ''}`;
  const where = esc(room.name) + (dm ? `<span class="spot-dm">${esc(tr('私聊 {name}', { name: agentName(dm) }))}</span>` : '');
  // 鼠标停一会儿，能看到同一个聊天里的上一条，知道当时在聊什么
  const ctx = h.prev ? tr('上一条 · {name}：{text}', { name: speakerOf(h.prev), text: (h.prev.cut ? '…' : '') + plainText(h.prev.text) }) : '';
  return `<li class="spot-row${i === SP.active ? ' active' : ''}" data-i="${i}" data-hit-key="${esc(key)}" data-hit-seq="${h.seq}"${ctx ? ` title="${esc(ctx)}"` : ''}>
    <div class="spot-avatar">${convAvatar({ room, dm })}</div>
    <div class="spot-main"><div class="spot-line"><span class="spot-where">${where}</span><span class="spot-time">${fmtShort(h.ts)}</span></div>
    <div class="spot-text"><span class="spot-who">${esc(tr('{name}：', { name: speakerOf(h) }))}</span>${highlight(text, SP.q)}</div></div>
    <span class="spot-go">${GO_ICON}</span></li>`;
}

function renderSearch() {
  const body = $('#spot-body');
  const q = SP.q;
  const convs = q ? searchConvs(q) : [];
  $('#spot-filters').innerHTML = filtersHtml(convs);
  if (!q) {
    body.innerHTML = `<div class="spot-empty">${tr('在所有群聊和私聊里找消息和聊天')}<small>${tr('↑↓ 选择 · 回车打开 · Esc 关闭')}</small></div>`;
    return;
  }
  if (!SP.res) return void (body.innerHTML = `<div class="spot-empty">${tr('正在搜…')}</div>`);
  const hits = SP.tab === 'convs' ? [] : SP.res.hits;
  const shownConvs = SP.tab === 'msgs' ? [] : SP.tab === 'all' ? convs.slice(0, SHORT_CONVS) : convs;
  let i = 0;
  const out = [];
  if (shownConvs.length) {
    const all = SP.tab === 'all' && convs.length > SHORT_CONVS ? `<button type="button" class="spot-more" data-tab="convs">${tr('查看全部 {n} 个', { n: convs.length })}</button>` : '';
    out.push(`<div class="spot-sec"><span>${tr('聊天')}</span>${all}</div><ul class="spot-list">${shownConvs.map((c) => convRowHtml(c, i++)).join('')}</ul>`);
  }
  if (hits.length) {
    const more = SP.res.more ? `<span class="spot-note">${tr('只列出最近 {n} 条，共 {total} 条', { n: hits.length, total: SP.res.total })}</span>` : '';
    out.push(`<div class="spot-sec"><span>${tr('消息')}</span>${more}</div><ul class="spot-list">${hits.map((h) => hitRowHtml(h, i++)).join('')}</ul>`);
  }
  body.innerHTML = out.join('') || `<div class="spot-empty">${SP.from || SP.room ? tr('这个筛选下没有找到，换个筛选试试') : tr('没有找到相关的聊天和消息')}</div>`;
  body.scrollTop = 0;
}

function moveActive(d) {
  const rows = [...$('#spot-body').querySelectorAll('.spot-row')];
  if (!rows.length) return;
  SP.active = (SP.active + d + rows.length) % rows.length;
  rows.forEach((r, i) => r.classList.toggle('active', i === SP.active));
  rows[SP.active].scrollIntoView({ block: 'nearest' });
}

// 换了关键词或筛选、新结果还没回来时，列表上的是旧结果：键盘、鼠标都不让打开（列表也淡下去）
const searchStale = () => SP.loading || $('#spot-input').value.trim() !== SP.q;

async function openSearchRow(li) {
  if (searchStale()) return;
  const q = SP.q;
  closeDialog($('#dlg-search'));
  if (li.dataset.convKey) return openConv(li.dataset.convKey);
  await openConv(li.dataset.hitKey);
  const el = await jumpTo(Number(li.dataset.hitSeq));
  if (el) markFound(el, q);
}

function bindSearch() {
  const dlg = $('#dlg-search');
  const input = $('#spot-input');
  // 侧栏的搜索框只是个入口：点一下（或者聚焦后直接打字）就打开面板
  const side = $('#search');
  side.addEventListener('mousedown', (e) => {
    e.preventDefault();
    openSearch();
  });
  side.addEventListener('focus', () => {
    side.blur();
    openSearch();
  });
  $('#search-key').textContent = IS_WIN ? 'Ctrl K' : '⌘K';
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (document.querySelector('dialog[open]:not(#dlg-search)')) return;
    e.preventDefault();
    openSearch();
  });
  input.addEventListener('input', () => {
    SP.loading = true; // 刚改了字：等新结果
    $('#spot-body').classList.add('stale');
    clearTimeout(runSearch.timer);
    runSearch.timer = setTimeout(runSearch, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const li = $('#spot-body').querySelectorAll('.spot-row')[SP.active];
      if (li) openSearchRow(li);
    }
  });
  $('#spot-clear').onclick = () => {
    input.value = '';
    input.focus();
    runSearch();
  };
  $('#spot-close').onclick = () => closeDialog(dlg);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return closeDialog(dlg); // 点面板外面也关
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      SP.tab = tab.dataset.tab;
      SP.active = 0;
      renderSearch();
      return input.focus();
    }
    if (e.target.closest('[data-reset]')) {
      SP.from = SP.room = '';
      return runSearch();
    }
    const row = e.target.closest('.spot-row');
    if (row) openSearchRow(row);
  });
  dlg.addEventListener('change', (e) => {
    if (e.target.id === 'spot-from') SP.from = e.target.value;
    else if (e.target.id === 'spot-room') SP.room = e.target.value;
    else return;
    runSearch();
    input.focus();
  });
  dlg.addEventListener('mousemove', (e) => {
    const row = e.target.closest('.spot-row');
    if (!row || Number(row.dataset.i) === SP.active) return;
    SP.active = Number(row.dataset.i);
    dlg.querySelectorAll('.spot-row').forEach((r) => r.classList.toggle('active', r === row));
  });
  // 关掉再打开：标签和筛选回到默认（关键词留着，方便接着搜）
  dlg.addEventListener('close', () => {
    Object.assign(SP, { tab: 'all', from: '', room: '' });
    reportDragRegions();
  });
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
  setHtml($('#room-icon'), convAvatar(conv));
  $('#room-name').textContent = dm ? `${agentLabel(dm)}` : room.name;
  $('#room-count').textContent = dm ? tr('· 私聊') : group ? `(${room.members.length + 1})` : '';
  $('#room-from').textContent = dm ? tr('来自「{name}」', { name: room.name }) : '';
  $('#room-from').hidden = !dm;
  // 顶部只显示文件夹名，完整路径放在提示里
  $('#room-folder').innerHTML = `${FOLDER_SVG}<span>${esc(room.cwd.split(/[\\/]/).filter(Boolean).pop() || room.cwd)}</span>`;
  $('#room-folder').title = tr('{label}：{file}', { label: IS_WIN ? tr('在资源管理器中打开') : tr('在访达中打开'), file: room.cwd });
  $('#room-folder').hidden = !!room.joint; // 联合群的项目文件夹只是跑 AI 的临时工作区，不给老板看
  const perm = $('#room-perm');
  perm.textContent = PERM_LABEL[room.permission] || room.permission;
  perm.className = `badge ${room.permission}`;
  perm.hidden = !!room.joint; // 联合群只有讨论档，顶栏那条已经写着，不再重复普通群的三档
  // 顶部的模型按钮：群里显示所有成员，私聊只显示对方
  if (!$('#model-menu').hidden && !conv.room.members.includes($('#model-menu').dataset.agent)) closeModelMenu();
  $('#model-switch').classList.toggle('many', !dm && room.members.length > 2);
  setHtml(
    $('#model-switch'),
    (dm ? [dm] : room.members).map((a) => modelChipHtml(a, dm ? dmView(room, a) : room)).join('') +
      // 顶栏一行放不下时（窄窗口 + 成员多）只显示这一个按钮，点开是成员和各自的模型
      (!dm && group ? `<button class="model-chip model-more" data-model-more aria-haspopup="menu" title="${esc(tr('成员和模型'))}"><span class="chip-stack">${room.members.slice(0, 3).map((a) => avatarHtml(a)).join('')}</span><span class="chip-model">${tr('模型')}</span>${CHEVRON_SVG}</button>` : ''),
  );
  const entry = $('#dm-entry');
  entry.hidden = dm || !group;
  // 窄窗口下这些头像收进一个按钮里（CSS 换），顶栏才不会被挤成两行
  entry.innerHTML = group && !dm
    ? `<span class="muted">${tr('私聊')}</span>${room.members.map((a) => `<button class="dm-btn" data-dm="${esc(a)}" title="${esc(tr('私聊 {name}', { name: agentLabel(a) }))}">${avatarHtml(a)}</button>`).join('')}<button class="dm-btn dm-more" data-dm-menu title="${tr('私聊')}" aria-label="${tr('私聊')}"><span class="dm-stack">${room.members.slice(0, 3).map((a) => avatarHtml(a)).join('')}</span><span class="dm-label">${tr('私聊')}</span>${CHEVRON_SVG}</button>`
    : '';
  $('#group-tools').hidden = !!dm || !group;
  // 手机上的 @ 按钮：只有群聊（两位以上）才有；私聊、单聊藏起来
  $('#btn-at').hidden = !!dm || !group;
  $('#btn-at').title = tr('提到谁（@）');
  $('#btn-at').setAttribute('aria-label', tr('提到谁'));
  if (dm || !group) closeAtPanel();
  setHtml($('#mention-all-icons'), room.members.map((a) => avatarHtml(a)).join(''));
  document.querySelectorAll('[data-mention]').forEach((b) => {
    const id = b.dataset.who || { Claude: 'claude', ChatGPT: 'gpt', DeepSeek: 'deepseek', GLM: 'glm', Gemini: 'gemini', Grok: 'grok', Cursor: 'cursor', API: 'api' }[b.dataset.mention];
    b.hidden = id ? !room.members.includes(id) : false;
  });
  renderTargets(room, dm);
  const hint = $('#dm-hint');
  hint.hidden = !dm;
  $('#chat').classList.toggle('can-mention', !dm && room.members.length > 1); // 群里点消息里的 @ 能填进输入框
  hint.firstElementChild.textContent = dm
    ? tr('这里是你和 {name} 的私聊，{others} 看不到。{name} 记得群里的所有事。别的 AI 私下找它的对话也显示在这里；它主动找别人的，在对方的私聊里。', { name: agentName(dm), others: room.members.filter((a) => a !== dm).map(agentName).join(LIST_SEP) })
    : '';

  renderInputMirror(); // 换了群、改了成员，@ 谁有头像跟着变
  syncToolsRow();
  syncJointMembers();
  buildMentionRes(); // 对方成员的名字要能认成 @
  syncJointMentionChips(room);
  syncJointQuickMentions(room); // 联合群里自己的 @ 快捷按钮也写全名
  renderJointBar(); // 联合群：对方成员、在线状态、讨论档
  renderVisionHint(); // 换了聊天、换了模型：图片提醒跟着更新
  fitHead();
  requestAnimationFrame(reportDragRegions);
}

// 顶部的几个模型按钮一样宽（按最宽的那个来），看起来整齐
function equalizeChips() {
  const chips = [...$('#model-switch').children].filter((c) => c.dataset.menu);
  chips.forEach((c) => (c.style.width = ''));
  if (chips.length < 2) return;
  const w = Math.ceil(Math.max(...chips.map((c) => c.getBoundingClientRect().width)));
  chips.forEach((c) => (c.style.width = `${w}px`));
}

// 窗口窄、成员多，顶栏一行放不下时，把模型切换挪到第二行，别把群名挤没了。
// 量的是每个下拉框本来的宽度，两种排法下都一样，所以不会来回跳
function fitHead() {
  const head = $('#room-head');
  if ($('#chat').hidden) return;
  const conv = currentConv();
  // 换了聊天、改了成员：重新按普通按钮量一次
  const sig = conv ? `${conv.key}|${conv.room.members.join(',')}` : '';
  if (head._sig !== sig) {
    head._sig = sig;
    head._need = null;
    head.classList.remove('compact');
  }
  const compact = head.classList.contains('compact');
  // 只有普通按钮才量：收成头像以后按钮宽度不一样了，沿用上次量到的数字，免得来回跳
  if (!compact) {
    equalizeChips();
    const width = (el) => (el.hidden ? 0 : el.offsetWidth + 10); // 10 是顶栏各块之间的间距
    const chips = [...$('#model-switch').children].filter((c) => c.dataset.menu).reduce((w, el) => w + el.offsetWidth + 6, 0);
    head._need = 32 + 150 + chips + width($('#dm-entry')) + width($('#btn-find')) + width($('#btn-settings')); // 32 是左右留白，150 留给群名
  }
  const need = head._need || 0;
  // 群聊一行放不下时，成员按钮收成一个「模型」按钮（点开是成员和各自的模型），顶栏不再变成两行；私聊只有一位，照旧
  const canIcon = !!conv && !conv.dm && conv.room.members.length > 1;
  const want = canIcon && need > head.clientWidth;
  if (want !== compact) {
    head.classList.toggle('compact', want);
    [...$('#model-switch').children].forEach((c) => (c.style.width = ''));
    if (!want) requestAnimationFrame(fitHead); // 展开以后重新按普通按钮量一次
    requestAnimationFrame(reportDragRegions);
  }
  head.classList.toggle('stacked', !want && need > head.clientWidth);
}

// 输入框上面那一行：私聊、单聊又没在干活时整行收起来
function syncToolsRow() {
  const row = document.querySelector('.composer-tools');
  row.hidden = $('#group-tools').hidden && $('#stop-controls').hidden;
  fitTools();
}

const stepsListHtml = (steps) => `<ol>${steps.map(stepHtml).join('')}</ol>`;
// 分页取回来的消息只带步数，展开时再去取步骤
const loadingStepsHtml = () => `<div class="steps-loading muted">${tr('正在取过程…')}</div>`;

const stepsLoading = new Set(); // 同一条别同时取两遍（展开和重画会各触发一次）
async function loadSteps(conv, seq, detailsEl) {
  const loadingKey = `${conv.roomId}:${seq}`;
  if (stepsLoading.has(loadingKey)) return;
  const now = findMessage(seq);
  const put = (steps) => {
    const target = findMessage(seq);
    if (target && steps) target.steps = steps;
    const d = detailsEl?.isConnected ? detailsEl : document.querySelector(`#messages details[data-steps="${seq}"]`);
    if (!d) return;
    d.querySelector('.steps-loading')?.remove();
    if (!d.querySelector('ol')) d.insertAdjacentHTML('beforeend', stepsListHtml(target?.steps || []));
    d.removeAttribute('data-steps-lazy');
  };
  if (now?.steps?.length) return put(now.steps);
  stepsLoading.add(loadingKey);
  const gen = S.clearGen.get(conv.roomId) || 0;
  try {
    const { steps } = await api('GET', `/api/rooms/${conv.roomId}/messages/${seq}/steps`);
    if (S.current !== conv.key) return;
    if ((S.clearGen.get(conv.roomId) || 0) !== gen) return; // 清空了：这个编号已经是别的消息
    put(steps || []);
  } catch (err) {
    detailsEl?.querySelector?.('.steps-loading')?.remove();
    toast(err.message);
  } finally {
    stepsLoading.delete(loadingKey);
  }
}

// 重画以后，之前展开着的「过程」要接着去取
function hydrateOpenSteps() {
  const conv = currentConv();
  if (!conv) return;
  for (const d of document.querySelectorAll('#messages details[data-steps][open]:not([data-steps-lazy-loaded])')) {
    const seq = Number(d.dataset.steps);
    if (d.querySelector('ol') || !d.querySelector('.steps-loading')) continue;
    d.dataset.stepsLazyLoaded = '1';
    loadSteps(conv, seq, d);
  }
}

// 排好版的 Markdown 记住不重算（同样的文字排出来总是一样的）
const mdCache = new Map();
function mdCached(text) {
  let html = mdCache.get(text);
  if (html === undefined) {
    html = md(text);
    if (mdCache.size > 3000) mdCache.clear();
    mdCache.set(text, html);
  }
  return html;
}

function stepHtml(s) {
  // 看过、改过的文件：和回复里的路径一样，点一下在访达里显示，图片悬停看缩略图
  const file = ['read', 'edit'].includes(s.kind) && !String(s.text).includes(', ') && looksLikeFile(s.text);
  const text = file
    ? `<span class="step-text file-ref" data-path="${esc(String(s.text).trim())}" title="${REVEAL_LABEL}">${esc(s.text)}</span>`
    : `<span class="step-text">${esc(s.text)}</span>`;
  return `<li class="step step-${esc(s.kind)}"><span class="step-icon">${STEP_ICON[s.kind] || '·'}</span>${text}</li>`;
}

function imagesHtml(roomId, images) {
  if (!images?.length) return '';
  return `<div class="msg-images">${images
    .map((img) => `<img src="/api/rooms/${esc(roomId)}/uploads/${esc(img.id)}" loading="lazy" alt="${tr('图片')}" class="zoomable">`)
    .join('')}</div>`;
}

const svgIcon = (d, w = 15) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const COPY_ICON = svgIcon('<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.6"/><path d="M15.5 8.5V6.6A2.6 2.6 0 0 0 12.9 4H6.6A2.6 2.6 0 0 0 4 6.6v6.3a2.6 2.6 0 0 0 2.6 2.6h1.9"/>');
const COPIED_ICON = svgIcon('<path d="m5 12.5 4.5 4.5L19 7.5"/>');
const EDIT_ICON = svgIcon('<path d="M14.5 5.5 18.5 9.5"/><path d="M4 20l1-4.6L15.6 4.8a2 2 0 0 1 2.8 0l.8.8a2 2 0 0 1 0 2.8L8.6 19 4 20z"/>');
const SPEAK_ICON = svgIcon('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>');
const STOP_SPEAK_ICON = svgIcon('<rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="currentColor" stroke="none"/>');
const FORWARD_ICON = svgIcon('<path d="M14 5l6 6-6 6"/><path d="M20 11H10a6 6 0 0 0-6 6v1.5"/>');
const REPLY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';

function whoLabel(from) {
  return from === 'user' ? tr('我') : agentLabel(from);
}

// 一小段原话（回复栏、引用里用）：去掉 Markdown 符号，链接只留文字，读起来干净
function plainSnippet(text, max = 80) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, tr('[代码]'))
    .replace(/!?\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*|__|~~/g, '')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function snippet(m) {
  return m.text ? plainSnippet(m.text) : m.images?.length ? tr('[图片]') : '';
}

// 引用：回复别人的消息时，气泡上方带一小段原话，点一下跳回原消息
function quoteHtml(q) {
  return `<button class="quote" data-jump="${q.seq}" title="${tr('跳到原消息')}"><b>${esc(whoLabel(q.from))}</b><span>${esc(plainSnippet(q.text, 140))}</span></button>`;
}

function messageHtml(roomId, m, prev, conv) {
  const sep = !prev || m.ts - prev.ts > 5 * 60 * 1000 ? `<div class="time-sep">${fmtTime(m.ts)}</div>` : '';
  if (m.from === 'system') {
    const forwarded = m.action?.type === 'forward' && isForwarded(roomId, m.action.seq);
    const act = m.action?.type === 'fresh'
      ? `<button class="notice-action" data-fresh="${esc(m.action.agent)}">${esc(tr('给 {name} 换新会话', { name: agentName(m.action.agent) }))}</button>`
      : m.action?.type === 'forward'
        ? `<button class="notice-action" data-forward="${m.action.seq}"${forwarded ? ' disabled' : ''}>${forwarded ? tr('已发到群里') : tr('发到群里')}</button>`
        : m.action?.type === 'resume'
          ? resumeButton(roomId, m)
          : m.action?.type === 'install'
            ? installButtonHtml('notice-action')
            : '';
    return `${sep}<div class="notice"><span>${esc(m.text)}</span>${act}</div>`;
  }
  const d = new Date(m.ts);
  const full = `${fmtDate(d, true)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const time = `<time class="msg-time" datetime="${d.toISOString()}" title="${full}">${fmtExact(m.ts)}</time>`;
  const act = (attr, title, icon) => `<button class="act-btn" ${attr} title="${title}" aria-label="${title}">${icon}</button>`;
  const copyBtn = m.text ? act(`data-copy="${m.seq}"`, tr('复制'), COPY_ICON) : '';
  const replyBtn = act(`data-reply="${m.seq}"`, tr('回复这条'), REPLY_ICON);
  if (m.from === 'user') {
    const jroom = roomById(roomId);
    const remoteUser = jroom?.joint && m.node && m.node !== jroom.joint.selfNode;
    if (remoteUser) {
      // 对方老板发的消息：靠左、标上是谁说的，不给自己这边的编辑按钮
      const text = m.text ? `<div class="bubble">${mdCached(m.text)}</div>` : '';
      const quote = m.replyTo ? quoteHtml(m.replyTo) : '';
      const actions = `<div class="msg-actions">${copyBtn}${replyBtn}${time}</div>`;
      return `${sep}<div class="msg user peer-user" data-seq="${m.seq}">${jointPeerAvatar({ peerName: jroom.joint.peerName })}<div class="msg-body"><div class="msg-name">${esc(jroom.joint.peerName || '')}<span class="side-tag joint-tag">${tr('远程')}</span></div>${quote}${imagesHtml(roomId, m.images)}${text}${actions}</div></div>`;
    }
    if (S.editMsg?.roomId === roomId && S.editMsg.seq === m.seq) {
      return `${sep}<div class="msg user editing" data-seq="${m.seq}">${avatarHtml('user')}<div class="msg-body"><div class="edit-box">
        <div class="edit-field"><div class="input-mirror edit-mirror" aria-hidden="true" hidden></div><textarea class="edit-input" rows="1" aria-label="${tr('修改这条消息')}">${esc(S.editMsg.text)}</textarea></div>
        <div class="edit-actions"><span class="edit-hint">${tr('改好后会作为新消息发出，大家会知道你改了哪条')}</span><button class="secondary" data-edit-cancel>${tr('取消')}</button><button class="primary" data-edit-send>${tr('发送')}</button></div>
      </div></div></div>`;
    }
    // 自己发的消息也按 Markdown 排版：粘贴进来的表格、代码块、列表不会原样显示成一堆竖线和星号
    const text = m.text ? `<div class="bubble">${mdCached(m.text)}</div>` : '';
    const quote = m.replyTo ? quoteHtml(m.replyTo) : '';
    const edited = m.editOf
      ? `<button class="quote edit-quote" data-jump="${m.editOf.seq}" title="${tr('跳到原消息')}"><b>${tr('修改了')}</b><span>${esc(String(m.editOf.text || '').replace(/\s+/g, ' '))}</span></button>`
      : '';
    const actions = `<div class="msg-actions">${time}${copyBtn}${act(`data-edit="${m.seq}"`, tr('编辑'), EDIT_ICON)}${replyBtn}</div>`;
    // 联合群里把自己发的标成「你」，和对方老板的消息区分开
    const mineName = jroom?.joint ? `<div class="msg-name">${tr('你')}</div>` : '';
    return `${sep}<div class="msg user" data-seq="${m.seq}">${avatarHtml('user')}<div class="msg-body">${mineName}${edited}${quote}${imagesHtml(roomId, m.images)}${text}${actions}</div></div>`;
  }
  const dur = m.durationMs ? tr('用时 {time}', { time: fmtDur(m.durationMs) }) : '';
  // 过程步骤展开时才画出来（长对话里攒了上千步，一直放在页面上会拖慢整个聊天记录）
  const stepsOpen = S.openSteps.has(`${roomId}:${m.seq}`);
  // 分页取回来的消息不带过程，只有步数；展开时再去取（长对话一次带上千步，光传过来就慢了）
  const stepCount = m.steps?.length || m.stepCount || 0;
  const foot = stepCount
    ? `<details class="steps" data-steps="${m.seq}"${m.steps?.length ? '' : ' data-steps-lazy'}${stepsOpen ? ' open' : ''}><summary>${tr('过程 · {n} 步', { n: stepCount })}${dur ? ` · ${dur}` : ''}</summary>${stepsOpen ? (m.steps?.length ? stepsListHtml(m.steps) : loadingStepsHtml()) : ''}</details>`
    : dur;
  const remoteAgent = S.jointMembers?.[m.from] && !S.jointMembers[m.from].mine;
  const canDm = !conv.dm && conv.room.members.length > 1 && !remoteAgent; // 第一期不能和对方的 AI 私聊
  const avatar = canDm ? `<button class="dm-btn" data-dm="${esc(m.from)}" title="${esc(tr('私聊 {name}', { name: agentLabel(m.from) }))}">${avatarHtml(m.from)}</button>` : avatarHtml(m.from);
  const modelText = [m.model ? modelLabel(m.model) : '', m.effort ? tr('思考 {level}', { level: EFFORT_LABEL[m.effort] || m.effort }) : ''].filter(Boolean).join(' · ');
  const model = modelText ? `<span class="msg-model">${esc(modelText)}</span>` : '';
  const sideTag = (m.side ? `<span class="side-tag" title="${tr('本体当时在群里忙，这条是分身先回的')}">${tr('分身')}</span>` : '') +
    (m.forwardOf !== undefined ? `<span class="side-tag" title="${tr('你把它在私聊里的这段话转到了群里')}">${tr('从私聊转来')}</span>` : '');
  const speaking = S.speaking?.roomId === roomId && S.speaking.seq === m.seq;
  const speakBtn = m.text && HAS_SPEECH
    ? act(`data-speak="${m.seq}" class="act-btn${speaking ? ' on' : ''}"`, speaking ? tr('停止朗读') : tr('朗读'), speaking ? STOP_SPEAK_ICON : SPEAK_ICON)
    : '';
  // 私聊里的回复：可以转到群里（转过的就不再显示）
  const forwardBtn = m.dm && m.text && conv.room.members.length > 1 && !isForwarded(roomId, m.seq) ? act(`data-forward="${m.seq}"`, tr('发到群里'), FORWARD_ICON) : '';
  const actions = `<div class="msg-actions">${copyBtn}${speakBtn}${forwardBtn}${replyBtn}${time}</div>`;
  // AI 之间的私聊：标明谁私下发给谁、什么时候发的
  const jr = roomById(roomId);
  const shownFrom = jr?.joint ? m.fromName || jointDisplayFor(jr, m.from) : agentLabel(m.from);
  const who = m.pm
    ? `${esc(agentLabel(m.from))}<span class="pm-arrow">→</span>${esc(agentLabel(m.pm))}<span class="side-tag pm-tag" title="${tr('它们之间的私聊，群里其他成员看不到')}">${tr('AI 私聊')}</span><span class="pm-time">${esc(fmtPmTime(m.ts))}</span>`
    : `${esc(shownFrom)}${S.jointMembers?.[m.from] && !S.jointMembers[m.from].mine ? `<span class="side-tag joint-tag">${tr('远程')}</span>` : ''}`;
  return `${sep}<div class="msg agent from-${esc(baseOf(m.from))}${m.pm ? ' pm' : ''}" data-seq="${m.seq}">${avatar}<div class="msg-body"><div class="msg-name">${who}${sideTag}${model}</div>${imagesHtml(roomId, m.images)}<div class="bubble">${mdCached(
    m.text,
  )}</div><div class="msg-foot">${foot}<span class="msg-ago" data-ts="${m.ts}" title="${full}">${esc(msgAgo(m.ts))}</span></div>${actions}</div></div>`;
}

function convMessages(conv) {
  return (S.messages.get(conv.key) || []).filter((m) => inConv(conv, m));
}

// 长对话只画最近的一段（PAGE 条），往上翻快到顶时再接上更早的：
// 一次把几百条消息全放进页面，光排版就要一百多毫秒，每次打开、重画都会卡一下
const PAGE = 80;

function renderMessages() {
  const conv = currentConv();
  if (!conv) return;
  const list = convMessages(conv);
  // 换了会话就从最近的一段开始；同一个会话里重画，保持已经接上的那些
  if (S.rendered?.key !== conv.key) S.rendered = { key: conv.key, from: Math.max(0, list.length - PAGE) };
  const from = Math.min(S.rendered.from, Math.max(0, list.length - PAGE));
  S.rendered.from = from;
  const typing = document.activeElement?.classList.contains('edit-input');
  const later = boundsOf(conv).hasLater ? `<button class="load-earlier load-later" data-later>${tr('更新的消息')}</button>` : '';
  $('#messages').innerHTML = earlierHtml(from) + list.slice(from).map((m, i) => messageHtml(conv.roomId, m, list[from + i - 1], conv)).join('') + later;
  restoreEditor(typing);
  refreshFind();
  hydrateOpenSteps();
}

// 「更早的 N 条」：手边（已经取下来的）还有更早的就先接本地的；
// 都接完了、服务器上还有，就变成「加载更早的消息」，再去取一段
function earlierHtml(from) {
  if (from > 0) return `<button class="load-earlier" data-earlier>${tr('更早的 {n} 条消息', { n: from })}</button>`;
  const conv = currentConv();
  if (conv && boundsOf(conv).hasEarlier) return `<button class="load-earlier" data-earlier>${tr('加载更早的消息')}</button>`;
  return '';
}

// 接上更早的一段，滚动位置保持不动（不会跳）
async function loadEarlier(upTo = null) {
  const conv = currentConv();
  if (!conv || !S.rendered) return;
  const list = convMessages(conv);
  const old = S.rendered.from;
  const box = $('#messages');
  const s = $('#scroller');
  S.pinned = false; // 在往上看，别被拽回最底下
  if (old > 0) {
    const from = upTo === null ? Math.max(0, old - PAGE) : Math.max(0, Math.min(old - PAGE, upTo));
    const before = s.scrollHeight;
    box.querySelector('[data-earlier]')?.remove();
    // 每条的时间分隔都是按真正的上一条算的，接上更早的不用改原来那些
    const tpl = document.createElement('template');
    tpl.innerHTML = earlierHtml(from) + list.slice(from, old).map((m, i) => messageHtml(conv.roomId, m, list[from + i - 1], conv)).join('');
    box.prepend(tpl.content);
    S.rendered.from = from;
    s.scrollTop += s.scrollHeight - before;
    return;
  }
  // 本地这一段已经到头了：问服务器要更早的一段，接在最上面。
  // 边界按这个会话算（私聊有私聊自己的边界，不会被同群里后来的群消息挤掉）
  const b = boundsOf(conv);
  if (!b.hasEarlier || b.first === null) return;
  if (S.loadingEarlier.has(conv.key)) return; // 连着点两下、或者滚动触发了两次：只取一次
  S.loadingEarlier.add(conv.key);
  const gen = S.clearGen.get(conv.roomId) || 0;
  try {
    const res = await api(
      'GET',
      `/api/rooms/${conv.roomId}/messages?limit=${MSG_PAGE}&conv=${encodeURIComponent(convTag(conv))}&before=${b.first}`,
    );
    const older = Array.isArray(res) ? res : res.messages || [];
    if (S.current !== conv.key) return; // 等的这会儿已经点去别的聊天了
    if ((S.clearGen.get(conv.roomId) || 0) !== gen) return; // 等的这会儿清空了：这些旧消息不要了
    if (older.length) {
      b.first = older[0].seq;
      b.last = b.last === null ? older[older.length - 1].seq : b.last;
    }
    b.hasEarlier = !!res.hasEarlier;
    S.bounds.set(conv.key, b);
    if (!older.length) {
      box.querySelector('[data-earlier]')?.remove();
      box.insertAdjacentHTML('afterbegin', earlierHtml(0));
      return;
    }
    const before = s.scrollHeight;
    S.messages.set(conv.key, mergeMessages(conv.key, older));
    const merged = convMessages(conv);
    // 只画当前会话里的；同一个编号已经画在页面上的跳过（两次请求几乎同时回来时不会重复）
    const shown = new Set([...box.querySelectorAll('.msg[data-seq]')].map((el) => Number(el.dataset.seq)));
    const added = older.filter((m) => inConv(conv, m) && !shown.has(m.seq));
    box.querySelector('[data-earlier]')?.remove();
    if (added.length) {
      const html = added
        .map((m) => {
          const i = merged.findIndex((x) => x.seq === m.seq);
          return messageHtml(conv.roomId, m, merged[i - 1], conv);
        })
        .join('');
      box.insertAdjacentHTML('afterbegin', earlierHtml(0) + html);
      S.rendered.from = Math.max(0, merged.findIndex((m) => m.seq === added[0].seq));
    } else {
      box.insertAdjacentHTML('afterbegin', earlierHtml(0)); // 这一段里没有这个会话的消息：把按钮留在上面，接着翻
    }
    s.scrollTop += s.scrollHeight - before;
  } catch (err) {
    toast(err.message);
  } finally {
    S.loadingEarlier.delete(conv.key);
  }
}

// 只重画一条消息（编辑、朗读这些只影响一条的，不用整页重画）
function rerenderMessage(seq) {
  const conv = currentConv();
  const m = findMessage(seq);
  const el = document.querySelector(`#messages .msg[data-seq="${seq}"]`);
  if (!conv || !m || !el) return; // 不在当前页面上（比如是另一个会话的），不用管
  const typing = document.activeElement?.classList.contains('edit-input');
  const tpl = document.createElement('template');
  tpl.innerHTML = messageHtml(conv.roomId, m, m, conv); // 把自己当成上一条：不会多画一个时间分隔
  el.replaceWith(tpl.content);
  restoreEditor(typing);
}

function restoreEditor(typing) {
  const ta = document.querySelector('.edit-input');
  if (!ta || !S.editMsg) return;
  fitEditor(ta);
  renderMirror(ta, ta.previousElementSibling);
  if (typing || S.editMsg.focus) {
    S.editMsg.focus = false;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(S.editMsg.sel, S.editMsg.sel);
  }
}

// ---------------- 消息上的操作：复制、编辑、朗读 ----------------

// 私聊里的这条回复是不是已经转到群里了
function isForwarded(roomId, seq) {
  return (S.messages.get(`g:${roomId}`) || []).some((x) => x.forwardOf === seq);
}

// 「让它接着做」按钮：提醒之后它们已经说过话了（接着做过了），按钮就灰掉
function resumeButton(roomId, m) {
  const done = (S.messages.get(`g:${roomId}`) || []).some((x) => x.seq > m.seq && m.action.agents.includes(x.from));
  const names = m.action.agents.map(agentName).join(LIST_SEP);
  return `<button class="notice-action" data-resume="${esc(m.action.agents.join(','))}"${done ? ' disabled' : ''}>${done ? tr('已经接着做了') : esc(tr('让 {names} 接着做', { names }))}</button>`;
}

// 上次退出时被打断的活：点一下让它们接着做
async function resumeAgents(btn) {
  const conv = currentConv();
  if (!conv) return;
  const agents = btn.dataset.resume.split(',');
  btn.disabled = true;
  try {
    await api('POST', `/api/rooms/${conv.roomId}/resume`, { agents });
    btn.textContent = tr('已经让它接着做');
  } catch (err) {
    btn.disabled = false;
    toast(err.message);
  }
}

async function forwardMessage(seq, btn) {
  const conv = currentConv();
  if (!conv) return;
  btn.disabled = true;
  try {
    await api('POST', `/api/rooms/${conv.roomId}/forward`, { seq });
    toast(tr('已发到群里'));
    document.querySelectorAll(`[data-forward="${seq}"]`).forEach((b) => {
      if (b.classList.contains('notice-action')) {
        b.disabled = true;
        b.textContent = tr('已发到群里');
      } else b.remove();
    });
  } catch (err) {
    btn.disabled = false;
    toast(err.message);
  }
}

function findMessage(seq) {
  const conv = currentConv();
  return conv ? (S.messages.get(conv.key) || []).find((m) => m.seq === seq) : null;
}

// 复制出去的纯文字：去掉 Markdown 的记号（**加粗**、`代码`、# 标题、- 列表开头这些），像看到的那样干净；
// 代码块里的内容原样保留。列表开头换成「•」，编号列表照旧
function mdToPlain(text) {
  const blocks = [];
  let s = String(text).replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => `${blocks.push(code.replace(/\n$/, '')) - 1}`);
  s = s
    .split('\n')
    .map((line) => {
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return ''; // 分隔线
      return line
        .replace(/^(\s{0,3})#{1,6}\s+/, '$1') // 标题
        .replace(/^(\s*)>\s?/, '$1') // 引用
        .replace(/^(\s*)[-*+]\s+\[[xX]\]\s+/, '$1☑ ') // 任务清单：做完的
        .replace(/^(\s*)[-*+]\s+\[ \]\s+/, '$1☐ ') // 任务清单：没做的
        .replace(/^(\s*)[-*+]\s+/, '$1• '); // 列表
    })
    .join('\n');
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `${codes.push(c) - 1}`); // 行内代码先藏起来，里面的 * _ 不动
  s = s
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => (t === u ? u : `${t}（${u}）`))
    .replace(/\[([^\]\n]+)\]\([^\s)]+\)/g, '$1') // 本机文件链接只留文字
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1$2')
    .replace(/~~([^~\n]+)~~/g, '$1');
  return s.replace(/(\d+)/g, (_, i) => codes[i]).replace(/(\d+)/g, (_, i) => blocks[i]);
}

// 复制一条消息：带格式的那份（粘到备忘录、飞书、Word 里是加粗、列表的样子）+ 去掉记号的纯文字
async function copyMessage(seq, btn) {
  const raw = cleanMentions(findMessage(seq)?.text || '');
  const text = mdToPlain(raw);
  const bubble = document.querySelector(`#messages .msg[data-seq="${seq}"] .bubble`);
  let html = '';
  if (bubble) {
    const box = bubble.cloneNode(true);
    box.querySelectorAll('button, .avatar, img').forEach((el) => el.remove()); // 代码块上的按钮、@ 标签里的头像、图片（地址是本机的，粘到别处会裂）不要
    html = box.innerHTML;
  }
  try {
    if (html && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
    } else {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    // 老系统不让用剪贴板接口：退回到选中再复制
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  btn.innerHTML = COPIED_ICON;
  btn.title = tr('已复制');
  setTimeout(() => {
    btn.innerHTML = COPY_ICON;
    btn.title = tr('复制');
  }, 1500);
}

function fitEditor(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`;
}

// 原文里的 @Claude 换成输入框里标签的写法（@、空隙、名字，后面原来有空格的换成全角空格），编辑时也显示成带头像的标签。
// 发出去前 cleanMentions 会换回来，没改的话和原文一模一样
function toTagForm(text) {
  const conv = currentConv();
  const members = conv && !conv.dm && conv.room.members.length > 1 ? conv.room.members : [];
  if (!members.length) return text;
  return text.replace(MENTION_TAG_RE, (all, pre, name, sp) =>
    members.includes(MENTION_WHO[name.toLowerCase()]) ? `${pre}@${MENTION_GAP}${name}${sp ? MENTION_SEP : ''}` : all,
  );
}

function startEdit(seq) {
  const m = findMessage(seq);
  if (!m) return;
  const text = toTagForm(m.text || '');
  const prev = S.editMsg?.seq;
  S.editMsg = { roomId: currentConv().roomId, seq, text, sel: text.length, focus: true };
  if (prev !== undefined && prev !== seq) rerenderMessage(prev); // 同时只改一条
  rerenderMessage(seq);
}

function cancelEdit() {
  const seq = S.editMsg?.seq;
  S.editMsg = null;
  if (seq !== undefined) rerenderMessage(seq);
}

// 改好的消息作为新消息发出去，注明改的是哪条（原来的图片、回复的哪条都带上）
async function sendEdit() {
  const ed = S.editMsg;
  const conv = currentConv();
  const m = ed && findMessage(ed.seq);
  if (!m || !conv) return;
  const text = cleanMentions(ed.text).trim();
  if (!text && !m.images?.length) return toast(tr('消息是空的'));
  if (text === String(m.text || '').trim()) return cancelEdit(); // 没改
  S.editMsg = null;
  rerenderMessage(m.seq);
  try {
    await api('POST', `/api/rooms/${conv.roomId}/messages`, {
      text,
      images: (m.images || []).map((i) => i.id),
      dm: conv.dm || undefined,
      replyTo: m.replyTo?.seq,
      editOf: m.seq,
    });
  } catch (err) {
    S.editMsg = { ...ed, focus: true };
    rerenderMessage(m.seq);
    toast(err.message);
  }
}

// 朗读：用系统自带的语音（Mac 上和「朗读」功能同一套声音），有中文就挑中文语音
const HAS_SPEECH = 'speechSynthesis' in window;

// 朗读前把 Markdown 收拾成平常说话的文字：代码不念，链接只念文字
// 代码块、链接换成的那句话跟着这段话本身的语言走（有中文就念中文），不跟界面语言：语音也是按内容挑的
function speechText(src) {
  const s = String(src || '')
    .replace(/```[\s\S]*?```/g, '\uE010')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '\uE011')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, '')
    .replace(/\*\*|__|~~|\|/g, ' ')
    .replace(/<\/?私聊老板>/g, '');
  const zh = /[\u4e00-\u9fff]/.test(s);
  return s.replace(/\uE010/g, zh ? '（这里有一段代码）' : '(code block)').replace(/\uE011/g, zh ? '链接' : 'link');
}

function pickVoice(lang) {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith(lang));
  const best = (v) => (/premium|enhanced|高级|优化/i.test(v.name) ? 2 : 0) + (v.lang.replace('_', '-').toLowerCase() === 'zh-cn' ? 1 : 0);
  return voices.sort((a, b) => best(b) - best(a))[0] || null;
}

function stopSpeaking() {
  if (!HAS_SPEECH) return;
  S.speaking = null;
  speechSynthesis.cancel();
}

function toggleSpeak(seq) {
  const conv = currentConv();
  const m = findMessage(seq);
  if (!conv || !m) return;
  const prev = S.speaking?.roomId === conv.roomId ? S.speaking.seq : undefined;
  stopSpeaking();
  if (prev !== undefined) rerenderMessage(prev); // 上一条的按钮变回「朗读」
  if (prev === seq) return;
  const text = speechText(m.text);
  const zh = /[\u4e00-\u9fff]/.test(text);
  const voice = pickVoice(zh ? 'zh' : 'en');
  // 按句子切成小段排队念：一口气念太长，有的浏览器念到一半会自己停掉
  const parts = text.match(/[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+/g)?.map((s) => s.trim()).filter(Boolean) || [];
  if (!parts.length) return;
  const token = { roomId: conv.roomId, seq };
  S.speaking = token;
  parts.forEach((part, i) => {
    const u = new SpeechSynthesisUtterance(part);
    u.lang = voice?.lang || (zh ? 'zh-CN' : 'en-US');
    if (voice) u.voice = voice;
    if (i === parts.length - 1) {
      u.onend = u.onerror = () => {
        if (S.speaking !== token) return;
        S.speaking = null;
        if (currentConv()?.roomId === token.roomId) rerenderMessage(seq);
      };
    }
    speechSynthesis.speak(u);
  });
  rerenderMessage(seq);
}

function liveKey(r) {
  return `${r.roomId}:${r.agent}${r.side ? ':side' : ''}`;
}

// 这个会话里该显示哪些「正在干活」：被另一位 AI 私下找来的那一轮，显示在它俩的私聊里，不在群里
function runInConv(r, conv) {
  if (r.roomId !== (conv.roomId ?? conv.room?.id)) return false; // 侧栏的会话只记了 room
  if (r.peer) return !!conv.dm && conv.dm === (r.pmIn || r.agent); // 被别的 AI 私下找来的这一轮：显示在那段对话所在的私聊里
  return conv.dm ? (r.dm || r.withDm) && r.agent === conv.dm : !r.dm;
}

function convRuns(conv) {
  return S.runs.filter((r) => runInConv(r, conv));
}

const IDLE_WARN = 2 * 60 * 1000; // 这么久没有任何动静，就提示可能卡住了

// 「可能卡住了」的提示：本体可以换新会话重来，分身只能停止
// 最后一步是「正在整理记忆」、还没整理完（服务端给这一步标了 busy；文字会按界面语言换，不能拿文字判断，旧版只能看中文开头）
const compacting = (key) => {
  const last = (S.live.get(key) || []).at(-1);
  return last?.kind === 'compact' && (!!last.busy || String(last.text).startsWith('正在整理记忆'));
};

function idleText(r, key) {
  const idle = Date.now() - (S.liveAt.get(key) || r.startedAt);
  if (idle < IDLE_WARN) return '';
  const last = (S.live.get(key) || []).at(-1);
  if (compacting(key)) return idle < 5 * 60 * 1000 ? '' : tr('记忆已经整理了 {time}，比平时久。再等等；一直这样的话，可以点「换新会话重来」。', { time: fmtDur(idle) });
  const waiting = last?.kind === 'run' ? tr('它可能还在等一条命令跑完；') : '';
  return r.side
    ? tr('分身已经 {time} 没有任何动静了，{waiting}一直这样的话可以点「停止」。', { time: fmtDur(idle), waiting })
    : tr('已经 {time} 没有任何动静了。{waiting}一直这样的话多半是卡住了（比如会话里的大图太多），可以点「换新会话重来」，它会带上最近的聊天记录重新开始。', { time: fmtDur(idle), waiting });
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

// 排着队的：它正在另一个场合干活（比如在老板的私聊里），这边有人叫它，要等那一轮干完才来。
// 显示一张小卡片，不然看着像「没反应」；点「去看看」到它正在干活的那个聊天
function queuedHtml(conv) {
  if (!conv) return '';
  return (S.queued || [])
    .filter((q) => q.roomId === conv.roomId && (conv.dm ? q.agent === conv.dm && q.dm && q.busy !== 'dm' : q.group && q.busy !== 'group'))
    .filter((q) => !convRuns(conv).some((r) => r.agent === q.agent)) // 这里已经有它在干活（比如分身在先回话）：不再重复
    .map((q) => {
      const text =
        q.busy === 'dm' ? tr('正在私聊里干活，这边排着队，那一轮做完就来') : q.busy === 'pm' ? tr('正在私下回同事，这边排着队，那一轮做完就来') : tr('正在群里干活，这边排着队，那一轮做完就来');
      const run = S.runs.find((r) => r.roomId === q.roomId && r.agent === q.agent && !r.side);
      // 「去看看」到它正在干活的那个聊天：回同事私聊的那一轮显示在那段对话所在的私聊里
      const target = q.busy === 'group' ? `g:${q.roomId}` : `d:${q.roomId}:${q.busy === 'pm' ? run?.pmIn || q.agent : q.agent}`;
      return `<div class="msg agent live queued from-${esc(baseOf(q.agent))}">${avatarHtml(q.agent)}<div class="msg-body"><div class="msg-name">${esc(agentLabel(q.agent))}</div>
        <div class="bubble"><div class="live-head"><span class="queued-dot"></span><span class="queued-text">${esc(text)}</span><button class="live-goto" data-goto="${esc(target)}">${tr('去看看')}</button></div></div></div></div>`;
    })
    .join('');
}

// 展开的过程每来一步都会整块重画：老板停在最底下就跟着最新一步走；往上翻着看时，记住正在看的那一步，重画后放回原处
function saveLiveScroll() {
  const saved = new Map();
  document.querySelectorAll('.live-steps.open').forEach((ol) => {
    const key = ol.dataset.liveList;
    if (ol.scrollHeight - ol.scrollTop - ol.clientHeight < 24) return; // 在最底下：照旧跟着走
    const items = [...ol.children];
    const top = ol.getBoundingClientRect().top;
    const i = items.findIndex((li) => li.getBoundingClientRect().bottom > top);
    if (i < 0) return;
    saved.set(key, { index: Number(ol.dataset.dropped || 0) + i, offset: items[i].getBoundingClientRect().top - ol.getBoundingClientRect().top });
  });
  return saved;
}

function restoreLiveScroll(saved) {
  document.querySelectorAll('.live-steps.open').forEach((ol) => {
    const key = ol.dataset.liveList;
    const at = saved.get(key);
    if (!at) {
      ol.scrollTop = ol.scrollHeight;
      return;
    }
    const li = ol.children[at.index - (S.liveDropped.get(key) || 0)];
    // 正在看的那步太旧被挤掉了，就停在最上面
    ol.scrollTop = li ? ol.scrollTop + li.getBoundingClientRect().top - ol.getBoundingClientRect().top - at.offset : 0;
  });
}

function renderLive() {
  const conv = currentConv();
  const runs = conv ? convRuns(conv) : [];
  const scrolls = saveLiveScroll();
  $('#live').innerHTML = runs
    .map((r) => {
      const key = liveKey(r);
      const all = S.live.get(key) || [];
      const open = S.liveOpen.has(key);
      const shown = open ? all : all.slice(-3);
      const toggle = all.length
        ? `<button class="live-toggle${open ? ' open' : ''}" data-live-toggle="${esc(key)}">${open ? tr('收起过程 · {n} 步', { n: all.length }) : tr('展开过程 · {n} 步', { n: all.length })}
            <svg viewBox="0 0 10 10" width="8" height="8"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
        : '';
      const groupSide = r.side && !r.dm && !r.peer; // 本体在老板私聊里忙，分身先在群里回话
      const sideTag = r.side
        ? `<span class="side-tag" title="${groupSide ? tr('本体在私聊里忙，分身先来群里回话（只能看，不能改）') : r.peer ? tr('本体在群里忙，分身先来回同事的私聊（只能看，不能改）') : tr('本体在群里忙，分身先来回你的私聊（只能看，不能改）')}">${tr('分身')}</span>`
        : '';
      const enter = S.liveSeen.has(key) ? '' : ' enter';
      S.liveSeen.add(key);
      // 干活时也显示用的哪个模型、思考强度（和做完的回复同一个样子；跟随默认的显示默认的那个）
      const effortName = effortShortName(r.agent, r.model || '', r.effort || '');
      const liveModel = [modelShortName(r.agent, r.model || ''), effortName ? tr('思考 {level}', { level: effortName }) : ''].filter(Boolean).join(' · ');
      return `<div class="msg agent live from-${esc(baseOf(r.agent))}${enter}">${avatarHtml(r.agent)}<div class="msg-body"><div class="msg-name">${esc(agentLabel(r.agent))}${sideTag}${liveModel ? `<span class="msg-model">${esc(liveModel)}</span>` : ''}</div>
        <div class="bubble"><div class="live-head"><span class="typing"><i></i><i></i><i></i></span>
        <span>${r.side ? (groupSide ? tr('本体在私聊里忙，分身先来回一句') : r.peer ? tr('正在回复 {name}', { name: agentName(r.peer) }) : tr('正在回复你')) : compacting(key) ? tr('正在整理记忆') : tr('正在干活')} · <span class="elapsed" data-start="${r.startedAt}">${fmtDur(Date.now() - r.startedAt)}</span></span>
        ${toggle}${
          r.side ? '' : `<button class="live-fresh-mini" data-agent="${esc(r.agent)}" title="${tr('会话太重、卡住时用：结束这一轮，换个新会话重来')}">${tr('换新会话')}</button>`
        }<button class="live-stop" data-agent="${esc(r.agent)}" data-only="${r.side ? 'side' : 'main'}">${tr('停止')}</button></div>
        <div class="live-idle" data-idle="${esc(key)}"${idleText(r, key) ? '' : ' hidden'}><span>${esc(idleText(r, key))}</span>${
          r.side ? '' : `<button class="live-fresh" data-agent="${esc(r.agent)}">${tr('换新会话重来')}</button>`
        }</div>
        ${shown.length ? `<ol class="live-steps${open ? ' open' : ''}${S.liveAnimate === key ? ' enter' : ''}" data-live-list="${esc(key)}" data-dropped="${S.liveDropped.get(key) || 0}">${shown.map(stepHtml).join('')}</ol>` : ''}
        </div></div></div>`;
    })
    .join('') + queuedHtml(conv);
  restoreLiveScroll(scrolls);
  renderStopControls(conv);
  syncToolsRow();
}

// 停止按钮只占一个位置，免得把输入框上面那一行挤成两行：一位在干活就是「停止 谁」；
// 好几位在干就合成一个「全部停止」，要单独停某一位，点它干活气泡里的「停止」
function renderStopControls(conv) {
  const box = $('#stop-controls');
  const runs = conv ? S.runs.filter((r) => r.roomId === conv.roomId) : [];
  box.hidden = runs.length === 0;
  // 窄屏上「停止」出现后要给 @ 名字让位置：CSS 靠这两个类决定什么时候先把「接着上一位」收起来
  const tools = document.querySelector('.composer-tools');
  tools?.classList.toggle('has-stop', runs.length > 0);
  tools?.classList.toggle('has-stop-all', runs.length > 1);
  const who = stopControlWho;
  if (runs.length === 1) {
    const r = runs[0];
    // 手机上一行要同时放下 @ 按钮、接着谁和停止：停止只写「停止」，谁在干活看头像和上面的气泡
    const label = isNarrow() ? tr('停止') : tr('停止 {name}', { name: who(r) });
    setHtml(box, `<button class="chip danger" data-stop="${esc(r.agent)}" data-only="${r.side ? 'side' : 'main'}" title="${esc(tr('停止 {name}', { name: who(r) }))}">${avatarHtml(r.agent)}${esc(label)}</button>`);
  } else if (runs.length > 1) {
    const faces = [...new Set(runs.map((r) => r.agent))].map((a) => avatarHtml(a)).join('');
    setHtml(box, `<button class="chip danger strong" data-stop="" title="${esc(tr('{names} 正在干活。要单独停某一位，点它气泡里的「停止」', { names: runs.map(who).join(LIST_SEP) }))}"><span class="chip-stack">${faces}</span>${tr('全部停止')}</button>`);
  } else setHtml(box, '');
  fitTools();
  updateSendButton(); // 有人在干活、输入框空着时，手机上的发送键要变成停止
}

// 输入框上面那一行始终只占一行：电脑上放不下时 @ 按钮只留头像；手机上横着滚，名字都留着
function fitTools() {
  const row = document.querySelector('.composer-tools');
  if (!row || row.hidden) return;
  row.classList.remove('compact');
  // 手机上放不下时在那一行里横着滚，@ 按钮仍然带头像和名字（只留头像看不出是谁）
  const over = row.scrollWidth > row.clientWidth + 1;
  row.classList.toggle('compact', over);
}

// ---------------- 消息区的滚动条和「回到最新」按钮 ----------------
// 系统滚动条藏起来（顶栏、输入区浮在消息上，会把它两头盖住），换成自己画的一条：只在两者之间，
// 鼠标移到右边缘才出现，可以拖、可以点。往上翻离最新消息远了，右下角出现「回到最新」按钮（仿飞书），翻上去时来的新消息数也标在上面

function updateScrollbar() {
  const s = $('#scroller');
  const bar = $('#scrollbar');
  const thumb = bar.firstElementChild;
  const max = s.scrollHeight - s.clientHeight;
  bar.classList.toggle('none', max <= 1);
  if (max <= 1) return;
  const track = bar.clientHeight;
  const h = Math.min(track, Math.max(36, Math.round((track * s.clientHeight) / s.scrollHeight)));
  thumb.style.height = `${h}px`;
  thumb.style.transform = `translateY(${Math.round(((track - h) * s.scrollTop) / max)}px)`;
}

function updateToBottom() {
  const s = $('#scroller');
  const btn = $('#btn-to-bottom');
  const far = s.scrollHeight - s.scrollTop - s.clientHeight > Math.max(240, s.clientHeight * 0.5);
  if (!far) S.newBelow = 0;
  btn.classList.toggle('show', far);
  btn.tabIndex = far ? 0 : -1;
  const n = btn.querySelector('.to-bottom-count');
  n.hidden = !S.newBelow;
  n.textContent = S.newBelow > 99 ? '99+' : String(S.newBelow);
  btn.title = S.newBelow ? tr('有 {n} 条新消息，回到最新', { n: S.newBelow }) : tr('回到最新消息');
}

async function jumpToBottom() {
  const conv = currentConv();
  if (conv && boundsOf(conv).hasLater) await loadLatestWindow(); // 跳到过老消息：先把最新的一段取回来
  const s = $('#scroller');
  S.newBelow = 0;
  const target = s.scrollHeight - s.clientHeight;
  // 离得太远：先一下跳到离底部一屏多的地方，再平滑滚完（不然要滚好几秒）
  if (target - s.scrollTop > s.clientHeight * 2) s.scrollTop = target - s.clientHeight * 1.5;
  s.scrollTo({ top: s.scrollHeight, behavior: reduceMotion() ? 'auto' : 'smooth' });
  // 滚动期间图片可能加载出来把列表撑高：最后对准一次，并恢复「贴着最底下」
  setTimeout(() => {
    scrollToBottom();
    S.pinned = true;
    updateToBottom();
  }, 450);
}

function bindScrollbar() {
  const s = $('#scroller');
  const bar = $('#scrollbar');
  const thumb = bar.firstElementChild;
  let hideTimer = 0;
  let grab = null; // 拖动时，鼠标按在滑块上的位置
  const show = (on) => {
    clearTimeout(hideTimer);
    if (on) bar.classList.add('show');
    else if (grab === null) hideTimer = setTimeout(() => bar.classList.remove('show'), 600);
  };
  $('#chat').addEventListener('mousemove', (e) => {
    const r = bar.getBoundingClientRect();
    show(e.clientX >= r.left - 18 && e.clientY >= r.top && e.clientY <= r.bottom);
  });
  $('#chat').addEventListener('mouseleave', () => show(false));
  const moveTo = (y) => {
    const r = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (y - r.top - grab) / Math.max(1, r.height - thumb.offsetHeight)));
    s.scrollTop = ratio * (s.scrollHeight - s.clientHeight);
  };
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const t = thumb.getBoundingClientRect();
    // 按在滑块上就从按住的地方拖；按在空白处，滑块先跳过来（中心对准鼠标）
    grab = e.clientY >= t.top && e.clientY <= t.bottom ? e.clientY - t.top : t.height / 2;
    S.pinned = false;
    bar.classList.add('dragging');
    bar.setPointerCapture(e.pointerId);
    moveTo(e.clientY);
  });
  bar.addEventListener('pointermove', (e) => grab !== null && moveTo(e.clientY));
  const end = () => {
    if (grab === null) return;
    grab = null;
    bar.classList.remove('dragging');
    show(false);
    if (S.rendered?.from && s.scrollTop < 400) loadEarlier(); // 拖的时候不接更早的消息（滑块会跳），松手再接
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.dragging = () => grab !== null;
  s.addEventListener(
    'scroll',
    () => {
      requestAnimationFrame(updateScrollbar);
      updateToBottom();
    },
    { passive: true },
  );
  const ro = new ResizeObserver(() => requestAnimationFrame(() => (updateScrollbar(), updateToBottom())));
  ro.observe(s, { box: 'border-box' }); // 只看外框：顶栏、输入区变高时上下留白会变，那不用管
  ro.observe($('#messages'));
  $('#btn-to-bottom').onclick = jumpToBottom;
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
  S.jointMembers = {};
  syncJointMembers(); // 先把对方成员的名字/头像备好，消息先画也能对上名字
  S.folders = st.folders || [];
  rebuildMembers();
  S.defaults = st.defaults || {};
  S.engines = st.engines || {};
  S.usage = st.usage || {};
  S.projectsDir = st.projectsDir || '';
  S.queued = st.queued || [];
  setRuns(st.runs || []);
  if (st.restartPending) setRestartPending(st.restartPending, '', true);
  showUpdateRollback(st.updateRollback);
}

// 升级以后新版本没起来、自动退回了旧版本：告诉老板一声（同一次回退只说一次）
function showUpdateRollback(info) {
  if (!info) return;
  const short = (v) => String(v || '').slice(0, 7) || '?';
  const to = info.toVersion || short(info.to);
  const from = info.fromVersion || short(info.from);
  const tag = `${info.from || ''}→${info.to || ''}`;
  if (tag && storeGet('clawchat.rollbackSeen') === tag) return;
  if (tag) storeSet('clawchat.rollbackSeen', tag);
  toast(tr('升级到 {to} 后没能启动，已经自动退回 {from}', { to, from }), 8000);
}

function setRuns(runs) {
  S.runs = runs;
  const keys = new Set(runs.map(liveKey));
  for (const k of [...S.live.keys()]) if (!keys.has(k)) { S.live.delete(k); S.liveDropped.delete(k); }
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

// 私聊里也要知道群里有没有这条（「发到群里」按钮转过的就不再显示）：后台把群里的最近一段取一份
function primeGroupMessages(roomId) {
  const key = `g:${roomId}`;
  if (S.messages.has(key)) return;
  loadMessages({ key, roomId, dm: null }).catch(() => {});
}

// 打开聊天时只取最近一段：大群有几 MB，全部取过来又慢又占内存。往上翻、跳到老消息时再补
const MSG_PAGE = 150;

function mergeMessages(key, incoming) {
  const map = new Map((S.messages.get(key) || []).map((m) => [m.seq, m]));
  for (const m of incoming) if (!map.has(m.seq)) map.set(m.seq, m);
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

// 会话在接口里的名字：群里是 g，和某位的私聊是 d:<成员>（和搜索里的算法一样）
const convTag = (conv) => (conv.dm ? `d:${conv.dm}` : 'g');
// 一个群里所有会话的缓存 key（群 + 各个私聊）：清空、删群时一起清
function convKeysOfRoom(roomId) {
  const out = [`g:${roomId}`];
  for (const map of [S.messages, S.bounds, S.early]) for (const k of map.keys()) if (k.startsWith(`d:${roomId}:`)) out.push(k);
  return [...new Set(out)];
}
const boundsOf = (conv) => S.bounds.get(conv.key) || { first: null, last: null, hasEarlier: false, hasLater: false };
function setBounds(conv, messages, res) {
  const b = { ...boundsOf(conv) };
  b.hasEarlier = !!res.hasEarlier;
  b.hasLater = !!res.hasLater;
  if (messages.length) {
    b.first = messages[0].seq;
    b.last = messages[messages.length - 1].seq;
  }
  S.bounds.set(conv.key, b);
}
// 来了新消息：这个会话已经取到的最新一条跟着往后挪（不然「更新的消息」会误判）
function touchBounds(convKey, m) {
  const b = S.bounds.get(convKey);
  if (b && (b.last === null || m.seq > b.last)) b.last = m.seq;
}

async function loadMessages(conv) {
  if (S.messages.has(conv.key)) return true;
  const gen = S.clearGen.get(conv.roomId) || 0;
  try {
    const res = await api('GET', `/api/rooms/${conv.roomId}/messages?limit=${MSG_PAGE}&conv=${encodeURIComponent(convTag(conv))}`);
    const messages = Array.isArray(res) ? res : res.messages || []; // 服务端不认识分页参数时会发来全部（老版本）
    if ((S.clearGen.get(conv.roomId) || 0) !== gen) return true; // 等的这会儿清空了：空的就是对的
    const merged = mergeMessages(conv.key, [...messages, ...(S.early.get(conv.key) || [])]);
    S.early.delete(conv.key);
    S.messages.set(conv.key, merged);
    setBounds(conv, arrSorted(merged), res);
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

// 边界只跟这一段的最后一条有关：按编号排好再算（SSE 先到的消息可能排在后面）
const arrSorted = (list) => list.slice().sort((a, b) => a.seq - b.seq);

// 要跳到一条还没取下来的老消息：取它附近的一段，整段画出来再跳
async function ensureSeqLoaded(seq) {
  const conv = currentConv();
  if (!conv) return false;
  if ((S.messages.get(conv.key) || []).some((m) => m.seq === seq)) return true;
  const gen = S.clearGen.get(conv.roomId) || 0;
  try {
    const res = await api('GET', `/api/rooms/${conv.roomId}/messages?limit=${MSG_PAGE}&conv=${encodeURIComponent(convTag(conv))}&around=${seq}`);
    const around = Array.isArray(res) ? res : res.messages || [];
    if (!around.length || S.current !== conv.key) return false;
    if ((S.clearGen.get(conv.roomId) || 0) !== gen) return false; // 等的这会儿清空了：旧消息不要了
    // 整段换掉：和原来那段之间隔着没取下来的消息，混在一起会跳号
    const map = new Map(around.map((m) => [m.seq, m]));
    S.messages.set(conv.key, [...map.values()].sort((a, b) => a.seq - b.seq));
    setBounds(conv, arrSorted(around), res);
    S.rendered = { key: conv.key, from: 0 };
    renderMessages();
    return true;
  } catch {
    return false;
  }
}

// 跳到过很老的一段以后，再回到最新的这一段
async function loadLatestWindow() {
  const conv = currentConv();
  if (!conv) return false;
  const gen = S.clearGen.get(conv.roomId) || 0;
  const old = S.messages.get(conv.key) || [];
  const tail = old.length ? old[old.length - 1].seq : -1;
  try {
    const res = await api('GET', `/api/rooms/${conv.roomId}/messages?limit=${MSG_PAGE}&conv=${encodeURIComponent(convTag(conv))}`);
    const latest = Array.isArray(res) ? res : res.messages || [];
    if (!latest.length || S.current !== conv.key) return false;
    if ((S.clearGen.get(conv.roomId) || 0) !== gen) return false;
    // 等的时候真正收到的新消息（比原来最后一条还新）：留着，别被这一页盖掉
    const arrived = (S.messages.get(conv.key) || []).filter((m) => m.seq > tail);
    const merged = new Map([...latest, ...arrived].map((m) => [m.seq, m]));
    // 整段换掉：中间没取下来的那段不用留
    S.messages.set(conv.key, [...merged.values()].sort((a, b) => a.seq - b.seq));
    setBounds(conv, arrSorted([...merged.values()]), res);
    const list = convMessages(conv);
    S.rendered = { key: conv.key, from: Math.max(0, list.length - PAGE) };
    renderMessages();
    S.newBelow = 0;
    S.pinned = true;
    scrollToBottom();
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

// ---------------- 草稿：每个会话各管各的 ----------------
// 切走时记下输入框里还没发的字，切回来再放回去；存在本机，关掉重开也还在
function loadDrafts() {
  try {
    return JSON.parse(storeGet('clawchat.drafts') || '{}') || {};
  } catch {
    return {};
  }
}

function saveDraft(key) {
  if (!key) return;
  const text = $('#input').value;
  if (text.trim()) S.drafts[key] = text;
  else delete S.drafts[key];
  storeSet('clawchat.drafts', JSON.stringify(S.drafts));
}

// 待发送的图片也按会话存一份草稿：切走时收起来，切回来放回去。传好了的（服务端已经有这张图）记在本机，
// 关掉 ClawChat 再打开也还在；还在上传、传失败的只留在内存里
function saveAttachDrafts() {
  const out = {};
  const all = [...S.attachDrafts];
  if (S.current && S.attachments.length) all.push([S.current, S.attachments]); // 正在看的这个会话也存：粘了图没切走就关掉，下次也还在
  for (const [key, list] of all) {
    const done = list.filter((a) => a.status === 'done' && a.id).map((a) => ({ id: a.id, roomId: a.roomId }));
    if (done.length) out[key] = done;
  }
  storeSet('clawchat.attachDrafts', JSON.stringify(out));
}

function loadAttachDrafts() {
  try {
    for (const [key, list] of Object.entries(JSON.parse(storeGet('clawchat.attachDrafts') || '{}') || {})) {
      if (!Array.isArray(list)) continue;
      const atts = list
        .filter((a) => /^[a-f0-9]{16}s?\.(png|jpg|gif|webp)$/.test(a?.id || '') && /^[a-f0-9]+$/.test(a?.roomId || ''))
        .map((a) => ({ url: `/api/rooms/${a.roomId}/uploads/${a.id}`, status: 'done', id: a.id, error: '', roomId: a.roomId, fresh: false, remote: true }));
      if (atts.length) S.attachDrafts.set(key, atts);
    }
  } catch {}
}

function stashAttachments(key) {
  if (key && S.attachments.length) S.attachDrafts.set(key, S.attachments);
  else if (key) S.attachDrafts.delete(key);
  S.attachments = [];
  saveAttachDrafts();
}

// 群被清空、删掉了：服务端的图片已经删了，这个群（连同私聊）没发出去的图片草稿也一起扔掉，免得留着坏图
function dropRoomAttachments(roomId) {
  for (const k of [...S.attachDrafts.keys()]) if (parseKey(k)?.roomId === roomId) S.attachDrafts.delete(k);
  if (currentConv()?.roomId === roomId) {
    for (const a of S.attachments) URL.revokeObjectURL(a.url);
    S.attachments = [];
    renderAttachments();
  }
  saveAttachDrafts();
}

function restoreAttachments(key) {
  S.attachments = S.attachDrafts.get(key) || [];
  S.attachDrafts.delete(key);
  renderAttachments();
}

function loadDraft(key) {
  $('#input').value = S.drafts[key] || '';
  hideMentionMenu();
  autoGrow();
}

// keepFocus：从侧栏点进来、用键盘上下切过来的，焦点留在侧栏（接着按上下还能切；直接打字会跳到输入框）
// ---------------- 手机版（≤600 宽）：聊天列表和聊天单页切换 ----------------
const isNarrow = () => window.matchMedia('(max-width: 600px)').matches;

// 从列表点进聊天：地址记进浏览器历史，手机上的返回键/侧滑也能回到列表
function enterMobileChat(key, { fromHistory = false } = {}) {
  if (!isNarrow()) return;
  const root = document.documentElement;
  root.classList.add('mobile-chat');
  if (document.activeElement && document.activeElement !== $('#input')) document.activeElement.blur?.();
  if (fromHistory) return;
  const state = { clawchatKey: key };
  const url = `#${encodeURIComponent(key)}`;
  // 已经在聊天里换了一个聊天：替换这一条历史，返回键仍然是回列表
  if (history.state?.clawchatKey) history.replaceState(state, '', url);
  else history.pushState(state, '', url);
}

// 手机键盘弹起来时，整个界面跟着可视区域缩，输入框不会被键盘挡住
function bindMobileViewport() {
  const vv = window.visualViewport;
  const sync = () => {
    const root = document.documentElement.style;
    if (!isNarrow()) {
      root.removeProperty('--vvh');
      root.removeProperty('--vvtop');
      return;
    }
    // iPhone 弹键盘时，看得见的那块区域（visual viewport）会变矮，整页还会被往上推一截（offsetTop）：
    // 界面按它的高度缩、再挪到它的位置上，输入框正好贴着键盘，中间不会空出一大段
    root.setProperty('--vvh', `${Math.round(vv?.height || window.innerHeight)}px`);
    root.setProperty('--vvtop', `${Math.round(vv?.offsetTop || 0)}px`);
    fitAtPanel();
    if (document.activeElement === $('#input') && S.pinned) scrollToBottom();
  };
  if (vv) {
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
  }
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', () => setTimeout(sync, 120));
  // 横竖屏切换后提示语长短可能不一样；输入框的最大高度也跟着窄/宽屏变一下
  window.addEventListener('resize', () => {
    const conv = currentConv();
    if (conv && !$('#chat').hidden) renderTargets(conv.room, conv.dm);
    if (!isNarrow()) closeAtPanel();
    fitAtPanel();
    autoGrow();
  });
  sync();
}

function exitMobileChat() {
  document.documentElement.classList.remove('mobile-chat');
  closeAtPanel();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  document.activeElement?.blur?.(); // 回列表时把键盘收起来
}

window.addEventListener('popstate', (e) => {
  if (!isNarrow()) return;
  const key = e.state?.clawchatKey;
  if (key) {
    document.documentElement.classList.add('mobile-chat');
    if (S.current !== key) openConv(key, { fromHistory: true });
  } else exitMobileChat();
});

async function openConv(key, { keepFocus = false, stayList = false, fromHistory = false } = {}) {
  const c = parseKey(key);
  if (!c || !roomById(c.roomId)) return;
  if (!stayList) enterMobileChat(key, { fromHistory }); // 手机上点开聊天就切到聊天页；启动时留在列表
  if (c.dm && !S.openedDms.has(key)) S.openedDms.set(key, Date.now());
  const switching = S.current !== key;
  if (switching) {
    // 要打开的聊天在收起的收纳组、或者收起的群底下（比如从搜索里点过来）：先展开，免得侧栏里找不到它
    const folder = roomById(c.roomId)?.folder;
    if (folder && collapsedFolders.delete(folder)) storeSet('clawchat.folderCollapsed', JSON.stringify([...collapsedFolders]));
    if (c.dm && collapsed.delete(c.roomId)) storeSet('clawchat.collapsed', JSON.stringify([...collapsed]));
    closeFind();
    saveDraft(S.current);
    stashAttachments(S.current); // 还没发出去的图片跟着这个会话收起来，切回来时还在
    closeAtPanel();
    cancelReply();
    S.editMsg = null; // 正在改的消息是别的会话的，别带过去
  }
  S.current = key;
  if (switching) {
    S.newBelow = 0;
    loadDraft(key);
    restoreAttachments(key);
    refreshSessionImages(c.roomId);
  }
  storeSet('clawchat.current', key);
  S.unread.delete(key);
  renderConvs();
  revealSideItem(key); // 群多的时候，打开的这个可能在侧栏下面看不见
  renderShell();
  if (!S.messages.has(c.key)) $('#messages').innerHTML = '';
  if (!(await loadMessages(c)) || S.current !== key) return;
  if (c.dm) primeGroupMessages(c.roomId); // 私聊里的「发到群里」要看群里有没有这段，顺手把群里的消息取一份
  if (currentConv()) renderTargets(currentConv().room, currentConv().dm); // 消息读到了，才知道「上一位」是谁
  renderMessages();
  renderLive();
  scrollToBottom();
  replay($('#scroller'), 'switching');
  if (!keepFocus && !stayList && !isNarrow()) $('#input').focus(); // 手机上等老板自己点输入框，别一进聊天就弹键盘
}

// ---------------- 系统通知 ----------------
// ClawChat 不在前台时，AI 回了话（或者出错了）就发一条系统通知；同一个会话只留最新一条，点一下直接打开那个会话
const notifyOn = () => storeGet('clawchat.notify') !== 'off';

function notifyReply(roomId, m, key) {
  if (!notifyOn() || document.hasFocus()) return;
  const room = roomById(roomId);
  if (!room) return;
  const solo = room.members.length === 1;
  const title = m.from === 'system'
    ? `ClawChat · ${room.name}`
    : m.pm
      ? `${agentName(m.from)} ${pmVerb(m)} ${agentName(m.pm)} · ${room.name}`
      : m.dm && !solo ? tr('{name}（私聊）', { name: agentName(m.from) }) : solo ? agentName(m.from) : `${agentName(m.from)} · ${room.name}`;
  const body = plainSnippet(m.text, 140) || (m.images?.length ? tr('[图片]') : '');
  if (hasNative()) return native({ type: 'notify', title, body, key });
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, tag: key, icon: '/favicon.png' });
  n.onclick = () => {
    window.focus();
    openConv(key);
    n.close();
  };
}

// 浏览器（比如 Windows 上的 Edge 窗口）要先问一次通知权限，而且得在点击之类的操作里问
function askNotifyPermission() {
  if (hasNative() || !notifyOn() || !('Notification' in window) || Notification.permission !== 'default') return;
  Notification.requestPermission().catch(() => {});
}
window.__clawchatOpenConv = (key) => openConv(key);

// 群里最后说话的那位 AI（不算私聊）：不 @ 人时「接着上一位」就发给它
function lastSpeakerOf(room) {
  const list = S.messages.get(`g:${room.id}`) || []; // 只看群里的消息，私聊里说的话不算
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m.dm && !m.pm && room.members.includes(m.from)) return m.from;
  }
  return room.members.includes(room.lastAgent) ? room.lastAgent : null; // 聊天记录刚清空过：用清空前记下的那位
}

// 「不 @ 时」下拉框和输入框里的提示：接着上一位时写明现在是谁，打字前、打字时都看得到这条会发给谁
// 回复某位 AI 时，这条实际只发给它（又 @ 了别人就按 @ 的来）：
// 输入框提示和「不 @ 时」那一处都得跟着变，别让人以为还会发给「接着上一位」那位
function replyAgentOf(conv) {
  if (!conv || !S.replyTo) return null;
  const from = S.replyTo.from;
  if (!from || from === 'user' || from === conv.dm) return null; // 私聊里、回复自己的消息：不影响收件人
  return conv.room.members.includes(from) || (conv.room.jointMembers || []).some((m) => m.key === from) ? from : null;
}

// 回复期间输入框里 @ 了谁：@所有人算 all，其余按成员列出来
function replyMentions(conv) {
  if (!conv || conv.dm || (conv.room.members.length < 2 && !conv.room.joint)) return { all: false, named: [] };
  const tokens = mentionTokens($('#input').value || '');
  return {
    all: tokens.some((t) => t.who === 'all'),
    named: [...new Set(tokens.map((t) => t.who).filter((a) => a !== 'all' && (conv.room.members.includes(a) || (conv.room.jointMembers || []).some((m) => m.key === a))))],
  };
}

// 输入框的占位提示：回复某位时写成「回复 X，只有它会回答」；又 @ 了别人就按 @ 的写
function placeholderFor(room, dm) {
  const narrow = isNarrow();
  const dn = (a) => jointDisplayFor(room, a);
  if (dm) return tr('私聊 {name}', { name: agentName(dm) });
  const conv = currentConv();
  const reply = replyAgentOf(conv);
  if (reply) {
    const { all, named } = replyMentions(conv);
    if (all) return narrow ? tr('发给所有人') : tr('发给所有人（回复 {name}）', { name: dn(reply) });
    if (named.length) {
      const names = named.map(dn).join(LIST_SEP);
      return narrow ? tr('发给 {names}', { names }) : tr('发给 {names}（@ 的才会回答）', { names });
    }
    return narrow ? tr('回复 {name}', { name: dn(reply) }) : tr('回复 {name}，只有它会回答', { name: dn(reply) });
  }
  const last = lastSpeakerOf(room);
  if (room.members.length > 1 && room.defaultTarget === 'last' && last) {
    return narrow ? tr('发给 {name}', { name: dn(last) }) : tr('发给 {name}（接着上一位），要找别人就 @ 它', { name: dn(last) });
  }
  return window.innerWidth <= 360 ? tr('说点什么…') : tr('发送给 {name}', { name: room.name }); // 320 这种窄屏放不下长群名
}

// 回复期间：电脑上把「不 @ 时」下拉换成一句说明（不改群设置）；手机 @ 面板开着的话一起重画
function syncReplyTargets() {
  const conv = currentConv();
  if (!conv) return;
  const { room, dm } = conv;
  $('#input').placeholder = placeholderFor(room, dm);
  const reply = replyAgentOf(conv);
  const target = document.querySelector('.composer-tools .target');
  const note = $('#reply-target-note');
  if (target) target.style.display = reply ? 'none' : ''; // .target 是 display:flex，用 hidden 盖不住
  if (note) {
    note.hidden = !reply;
    if (reply) {
      const { all, named } = replyMentions(conv);
      const replyName = jointDisplayFor(room, reply);
      note.textContent = all
        ? tr('发给所有人（回复 {name}）', { name: replyName })
        : named.length
          ? tr('发给 @ 的人（回复 {name}）', { name: replyName })
          : tr('只发给 {name}（回复中）', { name: replyName });
      note.title = tr('取消回复后恢复「不 @ 时发给」的设置');
    }
  }
  const panel = $('#at-panel');
  if (panel && !panel.hidden) panel.innerHTML = atPanelHtml(); // 面板里的「不 @ 时发给」也要跟着变
}

function renderTargets(room, dm) {
  const many = room.members.length > 2;
  const last = lastSpeakerOf(room);
  const dn = (a) => jointDisplayFor(room, a);
  // 手机上下拉框是个小胶囊：「接着上一位」和电脑上一样带上是谁（括号里），其余选项写短一点
  const narrow = isNarrow();
  const targets = [
    ['last', last ? tr('接着上一位（{name}）', { name: dn(last) }) : tr('接着上一位')],
    ['all', many ? tr('大家同时开工') : tr('两位同时开工')],
    ['sequential', many ? tr('大家依次回答') : tr('两位依次回答')],
    ...room.members.map((a) => [a, narrow ? dn(a) : tr('只发给 {name}', { name: dn(a) })]),
  ];
  setHtml($('#default-target'), targets.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join(''));
  $('#default-target').value = room.defaultTarget;
  syncReplyTargets(); // 占位提示、回复期间的说明都按当前状态重算
}

function onMessage(roomId, m) {
  if (m.from === 'gpt' || (m.from === 'system' && m.action?.type === 'fresh')) refreshSessionImages(roomId);
  const key = convOf(roomId, m); // 这条属于哪个会话：群、某人跟老板的私聊、或者两位 AI 之间的私聊
  const list = S.messages.get(key);
  if (list) {
    if (list.some((x) => x.seq === m.seq)) return;
    list.push(m);
    touchBounds(key, m);
  } else {
    if (!S.early.has(key)) S.early.set(key, []);
    S.early.get(key).push(m);
  }
  const conv = currentConv();
  if (conv && conv.roomId === roomId && !m.dm && !m.pm && conv.room.members.includes(m.from)) renderTargets(conv.room, conv.dm);
  if (list && conv && conv.roomId === roomId && inConv(conv, m)) {
    const near = nearBottom() || m.from === 'user';
    if (!near && m.from !== 'system') S.newBelow = (S.newBelow || 0) + 1;
    const shown = convMessages(conv);
    const tpl = document.createElement('template');
    tpl.innerHTML = messageHtml(roomId, m, shown[shown.length - 2], conv);
    for (const el of tpl.content.children) el.classList.add('enter');
    $('#messages').appendChild(tpl.content);
    if (near) scrollToBottom();
    updateToBottom();
  }
  if (m.from !== 'user' && m.from !== 'system') {
    const focused = document.hasFocus();
    if (S.current !== key || !focused) {
      S.unread.set(key, (S.unread.get(key) || 0) + 1);
      renderConvs();
    }
    if (!focused || (m.dm && S.current !== key)) native({ type: 'attention' });
    if (m.dm && S.current !== key) toast(tr('{name} 私聊你：{text}', { name: agentName(m.from), text: firstLine(m.text).slice(0, 40) }), 4000);
    notifyReply(roomId, m, key);
  } else if (m.from === 'system' && /出错/.test(m.text || '')) {
    notifyReply(roomId, m, key);
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'message':
      onMessage(ev.roomId, ev.message);
      break;
    case 'joint-pair':
      // 有人拿邀请码来加入：弹给老板确认（对方在场，不能自动同意）
      openJointApprove(ev);
      break;
    case 'joint-approval':
      // 对方请我这边 AI 动手：先让老板点头
      openJointApproval(ev);
      break;
    case 'joint-approval-done':
      if (S.jointApproval?.approvalId === ev.approvalId) {
        S.jointApproval = null;
        closeDialog($('#dlg-joint-action'));
        toast(ev.approved ? tr('对方已经开始动手') : tr('这次动手请求已经结束，只讨论'));
      }
      break;
    case 'joint-biometric-enrolled':
      // Mac 外壳刚登记了这台电脑的 Touch ID：让老板知道以后私钥类文件要按指纹
      toast(tr('这台电脑的 Touch ID 已登记，之后发私钥类文件需要按指纹'), 6000);
      break;
    case 'joint-file-request':
      // 对方想要一个文件：先让本机老板选文件，选完再显示确认框
      openJointFileRequest(ev);
      break;
    case 'joint-file-arrived':
      toast(tr('文件已收到：{name}，在联合群收件箱里', { name: ev.name || tr('文件') }), 6000);
      if ($('#dlg-joint-inbox')?.open) openJointInbox();
      break;
    case 'joint-file-failed':
      toast(tr('文件没收到：{name}', { name: ev.name || tr('文件') }), 6000);
      break;
    case 'step': {
      const k = liveKey(ev);
      const arr = S.live.get(k) || [];
      arr.push(ev.step);
      if (arr.length > 300) S.liveDropped.set(k, (S.liveDropped.get(k) || 0) + arr.splice(0, arr.length - 300).length);
      S.live.set(k, arr);
      S.liveAt.set(k, Date.now());
      if (currentConv()?.roomId === ev.roomId) keepBottom(renderLive);
      break;
    }
    case 'status':
      S.queued = ev.queued || [];
      setRuns(ev.runs || []);
      renderConvs();
      keepBottom(renderLive);
      break;
    case 'usage':
      S.usage = ev.usage || {};
      renderUsage();
      break;
    case 'agents':
      S.agents = ev.agents || {};
      rebuildMembers();
      renderShell();
      renderEngines();
      break;
    case 'rooms':
      S.rooms = ev.rooms || [];
      S.jointMembers = {};
      syncJointMembers();
      buildMentionRes();
      buildMentionItems();
      if (S.current && !currentConv()) S.current = null;
      renderConvs();
      renderShell();
      renderEngines(); // 侧栏的黄色提醒只管有聊天用到的程序
      break;
    case 'cleared':
      // 这个群的聊天记录被清空了：本地的也清掉，正在看的话重画
      for (const k of convKeysOfRoom(ev.roomId)) {
        S.messages.delete(k);
        S.bounds.delete(k);
        S.early.delete(k);
        S.loadingEarlier.delete(k);
      }
      S.clearGen.set(ev.roomId, (S.clearGen.get(ev.roomId) || 0) + 1); // 清空前发出去的取消息请求，回来也不要了
      dropRoomAttachments(ev.roomId);
      const cur = currentConv();
      if (cur && cur.roomId === ev.roomId) S.messages.set(cur.key, []); // 正在看的不是被清的这个群时，别动它
      for (const k of [...S.unread.keys()]) if (parseKey(k)?.roomId === ev.roomId) S.unread.delete(k);
      for (const k of [...S.openedDms.keys()]) if (parseKey(k)?.roomId === ev.roomId && k !== S.current) S.openedDms.delete(k); // 没消息的私聊别留在侧栏
      if (currentConv()?.roomId === ev.roomId) {
        closeFind();
        cancelReply(); // 正在回复、正在改的那条已经没了
        S.editMsg = null;
        S.rendered = null;
        renderMessages();
      }
      renderConvs();
      break;
    case 'folders':
      S.folders = ev.folders || [];
      renderConvs();
      break;
    case 'engines':
      S.engines = ev.engines || {};
      renderEngines();
      renderShell(); // 模型列表可能多了新模型
      refreshInstallButtons();
      if ($('#dlg-room')?.open) {
        updateMemberStates();
        syncMemberFields(); // 登录、安装完成时，建群提示跟着更新
      }
      offerClaudeCode('start');
      break;
    case 'installing':
      S.installing[ev.engine] = !!ev.on;
      refreshInstallButtons();
      renderEngines();
      break;
    case 'restarting':
      showRestarting();
      break;
    case 'restart-pending':
      setRestartPending(ev.waiting, ev.error);
      break;
    case 'quitting':
      showQuit();
      break;
    case 'icons':
      // 服务刚下载好 DeepSeek 的官方头像：换个地址让浏览器重新取（之前取不到的结果可能被记住了）
      document.documentElement.style.setProperty('--ds-icon', `url("/icons/deepseek.png?v=${Date.now()}")`);
      detectIcons(`?v=${Date.now()}`);
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
      S.bounds.clear();
      S.early.clear();
      for (const r of S.rooms) S.clearGen.set(r.id, (S.clearGen.get(r.id) || 0) + 1);
      renderEngines();
      renderConvs();
      // 手机上停在列表页重连时，别自动跳进原来的聊天
      const stayList = isNarrow() && !document.documentElement.classList.contains('mobile-chat');
      if (currentConv()) openConv(S.current, { stayList });
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
        ${a.status === 'uploading' ? `<span class="att-state">${tr('上传中…')}</span>` : a.status === 'error' ? `<span class="att-state" title="${esc(a.error)}">${tr('失败')}</span>` : ''}
        <button class="att-remove" data-i="${i}" title="${tr('移除')}">×</button>
      </div>`,
    )
    .join('');
  for (const a of S.attachments) a.fresh = false; // 进场动画只播一次
  updateSendButton();
  saveAttachDrafts();
  renderVisionHint(); // 挂了图：看看这次要回话的模型能不能看图
}

// ---------------- 图片和模型能不能看图 ----------------
// 这条消息实际会发给谁：跟着 @ 名单、回复对象、群设置里的「不 @ 时发给」走，和 lib/hub.js 的规则一致
function composeTargets(conv) {
  const room = conv.room;
  if (conv.dm) return [conv.dm];
  const remote = (room.jointMembers || []).filter((m) => !m.mine).map((m) => m.key);
  if (room.members.length === 1 && !room.joint) return [...room.members];
  const tokens = mentionTokens($('#input').value || '');
  if (tokens.some((t) => t.who === 'all')) return [...room.members, ...remote];
  const named = [...new Set(tokens.map((t) => t.who).filter((a) => a !== 'all' && (room.members.includes(a) || remote.includes(a))))];
  if (named.length) return named;
  if (S.replyTo && (room.members.includes(S.replyTo.from) || remote.includes(S.replyTo.from))) return [S.replyTo.from];
  if (room.defaultTarget === 'last') {
    const last = lastSpeakerOf(room); // 还没人说过话：服务端会发给所有人
    return last ? [last] : [...room.members];
  }
  if (room.defaultTarget === 'all' || room.defaultTarget === 'sequential') return [...room.members];
  return room.members.includes(room.defaultTarget) ? [room.defaultTarget] : [...room.members];
}

// 某位现在用的模型（私聊里可能单独设过）：有没有 vision 这个字段，true / false / null
function modelInfoFor(agent, room) {
  const eng = S.engines[AGENT_ENGINE[agent]] || {};
  const list = eng.models || [];
  const id = (room?.models?.[agent] || '') || eng.defaultModel || '';
  return list.find((m) => m.id === id) || list.find((m) => m.id === eng.defaultModel) || list[0] || null;
}

function hasVisionAlternative(agent, room) {
  const list = S.engines[AGENT_ENGINE[agent]]?.models || [];
  const cur = modelInfoFor(agent, room);
  return list.some((m) => m.vision === true && m.id !== cur?.id);
}

// 挂了图片、这一条又要发给看不了图的模型时，在附件下面提醒一句；不拦发送
function renderVisionHint() {
  const box = $('#vision-hint');
  if (!box) return;
  const conv = currentConv();
  const hasImages = S.attachments.some((a) => a.status === 'done');
  if (!conv || !hasImages) {
    box.hidden = true;
    return;
  }
  const targets = composeTargets(conv);
  const cant = [];
  const unknown = [];
  for (const a of targets) {
    const m = modelInfoFor(a, convRoom(conv, a));
    if (m?.vision === false) cant.push({ agent: a, model: m });
    else if (m?.vision === null) unknown.push({ agent: a, model: m });
  }
  if (!cant.length && !unknown.length) {
    box.hidden = true;
    return;
  }
  const names = (arr) => arr.map((x) => agentName(x.agent)).join(LIST_SEP);
  const modelName = (x) => x.model.name || x.model.id;
  const lines = [];
  if (cant.length) {
    lines.push(
      cant.length === 1
        ? tr('{name} 现在用的「{model}」看不了图片，发过去它只会收到图片的文件路径。', { name: agentName(cant[0].agent), model: modelName(cant[0]) })
        : tr('{names} 看不了图片，发过去只会收到图片的文件路径。', { names: names(cant) }),
    );
  }
  if (unknown.length) {
    lines.push(
      unknown.length === 1
        ? tr('平台没说明「{model}」能不能看图，先按看不了处理：发过去它只会收到图片的文件路径。', { model: modelName(unknown[0]) })
        : tr('{names} 的模型平台没说明能不能看图，先按看不了处理：它们只会收到图片的文件路径。', { names: names(unknown) }),
    );
  }
  box.className = `vision-hint${cant.length ? ' warn' : ''}`;
  box.innerHTML = lines.map((x) => `<span>${esc(x)}</span>`).join('<br>');
  // 只有一位收件人、而且有能看图的模型可选时，给个「换模型」的入口
  const one = targets.length === 1 ? targets[0] : null;
  if (one && hasVisionAlternative(one, convRoom(conv, one))) {
    box.insertAdjacentHTML('beforeend', `<button type="button" class="vision-switch" data-vision-switch="${esc(one)}">${tr('换成能看图的模型')}</button>`);
  }
  box.hidden = false;
}

// 点「换成能看图的模型」：打开这一位的模型菜单；窄窗口里它收在「模型」按钮里，就点那个
function openModelMenuFor(agent) {
  const chip = document.querySelector(`#model-switch [data-menu="${agent}"]`);
  if (chip && chip.offsetParent) return openModelMenu(agent, chip);
  document.querySelector('#model-switch [data-model-more]')?.click();
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
    throw new Error(tr('这种图片格式（比如 HEIC）在这台电脑上打不开，请先另存成 JPG 或 PNG 再发'));
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
  if (!blob) throw new Error(tr('这张图片处理不了，换一张试试'));
  return { body: blob, type: 'image/jpeg' };
}

function addFiles(files) {
  const conv = currentConv();
  if (!conv) return;
  const images = [...files].filter((f) => imageType(f));
  if (!images.length) {
    if (files.length) toast(tr('只能发图片'));
    return;
  }
  for (const file of images.slice(0, 20 - S.attachments.length)) {
    const att = { url: URL.createObjectURL(file), status: 'uploading', id: null, error: '', roomId: conv.roomId, fresh: true };
    S.attachments.push(att);
    prepareImage(file)
      .then(({ body, type }) => fetch(`/api/rooms/${conv.roomId}/uploads`, { method: 'POST', headers: { 'content-type': type, 'x-clawchat': '1' }, body }))
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || tr('上传失败'));
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
  const el = $('#input');
  const hasText = !!el.value.trim();
  const uploading = S.attachments.some((a) => a.status === 'uploading');
  const ready = S.attachments.some((a) => a.status === 'done');
  const conv = currentConv();
  const runs = conv ? convRuns(conv) : [];
  // 手机上：这个聊天里有人干活、输入框空着、也没有待发的图片时，发送键变成停止键
  const stopping = isNarrow() && !S.editMsg && runs.length > 0 && !hasText && S.attachments.length === 0;
  const btn = $('#btn-send');
  btn.classList.toggle('stopping', stopping);
  btn.disabled = stopping ? false : uploading || (!hasText && !ready);
  if (stopping) {
    const label = runs.length > 1 ? tr('全部停止') : tr('停止 {name}', { name: stopControlWho(runs[0]) });
    btn.title = label;
    btn.setAttribute('aria-label', label);
  } else {
    btn.title = tr('发送（Enter）');
    btn.setAttribute('aria-label', tr('发送'));
  }
}

function stopControlWho(r) {
  return r.side ? tr('{name} 分身', { name: agentName(r.agent) }) : r.dm ? tr('{name}（私聊）', { name: agentName(r.agent) }) : agentName(r.agent);
}

// 手机上发送键兼做停止：一位就停它，几位就全部停（和原来「停止」那一行一样）
function stopFromSend() {
  const conv = currentConv();
  if (!conv) return;
  const runs = convRuns(conv);
  if (!runs.length) return updateSendButton();
  const btn = $('#btn-send');
  btn.disabled = true;
  const body = runs.length === 1 ? { agent: runs[0].agent, only: runs[0].side ? 'side' : 'main' } : {};
  api('POST', `/api/rooms/${conv.roomId}/stop`, body).catch((err) => {
    toast(err.message);
    updateSendButton();
  });
}

function autoGrow() {
  const el = $('#input');
  el.style.height = 'auto';
  // 手机上没有边框，不用补这 2px；补了会比两边的按钮高出一截
  const extra = isNarrow() ? 0 : 2;
  const full = el.scrollHeight + extra; // scrollHeight 不含上下边框
  // 手机上最多长到 5 行：再高会把输入框顶到顶栏上（键盘弹起来时尤其明显）
  const max = isNarrow() ? 132 : 240;
  el.style.height = `${Math.min(full, max)}px`;
  el.style.overflowY = full > max ? 'auto' : 'hidden';
  renderInputMirror();
  updateSendButton();
}

// 输入框里 @ 了群里的成员时，底下的垫层把 @ 换成它的头像（写法和 lib/hub.js 的 MENTION_RE 一样）。
// 从菜单或快捷按钮插入的是「@ + 半角空格 + 名字」：头像盖住「@ 」这一段，和名字之间正好留出空隙；
// 自己手打的 @Claude 没有这个空格，放不下头像，就只显示成蓝色标签
const MENTION_GAP = '\u2002';
// @ 标签后面跟一个全角空格：标签底色左右各伸出 4 像素，普通空格（约 4 像素）会被盖满，看着像和后面的字贴在一起
const MENTION_SEP = '\u2003';
// 发出去、复制出去的文字换回普通的写法：@Claude 后面一个普通空格
const cleanMentions = (s) => String(s).replace(new RegExp(`@${MENTION_GAP}`, 'g'), '@').replace(new RegExp(MENTION_SEP, 'g'), ' ');
// @ 谁认的写法：按成员表生成（多开的 ChatGPT2 也认，长的写法排前面），和 lib/hub.js 的 mentionTables 一致
const ALL_WORDS = '所有人|全体成员|全体|大家|all|everyone';
const BASE_ALIASES = { claude: ['claude', '克劳德'], gpt: ['chatgpt', 'gpt', 'codex'], deepseek: ['deepseek', '深度求索'], glm: ['glm', '智谱'], gemini: ['gemini', '谷歌'], grok: ['grok', '格罗克'], cursor: ['cursor'], api: ['api'] };
let MENTION_WHO = {};
let MENTION_SHOW_RE, MENTION_TAIL_RE, MENTION_MSG_RE, MENTION_TAG_RE;
function buildMentionRes() {
  MENTION_WHO = {};
  for (const a of AGENT_IDS) for (const w of S.agents?.[a]?.aliases || BASE_ALIASES[a] || [a]) MENTION_WHO[w.toLowerCase()] = a;
  // 联合群里对方的成员：@Claude·小王 这种写法认到成员 key
  for (const room of S.rooms || []) for (const m of room.jointMembers || []) {
    if (!m?.key || m.mine) continue;
    MENTION_WHO[jointMemberDisplay(m).toLowerCase()] = m.key;
  }
  const names = Object.keys(MENTION_WHO).sort((x, y) => y.length - x.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  MENTION_SHOW_RE = new RegExp(`@(\\s?)(${names}|${ALL_WORDS})`, 'gi');
  MENTION_TAIL_RE = new RegExp(`(?:^|[^A-Za-z0-9_.])(@[ \\u2002]?(?:${names}|${ALL_WORDS})[ \\u2003]?)$`, 'i');
  MENTION_MSG_RE = new RegExp(`(^|[^A-Za-z0-9_.])@(${names}|${ALL_WORDS.replace('|all', '')})`, 'gi');
  MENTION_TAG_RE = new RegExp(`(^|[^A-Za-z0-9_.])@(${names})( ?)`, 'gi');
}
buildMentionRes();
// 输入框里会显示成标签的 @成员：[{ start, end, who, gap, name }]（画标签、管光标都用这一份，判断一致）
function mentionTokens(text) {
  const conv = currentConv();
  const members = conv && !conv.dm && conv.room.members.length > 1 ? [...conv.room.members, ...(conv.room.jointMembers || []).map((m) => m.key)] : [];
  if (!members.length) return [];
  const out = [];
  for (const m of text.matchAll(MENTION_SHOW_RE)) {
    if (m.index > 0 && /[A-Za-z0-9_.]/.test(text[m.index - 1])) continue; // me@all 这种不算
    const who = MENTION_WHO[m[2].toLowerCase()] || 'all';
    if (who !== 'all' && !members.includes(who)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, who, gap: m[1], name: m[2] });
  }
  return out;
}

function renderInputMirror() {
  renderMirror($('#input'), $('#input-mirror'));
}

// 输入框（或编辑框）底下的垫层：@成员画成带头像的标签
function renderMirror(el, mirror) {
  if (!el || !mirror) return;
  const text = el.value;
  let html = '';
  let last = 0;
  for (const t of mentionTokens(text)) {
    const icon = t.who !== 'all' && t.gap === MENTION_GAP;
    const head = icon ? `<span class="mention-at">@${MENTION_GAP}${avatarHtml(t.who)}</span>` : esc(`@${t.gap}`);
    html += `${esc(text.slice(last, t.start))}<span class="mention-tok">${head}${esc(t.name)}</span>`;
    last = t.end;
  }
  const found = last > 0;
  el.parentElement.classList.toggle('mirrored', found);
  mirror.hidden = !found;
  if (!found) return void (mirror.textContent = '');
  // 最后是换行时补一个空格，不然垫层少一行
  mirror.innerHTML = html + esc(text.slice(last)) + (text.endsWith('\n') ? ' ' : '');
  mirror.style.overflowY = el.style.overflowY === 'auto' ? 'scroll' : 'hidden'; // Windows 的滚动条占宽度，两边要一样宽
  mirror.scrollTop = el.scrollTop;
}

async function sendMessage() {
  const conv = currentConv();
  const el = $('#input');
  if (!conv || $('#btn-send').disabled) return;
  askNotifyPermission();
  // 先把要发的内容和归属定下来：下面等「最新一段」回来的时候，可能已经切去别的聊天、在那边打字了
  const raw = el.value;
  const text = cleanMentions(raw).trim(); // 发出去的还是普通的 @Claude
  const draftKey = S.current;
  const sent = S.attachments.filter((a) => a.status === 'done' && a.roomId === conv.roomId);
  if (!text && !sent.length) return;
  if (boundsOf(conv).hasLater) {
    await loadLatestWindow(); // 正在看很早的一段：新消息要接在最新那段后面
    if (S.current !== draftKey) return; // 等的时候切走了：这条先不发，两个会话的草稿都还在
    if (el.value !== raw) return; // 等的时候又把字改了：别把这几个字清掉
  }
  el.value = '';
  const kept = S.attachments;
  const reply = S.replyTo;
  S.attachments = [];
  renderAttachments();
  cancelReply();
  autoGrow();
  saveDraft(draftKey); // 发出去了，这个会话的草稿清掉
  const mentionKeys = conv.room?.joint
    ? [...new Set(mentionTokens(text).filter((t) => t.who !== 'all').map((t) => jointMemberOf(conv.room, t.who)?.key || t.who))]
    : [];
  // 回复某位 AI 时也把它的完整 key 带上（加入方以 mentions 为准；主持方目前从正文里解析）
  if (reply && reply.from !== 'user' && conv.room?.joint) {
    const k = jointMemberOf(conv.room, reply.from)?.key || reply.from;
    if (!mentionKeys.includes(k)) mentionKeys.push(k);
  }
  try {
    await api('POST', `/api/rooms/${conv.roomId}/messages`, { text, images: sent.map((a) => a.id), dm: conv.dm || undefined, replyTo: reply?.seq, ...(mentionKeys.length ? { mentions: mentionKeys } : {}) });
    for (const a of kept) URL.revokeObjectURL(a.url);
  } catch (err) {
    // 没发出去：字放回原来那个会话（这期间可能已经切到别的会话了）
    if (S.current !== draftKey) {
      S.drafts[draftKey] = raw;
      storeSet('clawchat.drafts', JSON.stringify(S.drafts));
      if (kept.length) {
        S.attachDrafts.set(draftKey, [...kept, ...(S.attachDrafts.get(draftKey) || [])]);
        saveAttachDrafts();
      }
      return toast(err.message);
    }
    el.value = raw;
    S.attachments = kept;
    renderAttachments();
    if (reply) startReply(reply.seq);
    autoGrow();
    toast(err.message);
  }
}

// ---------------- 输入 @ 时弹出的成员菜单 ----------------

const BASE_MENTION_ITEMS = [
  { id: 'claude', label: 'Claude', sub: 'Anthropic', insert: 'Claude', keys: ['claude', '克劳德'] },
  { id: 'gpt', label: 'ChatGPT', sub: 'OpenAI Codex', insert: 'ChatGPT', keys: ['chatgpt', 'gpt', 'codex', 'openai'] },
  { id: 'deepseek', label: 'DeepSeek', sub: tr('深度求索'), insert: 'DeepSeek', keys: ['deepseek', 'ds', '深度求索', 'shendu'] },
  { id: 'glm', label: 'GLM', sub: tr('智谱'), insert: 'GLM', keys: ['glm', '智谱', 'zhipu', 'bigmodel'] },
  { id: 'gemini', label: 'Gemini', sub: 'Google', insert: 'Gemini', keys: ['gemini', '谷歌', 'google'] },
  { id: 'grok', label: 'Grok', sub: 'xAI', insert: 'Grok', keys: ['grok', '格罗克', 'xai'] },
  { id: 'cursor', label: 'Cursor', sub: 'Anysphere', insert: 'Cursor', keys: ['cursor'] },
  { id: 'api', label: 'API', sub: tr('API 平台 · 借 Claude Code 干活'), insert: 'API', keys: ['api'] },
  { id: 'all', label: tr('所有人'), sub: tr('大家一起'), insert: ALL_WORD, keys: ['所有人', 'all', 'everyone', '大家', '全体', 'suoyouren'] },
];
// 多开的排在本体后面
let MENTION_ITEMS = BASE_MENTION_ITEMS;
function buildMentionItems() {
  const out = [];
  for (const it of BASE_MENTION_ITEMS) {
    out.push(it);
    for (const a of AGENT_IDS.filter((x) => S.agents?.[x]?.base === it.id)) {
      const ag = S.agents[a];
      out.push({ id: a, label: ag.name, sub: tr('{name} 的 {n} 号', { name: S.agents[it.id]?.name || it.label, n: ag.n }), insert: ag.name, keys: ag.aliases || [a] });
    }
  }
  // 联合群里对方的成员：@Claude·小王
  for (const room of S.rooms || []) for (const m of room.jointMembers || []) {
    if (!m?.key || m.mine) continue;
    const disp = jointMemberDisplay(m);
    out.push({ id: m.key, label: disp, sub: `${m.name} · ${m.owner}`, insert: disp, keys: [disp.toLowerCase()] });
  }
  MENTION_ITEMS = out;
}

// 正在用 @ 菜单的框：底部的输入框，或者正在改的那条消息的编辑框
const fieldOf = (x) => (x instanceof HTMLTextAreaElement ? x : x?.target instanceof HTMLTextAreaElement ? x.target : null);
function mentionField() {
  return S.mentionEl?.isConnected ? S.mentionEl : $('#input');
}

// 光标前面是不是正在打「@xxx」：返回 @ 的位置和已经打的字
function mentionQuery() {
  const el = mentionField();
  if (el.selectionStart !== el.selectionEnd) return null;
  const before = el.value.slice(0, el.selectionStart);
  const m = before.match(/(?:^|[\s(（，。,.!?！？:：])@([^\s@]{0,20})$/);
  return m ? { start: el.selectionStart - m[1].length - 1, q: m[1].toLowerCase() } : null;
}

function hideMentionMenu() {
  S.mention = null;
  $('#mention-menu').hidden = true;
}

function updateMentionMenu(from) {
  if (fieldOf(from)) S.mentionEl = fieldOf(from);
  const conv = currentConv();
  const mq = conv && !conv.dm && conv.room.members.length > 1 ? mentionQuery() : null;
  if (!mq) return hideMentionMenu();
  const allowed = new Set([...conv.room.members, ...(conv.room.jointMembers || []).map((m) => m.key)]);
  const items = MENTION_ITEMS.filter(
    (it) => (it.id === 'all' || allowed.has(it.id)) && (!mq.q || [it.label.toLowerCase(), ...it.keys].some((k) => k.startsWith(mq.q))),
  );
  if (!items.length) return hideMentionMenu();
  const keepIndex = S.mention && S.mention.q === mq.q ? S.mention.index : 0;
  S.mention = { ...mq, items, index: Math.min(keepIndex, items.length - 1) };
  const all = [...allowed];
  const icon = (it) => (it.id === 'all' ? `<span class="mention-all${all.length > 2 ? ' three' : ''}">${all.map((a) => avatarHtml(a)).join('')}</span>` : avatarHtml(it.id));
  $('#mention-menu').innerHTML = items
    .map(
      (it, i) => `<div class="mention-item${i === S.mention.index ? ' active' : ''}" role="option" data-mention-pick="${i}">
        ${icon(it)}<span class="mention-label"><b>${esc(it.label)}</b><small>${esc(it.sub)}</small></span>${i === S.mention.index ? '<kbd>↩</kbd>' : ''}</div>`,
    )
    .join('');
  $('#mention-menu').hidden = false;
  placeMentionMenu();
}

// 菜单放在哪：底部输入框的就在输入框上面；编辑框的挪到页面最外层，贴着编辑框下面（下面放不下就放上面）
function placeMentionMenu() {
  const menu = $('#mention-menu');
  const el = mentionField();
  if (el.id === 'input') {
    if (menu.parentElement !== el.parentElement) el.parentElement.appendChild(menu);
    menu.classList.remove('floating');
    menu.style.left = menu.style.top = '';
    return;
  }
  if (menu.parentElement !== document.body) document.body.appendChild(menu);
  menu.classList.add('floating');
  const box = (el.closest('.edit-box') || el).getBoundingClientRect();
  const h = menu.offsetHeight;
  const below = box.bottom + 6 + h < window.innerHeight - 8;
  menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${below ? box.bottom + 6 : Math.max(8, box.top - h - 6)}px`;
}

// 改输入框里的一段字，并且能用 ⌘Z 撤销、⇧⌘Z 重做：直接给 value 赋值会把浏览器记的撤销记录整个清掉
// 粘贴进输入框的文字里有「@Claude」这类手打的写法（比如从别的消息复制来的），换成和点 @ 按钮插入的一样：带头像的标签。
// 只换「@」后面那个看不见的空隙，后面紧跟的普通空格换成全角空格；cleanMentions 还原后和粘贴的原文一字不差
function pastedMentions(text) {
  const conv = currentConv();
  const members = conv && !conv.dm && conv.room.members.length > 1 ? conv.room.members : [];
  if (!members.length) return text;
  const names = Object.keys(MENTION_WHO).sort((x, y) => y.length - x.length).map(escRe).join('|');
  let out = '';
  let last = 0;
  for (const m of text.matchAll(new RegExp(`@(${names})`, 'gi'))) {
    const end = m.index + m[0].length;
    if (m.index > 0 && /[A-Za-z0-9_.]/.test(text[m.index - 1])) continue; // me@claude 这种不算
    if (/[A-Za-z0-9_]/.test(text[end] || '')) continue; // @Claudex 不是 @Claude
    if (!members.includes(MENTION_WHO[m[1].toLowerCase()])) continue;
    const space = text[end] === ' ';
    out += `${text.slice(last, m.index)}@${MENTION_GAP}${m[1]}${space ? MENTION_SEP : ''}`;
    last = end + (space ? 1 : 0);
  }
  return out + text.slice(last);
}

function editInput(el, start, end, text) {
  el.focus();
  // 先把光标挪开一下：不然浏览器会把这次插入和前面刚打的字算成同一步，撤销时一起没了
  el.setSelectionRange(start === 0 && end === 0 ? el.value.length : 0, start === 0 && end === 0 ? el.value.length : 0);
  el.setSelectionRange(start, end);
  // 「插入文字」会进撤销记录，也会触发 input 事件（自动长高、@ 标签、草稿都跟着更新）；万一不支持就退回直接改
  if (!document.execCommand('insertText', false, text)) {
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function pickMention(i) {
  const el = mentionField();
  const it = S.mention?.items[i];
  if (!it) return;
  // 按光标现在的位置重新算（菜单打开后光标可能被挪过，比如点进了别的 @ 标签）
  const mq = mentionQuery();
  if (!mq) return hideMentionMenu();
  const start = mq.start;
  // 光标停在名字中间（比如 @Cl|aude）时，后半截名字一起换掉；但只换「正好能接上名字」的那几个字母，
  // 别的一个字都不动（以前会把光标后面直到空格的字全删掉，中文没有空格，后面整段话就没了）
  let end = el.selectionStart;
  const typed = el.value.slice(start + 1, end).toLowerCase();
  const after = el.value.slice(end).match(/^[A-Za-z0-9]*/)[0];
  const name = it.insert.toLowerCase();
  if (after && name.startsWith(typed) && name.startsWith(typed + after.toLowerCase())) {
    end += after.length;
    if (el.value[end] === ' ' || el.value[end] === MENTION_SEP) end++; // 名字后面原来的空格，换成标签自带的
  }
  const token = `@${it.id === 'all' ? '' : MENTION_GAP}${it.insert}${MENTION_SEP}`; // @所有人没有头像，不用留空隙
  hideMentionMenu();
  editInput(el, start, end, token);
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

// ---------------- 输入框里的 @ 标签是一个整体 ----------------
// 标签只是画出来的，底下还是一个个字：光标不能进到中间，不然能删掉其中一个字，把 @Claude 改成 @Clade

// 左右方向键碰到标签：直接跳过整个标签
function mentionArrow(e) {
  if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.isComposing) return false;
  const el = e.target;
  if (el.selectionStart !== el.selectionEnd) return false;
  const p = el.selectionStart;
  const left = e.key === 'ArrowLeft';
  const t = mentionTokens(el.value).find((t) => (left ? p > t.start && p <= t.end : p >= t.start && p < t.end));
  if (!t) return false;
  e.preventDefault();
  const q = left ? t.start : t.end;
  el.setSelectionRange(q, q);
  return true;
}

// 向前删除（Delete）：光标在标签前面时，先选中整个标签，再按一次才删（和退格一样）
function selectMentionOnDelete(e) {
  if (e.key !== 'Delete' || e.isComposing || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return false;
  const el = e.target;
  if (el.selectionStart !== el.selectionEnd) return false;
  const t = mentionTokens(el.value).find((t) => t.start === el.selectionStart);
  if (!t) return false;
  e.preventDefault();
  const end = el.value[t.end] === MENTION_SEP || el.value[t.end] === ' ' ? t.end + 1 : t.end;
  el.setSelectionRange(t.start, end, 'forward');
  return true;
}

// 鼠标点进标签中间、Option+方向键跳词、Shift 选到标签一半：光标贴到标签边上，选区扩成整个标签
function snapToMentions(from) {
  const el = fieldOf(from) || $('#input');
  const tokens = mentionTokens(el.value);
  if (!tokens.length) return;
  const s = el.selectionStart;
  const e = el.selectionEnd;
  if (s === e) {
    const t = tokens.find((t) => s > t.start && s < t.end);
    if (t) {
      const p = s - t.start < t.end - s ? t.start : t.end;
      el.setSelectionRange(p, p);
      updateMentionMenu(el); // 光标挪了，@ 菜单跟着重新判断
    }
    return;
  }
  let ns = s;
  let ne = e;
  for (const t of tokens) {
    if (ns > t.start && ns < t.end) ns = t.start;
    if (ne > t.start && ne < t.end) ne = t.end;
  }
  if (ns !== s || ne !== e) el.setSelectionRange(ns, ne, el.selectionDirection);
}

// 光标紧跟在一个完整的 @提及后面（后面最多一个空格）时按退格：先把整个 @提及选中，再按一次才删掉。
// 认的写法和 lib/hub.js 的 MENTION_RE 一样；返回 true 表示这个按键被用掉了
function selectMentionOnBackspace(e) {
  const el = e.target;
  if (e.key !== 'Backspace' || e.isComposing || e.keyCode === 229 || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return false;
  if (el.selectionStart !== el.selectionEnd) return false;
  const m = el.value.slice(0, el.selectionStart).match(MENTION_TAIL_RE);
  if (!m) return false;
  e.preventDefault();
  el.setSelectionRange(el.selectionStart - m[1].length, el.selectionStart, 'backward');
  hideMentionMenu();
  return true;
}

// ---------------- 回复 ----------------

function startReply(seq) {
  const conv = currentConv();
  const m = conv && findMessage(seq); // 消息缓存是按会话存的，用 conv.roomId 找不到
  if (!m) return;
  S.replyTo = { seq: m.seq, from: m.from };
  $('#reply-who').textContent = tr('回复 {name}', { name: whoLabel(m.from) });
  $('#reply-snippet').textContent = snippet(m);
  // 回复某位 AI：只有它会回答（又 @ 了别人的话，就按 @ 的来）
  const solo = conv.dm || conv.room.members.length < 2;
  $('#reply-hint').textContent = m.from !== 'user' && !solo ? tr('只有 {name} 会回复', { name: agentName(m.from) }) : '';
  $('#reply-bar').hidden = false;
  $('#input').focus();
  syncReplyTargets(); // 回复某一位时，输入框提示和「不 @ 时」那一处跟着变
  renderVisionHint(); // 回复某一位时，这条只会发给它：图片提醒跟着换
}

function cancelReply() {
  S.replyTo = null;
  $('#reply-bar').hidden = true;
  syncReplyTargets();
  renderVisionHint();
}

async function jumpTo(seq) {
  S.pinned = false; // 要跳过去看那条，别被拽回最底下
  let el = document.querySelector(`#messages .msg[data-seq="${seq}"]`);
  // 还没画出来（在更早的那段里）：先把它前面一点接上；本地没有就问服务器要它附近的一段
  if (!el && S.rendered?.from) {
    const conv = currentConv();
    const i = conv ? convMessages(conv).findIndex((m) => m.seq === seq) : -1;
    if (i >= 0 && i < S.rendered.from) {
      await loadEarlier(Math.max(0, i - 10));
      el = document.querySelector(`#messages .msg[data-seq="${seq}"]`);
    }
  }
  if (!el) {
    await ensureSeqLoaded(seq);
    el = document.querySelector(`#messages .msg[data-seq="${seq}"]`);
  }
  if (!el) return toast(tr('原消息不在这个会话里了'));
  // 直接跳过去（平滑滚动会被图片加载等高度变化打断），下一帧再对准一次
  el.scrollIntoView({ block: 'center' });
  requestAnimationFrame(() => requestAnimationFrame(() => el.scrollIntoView({ block: 'center' })));
  el.classList.remove('flash');
  void el.offsetWidth; // 重新触发闪一下的动画
  el.classList.add('flash');
  return el;
}

// 在跳到的那条消息里把关键词标出来（只标正文；之前标过的先去掉）。
// 关键词可能被 Markdown 劈在几个文字片段里（比如「部**署**」），所以把正文的文字连起来找，再按片段分头标
function markFound(el, q) {
  clearFoundMarks();
  const needle = q.trim().toLowerCase();
  const body = el.querySelector('.bubble');
  if (!needle || !body) return;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let all = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ n, from: all.length });
    all += n.nodeValue;
  }
  const low = all.toLowerCase();
  const cuts = new Map(); // 文字片段 → 要标的 [起, 止)
  for (let at = low.indexOf(needle); at >= 0; at = low.indexOf(needle, at + needle.length)) {
    const end = at + needle.length;
    for (const { n, from } of nodes) {
      const to = from + n.nodeValue.length;
      if (to <= at || from >= end) continue;
      if (!cuts.has(n)) cuts.set(n, []);
      cuts.get(n).push([Math.max(at, from) - from, Math.min(end, to) - from]);
    }
  }
  for (const [n, ranges] of cuts) {
    const text = n.nodeValue;
    const frag = document.createDocumentFragment();
    let i = 0;
    for (const [s0, e0] of ranges) {
      frag.append(text.slice(i, s0));
      const m = document.createElement('mark');
      m.className = 'found';
      m.textContent = text.slice(s0, e0);
      frag.append(m);
      i = e0;
    }
    frag.append(text.slice(i));
    n.replaceWith(frag);
  }
}

function clearFoundMarks() {
  document.querySelectorAll('#messages mark.found').forEach((m) => {
    const parent = m.parentNode;
    m.replaceWith(m.textContent);
    parent.normalize();
  });
}

// ---------------- 在当前聊天里搜 ----------------
// 顶栏的放大镜（或 ⌘F / Ctrl+F）打开：只搜这个群或这个私聊里看得到的消息，最新的在前；
// 下面列出所有结果，点一条就跳过去；回车 / ↑ 往更早的找，Shift+回车 / ↓ 往更新的找，Esc 关掉
const FIND = { q: '', hits: [], at: -1, seq: 0 };

function openFind(q = null) {
  if (!currentConv()) return;
  const box = $('#find');
  const input = $('#find-input');
  box.hidden = false;
  $('#btn-find').classList.add('on');
  if (q !== null) input.value = q;
  input.focus();
  input.select();
  runFind(true);
}

function closeFind() {
  const box = $('#find');
  if (box.hidden) return;
  box.hidden = true;
  $('#btn-find').classList.remove('on');
  clearFoundMarks();
  FIND.seq++; // 还在路上的搜索结果回来也不要了
  Object.assign(FIND, { q: '', hits: [], at: -1 });
}

// 这个聊天里命中的消息，最新的在前。问服务端搜（只取最近一段消息以后，本地找不到更早的那些了），
// 命中里带着会话归属，按当前是群还是私聊筛一下
async function findHits(conv, q) {
  if (!conv || !q) return [];
  const params = new URLSearchParams({ q, room: conv.roomId });
  const res = await api('GET', `/api/search?${params}`);
  return (res.hits || []).filter((h) => inConv(conv, h));
}

// 消息整页重画以后（来了新消息、改了消息）：还停在原来那条上，那条里的标黄补回来
function refreshFind() {
  if ($('#find').hidden || !FIND.q) return;
  renderFind(!$('#find-list').hidden);
  const cur = FIND.hits[FIND.at]?.seq;
  const el = cur !== undefined && document.querySelector(`#messages .msg[data-seq="${cur}"]`);
  if (el) markFound(el, FIND.q);
}

async function runFind(showList = false) {
  const conv = currentConv();
  const q = $('#find-input').value.trim();
  const seq = ++FIND.seq;
  FIND.q = q;
  FIND.at = -1;
  FIND.hits = [];
  clearFoundMarks();
  if (!conv || !q) return renderFind(showList);
  try {
    const hits = await findHits(conv, q);
    if (seq !== FIND.seq) return; // 又改了关键词
    FIND.hits = hits;
  } catch {
    if (seq !== FIND.seq) return;
    FIND.hits = [];
  }
  renderFind(showList);
}


function renderFind(showList) {
  const { q, hits, at } = FIND;
  $('#find-count').textContent = !q ? '' : hits.length ? (at >= 0 ? `${at + 1}/${hits.length}` : tr('{n} 条', { n: hits.length })) : tr('没有找到');
  $('#find').classList.toggle('none', !!q && !hits.length);
  $('#find-prev').disabled = !hits.length || at >= hits.length - 1;
  $('#find-next').disabled = !hits.length || at <= 0;
  const list = $('#find-list');
  list.hidden = !showList || !hits.length;
  if (list.hidden) return;
  const needle = q.toLowerCase();
  list.innerHTML = hits
    .slice(0, 300)
    .map((m, i) => {
      const text = plainText(m.text);
      const pos = text.toLowerCase().indexOf(needle);
      const start = Math.max(0, pos - 30);
      // 服务端给的是一小段（开头被截过的话前面加个省略号）；万一关键词被 Markdown 去掉了就整段放出来
      const snippet = pos < 0 ? text : `${start > 0 || m.cut ? '…' : ''}${text.slice(start, pos + needle.length + 120)}`;
      return `<li class="find-item${i === at ? ' active' : ''}" data-find-at="${i}">
        <div class="hit-line">${avatarHtml(m.from === 'user' ? 'user' : m.from)}<span class="hit-who">${esc(speakerOf(m))}</span><span class="time">${fmtShort(m.ts)}</span></div>
        <div class="hit-text">${highlight(snippet, q)}</div></li>`;
    })
    .join('');
}

// 跳到第 i 条结果；列表收起来，免得挡住消息（点一下输入框再展开）
// 老消息可能还没取下来：jumpTo 会先把那一段取回来
async function gotoFind(i) {
  if (!FIND.hits.length) return;
  FIND.at = Math.max(0, Math.min(FIND.hits.length - 1, i));
  renderFind(false);
  const el = await jumpTo(FIND.hits[FIND.at].seq);
  if (el && FIND.q) markFound(el, FIND.q);
}

function bindFind() {
  const input = $('#find-input');
  $('#btn-find').onclick = () => ($('#find').hidden ? openFind() : closeFind());
  $('#find-close').onclick = closeFind;
  $('#find-prev').onclick = () => gotoFind(FIND.at + 1);
  $('#find-next').onclick = () => gotoFind(FIND.at - 1);
  input.addEventListener('input', () => {
    clearTimeout(runFind.timer);
    runFind.timer = setTimeout(() => runFind(true), 120);
  });
  input.addEventListener('click', () => renderFind(true));
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
      $('#input').focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(runFind.timer);
      if (FIND.q !== input.value.trim()) runFind();
      gotoFind(e.shiftKey ? FIND.at - 1 : FIND.at + 1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      gotoFind(e.key === 'ArrowUp' ? FIND.at + 1 : FIND.at - 1);
    }
  });
  $('#find-list').addEventListener('click', (e) => {
    const li = e.target.closest('[data-find-at]');
    if (li) gotoFind(Number(li.dataset.findAt));
  });
  // 点到搜索框外面（比如去看消息了），结果列表收起来
  document.addEventListener('pointerdown', (e) => {
    if (!$('#find').hidden && !e.target.closest('#find')) $('#find-list').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'f' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (document.querySelector('dialog[open]') || $('#chat').hidden) return;
    e.preventDefault();
    openFind();
  });
  $('#btn-find').title = tr('在这个聊天里搜（{key}）', { key: IS_WIN ? 'Ctrl+F' : '⌘F' });
}

function insertMention(name, el = $('#input')) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, start);
  const token = `${before && !/\s$/.test(before) ? ' ' : ''}@${name === '所有人' || name === 'everyone' ? '' : MENTION_GAP}${name}${MENTION_SEP}`;
  editInput(el, start, end, token);
}

// 手机上的「@」面板：提到谁、以及不 @ 时发给谁（电脑上用输入框上面的那一行）
function closeAtPanel() {
  const p = $('#at-panel');
  if (p) p.hidden = true;
}

function atPanelHtml() {
  const conv = currentConv();
  if (!conv) return '';
  const people = [...conv.room.members, ...(conv.room.jointMembers || []).filter((m) => !m.mine).map((m) => m.key)]
    .map((a) => `<button type="button" class="at-person" data-at-insert="${esc(jointDisplayFor(conv.room, a))}">${avatarHtml(a)}<span>${esc(jointDisplayFor(conv.room, a))}</span></button>`)
    .join('');
  const allPerson = `<button type="button" class="at-person" data-at-all><span class="at-all-avatar">@</span><span>${tr('所有人')}</span></button>`;
  const sel = $('#default-target');
  const options = sel
    ? [...sel.options]
        .map(
          (o) =>
            `<button type="button" class="at-target" data-at-target="${esc(o.value)}"><span class="at-check">${o.value === sel.value ? CHECK_SVG : ''}</span><span>${esc(o.textContent)}</span></button>`,
        )
        .join('')
    : '';
  // 回复某位 AI 时，「不 @ 时发给」不起作用：这一段换成一句说明，别让人以为会发给「接着上一位」
  const reply = replyAgentOf(conv);
  let targetSection;
  if (reply) {
    const { all, named } = replyMentions(conv);
    const names = (all ? [tr('所有人')] : named.map(agentName)).join(LIST_SEP);
    targetSection = `<div class="at-sep"></div><div class="at-reply-note">${
      all || named.length
        ? esc(tr('这条会发给 @ 的人：{names}', { names }))
        : esc(tr('正在回复 {name}：这条只发给它，要叫别人就 @ 他们', { name: agentName(reply) }))
    }</div>`;
  } else {
    targetSection = `<div class="at-sep"></div><div class="at-title">${tr('不 @ 时发给')}</div><div class="at-targets">${options}</div>`;
  }
  return `<div class="at-title">${tr('提到谁')}</div><div class="at-people">${people}${allPerson}</div>${targetSection}`;
}

function fitAtPanel() {
  const panel = $('#at-panel');
  if (!panel || panel.hidden) return;
  const headBottom = $('#room-head')?.getBoundingClientRect().bottom || 0;
  const composerTop = $('#composer').getBoundingClientRect().top;
  panel.style.maxHeight = `${Math.max(120, Math.min(420, Math.floor(composerTop - headBottom - 10)))}px`;
}

function toggleAtPanel() {
  const panel = $('#at-panel');
  if (!panel) return;
  if (!panel.hidden) return void (panel.hidden = true);
  const conv = currentConv();
  if (!conv || conv.dm || conv.room.members.length < 2) return;
  panel.innerHTML = atPanelHtml();
  panel.hidden = false;
  fitAtPanel();
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

// 选一个要发给对方的文件：Mac 外壳用原生面板，浏览器里让本机服务弹系统对话框
async function pickFile() {
  if (hasNative() && nativeCaps.pickFile) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      pickResolvers.set(id, resolve);
      native({ type: 'pickFile', id });
    });
  }
  const { path } = await api('POST', '/api/pick-file');
  return path;
}

// 让 Mac 外壳用 Touch ID（Secure Enclave 私钥）给服务端出的确认串签名；旧外壳没有这个能力
async function biometricSign(payload) {
  if (!hasNative() || !nativeCaps.biometric) throw new Error(tr('这台电脑用不了 Touch ID 确认'));
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    biometricResolvers.set(id, resolve);
    native({ type: 'biometricSign', id, payload });
  });
}

// 私聊里单独的设置（和 lib/hub.js 的 dmRoom 一样）：没单独设置的跟着群里
function dmView(room, agent) {
  const o = room.dmSettings?.[agent];
  if (!o) return room;
  const pick = (map, v) => (v === undefined ? map : { ...map, [agent]: v });
  return { ...room, models: pick(room.models, o.model), efforts: pick(room.efforts, o.effort), fast: pick(room.fast, o.fast) };
}

// 当前会话里这一位实际用的设置：私聊里看私聊的，群里看群的
const convRoom = (conv, agent) => (conv.dm ? dmView(conv.room, agent) : conv.room);

// 改设置：在私聊里只改私聊那份（群里不变），在群里改群的
function settingsPatch(conv, agent, field, value) {
  if (conv.dm) return { dmSettings: { [agent]: { [field]: value } } };
  const key = { model: 'models', effort: 'efforts', fast: 'fast' }[field];
  return { [key]: { ...conv.room[key], [agent]: value } };
}

async function patchSettings(conv, body) {
  const { room } = await api('PATCH', `/api/rooms/${conv.roomId}`, body);
  S.rooms = S.rooms.map((r) => (r.id === room.id ? room : r));
}

const scopeText = (conv) => (conv.dm ? tr('（只改私聊，群里不变）') : '');

async function resetDmSettings(agent) {
  const conv = currentConv();
  if (!conv?.dm) return;
  try {
    await patchSettings(conv, { dmSettings: { [agent]: null } });
    toast(tr('私聊里的 {name} 恢复成和群里一样的设置', { name: agentName(agent) }));
  } catch (err) {
    toast(err.message);
  }
  $('#model-switch')._html = null;
  renderShell();
}

async function switchEffort(agent, id) {
  const conv = currentConv();
  if (!conv) return;
  try {
    await patchSettings(conv, settingsPatch(conv, agent, 'effort', id));
    toast(tr('{name} 的思考强度换成了「{level}」，下一轮生效{scope}', { name: agentName(agent), level: id ? EFFORT_LABEL[id] || id : tr('默认'), scope: scopeText(conv) }));
  } catch (err) {
    toast(err.message);
  }
  $('#model-switch')._html = null;
  renderShell();
}

// ---------------- 顶部的模型按钮和弹出菜单 ----------------
// 每位一个小按钮：头像 + 模型 + 思考强度（GPT 开了快速模式再多一个闪电）；点开是菜单，分「模型」「思考强度」「速度」三组

const FOLDER_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.8 4.2c0-.8.6-1.4 1.4-1.4h3l1.4 1.5h5.2c.8 0 1.4.6 1.4 1.4v6.1c0 .8-.6 1.4-1.4 1.4H3.2c-.8 0-1.4-.6-1.4-1.4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const CHEVRON_SVG = '<svg class="chip-chevron" viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d="M2 3.6 5 6.6l3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SCOPE_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5h16v10H9l-5 4z"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.2 6.4 4.8 9 9.8 3.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// 现在实际用的模型、思考强度的名字（「默认」就显示默认对应的那个）
function modelShortName(agent, id) {
  if (id) return modelOptions(agent).find((o) => o.id === id)?.name || modelLabel(id);
  const e = S.engines[AGENT_ENGINE[agent]] || {};
  return e.defaultLabel || (e.defaultModel ? modelLabel(e.defaultModel) : tr('默认'));
}

function effortShortName(agent, modelId, id) {
  if (id) return EFFORT_LABEL[id] || id;
  if (!effortsFor(agent, modelId).length) return '';
  const e = S.engines[AGENT_ENGINE[agent]] || {};
  const def = e.defaultEffort || e.models?.find((m) => m.id === (modelId || e.defaultModel))?.defaultEffort || '';
  return def ? EFFORT_LABEL[def] || def : '';
}

function modelChipHtml(a, room) {
  const model = room.models?.[a] || '';
  const effort = effortShortName(a, model, room.efforts?.[a]);
  const fast = !!room.fast?.[a] && fastSpeed(a, model) !== null;
  const level = heavyLevel(sessionImages(room.id, a));
  const warn = level
    ? `<span class="chip-warn${level > 1 ? ' bad' : ''}" title="${esc(tr('会话里存了约 {size}MB 图片，越来越慢，点开换新会话', { size: (sessionImages(room.id, a) / 1048576).toFixed(1) }))}"></span>`
    : '';
  // 提示里写清楚现在用的是哪个模型（窄窗口下按钮只剩头像，靠这个也知道是谁、什么模型）
  const tip = tr('{name}：{model}，下一轮生效', {
    name: agentName(a),
    model: `${modelShortName(a, model)}${effort ? ` · ${tr('思考 {level}', { level: effort })}` : ''}`,
  });
  return `<button class="model-chip" data-menu="${esc(a)}" aria-haspopup="menu" title="${esc(tip)}">${avatarHtml(a)}<span class="chip-model">${esc(modelShortName(a, model))}</span>${
    effort ? `<span class="chip-effort">${esc(effort)}</span>` : ''}${fast ? `<span class="chip-fast">${BOLT_SVG}${tr('快速')}</span>` : ''}${warn}${CHEVRON_SVG}</button>`;
}

// 模型能不能看图的小标记：true 能看（眼睛）、false 看不了（眼睛划掉）、null 还不确定（淡一点的眼睛）。
// 没有这个字段（比如 Codex 的模型目录里没写）就什么都不画，别乱标。
const EYE_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12s3.6-6.2 9.5-6.2S21.5 12 21.5 12s-3.6 6.2-9.5 6.2S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12s3.6-6.2 9.5-6.2S21.5 12 21.5 12s-3.6 6.2-9.5 6.2S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/><path d="m4 4 16 16"/></svg>';
function visionMarkHtml(vision) {
  if (vision === true) return `<span class="vision-mark" title="${esc(tr('能看图'))}">${EYE_SVG}</span>`;
  if (vision === false) return `<span class="vision-mark off" title="${esc(tr('看不了图片：发过去它只会收到文件路径'))}">${EYE_OFF_SVG}</span>`;
  if (vision === null) return `<span class="vision-mark unknown" title="${esc(tr('平台没说明能不能看图，先按看不了处理'))}">${EYE_SVG}</span>`;
  return '';
}

function menuItemHtml(attrs, label, sub, checked) {
  return `<button class="menu-item" role="menuitemradio" aria-checked="${checked}" ${attrs}><span class="menu-check">${checked ? CHECK_SVG : ''}</span><span class="menu-text"><span class="menu-label">${label}</span>${
    sub ? `<small>${esc(sub)}</small>` : ''}</span></button>`;
}

const hasCjk = (s) => /[\u4e00-\u9fff]/.test(s || ''); // Codex 自带的模型说明是英文，不显示
// 模型说明只显示和界面同一种语言的：中文界面只显示中文说明，英文界面只显示不带中文的
const descForUi = (s) => (I18N.lang === 'zh' ? hasCjk(s) : s && !hasCjk(s)) ? s : '';

function openModelMenu(agent, chip) {
  const conv = currentConv();
  if (!conv) return;
  const room = convRoom(conv, agent);
  const cur = room.models?.[agent] || '';
  const opts = modelOptions(agent);
  if (cur && !opts.some((o) => o.id === cur)) opts.push({ id: cur, name: tr('{name}（自定义）', { name: cur }) });
  let html = '';
  const imgs = sessionImages(conv.roomId, agent);
  if (heavyLevel(imgs)) {
    html += `<div class="menu-note warn${heavyLevel(imgs) > 1 ? ' bad' : ''}">${tr('会话里存了约 {size}MB 图片：它看过的每张图都存在里面，每轮都要重发，到 15MB 左右就会慢到像卡住。这批活做完就换个新会话。', { size: (imgs / 1048576).toFixed(1) })}</div>`;
    html += menuItemHtml('data-pick-fresh', tr('换新会话…'), tr('可以选一位同事把情况重新交代给它'), false) + '<div class="menu-sep"></div>';
  }
  if (conv.dm) {
    html += `<div class="menu-note">${SCOPE_ICON}${tr('在这里切换只改私聊，群里的设置不变')}</div>`;
    if (conv.room.dmSettings?.[agent]) html += menuItemHtml('data-pick-reset', tr('恢复成和群聊一样'), '', false) + '<div class="menu-sep"></div>';
  }
  html += `<div class="menu-section">${tr('模型')}</div>`;
  html += opts.map((o) => menuItemHtml(`data-pick-model="${esc(o.id)}"`, `${esc(o.name)}${visionMarkHtml(o.vision)}`, descForUi(o.description), o.id === cur)).join('');
  html += menuItemHtml(`data-pick-model="${CUSTOM_MODEL}"`, tr('自定义模型…'), '', false);
  const efforts = effortsFor(agent, cur);
  if (efforts.length || room.efforts?.[agent]) {
    const curEffort = room.efforts?.[agent] || '';
    const def = effortShortName(agent, cur, '');
    html += `<div class="menu-sep"></div><div class="menu-section">${tr('思考强度')}</div>`;
    html += menuItemHtml('data-pick-effort=""', def ? tr('默认 · {label}', { label: esc(def) }) : tr('默认'), tr('跟随自己的设置'), !curEffort);
    html += efforts.map((id) => menuItemHtml(`data-pick-effort="${esc(id)}"`, esc(EFFORT_LABEL[id] || id), EFFORT_HINT[id] || '', id === curEffort)).join('');
  }
  const speed = fastSpeed(agent, cur);
  if (speed !== null) {
    const on = !!room.fast?.[agent];
    html += `<div class="menu-sep"></div><div class="menu-section">${tr('速度')}</div>`;
    html += menuItemHtml('data-pick-fast="0"', tr('标准'), tr('正常消耗额度'), !on);
    html += menuItemHtml('data-pick-fast="1"', `<span class="menu-fast">${BOLT_SVG}${tr('快速')}</span>`, speed ? tr('约 {speed} 倍速 · 额度按 2.5 倍消耗', { speed }) : tr('额度按 2.5 倍消耗'), on);
  }
  const menu = $('#model-menu');
  menu.innerHTML = html;
  menu.dataset.agent = agent;
  menu.hidden = false;
  const r = chip.getBoundingClientRect();
  const top = r.bottom + 6;
  menu.style.top = `${top}px`;
  menu.style.maxHeight = `${window.innerHeight - top - 12}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  chip.classList.add('open');
  (menu.querySelector('[aria-checked="true"]') || menu.querySelector('.menu-item'))?.focus();
  reportDragRegions();
}

function closeModelMenu() {
  const menu = $('#model-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  document.querySelectorAll('.model-chip.open').forEach((c) => c.classList.remove('open'));
  reportDragRegions();
}

function pickFromMenu(item) {
  const agent = $('#model-menu').dataset.agent;
  closeModelMenu();
  if (item.dataset.pickModel !== undefined) switchModel(agent, item.dataset.pickModel);
  else if (item.dataset.pickEffort !== undefined) switchEffort(agent, item.dataset.pickEffort);
  else if (item.dataset.pickReset !== undefined) resetDmSettings(agent);
  else if (item.dataset.pickFresh !== undefined) freshAgent(agent, null);
  else if (item.dataset.pickFast !== undefined) {
    const on = item.dataset.pickFast === '1';
    const conv = currentConv();
    if (conv && on !== !!convRoom(conv, agent).fast?.[agent]) switchFast(agent, on);
  }
}

async function switchFast(agent, on) {
  const conv = currentConv();
  if (!conv) return;
  if (on && !(await confirmFast(fastSpeed(agent, convRoom(conv, agent).models?.[agent])))) return;
  try {
    await patchSettings(conv, settingsPatch(conv, agent, 'fast', on));
    const vars = { name: agentName(agent), scope: scopeText(conv) };
    toast(on ? tr('{name} 换成了快速模式，下一轮生效{scope}', vars) : tr('{name} 换回了标准速度，下一轮生效{scope}', vars));
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
  $('#custom-model-title').textContent = tr('给 {name} 换一个列表里没有的模型', { name: agentName(agent) });
  $('#custom-model-hint').textContent = {
    gpt: tr('填 Codex 里的模型名，比如 gpt-7.0。'),
    deepseek: tr('填 DeepSeek 的模型名，比如 deepseek-v5-pro。'),
  }[agent] || tr('填 Claude Code 能用的模型名，比如 claude-opus-6-0，或者 opus、fable 这样的别名。');
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
  status.textContent = tr('正在用 {model} 试着回一句话，最多等一分半…', { model: id });
  try {
    const res = await api('POST', '/api/models/check', { agent, id });
    if (!res.ok) {
      status.className = 'error';
      status.textContent = tr('用不了：{error}', { error: res.error });
      return;
    }
    closeDialog(dlg);
    await switchModel(agent, id, true);
    if (res.model && res.model !== id) toast(tr('{name} 已切换到 {model}（实际是 {actual}），下一轮生效', { name: agentName(agent), model: id, actual: modelLabel(res.model) }));
  } catch (err) {
    status.className = 'error';
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// 一键更新 Claude Code / Codex：新模型常常要新版本才看得到
async function updateEngine(engine, btn) {
  const name = { codex: 'Codex', grok: 'Grok Build', cursor: 'Cursor CLI' }[engine] || 'Claude Code';
  btn.disabled = true;
  btn.textContent = tr('更新中…');
  try {
    const res = await api('POST', '/api/engines/update', { engine });
    S.engines = res.engines || S.engines;
    toast(res.ok ? tr('{name} 已是最新：{version}', { name, version: S.engines[engine]?.version || '' }) : tr('{name} 更新失败：{error}', { name, error: res.output }), 5000);
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
  if (changed) $('#dlg-settings .prefs-body').scrollTop = 0; // 换一页从头看，别沿用上一页滚到的位置
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

// ---------------- 手机访问（Tailscale） ----------------
const REMOTE = { info: null, busy: false };
const ANDROID = { info: null, busy: false, error: '' };
const isAndroidApp = () => /ClawChatAndroid/i.test(navigator.userAgent);
const isLocalHost = () => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname);
// 服务端的报错里可能带 Tailscale 开通 HTTPS 的链接：转成能点的（先转义，再单独把网址找出来）
const linkify = (text) => esc(String(text)).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

async function refreshRemote() {
  try {
    REMOTE.info = await api('GET', '/api/remote');
  } catch {
    REMOTE.info = null;
  }
  renderRemote();
}

function renderRemote() {
  const toggle = $('#remote-toggle');
  const hint = $('#remote-hint');
  const row = $('#remote-url-row');
  if (!toggle) return;
  const info = REMOTE.info;
  if (!info) {
    toggle.checked = false;
    toggle.disabled = true;
    row.hidden = true;
    hint.hidden = false;
    hint.textContent = tr('正在读取手机访问的状态…');
    return;
  }
  const local = isLocalHost();
  const ready = info.tailscale === 'ready';
  toggle.checked = !!info.enabled;
  toggle.disabled = REMOTE.busy || !local || (!info.enabled && !ready);
  row.hidden = !(info.enabled && info.url);
  if (!row.hidden) {
    const a = $('#remote-url');
    a.textContent = info.url;
    a.href = info.url;
    a.title = info.url;
  }
  const lines = [];
  if (!local) lines.push(tr('手机访问的开关只能在电脑上改。'));
  if (info.tailscale === 'missing') lines.push(info.error || tr('这台电脑上还没装 Tailscale，先安装再回来打开。'));
  else if (info.tailscale === 'stopped') lines.push(info.error || tr('先在电脑上打开 Tailscale 并登录。'));
  if (info.enabled && info.login) lines.push(tr('只允许 {login} 的设备访问。', { login: info.login }));
  else if (info.tailscale === 'ready' && !info.enabled && info.login) lines.push(tr('打开后，只有 {login} 的设备能通过 Tailscale 访问。', { login: info.login }));
  if (REMOTE.busy) lines.push(tr('正在配置…第一次用可能要十几秒。'));
  if (info.error && info.tailscale === 'ready') lines.push(info.error); // 打开失败（比如要去网页上开通 HTTPS）

  hint.hidden = !lines.length;
  hint.innerHTML = lines.map((x) => linkify(x)).join('<br>');
}

async function setRemote(on) {
  if (REMOTE.busy) return;
  REMOTE.busy = true;
  renderRemote();
  try {
    const info = await api('POST', '/api/remote', { enabled: on });
    REMOTE.info = info;
    if (on && !info.enabled) toast(tr('没能打开手机访问，看看下面的说明'), 6000);
    else toast(on ? tr('手机访问已打开') : tr('手机访问已关闭'));
  } catch (err) {
    REMOTE.info = { ...(REMOTE.info || {}), error: err.message };
    toast(err.message, 6000);
  } finally {
    REMOTE.busy = false;
    renderRemote();
  }
}

async function copyRemoteUrl() {
  const url = REMOTE.info?.url || '';
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    toast(tr('地址已复制'));
    // 按钮上也打个勾，过一会儿变回来
    const btn = $('#remote-copy');
    btn.textContent = tr('已复制');
    btn.classList.add('done');
    clearTimeout(copyRemoteUrl.timer);
    copyRemoteUrl.timer = setTimeout(() => { btn.textContent = tr('复制'); btn.classList.remove('done'); }, 1600);
  } catch {
    toast(tr('复制不了，请手动选中地址复制'));
  }
}

// 安卓 App：能不能打包、打好了没有（服务端 GET /api/android）。在 App 里打开时只显示「App 设置」跳回填地址那一页
async function refreshAndroid() {
  if (!isAndroidApp()) {
    try {
      ANDROID.info = await api('GET', '/api/android');
      ANDROID.error = '';
    } catch (err) {
      ANDROID.info = null;
      ANDROID.error = err.message;
    }
  }
  renderAndroid();
}

function renderAndroid() {
  const row = $('#android-row');
  if (!row) return;
  const dl = $('#android-download');
  const appLink = $('#android-settings');
  const note = $('#android-note');
  const hint = $('#android-hint');
  if (isAndroidApp()) {
    dl.hidden = true;
    appLink.hidden = false;
    note.textContent = tr('换地址、开关通知');
    hint.hidden = true;
    return;
  }
  appLink.hidden = true;
  const info = ANDROID.info;
  if (ANDROID.error) {
    dl.hidden = true;
    note.textContent = tr('读取不到安卓 App 的状态');
  } else if (!info) {
    dl.hidden = true;
    note.textContent = tr('正在读取…');
  } else if (!info.canBuild) {
    dl.hidden = true;
    note.textContent = tr('这台电脑没装 Android SDK，打不了安卓 App');
  } else {
    dl.hidden = false;
    dl.textContent = ANDROID.busy ? tr('正在准备…') : tr('下载安装');
    dl.classList.toggle('disabled', ANDROID.busy);
    dl.setAttribute('aria-disabled', ANDROID.busy ? 'true' : 'false');
    note.textContent = info.built
      ? info.current
        ? tr('App 已是最新（{version}）', { version: info.built })
        : tr('App 已打好（{version}），这次下载会重新打包', { version: info.built })
      : tr('第一次点会先打包，大约 3 秒');
  }
  const showHint = !!info?.canBuild;
  hint.hidden = !showHint;
  hint.textContent = showHint ? tr('手机上要先装 Tailscale、登录同一个账号；安装时手机会提示「允许安装未知来源的应用」，点允许。') : '';
}

// 点下载：打包可能要几秒，按钮上显示「正在准备…」，好了再交给浏览器保存
async function downloadAndroid(e) {
  e.preventDefault();
  if (ANDROID.busy || isAndroidApp() || !ANDROID.info?.canBuild) return;
  ANDROID.busy = true;
  renderAndroid();
  try {
    const res = await fetch('/api/android/apk', { cache: 'no-store' });
    if (!res.ok) {
      let message = '';
      try {
        message = (await res.json())?.error || '';
      } catch {}
      throw new Error(message || tr('下载失败'));
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ClawChat.apk';
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(tr('安卓 App 已下载'));
    await refreshAndroid();
  } catch (err) {
    toast(err.message, 6000);
  } finally {
    ANDROID.busy = false;
    renderAndroid();
  }
}

async function openSettings(tab = 'general') {
  const dlg = $('#dlg-settings');
  $('#quit-section').hidden = hasNative(); // Mac 应用按 ⌘Q 退出；Windows 和浏览器里在这里退出
  if (!dlg.open) dlg.showModal();
  reportDragRegions();
  showSettingsTab(tab);
  renderEngines();
  renderUsage();
  if (tab === 'engines') refreshUsage();
  clearInterval(renderUsage.timer);
  renderUsage.timer = setInterval(() => {
    if (!$('#dlg-settings')?.open) return clearInterval(renderUsage.timer);
    renderUsage();
  }, 60000);
  refreshRemote();
  refreshAndroid();
  try {
    const info = await api('GET', '/api/app');
    S.app = info;
    const tilde = (p) => (IS_WIN ? String(p || '') : String(p || '').replace(/^\/Users\/[^/]+/, '~')); // 像访达一样把个人目录写成 ~
    $('#set-data-dir').textContent = tilde(info.dataDir);
    $('#set-data-dir').title = info.dataDir;
    $('#set-projects-dir').textContent = tilde(info.projectsDir);
    $('#set-projects-dir').title = info.projectsDir;
    const ver = info.commit ? tr('{version}（{commit}）', { version: info.version, commit: info.commit }) : info.version;
    $('#set-version').textContent = ver;
    $('#about-version').textContent = tr('版本 {version}', { version: ver });
    $('#upd-title').textContent = `ClawChat ${info.version}`;
    const repo = info.repo ? `<a href="${esc(info.repo)}" target="_blank" rel="noopener">${esc(info.repo.replace(/^https:\/\//, ''))}</a>` : tr('还没关联 GitHub 仓库');
    $('#set-repo').innerHTML = repo;
    $('#about-repo').textContent = info.repo ? info.repo.replace(/^https:\/\//, '') : '';
    $('#about-repo').href = info.repo || '#';
  } catch (err) {
    toast(err.message);
  }
  if (tab === 'update') checkForUpdate(true);
}
window.__clawchatOpenSettings = (tab) => openSettings(tab || 'general');

// 有新版本（或者新版本已经下载好、等重启）：左下角「设置」右边亮出更新按钮（仿 ChatGPT）
function setUpdateDot(on, res = null) {
  S.update = on ? res : null;
  document.querySelectorAll('i.update-dot').forEach((d) => (d.hidden = !on)); // 设置里「软件更新」那一页的小红点
  const badge = $('#btn-update-badge');
  badge.hidden = !on;
  if (on) badge.title = res?.behind ? tr('有新版本 {version}，点这里更新', { version: res.latest || '' }) : tr('新版本已经下载好，点这里重启生效');
}

// 正在干活的有哪几位（名字）
const busyNames = () => [...new Set(S.runs.map((r) => agentName(r.agent)))];

// 更新、重启时有人在干活：可以等它们这一轮干完再自动重启，也可以现在重启（重启后被打断的活自动接着做）
function busyText(busy) {
  const names = busy.join(LIST_SEP);
  return busy.length > 1
    ? tr('{names} 正在干活。可以等它们这一轮干完再自动重启；现在重启的话，它们手上的活会被打断，重启后自动接着做。', { names })
    : tr('{names} 正在干活。可以等它这一轮干完再自动重启；现在重启的话，它手上的活会被打断，重启后自动接着做。', { names });
}

// restartOnly：新版本已经下载好，只差重启；否则先拉新代码再重启
async function startRestart(restartOnly, when) {
  if (restartOnly) {
    const r = await api('POST', '/api/app/restart', { when });
    if (r.waiting) return setRestartPending('restart');
  } else {
    if (when !== 'idle') toast(tr('正在从 GitHub 拉取最新代码…'), 20000);
    const r = await api('POST', '/api/app/update', { when });
    if (!r.ok) throw new Error(r.error);
    if (r.waiting) return setRestartPending('update');
    if (!r.updated) return toast(tr('已经是最新版'));
  }
  showRestarting();
}

async function updateFromBadge() {
  if (S.restartPending) return askCancelPending();
  const res = S.update;
  if (!res) return;
  if (res.dirty) return toast(tr('本地有没提交的改动，先处理掉才能升级'), 5000);
  const restartOnly = !res.behind && res.needsRestart;
  const busy = busyNames();
  const changes = (res.changes || []).slice(0, 4).map((c) => `· ${splitChange(c.subject).title}`).join('\n'); // 确认框里只列标题，细节在设置页里看
  const ok = await askConfirm({
    title: restartOnly ? tr('新版本已经下载好') : tr('有新版本 {version}', { version: res.latest || '' }),
    text: `${changes ? `${changes}\n\n` : ''}${restartOnly ? tr('重启 ClawChat 后生效。聊天记录和记忆都不受影响。') : tr('会从 GitHub 拉取最新代码，然后自动重启。聊天记录和记忆都不受影响。')}${busy.length ? `\n\n${busyText(busy)}` : ''}`,
    ok: busy.length ? tr('等干完再重启') : restartOnly ? tr('立即重启') : tr('更新并重启'),
    alt: busy.length ? tr('现在重启') : '',
  });
  if (!ok) return;
  try {
    await startRestart(restartOnly, busy.length && ok !== 'alt' ? 'idle' : 'now');
  } catch (err) {
    toast(err.message, 5000);
  }
}

// 在等大家干完再重启：左下角的更新按钮转圈，点它可以马上重启或者不重启了
function setRestartPending(kind, error = '', quiet = false) {
  S.restartPending = kind || false;
  const badge = $('#btn-update-badge');
  badge.classList.toggle('pending', !!kind);
  if (kind) {
    badge.hidden = false;
    badge.title = tr('等正在干活的这一轮干完，就自动重启。点这里可以马上重启，或者不重启了');
    const names = busyNames().join(LIST_SEP) || tr('大家');
    if (!quiet) toast(kind === 'update' ? tr('等 {names} 这一轮干完，就自动更新并重启', { names }) : tr('等 {names} 这一轮干完，就自动重启', { names }), 4000);
  } else {
    setUpdateDot(!!S.update, S.update);
    if (error) toast(error, 5000);
  }
  const status = $('#update-status');
  if (status && kind) status.textContent = tr('等正在干活的这一轮干完，就自动重启…');
}

async function askCancelPending() {
  const kind = S.restartPending;
  const busy = busyNames();
  const ok = await askConfirm({
    title: tr('干完后自动重启'),
    text: `${busy.length ? tr('{names} 还在干活，', { names: busy.join(LIST_SEP) }) : ''}${kind === 'update' ? tr('这一轮都干完后，ClawChat 会自动更新并重启。') : tr('这一轮都干完后，ClawChat 会自动重启。')}`,
    ok: tr('现在就重启'),
    alt: tr('不重启了'),
  });
  if (!ok) return;
  try {
    if (ok === 'alt') {
      await api('POST', '/api/app/restart-cancel');
      return;
    }
    await startRestart(kind === 'restart', 'now');
  } catch (err) {
    toast(err.message, 5000);
  }
}

// 一条更新：提交说明写的是「这一版做了什么：细节……（0.7.13）」。拆成版本号标签、标题（冒号前那句）、
// 细节（默认两行，点一下展开）；时间按界面语言显示成「4 分钟前」
function splitChange(subject) {
  let text = String(subject || '').trim();
  const ver = text.match(/[（(](\d+\.\d+\.\d+)[）)]\s*$/)?.[1] || '';
  if (ver) text = text.replace(/[（(]\d+\.\d+\.\d+[）)]\s*$/, '').trim();
  const cut = text.search(/[：:]/);
  if (cut > 0 && cut <= 60) return { ver, title: text.slice(0, cut), detail: text.slice(cut + 1).trim() };
  return { ver, title: text, detail: '' };
}

function agoText(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const min = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (min < 1) return tr('刚刚');
  if (min < 60) return tr('{n} 分钟前', { n: min });
  if (min < 24 * 60) return tr('{h} 小时 {m} 分钟前', hourMin(min));
  return fmtTime(t);
}

function changeItemHtml(c) {
  const { ver, title, detail } = splitChange(c.subject);
  return `<li><div class="uc-head">${ver ? `<span class="uc-ver">${esc(ver)}</span>` : ''}<span class="uc-title" title="${esc(title)}">${esc(title)}</span><time class="uc-time" datetime="${esc(c.at || '')}">${esc(c.at ? agoText(c.at) : c.when || '')}</time></div>${
    detail ? `<div class="uc-detail" title="${esc(tr('点一下展开 / 收起'))}">${esc(detail)}</div>` : ''
  }</li>`;
}

// 检查更新：show=true 时把结果显示在设置页里；启动时也会悄悄查一次，有新版就在「设置」上亮个小点
async function checkForUpdate(show = false) {
  const status = $('#update-status');
  const list = $('#update-changes');
  const box = $('#update-changes-box');
  const btn = $('#btn-do-update');
  if (show) {
    status.textContent = tr('正在检查…');
    box.hidden = true;
    btn.hidden = true;
  }
  let res;
  try {
    res = await api('POST', '/api/app/check-update');
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  setUpdateDot(res.ok && (res.behind > 0 || res.needsRestart), res);
  if (!show) return;
  if (!res.ok) {
    status.innerHTML = `<span class="error">${esc(res.error)}</span>`;
    return;
  }
  if (!res.behind && res.needsRestart) {
    // 代码已经是新的了，只是还没重启
    status.innerHTML = `<span class="new-text">${tr('新版本 {version} 已经装好，重启 ClawChat 后生效', { version: esc(res.current) })}</span>`;
    btn.hidden = false;
    btn.disabled = false;
    btn.textContent = tr('立即重启');
    btn.dataset.mode = 'restart';
    return;
  }
  btn.textContent = tr('立即升级');
  btn.dataset.mode = 'update';
  if (!res.behind) {
    status.innerHTML = `<span class="ok-text">${tr('已是最新版本')}</span>`;
    return;
  }
  status.innerHTML = `<span class="new-text">${tr('有新版本 {version} 可以升级', { version: esc(res.latest) })}</span><span class="muted"> · ${tr('{n} 处更新', { n: res.behind })}</span>`;
  list.innerHTML = res.changes.map(changeItemHtml).join('');
  list.querySelectorAll('.uc-detail').forEach((el) => (el.onclick = () => el.classList.toggle('open')));
  box.hidden = !res.changes.length;
  btn.hidden = false;
  btn.disabled = !!res.dirty;
  if (res.dirty) status.insertAdjacentHTML('beforeend', `<br><span class="error">${tr('本地有没提交的改动，先处理掉才能升级。')}</span>`);
}

async function doUpdate() {
  const btn = $('#btn-do-update');
  const busy = busyNames();
  let when = 'now';
  if (busy.length) {
    const ok = await askConfirm({ title: tr('{names} 正在干活', { names: busy.join(LIST_SEP) }), text: busyText(busy), ok: tr('等干完再重启'), alt: tr('现在重启') });
    if (!ok) return;
    if (ok !== 'alt') when = 'idle';
  }
  if (when === 'idle') {
    try {
      await startRestart(btn.dataset.mode === 'restart', 'idle');
    } catch (err) {
      $('#update-status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
    }
    return;
  }
  btn.disabled = true;
  if (btn.dataset.mode === 'restart') {
    btn.textContent = tr('正在重启…');
    try {
      await api('POST', '/api/app/restart');
      showRestarting();
    } catch (err) {
      $('#update-status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
      btn.disabled = false;
      btn.textContent = tr('立即重启');
    }
    return;
  }
  btn.textContent = tr('正在升级…');
  $('#update-status').textContent = tr('正在从 GitHub 拉取最新代码…');
  try {
    const res = await api('POST', '/api/app/update');
    if (!res.ok) throw new Error(res.error);
    if (!res.updated) {
      $('#update-status').textContent = tr('已经是最新版');
      return;
    }
    showRestarting();
  } catch (err) {
    $('#update-status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = tr('立即升级');
  }
}

// 升级后服务会重启：在应用里会自动重开窗口；在浏览器里等服务回来就刷新
function showRestarting() {
  $('#update-status').textContent = tr('升级好了，正在重启，稍等十几秒…');
  toast(tr('ClawChat 正在重启升级…'), 20000);
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

// 换新会话前先问老板：谁来给它交代情况。可以选群里另一位 AI（默认是上一个给它派活的）、不用交代（它自己看记录），或者老板自己来
const NOTE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5V8h4M10 12.5h5M10 16h5"/></svg>`;

async function askFresh(agent, roomId) {
  const room = roomById(roomId);
  if (!room) return null;
  let suggested = null;
  try {
    ({ briefer: suggested } = await api('GET', `/api/rooms/${roomId}/fresh?agent=${encodeURIComponent(agent)}`));
  } catch {}
  const name = agentName(agent);
  const busy = S.runs.some((r) => r.roomId === roomId && r.agent === agent && !r.side);
  const conv = currentConv();
  const inDm = conv?.roomId === roomId && conv.dm === agent;
  const peers = room.members.filter((a) => a !== agent);
  const option = (value, icon, label, sub, tag = '') =>
    `<label class="radio fresh-opt"><input type="radio" name="fresh-by" value="${esc(value)}"${value === (suggested || 'self') ? ' checked' : ''}>${icon}<span><b>${esc(label)}</b>${
      tag ? `<em class="tag-rec">${esc(tag)}</em>` : ''}${sub ? `<small>${esc(sub)}</small>` : ''}</span></label>`;
  $('#fresh-title').textContent = tr('给 {name} 换新会话', { name });
  $('#fresh-text').textContent = busy
    ? tr('换了以后，{name} 之前聊过的细节就不记得了，项目文件夹里的东西都还在。它手上这一轮会先停下。\n谁来给它交代一下情况？', { name })
    : tr('换了以后，{name} 之前聊过的细节就不记得了，项目文件夹里的东西都还在。\n谁来给它交代一下情况？', { name });
  $('#fresh-options').innerHTML = [
    ...peers.map((a) =>
      option(
        a,
        avatarHtml(a),
        tr('{name} 来交代', { name: agentName(a) }),
        S.runs.some((r) => r.roomId === roomId && r.agent === a && !r.side) ? tr('它正在干活，这一轮干完再来交代') : tr('在群里把情况讲给它，讲完它接着干'),
        a === suggested ? tr('上次给它派活') : '',
      ),
    ),
    option('self', `<span class="avatar av-note">${NOTE_ICON}</span>`, tr('不用交代'), busy ? tr('它自己翻最近的聊天和完整记录，马上接着干') : tr('它自己翻最近的聊天和完整记录，下次叫它时生效')),
    option('boss', avatarHtml('user'), tr('我自己来交代'), inDm || room.members.length === 1 ? tr('换好后你直接跟它说') : tr('换好后输入框里会 @ 上 {name}，你来说', { name })),
  ].join('');
  const dlg = $('#dlg-fresh');
  let answer = null;
  $('#btn-fresh-ok').onclick = (e) => {
    e.preventDefault();
    answer = dlg.querySelector('input[name="fresh-by"]:checked')?.value || 'self';
    closeDialog(dlg);
  };
  $('#btn-fresh-cancel').onclick = () => closeDialog(dlg);
  dlg.showModal();
  dlg.querySelector('input[name="fresh-by"]:checked')?.focus();
  reportDragRegions();
  return new Promise((resolve) =>
    dlg.addEventListener('close', () => {
      reportDragRegions();
      resolve(answer);
    }, { once: true }),
  );
}

// 给某位换新会话：正在干活就把这一轮换个新会话重来；空着就直接换。先问老板谁来交代情况
async function freshAgent(agent, btn, roomId = currentConv()?.roomId) {
  if (!roomId) return;
  const by = await askFresh(agent, roomId);
  if (!by) return;
  if (btn) btn.disabled = true;
  let done = false;
  try {
    const { result } = await api('POST', `/api/rooms/${roomId}/fresh`, { agent, by });
    done = true;
    const name = agentName(agent);
    toast(
      result === 'none'
        ? tr('{name} 现在没有会话，下次叫它本来就是新开的', { name })
        : by === 'boss'
          ? tr('{name} 换成了新会话，跟它交代一下吧', { name })
          : S.agents[by]
            ? tr('{name} 换成了新会话，先请 {by} 把情况交代给它', { name, by: agentName(by) })
            : result === 'restarted'
              ? tr('{name} 正在换新会话', { name })
              : tr('{name} 换成了新会话，下次叫它时生效', { name }),
      3500,
    );
    if (by === 'boss' && result !== 'none') briefYourself(agent, roomId);
  } catch (err) {
    toast(err.message);
    if (btn) btn.disabled = false;
  }
  // 从群设置（右上角「···」）里换的：换好了就把群设置也关掉，回到聊天看交代的过程；
  // 群设置里还改了别的、没保存，就留着窗口，免得改的东西丢了，只刷新会话那一栏
  const settings = $('#dlg-room');
  if (S.editing === roomId && settings.open) {
    if (done && roomFormSnapshot() === roomFormSnapshot.saved) closeDialog(settings);
    else setTimeout(() => loadSessions(roomById(roomId)), 600);
  }
  setTimeout(() => refreshSessionImages(roomId), 600);
}

// 老板选了自己来交代：群里在输入框 @ 上它，私聊、单聊里直接说就行。群设置还开着的话，等关掉再填，免得抢焦点
function briefYourself(agent, roomId) {
  const settings = $('#dlg-room');
  if (settings.open) return settings.addEventListener('close', () => setTimeout(() => briefYourself(agent, roomId), 200), { once: true });
  const conv = currentConv();
  if (conv?.roomId !== roomId) return;
  const el = $('#input');
  const tag = `@${MENTION_GAP}${agentName(agent)}${MENTION_SEP}`;
  if (conv.dm || conv.room.members.length < 2 || el.value.includes(tag)) return el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  insertMention(agentName(agent), el);
}

// ---------------- ChatGPT 会话太重的常驻提醒 ----------------
// 它看过的图都会整张存进会话，每轮都要重发：到 8MB 顶部按钮上亮橙点，13MB 变红点；点开菜单最上面就能换新会话
const HEAVY = [8 * 1048576, 13 * 1048576];
const heavyLevel = (bytes) => HEAVY.filter((n) => bytes >= n).length;
const sessionImages = (roomId, agent) => S.sessionImages.get(roomId)?.[agent] || 0;

async function refreshSessionImages(roomId) {
  const room = roomById(roomId);
  if (!room?.members.includes('gpt')) return;
  try {
    const { sessions } = await api('GET', `/api/rooms/${roomId}/sessions`);
    const before = sessionImages(roomId, 'gpt');
    S.sessionImages.set(roomId, Object.fromEntries(Object.entries(sessions).map(([a, s]) => [a, s.images || 0])));
    if (heavyLevel(before) !== heavyLevel(sessionImages(roomId, 'gpt')) && currentConv()?.roomId === roomId) {
      $('#model-switch')._html = null;
      renderShell();
    }
  } catch {}
}

// 什么时候该换新会话：写在每一位的会话下面
const FRESH_TIPS = {
  claude: tr('什么时候换：用到七成左右，或一件大事做完时。越长每轮越慢、越费额度；快满时它会自动压缩记忆，要等一两分钟，细节也会丢。'),
  gpt: tr('什么时候换：用到七成左右，或图片到 8MB 时（一批图做完就换）。图片攒到 15MB 左右，它会慢得像卡住一样。'),
  deepseek: tr('什么时候换：上限很大，不容易满，一件事做完、或用到七成左右时换。越长每轮越慢、越费钱（大多走缓存，花费很低）。'),
};
const USAGE_WARN = 0.7; // 用到七成：建议换
const USAGE_BAD = 0.85; // 用到八成五：快满了，随时会自动压缩

// 46.9 万、100 万、8,000；英文界面写成 469K、1M、8,000
function fmtTokens(n) {
  if (I18N.lang !== 'zh') return n.toLocaleString('en-US', n < 10000 ? {} : { notation: 'compact', maximumFractionDigits: 1 });
  if (n < 10000) return n.toLocaleString('zh-CN');
  return `${(n / 10000).toFixed(n >= 1000000 ? 0 : 1).replace(/\.0$/, '')} 万`;
}

// 群设置里的「会话（记忆）」：每位记了多少（上下文用了多少、上限多少，ChatGPT 还有存着的图片）、什么时候该换，随时可以手动换
async function loadSessions(room) {
  const box = $('#session-list');
  if (!room) return;
  try {
    const { sessions } = await api('GET', `/api/rooms/${room.id}/sessions`);
    box.innerHTML = room.members
      .map((a) => {
        const s = sessions[a] || {};
        const ratio = s.window ? s.used / s.window : 0;
        const imgLevel = heavyLevel(s.images || 0);
        const ctxLevel = ratio >= USAGE_BAD ? 2 : ratio >= USAGE_WARN ? 1 : 0;
        const level = Math.max(ctxLevel, imgLevel);
        const parts = [s.busy ? tr('正在干活') : s.has ? tr('有会话') : tr('还没有会话，下次叫它会新开一个')];
        if (s.used) {
          const pct = Math.round(ratio * 100);
          parts.push(
            s.window
              ? tr('记忆已用 {pct}%（{used} / {total} token）', { pct: pct || tr('不到 1'), used: fmtTokens(s.used), total: fmtTokens(s.window) })
              : tr('记忆已用 {used} token（上限等它下次回复后显示）', { used: fmtTokens(s.used) }),
          );
        }
        if (s.images) parts.push(tr('图片 {size}MB', { size: (s.images / 1048576).toFixed(1) }));
        const advice = level > 1 ? (imgLevel > 1 ? tr('图片太多，马上换新会话') : tr('快满了，建议现在就换')) : level ? tr('建议换新会话') : '';
        const bar = s.used && s.window
          ? `<span class="usage-bar${ctxLevel > 1 ? ' bad' : ctxLevel ? ' warn' : ''}"><i style="width:${Math.min(100, Math.max(1, ratio * 100)).toFixed(1)}%"></i></span>`
          : '';
        return `<div class="list-row top session-row">${avatarHtml(a)}<span class="row-text"><b>${esc(agentName(a))}</b><small class="usage-text${level > 1 ? ' bad' : level ? ' warn' : ''}">${esc(
          advice ? tr('{text}，{advice}', { text: parts.join(' · '), advice }) : parts.join(' · '),
        )}</small>${bar}<small class="fresh-tip">${esc(FRESH_TIPS[a] || '')}</small></span><button type="button" class="secondary" data-fresh="${esc(a)}"${s.has || s.busy ? '' : ' disabled'}>${tr('换新会话')}</button></div>`;
      })
      .join('');
  } catch (err) {
    box.innerHTML = `<div class="list-row"><span class="row-text"><small class="error">${esc(err.message)}</small></span></div>`;
  }
}

// 借外部接口那几位的 API Key（DeepSeek、GLM）：服务那边先试一下能不能用，能用才存
async function saveProviderKey(id) {
  const input = $(`#${id}-key`);
  const btn = $(`#btn-${id}-save`);
  const name = agentName(id);
  btn.disabled = true;
  btn.textContent = tr('检查中…');
  try {
    const res = await api('POST', `/api/${id}/key`, { key: input.value.trim() });
    S.engines = res.engines || S.engines;
    input.value = '';
    toast(res.warning || (S.engines[id]?.hasKey ? tr('{name} 的 API Key 已保存，可以用了', { name }) : tr('已删掉 {name} 的 API Key', { name })), 4000);
    if (S.engines[id]?.hasKey && needsClaudeCode(id)) setTimeout(() => offerClaudeCode('key', [id]), 600); // Key 填好了，但借来干活的 Claude Code 还没装
  } catch (err) {
    toast(err.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = tr('保存');
  }
  renderEngines();
  $('#model-switch')._html = null; // 模型列表可能变了
  renderShell();
}

// API：填一个 OpenAI 兼容平台的地址和 Key。服务端先读出模型列表试试，能用才存
async function saveApiKey() {
  const baseEl = $('#api-base');
  const keyEl = $('#api-key');
  const btn = $('#btn-api-save');
  btn.disabled = true;
  btn.textContent = tr('检查中…');
  const base = baseEl.value.trim();
  const key = keyEl.value.trim();
  try {
    if (!base && key) throw new Error(tr('先填接口地址（到 /v1 为止），再填 Key'));
    // 地址清空、Key 也空着 = 删掉；只改地址、Key 空着 = 保留原来的 Key（服务端收到不带 key 的请求就保留）
    const body = { base };
    if (key) body.key = key;
    if (!base) body.key = '';
    const res = await api('POST', '/api/api/key', body);
    S.engines = res.engines || S.engines;
    keyEl.value = '';
    toast(
      res.warning ||
        (!base ? tr('已删掉 API 的地址和 Key') : key ? tr('API 的地址和 Key 已保存，可以用了') : tr('接口地址已保存')),
      4000,
    );
    if (S.engines.api?.hasKey) setTimeout(() => offerClaudeCode('key', ['api']), 600); // 借来干活的 Claude Code 还没装的话问一下
  } catch (err) {
    toast(err.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = tr('保存');
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
    btn.textContent = busy > 1 ? tr('有 {n} 位正在干活，再点一次确认退出', { n: busy }) : tr('有 1 位正在干活，再点一次确认退出');
    return;
  }
  try {
    await api('POST', '/api/app/quit');
  } catch {}
  showQuit();
}

function showQuit() {
  const again = IS_WIN ? tr('下次双击桌面上的 ClawChat 就能打开。') : tr('下次运行 npm start 就能打开。');
  document.body.innerHTML = `<div class="quit-screen"><h2>${tr('ClawChat 已退出')}</h2><p>${tr('可以关掉这个窗口了。')}${again}</p></div>`;
}

let lastEngineRefresh = 0;
function refreshEngines(force = false) {
  if (!force && Date.now() - lastEngineRefresh < 60 * 1000) return;
  lastEngineRefresh = Date.now();
  api('POST', '/api/engines/refresh').catch(() => {}); // 有变化会通过事件推回来
}

// 群设置里的下拉框做成 macOS 的弹出按钮：带框，宽度刚好包住选中的字（原生下拉框默认按最长的选项算宽度）
const measureCtx = document.createElement('canvas').getContext('2d');
function fitSelects(root = $('#dlg-room')) {
  root.querySelectorAll('.group-box select').forEach((sel) => {
    const cs = getComputedStyle(sel);
    measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const w = measureCtx.measureText(sel.selectedOptions[0]?.textContent || '').width;
    sel.style.width = `${Math.ceil(w + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2)}px`;
  });
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
  formField('fastGpt').value = room?.fast?.gpt ? '1' : '';
  refreshSpeedField();
  fitSelects();
}

// 群设置里单独的「速度」分区：ChatGPT 在群里、当前模型支持快速模式才显示
function refreshSpeedField() {
  const speed = fastSpeed('gpt', formField('modelGpt').value);
  // 联合群里 ChatGPT 一律标准速度，这一栏选了也不生效，不显示
  $('#speed-fields').hidden = speed === null || !formField('memberGpt').checked || !!roomById(S.editing)?.joint;
  if (speed === null) formField('fastGpt').value = '';
  formField('fastGpt').options[1].textContent = speed ? tr('快速 · 约 {speed} 倍速', { speed }) : tr('快速 · 更快');
  $('#speed-hint').textContent = speed
    ? tr('快速模式下 ChatGPT 大约快 {speed} 倍，但会按标准速度的 2.5 倍消耗你 ChatGPT 订阅里的额度（OpenAI 官方数据），所以默认用标准速度。聊天窗口顶部 ChatGPT 的按钮里也能随时切换。', { speed })
    : tr('快速模式下 ChatGPT 会快一些，但会按标准速度的 2.5 倍消耗你 ChatGPT 订阅里的额度（OpenAI 官方数据），所以默认用标准速度。聊天窗口顶部 ChatGPT 的按钮里也能随时切换。');
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
  try {
    await patchSettings(conv, { ...settingsPatch(conv, agent, 'model', id), custom: custom ? [agent] : [] });
    const name = modelOptions(agent).find((o) => o.id === id)?.name || id;
    toast(tr('{name} 已切换到 {model}，下一轮生效{scope}', { name: agentName(agent), model: name, scope: scopeText(conv) }));
  } catch (err) {
    toast(err.message);
  }
  $('#model-switch')._html = null; // 切换失败时让下拉框退回原来的选项
  renderShell();
}

function syncMemberFields() {
  const members = AGENT_IDS.filter((a) => formField(fieldName('member', a)).checked);
  // 加入方的「协作」归主持方管，不显示
  $('#group-fields').hidden = members.length < 2 || roomById(S.editing)?.joint?.role === 'guest';

  for (const a of AGENT_IDS) $(`#field-model-${a}`).hidden = !members.includes(a);
  refreshSpeedField();
  formField('name').placeholder = members.length === 1 ? tr('留空就叫「{name}」', { name: agentLabel(members[0]) }) : tr('比如：今天争取不加班');
  // 勾了还不能用的成员，提前说一声（不拦着，先建好也行）；没装的直接给「安装」按钮
  const hint = $('#member-hint');
  hint.innerHTML = memberHintHtml(members);
  hint.hidden = !hint.textContent.trim();
  return members;
}

// 群设置里提示：勾上的成员缺什么。没装的给一键安装的按钮，没登录的说清去哪登录
function memberHintHtml(members) {
  const rows = [];
  const has = (b) => members.some((a) => baseOf(a) === b);
  // Claude、DeepSeek、GLM 都要借 Claude Code，没装就一起说
  const needs = NEEDS_CLAUDE_CODE.filter(has);
  if (needs.length && claudeMissing()) {
    rows.push(`${esc(tr('Claude Code 是 {names} 干活必需的，这台电脑还没装：', { names: needs.map(agentName).join(LIST_SEP) }))} ${installButtonHtml('secondary', 'claude')}`);
  }
  const ds = S.engines.deepseek;
  if (has('deepseek') && ds && !claudeMissing() && !ds.hasKey) rows.push(esc(tr('DeepSeek 还没填 API Key：建好后在「设置 → 程序与模型」里填一下就能用。')));
  for (const b of ['gpt', 'grok', 'cursor']) {
    if (!has(b)) continue;
    const key = AGENT_ENGINE[b];
    const e = S.engines[key];
    if (!e) continue;
    if (!e.path) rows.push(`${esc(tr('{name} 要装 {bin} 才能用：', { name: agentName(b), bin: INSTALL_NAMES[key] }))} ${installButtonHtml('secondary', key)}`);
    else if (e.loggedIn === false) rows.push(esc(tr('{name} 还没登录：登录要在电脑上做，打开「设置 → 程序与模型」点「登录」。', { name: agentName(b) })));
  }
  // API：填了地址和 Key 没填、或者连不上，说一声
  const api = S.engines.api;
  if (has('api') && api) {
    if (!api.hasKey) rows.push(esc(tr('API 还没填接口地址和 API Key：建好后在「设置 → 程序与模型」里填一下就能用。')));
    else if (!api.ok) rows.push(esc(tr('API 连不上：{error}', { error: !api.base ? tr('还没填接口地址') : api.keyError || tr('检查一下地址和 Key') })));
  }
  return rows.join('<br>');
}

// 新建聊天时默认勾上能用的成员；一个都不能用（比如还在检测）就勾 Claude 和 GPT。
// 多开的（ChatGPT2 这类）不默认勾：它们是老板自己加进来的，要用就在群设置里勾上，
// 不然每建一个群都会多出一位同账号的 AI，不 @ 的时候容易和本体一起开工
function defaultMembers() {
  const ready = BASE_IDS.filter(memberReady);
  return ready.length ? ready : ['claude', 'gpt'];
}

// 成员勾选框：这台电脑上用不了的（比如没登录 Claude、没装 Codex）默认不出现；已经在群里的照常显示。
// 想加还没装好的，点「显示全部」
// 这位现在用不了的原因，写在小字里（没装 / 没登录 / 没填 Key）：卡片照样显示，只是默认不勾
function memberIssue(a) {
  const b = baseOf(a);
  const E = S.engines;
  if (!Object.keys(E).length) return '';
  if (b === 'claude') return !E.claude?.path ? tr('没装') : E.claude.loggedIn === false ? tr('没登录') : '';
  if (b === 'gpt') return !E.codex?.path ? tr('没装') : E.codex.error ? tr('要升级 Codex') : E.codex.loggedIn === false ? tr('没登录') : '';
  if (b === 'gemini') return E.gemini?.ok ? '' : E.gemini?.path ? tr('还没配好') : tr('没装');
  if (b === 'grok') return !E.grok?.path ? tr('没装') : E.grok.loggedIn === false ? tr('没登录') : E.grok.error ? tr('要升级 Grok') : '';
  if (b === 'cursor') return !E.cursor?.path ? tr('没装') : E.cursor.loggedIn === false ? tr('没登录') : E.cursor.error ? tr('要升级 Cursor') : '';
  if (b === 'api') {
    if (!E.api) return '';
    if (!E.api.hasKey) return tr('还没填 API Key');
    if (!E.claude?.path) return tr('没装 Claude Code');
    if (!E.api.base) return tr('还没填地址');
    return E.api.ok ? '' : tr('连不上平台');
  }
  const e = E[b];
  if (!e?.hasKey) return tr('还没填 API Key');
  if (!E.claude?.path) return tr('没装 Claude Code');
  return e.ok ? '' : tr('API Key 不对');
}

// 成员卡片：用不了的也全部列出来，副标题换成原因（原来的说明先记在 data-sub 里，能用了再换回来）
function updateMemberStates() {
  for (const a of AGENT_IDS) {
    const box = formField(fieldName('member', a));
    const el = box?.closest('.member');
    if (!el) continue;
    const small = el.querySelector('.member-name small');
    if (!el.dataset.sub) el.dataset.sub = small.textContent;
    const issue = memberIssue(a);
    small.textContent = issue || el.dataset.sub;
    el.classList.toggle('unready', !!issue);
    el.title = issue ? tr('{name} 现在用不了：{reason}。可以先勾上建群，装好、登录或填上 Key 之后就能用。', { name: agentName(a), reason: issue }) : '';
  }
}

// 「＋ 多开一位」：在这个群里再加一位同账号的 AI。先选是谁，选完在成员格子里多一张 2 号卡片并勾上；
// 保存时服务端才真正开出来（编号取这个群还没用的最小号）
function renderClonePicker() {
  const box = $('#clone-picker');
  box.innerHTML = BASE_IDS.map((b) => `<button type="button" class="clone-pick" data-clone-base="${esc(b)}">${avatarHtml(b)}<span>${esc(agentName(b))}</span></button>`).join('');
  box.querySelectorAll('[data-clone-base]').forEach((btn) => (btn.onclick = () => addCloneMember(btn.dataset.cloneBase)));
}

function addCloneMember(base) {
  const checked = new Set(AGENT_IDS.filter((a) => baseOf(a) === base && formField(fieldName('member', a))?.checked));
  let n = 2;
  while (n <= 9 && checked.has(`${base}${n}`)) n++;
  if (n > 9) return toast(tr('{name} 最多开到 9 号', { name: agentName(base) }));
  const id = `${base}${n}`;
  $('#clone-picker').hidden = true;
  if (!S.agents[id]) PENDING_CLONES.add(id);
  rebuildMembers();
  const box = formField(fieldName('member', id));
  if (!box) return;
  box.checked = true;
  fillModelRow(id);
  syncMemberFields();
  updateMemberStates();
  box.closest('.member')?.scrollIntoView({ block: 'nearest' });
}

// 刚加的那张卡片的模型、思考强度下拉框里还没有选项：只补这一行
function fillModelRow(a) {
  const room = S.editing ? roomById(S.editing) : null;
  const models = room?.models || S.defaults.models || {};
  const efforts = room?.efforts || S.defaults.efforts || {};
  const m = formField(fieldName('model', a));
  const e = formField(fieldName('effort', a));
  if (m) m.outerHTML = modelSelectHtml(a, models[a], `name="${fieldName('model', a)}" data-pair="${esc(a)}"`);
  if (e) e.outerHTML = effortSelectHtml(a, models[a], efforts[a], `name="${fieldName('effort', a)}"`);
  if (baseOf(a) === 'gpt') refreshSpeedField();
}

function openDialog(room, preset = null) {
  S.editing = room ? room.id : null;
  const d = room || { ...S.defaults, name: '', cwd: '', members: preset || defaultMembers() };
  // 联合群里的成员一般用「节点:成员」的 key 存，自己这边的 id 从 jointMembers 里取
  const ownMembers = room?.joint && room.jointMembers?.length ? room.jointMembers.filter((m) => m.mine).map((m) => m.agentId) : d.members;
  const solo = !room?.joint && d.members.length === 1;
  $('#dlg-title').textContent = room?.joint ? tr('联合群设置') : room ? (solo ? tr('聊天设置') : tr('群设置')) : tr('新建聊天');
  $('#btn-save').textContent = room ? tr('保存') : tr('创建');
  const del = $('#btn-delete');
  del.hidden = !room;
  del.dataset.armed = '';
  del.textContent = solo ? tr('删除聊天') : tr('删除群聊');
  $('#btn-clear').hidden = !room;
  PENDING_CLONES = new Set(); // 上一次没保存就关掉的话，别把那张卡带进来
  $('#clone-picker').hidden = true;
  rebuildMembers();
  for (const a of AGENT_IDS) formField(fieldName('member', a)).checked = ownMembers.includes(a);
  updateMemberStates();
  syncJointFields(room);
  $('#perm-win-hint').hidden = !IS_WIN;
  $('#session-fields').hidden = !room;
  if (room) {
    $('#session-list').innerHTML = `<div class="list-row"><span class="row-text"><small>${tr('读取中…')}</small></span></div>`;
    loadSessions(room);
  }
  formField('name').value = d.name || '';
  formField('cwd').value = d.cwd || '';
  formField('cwd').placeholder = room ? '' : tr('留空就自动新建：{dir}/名字', { dir: S.projectsDir });
  formField('permission').value = d.permission || 'project';
  formField('collab').checked = d.collab !== false;
  formField('maxAutoTurns').value = d.maxAutoTurns || 25;
  // 收纳组：只有群能放（单聊勾一位成员的时候不显示）
  const folderSel = $('#set-folder');
  folderSel.innerHTML = [
    `<option value="">${tr('不放进收纳组')}</option>`,
    ...S.folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`),
    `<option value="__new__">${tr('新建收纳组…')}</option>`,
  ].join('');
  folderSel.value = room?.folder && S.folders.some((f) => f.id === room.folder) ? room.folder : '';
  fillModelOptions(room);
  syncMemberFields();
  $('#form-error').hidden = true;
  roomFormSnapshot.saved = roomFormSnapshot(); // 记下打开时的样子：换新会话后，没改过别的就顺手把窗口关掉
  $('#dlg-room').showModal();
  if (room?.joint) checkPendingJointPairs(); // 设置打开时补查一下有没有等你同意的加入申请
  $('#dlg-room .sheet-body').scrollTop = 0; // 上次滚到底下关掉的：再打开（尤其是新建）从头显示成员和名字
  reportDragRegions();
  // 手机上不自动聚焦名字：一打开群设置就弹键盘，挡住大半个窗口；窗口自己拿焦点（showModal 会把焦点给第一个输入框）
  if (finePointer()) formField('name').focus();
  else blurInDialog($('#dlg-room'));
}

// 手指点的设备上，弹窗打开时别让输入框拿到焦点（不然键盘会弹出来）：把焦点交给弹窗本身
function blurInDialog(dlg) {
  if (!dlg.hasAttribute('tabindex')) dlg.setAttribute('tabindex', '-1');
  dlg.focus({ preventScroll: true });
}

// 群设置里填的东西（名字、成员、模型、收纳组……），用来看打开以后有没有改过。
// 表单里带 name 的控件 FormData 会自动带上；不带 name 的（比如收纳组下拉框）要在这里手动补，以后加控件别漏了
function roomFormSnapshot() {
  return JSON.stringify([...new FormData($('#room-form'))].concat([['folder', $('#set-folder').value]]));
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
    fast: { gpt: !$('#speed-fields').hidden && formField('fastGpt').value === '1' },
  };
  body.folder = $('#set-folder').value || null; // 传 null 就是移出收纳组
  if (S.editing && roomById(S.editing)?.joint) {
    // 联合群没有项目文件夹和动手权限：别让服务端顺手建一个文件夹
    delete body.cwd;
    delete body.permission;
  }
  const btn = $('#btn-save');
  // 保存前先记下原来有哪些成员：改个群名、换个设置不该反复问「要不要装 Claude Code」
  const before = S.editing ? roomById(S.editing)?.members || [] : [];
  const jointRoom = S.editing ? roomById(S.editing) : null;
  btn.disabled = true;
  try {
    if (jointRoom?.joint) {
      // 权限先存（服务端会核对文件夹）；改群名、成员这些再走普通 PATCH
      if (!S.jointPolicy || S.jointPolicy.roomId !== S.editing) await loadJointPolicy(jointRoom);
      const agents = collectJointPolicy();
      if (!agents) throw new Error(tr('权限还没读取出来，请重新打开设置'));
      await api('PUT', `/api/rooms/${S.editing}/joint/policy`, { agents });
    }
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
    // 新建群、或者这次新加了要借 Claude Code 的成员时才问
    const who = (body.members || []).filter((a) => needsClaudeCode(a) && !before.includes(a));
    if (who.length) setTimeout(() => offerClaudeCode('room', who), 400);
  } catch (err) {
    $('#form-error').textContent = err.message;
    $('#form-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
}

// 清空聊天记录：先问清楚；「清空记录」AI 的记忆留着，「清空并让 AI 也忘掉」大家换新会话从头开始
async function clearRoom() {
  const room = roomById(S.editing);
  if (!room) return;
  const answer = await askConfirm({
    title: tr('清空「{name}」的聊天记录？', { name: room.name }),
    text: tr('这个聊天里所有的消息、私聊和图片都会删掉，删了找不回来；项目文件夹里的文件不动。选「清空记录」，AI 还记得之前聊过的事；选「清空并让 AI 也忘掉」，大家从头开始。'),
    ok: tr('清空记录'),
    alt: tr('清空并让 AI 也忘掉'),
  });
  if (!answer) return;
  try {
    await api('POST', `/api/rooms/${room.id}/clear`, { forget: answer === 'alt' });
    closeDialog($('#dlg-room'));
  } catch (err) {
    toast(err.message);
  }
}

async function deleteRoom() {
  const del = $('#btn-delete');
  if (!del.dataset.armed) {
    del.dataset.armed = '1';
    del.textContent = tr('再点一次确认删除（聊天记录和私聊都会清空，项目文件夹不动）');
    return;
  }
  try {
    await api('DELETE', `/api/rooms/${S.editing}`);
    dropRoomAttachments(S.editing);
    S.rooms = S.rooms.filter((r) => r.id !== S.editing);
    for (const k of convKeysOfRoom(S.editing)) {
      S.messages.delete(k);
      S.bounds.delete(k);
      S.early.delete(k);
    }
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

// opts.name：给「保存」用的文件名（手机上看电脑里的图才有）；opts.check：加载失败时去问原因
function openLightbox(src, opts = {}) {
  const box = $('#lightbox');
  const img = box.querySelector('img');
  let wait = box.querySelector('.lb-loading');
  let save = box.querySelector('.lb-save');
  if (!wait) {
    wait = document.createElement('div');
    wait.className = 'lb-loading';
    save = document.createElement('a');
    save.className = 'lb-save';
    box.append(wait, save);
  }
  wait.textContent = tr('加载中…');
  save.textContent = tr('保存 / 分享');
  lbZoom.reset();
  img.removeAttribute('src');
  img.hidden = true;
  wait.hidden = false;
  save.hidden = true;
  img.onload = () => {
    wait.hidden = true;
    img.hidden = false;
    if (opts.name) {
      // 转过格式的（HEIC 等）存下来是 JPEG，扩展名跟着改
      const jpeg = /\.(heic|heif|tiff?|psd|dng|cr2|nef|arw)$/i.test(opts.name);
      save.href = src;
      save.download = jpeg ? opts.name.replace(/\.[^.]+$/, '.jpg') : opts.name;
      save.hidden = false;
    }
  };
  img.onerror = async () => {
    if (box.hidden || img.getAttribute('src') !== src) return;
    const err = opts.check ? await viewError(src) : '';
    closeLightbox();
    toast(err || tr('图片打不开'), 5000);
  };
  img.src = src;
  box.hidden = false;
  reportDragRegions();
}

// 大图双指放大、放大后单指拖动、双击放大或复原（手机上整页不能缩放，只能在这里自己做）
const lbZoom = (() => {
  const pts = new Map();
  let scale = 1, x = 0, y = 0, start = null, moved = false, lastTap = 0;
  const img = () => $('#lightbox img');
  const apply = () => { img().style.transform = scale === 1 ? '' : `translate(${x}px, ${y}px) scale(${scale})`; };
  const reset = () => { scale = 1; x = 0; y = 0; pts.clear(); start = null; apply(); };
  const dist = ([a, b]) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = ([a, b]) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  function down(e) {
    if (e.target.closest('.lb-save')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) moved = false;
    const list = [...pts.values()];
    start = { scale, x, y, d: list.length > 1 ? dist(list) : 0, m: list.length > 1 ? mid(list) : list[0] };
    $('#lightbox').classList.add('gesturing');
  }
  function move(e) {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId);
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) moved = true;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const list = [...pts.values()];
    if (list.length > 1 && start.d) {
      const m = mid(list);
      scale = Math.min(6, Math.max(1, start.scale * (dist(list) / start.d)));
      x = start.x + (m.x - start.m.x);
      y = start.y + (m.y - start.m.y);
    } else if (scale > 1) {
      x = start.x + (e.clientX - start.m.x);
      y = start.y + (e.clientY - start.m.y);
    }
    apply();
  }
  function up(e) {
    if (!pts.delete(e.pointerId)) return;
    const list = [...pts.values()];
    if (list.length) start = { scale, x, y, d: list.length > 1 ? dist(list) : 0, m: list.length > 1 ? mid(list) : list[0] };
    else {
      $('#lightbox').classList.remove('gesturing');
      if (scale < 1.05) { scale = 1; x = 0; y = 0; apply(); }
    }
  }
  // 点一下：没在拖、没放大就关掉；双击：放大 / 复原
  function tap(e) {
    if (e.target.closest('.lb-save')) return;
    if (moved) return void (moved = false);
    const now = Date.now();
    if (now - lastTap < 300 && e.target.tagName === 'IMG') {
      lastTap = 0;
      clearTimeout(tap.timer);
      if (scale > 1) { scale = 1; x = 0; y = 0; } else scale = 2.5;
      return apply();
    }
    lastTap = now;
    clearTimeout(tap.timer);
    if (scale > 1) return; // 放大着看细节时点一下不关，双击复原后再点
    tap.timer = setTimeout(closeLightbox, e.target.tagName === 'IMG' ? 280 : 0);
  }
  return { reset, down, move, up, tap };
})();

function closeLightbox() {
  const box = $('#lightbox');
  if (box.hidden) return;
  animateThen(box, 'leaving', 180, () => {
    box.hidden = true;
    lbZoom.reset();
    reportDragRegions();
  });
}

function bind() {
  $('#btn-new').onclick = () => openDialog(null);
  // 联合群（第一期）
  $('#btn-joint-create-open').onclick = () => {
    closeDialog($('#dlg-room'));
    openJointCreate();
  };
  $('#btn-joint-create-cancel').onclick = () => closeDialog($('#dlg-joint-create'));
  $('#btn-joint-create-ok').onclick = submitJointCreate;
  $('#btn-joint-join-open').onclick = () => {
    closeDialog($('#dlg-room'));
    openJointJoin();
  };
  $('#btn-joint-join-cancel').onclick = () => closeDialog($('#dlg-joint-join'));
  $('#btn-joint-join-ok').onclick = submitJointJoin;
  $('#dlg-joint-join').addEventListener('close', () => {
    clearTimeout(jointJoinPoll);
    jointJoinPairId = '';
  });
  $('#btn-joint-copy').onclick = copyJointInvite;
  $('#btn-joint-invite-close').onclick = () => closeDialog($('#dlg-joint-invite'));
  $('#dlg-joint-invite').addEventListener('close', () => clearInterval(jointInviteTimer));
  $('#btn-joint-invite').onclick = requestJointInvite;
  $('#btn-joint-want-cancel').onclick = () => closeDialog($('#dlg-joint-want-file'));
  $('#btn-joint-want-send').onclick = submitJointWantFile;
  $('#btn-joint-action-no').onclick = () => answerJointApproval(false);
  $('#btn-joint-action-yes').onclick = () => answerJointApproval(true);
  $('#dlg-joint-action').addEventListener('cancel', (e) => e.preventDefault()); // 必须明确选同意或拒绝
  $('#joint-confirm-all').onchange = () => {
    const on = $('#joint-confirm-all').checked;
    if (S.jointPolicy) for (const p of Object.values(S.jointPolicy.agents)) p.confirm = on;
  };
  $('#btn-joint-inbox').onclick = openJointInbox;
  $('#btn-joint-leave').onclick = leaveJointRoom;
  $('#btn-joint-approve-no').onclick = () => answerJointApprove(false);
  $('#btn-joint-approve-yes').onclick = () => answerJointApprove(true);
  $('#btn-joint-file-no').onclick = () => closeDialog($('#dlg-joint-file'));
  $('#btn-joint-file-yes').onclick = approveJointFile;
  $('#btn-joint-inbox-close').onclick = () => closeDialog($('#dlg-joint-inbox'));
  document.addEventListener('click', (e) => {
    if (e.target.closest('#btn-joint-invite-bar')) requestJointInvite();
    if (e.target.closest('#btn-joint-want-file-bar')) openJointWantFile();
    const rev = e.target.closest('[data-inbox-reveal]');
    if (rev) {
      const room = jointRoom();
      if (room) api('POST', '/api/joint/files/inbox/reveal', { roomId: room.id, transferId: rev.dataset.inboxReveal }).catch((err) => toast(err.message));
    }
  });
  $('#btn-welcome-new').onclick = () => openDialog(null);
  document.querySelectorAll('[data-solo]').forEach((b) => (b.onclick = () => openDialog(null, [b.dataset.solo])));
  $('#btn-settings').onclick = () => currentConv() && openDialog(currentConv().room);
  $('#btn-cancel').onclick = () => closeDialog($('#dlg-room'));
  $('#btn-delete').onclick = deleteRoom;
  $('#btn-clear').onclick = clearRoom;
  $('#room-form').addEventListener('submit', submitDialog);
  $('#room-form').addEventListener('change', (e) => {
    if (/^member/.test(e.target.name)) syncMemberFields();
    if (e.target.dataset.pair) refreshEffortField(e.target.dataset.pair);
    if (e.target.dataset.pair === 'gpt') refreshSpeedField();
    if (e.target.name === 'fastGpt' && e.target.value === '1') {
      confirmFast(fastSpeed('gpt', formField('modelGpt').value)).then((yes) => {
        if (!yes) e.target.value = '';
        fitSelects();
      });
    }
    if (e.target.tagName === 'SELECT') fitSelects();
  });
  $('#btn-pick').onclick = async () => {
    try {
      const p = await pickFolder();
      if (p) formField('cwd').value = p;
    } catch (err) {
      toast(err.message);
    }
  };
  // 拖动排序：只能在同一层里换位置（收纳组和群之间、同一个组里的群之间、同一个群下面的私聊之间）
  const list = $('#conv-list');
  let dragging = null;
  const clearMarks = () => list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  const dropSpot = (e) => {
    const li = e.target?.closest?.('[data-drag-key]');
    if (!dragging || !li || li === dragging || li.dataset.dragScope !== dragging.dataset.dragScope) return null;
    const r = li.getBoundingClientRect();
    return { li, after: e.clientY > r.top + r.height / 2 };
  };
  const dropAt = (spot) => {
    const scope = dragging.dataset.dragScope;
    const keys = [...list.querySelectorAll(`[data-drag-scope="${CSS.escape(scope)}"]`)].map((el) => el.dataset.dragKey).filter((k) => k !== dragging.dataset.dragKey);
    keys.splice(keys.indexOf(spot.li.dataset.dragKey) + (spot.after ? 1 : 0), 0, dragging.dataset.dragKey);
    saveSideOrder(scope, keys);
    renderConvs();
  };
  list.addEventListener('dragstart', (e) => {
    dragging = e.target.closest?.('[data-drag-key]');
    if (!dragging) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging.dataset.dragKey);
    requestAnimationFrame(() => dragging?.classList.add('dragging'));
  });
  list.addEventListener('dragover', (e) => {
    const spot = dropSpot(e);
    clearMarks();
    if (!spot) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    spot.li.classList.add(spot.after ? 'drop-after' : 'drop-before');
  });
  list.addEventListener('drop', (e) => {
    const spot = dropSpot(e);
    clearMarks();
    if (!spot) return;
    e.preventDefault();
    dropAt(spot);
    if (finePointer()) $('#side-sink').focus(); // 列表重画后原来那一行已经不在了，dragend 冒不到列表上：放下时直接把键盘交回侧栏
  });
  // 键盘：点过侧栏以后按上下在收纳组、群、私聊之间移动（移到聊天上就打开它）；→ / ← 展开、收起；回车跳到输入框
  // （停在收纳组上是展开收起）。焦点其实落在侧栏里一个看不见的小输入框上：直接打字（包括拼音组字）先在它里面打，
  // 打完整段搬到真正的输入框。以前是按下字母再把焦点挪过去，拼音的第一下会变成一个裸字母
  const sink = $('#side-sink');
  const sidebar = $('#sidebar');
  // 用鼠标点了侧栏才把焦点交给它（拖完放下时在 drop 里交）；用 Tab 键路过侧栏不接管，不然 Tab 会被困在这里出不去
  // 手机、平板（手指点的）不交：焦点落到这个看不见的输入框上，iPhone 会把键盘弹出来
  list.addEventListener('click', () => finePointer() && sink.focus());
  sink.addEventListener('focus', () => {
    sidebar.classList.add('nav-on');
    markSideNav();
  });
  sink.addEventListener('blur', () => sidebar.classList.remove('nav-on'));
  const flushSink = () => {
    const text = sink.value;
    if (!text) return;
    sink.value = '';
    const el = $('#input');
    el.focus();
    editInput(el, el.value.length, el.value.length, text);
  };
  sink.addEventListener('compositionend', () => setTimeout(flushSink));
  sink.addEventListener('input', (e) => {
    if (!e.isComposing) flushSink();
  });
  sink.addEventListener('keydown', (e) => {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const rows = [...list.querySelectorAll('.conv-item')];
    const keyOf = (li) => li.dataset.key || `f:${li.dataset.folder}`;
    let i = rows.findIndex((li) => keyOf(li) === (SIDE_NAV.key || S.current));
    const row = rows[i];
    const folderId = row?.dataset.folder;
    const roomId = row?.dataset.key && parseKey(row.dataset.key)?.roomId;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      i = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      const next = rows[i];
      if (!next) return;
      const nextKey = keyOf(next);
      SIDE_NAV.key = nextKey;
      if (next.dataset.key) openConv(next.dataset.key, { keepFocus: true });
      else markSideNav();
      // openConv 会把整个列表重画，next 已经不在页面上了：按 key 找重画后的那一行再滚
      revealSideItem(nextKey);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const open = e.key === 'ArrowRight';
      if (folderId && collapsedFolders.has(folderId) === open) toggleFolder(folderId);
      else if (row?.classList.contains('has-children') && roomId && collapsed.has(roomId) === open) toggleCollapsed(roomId);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (folderId) toggleFolder(folderId);
      else $('#input').focus();
    }
  });
  list.addEventListener('dragend', () => {
    clearMarks();
    dragging?.classList.remove('dragging');
    dragging = null;
  });
  // 手机、平板：浏览器不支持网页的拖动事件，改成长按半秒（轻震一下）后拖着走，松手放下；手指一开始就在动的是在滚列表，不算
  let touch = null; // { li, x, y, timer, on, lastY }
  let swallowClick = false;
  const endTouchDrag = (drop) => {
    if (!touch) return;
    clearTimeout(touch.timer);
    cancelAnimationFrame(touch.raf);
    if (touch.on) {
      const spot = drop ? dropSpot({ target: document.elementFromPoint(touch.x, touch.lastY), clientY: touch.lastY }) : null;
      clearMarks();
      if (spot) dropAt(spot);
      dragging?.classList.remove('dragging');
      list.classList.remove('touch-dragging');
      dragging = null;
      swallowClick = true; // 松手时浏览器还会补一个 click，别把它当成「打开这个聊天」
      setTimeout(() => (swallowClick = false), 400);
    }
    touch = null;
  };
  list.addEventListener('touchstart', (e) => {
    const li = e.target.closest('[data-drag-key]');
    if (!li || e.touches.length > 1 || e.target.closest('button')) return;
    const t = e.touches[0];
    touch = { li, x: t.clientX, y: t.clientY, lastY: t.clientY, on: false };
    touch.timer = setTimeout(() => {
      if (!touch) return;
      touch.on = true;
      dragging = li;
      li.classList.add('dragging');
      list.classList.add('touch-dragging');
      navigator.vibrate?.(12);
      // 手指停在列表上下边缘时，列表跟着慢慢滚
      const scroller = list; // 聊天列表自己滚
      const tick = () => {
        if (!touch?.on) return;
        const r = scroller.getBoundingClientRect();
        const edge = 48;
        if (touch.lastY < r.top + edge) scroller.scrollTop -= 6;
        else if (touch.lastY > r.bottom - edge) scroller.scrollTop += 6;
        touch.raf = requestAnimationFrame(tick);
      };
      touch.raf = requestAnimationFrame(tick);
    }, 450);
  }, { passive: true });
  list.addEventListener('touchmove', (e) => {
    if (!touch) return;
    const t = e.touches[0];
    if (!touch.on) {
      if (Math.hypot(t.clientX - touch.x, t.clientY - touch.y) > 8) endTouchDrag(false); // 在滚列表
      return;
    }
    e.preventDefault(); // 拖着的时候别让页面跟着滚
    touch.lastY = t.clientY;
    touch.x = t.clientX;
    const spot = dropSpot({ target: document.elementFromPoint(t.clientX, t.clientY), clientY: t.clientY });
    clearMarks();
    if (spot) spot.li.classList.add(spot.after ? 'drop-after' : 'drop-before');
  }, { passive: false });
  list.addEventListener('touchend', () => endTouchDrag(true));
  list.addEventListener('touchcancel', () => endTouchDrag(false));
  // 长按拖动时别弹菜单（安卓长按会触发右键菜单）：在捕获阶段拦下，群的右键菜单也不出来
  list.addEventListener('contextmenu', (e) => {
    if (!touch?.on) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  list.addEventListener('click', (e) => {
    if (!swallowClick) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
  $('#conv-list').addEventListener('click', (e) => {
    const folderToggle = e.target.closest('[data-folder-toggle]');
    if (folderToggle) {
      toggleFolder(folderToggle.dataset.folderToggle); // 收纳组的小三角：只展开收起
      return;
    }
    const folderRow = e.target.closest('.conv-item[data-folder]');
    if (folderRow) {
      SIDE_NAV.key = `f:${folderRow.dataset.folder}`;
      toggleFolder(folderRow.dataset.folder); // 点整行也是展开 / 收起
      return;
    }
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      toggleCollapsed(toggle.dataset.toggle); // 小三角：只展开收起，不切换会话
      return;
    }
    const li = e.target.closest('.conv-item');
    if (!li) return;
    // 点有私聊的群这一整项：正在看这个群，就展开 / 收起它的私聊；没在看就打开它，私聊收着的话顺便展开
    const roomId = parseKey(li.dataset.key)?.roomId;
    if (li.classList.contains('has-children') && S.current === li.dataset.key && !isNarrow()) {
      toggleCollapsed(roomId); // 电脑上点整行还是展开/收起；手机上点整行直接进聊天，展开只点小箭头
      return;
    }
    openConv(li.dataset.key, { keepFocus: true });
    SIDE_NAV.key = li.dataset.key;
    if (li.classList.contains('has-children') && collapsed.has(roomId)) toggleCollapsed(roomId);
  });
  // 右键：群和收纳组都有菜单（私聊不参与收纳组）
  $('#conv-list').addEventListener('contextmenu', (e) => {
    const folderRow = e.target.closest('.conv-item[data-folder]');
    if (folderRow) {
      e.preventDefault();
      closeModelMenu();
      return void openFolderMenu(folderRow.dataset.folder, e.clientX, e.clientY);
    }
    const roomRow = e.target.closest('.conv-item[data-key]');
    const conv = roomRow && parseKey(roomRow.dataset.key);
    if (!conv || conv.dm) return;
    e.preventDefault();
    closeModelMenu();
    openRoomMenu(conv.roomId, e.clientX, e.clientY);
  });
  // 点外面关菜单用 pointerdown：iPhone 上点普通区域（消息、空白处）不会发 mousedown，用它的话手机上点外面关不掉
  document.addEventListener('pointerdown', (e) => {
    // 按在打开这个菜单的按钮上：先别关，交给按钮的点击来切换（不然这里刚关上，点击又把它打开，看着像「刷一下又打开了」）
    if (!$('#ctx-menu').hidden && !e.target.closest('#ctx-menu, #ctx-sub, [data-model-more], [data-dm-menu]')) closeMenus();
  });
  // 和菜单一样用 pointerdown：iPhone 上点普通区域（消息、空白处）不会发 mousedown，用它手机才关得掉
  document.addEventListener('pointerdown', (e) => {
    const panel = $('#at-panel');
    if (panel && !panel.hidden && !e.target.closest('#at-panel, #btn-at')) closeAtPanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenus();
      closeAtPanel();
    }
  });
  window.addEventListener('blur', () => {
    closeMenus();
    closeAtPanel();
  });
  // 群设置里的「收纳组」：选「新建…」就先建一个组，保存群设置时再放进去
  $('#set-folder').addEventListener('change', async (e) => {
    if (e.target.value !== '__new__') return;
    const name = await askText({ title: tr('新建收纳组'), label: tr('名字'), ok: tr('创建') });
    if (!name) return void (e.target.value = '');
    const folder = await createFolder(name);
    if (!folder) return void (e.target.value = '');
    e.target.insertAdjacentHTML('beforeend', `<option value="${esc(folder.id)}">${esc(folder.name)}</option>`);
    e.target.value = folder.id;
  });
  // 点群里的头像（或右上角的头像）就去私聊
  document.addEventListener('click', (e) => {
    const modelMore = e.target.closest('[data-model-more]');
    if (modelMore) {
      const conv = currentConv();
      // 菜单开着、又点了这个按钮：收起来（第二层的模型菜单开着也一样，别在上面再叠一层）
      if (!$('#model-menu').hidden) return void closeModelMenu();
      if (!$('#ctx-menu').hidden && $('#ctx-menu').dataset.for === 'model') return void closeMenus();
      if (conv && !conv.dm) {
        const r = modelMore.getBoundingClientRect();
        const room = conv.room;
        openCtxMenu(
          room.members.map((a) => ({
            label: `${agentLabel(a)} · ${modelShortName(a, room.models?.[a] || '')}${room.efforts?.[a] ? ` · ${EFFORT_LABEL[room.efforts[a]] || room.efforts[a]}` : ''}`,
            icon: avatarHtml(a),
            act: () => openModelMenu(a, modelMore),
          })),
          Math.round(r.left),
          Math.round(r.bottom + 6),
        );
        $('#ctx-menu').dataset.for = 'model';
      }
      return;
    }
    const more = e.target.closest('[data-dm-menu]');
    if (more) {
      const conv = currentConv();
      const r = more.getBoundingClientRect();
      if (!$('#ctx-menu').hidden && $('#ctx-menu').dataset.for === 'dm') return void closeMenus();
      if (conv && !conv.dm) {
        openCtxMenu(
          conv.room.members.map((a) => ({ label: tr('私聊 {name}', { name: agentLabel(a) }), icon: avatarHtml(a), act: () => openConv(`d:${conv.roomId}:${a}`) })),
          Math.round(r.right),
          Math.round(r.bottom + 6),
        );
        $('#ctx-menu').dataset.for = 'dm';
      }
      return;
    }
    const b = e.target.closest('.dm-btn');
    const conv = currentConv();
    if (b && conv && b.dataset.dm) openConv(`d:${conv.roomId}:${b.dataset.dm}`);
    const img = e.target.closest('img.zoomable');
    if (img) openLightbox(img.src);
    const reply = e.target.closest('[data-reply]');
    if (reply) startReply(Number(reply.dataset.reply));
    const copy = e.target.closest('[data-copy]');
    if (copy) copyMessage(Number(copy.dataset.copy), copy);
    const edit = e.target.closest('[data-edit]');
    if (edit) startEdit(Number(edit.dataset.edit));
    if (e.target.closest('[data-edit-cancel]')) cancelEdit();
    if (e.target.closest('[data-edit-send]')) sendEdit();
    const speak = e.target.closest('[data-speak]');
    if (speak) toggleSpeak(Number(speak.dataset.speak));
    const forward = e.target.closest('[data-forward]');
    if (forward && !forward.disabled) forwardMessage(Number(forward.dataset.forward), forward);
    const jump = e.target.closest('[data-jump]');
    if (jump) jumpTo(Number(jump.dataset.jump));
    const resume = e.target.closest('[data-resume]');
    if (resume && !resume.disabled) resumeAgents(resume);
    const fresh = e.target.closest('[data-fresh]');
    if (fresh) freshAgent(fresh.dataset.fresh, fresh, $('#dlg-room').open ? S.editing : currentConv()?.roomId);
  });
  $('#btn-reply-cancel').onclick = cancelReply;
  $('#btn-update-badge').onclick = updateFromBadge;
  $('#lightbox').onclick = (e) => lbZoom.tap(e);
  $('#lightbox').addEventListener('pointerdown', (e) => lbZoom.down(e));
  $('#lightbox').addEventListener('pointermove', (e) => lbZoom.move(e));
  for (const t of ['pointerup', 'pointercancel']) $('#lightbox').addEventListener(t, (e) => lbZoom.up(e));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#lightbox').hidden) closeLightbox();
  });
  document.querySelectorAll('#theme-switch [data-theme-value]').forEach((b) => (b.onclick = () => applyTheme(b.dataset.themeValue)));
  const langSel = $('#lang-select');
  langSel.value = I18N.pref;
  langSel.onchange = async () => {
    I18N.setPref(langSel.value);
    const next = langSel.value === 'system' ? I18N.systemLang() : langSel.value;
    // 亲手选的就要告诉服务端：手机上界面语言和电脑上的语言可能不一样（手机按自己的系统语言显示），
    // 所以哪怕界面上已经是这门语言，也要把「AI 回复用什么语言」改过来
    await syncLang(next, true).catch(() => {});
    if (next === I18N.lang) return;
    location.reload(); // 整个界面按新语言重画
  };
  $('#notify-switch').checked = notifyOn();
  $('#notify-switch').onchange = (e) => {
    storeSet('clawchat.notify', e.target.checked ? 'on' : 'off');
    if (e.target.checked) askNotifyPermission();
  };
  $('#dlg-room').addEventListener('close', reportDragRegions);
  $('#btn-clone-add-text').textContent = tr('多开一位');
  $('#btn-clone-add').title = tr('在这个群里再多一位同账号的 AI，有自己的记忆和设置');
  $('#btn-clone-add').onclick = () => {
    const picker = $('#clone-picker');
    if (!picker.hidden) return void (picker.hidden = true);
    renderClonePicker();
    picker.hidden = false;
  };
  // 群设置关掉：没保存的多开成员不要留着
  $('#dlg-room').addEventListener('close', () => {
    $('#clone-picker').hidden = true;
    if (PENDING_CLONES.size) {
      PENDING_CLONES = new Set();
      rebuildMembers();
    }
  });
  // 点到「多开一位」和选项之外，收起来
  document.addEventListener('pointerdown', (e) => {
    const picker = $('#clone-picker');
    if (!picker.hidden && !e.target.closest('#clone-picker, #btn-clone-add')) picker.hidden = true;
  });
  // 窗口宽度变了、模型列表加载完下拉框变宽了，都要重新看看顶栏放不放得下
  const headObserver = new ResizeObserver(() => requestAnimationFrame(fitHead));
  headObserver.observe($('#room-head'));
  headObserver.observe($('#model-switch'));
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
  $('#btn-back').onclick = () => {
    if (history.state?.clawchatKey) history.back();
    else exitMobileChat();
  };
  $('#remote-toggle').addEventListener('change', (e) => setRemote(e.target.checked));
  $('#remote-copy').onclick = copyRemoteUrl;
  $('#android-download').addEventListener('click', downloadAndroid);
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
  for (const id of KEY_TARGETS) {
    $(`#btn-${id}-save`).onclick = () => saveProviderKey(id);
  }
  for (const id of KEY_TARGETS) {
    $(`#${id}-key`)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) saveProviderKey(id);
    });
  }
  $('#btn-api-save').onclick = saveApiKey;
  for (const id of ['api-base', 'api-key']) {
    $(`#${id}`)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) saveApiKey();
    });
  }
  $('#btn-quit').onclick = quitApp;
  document.addEventListener('keydown', (e) => {
    if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openSettings();
    }
  });
  $('#set-engines').addEventListener('click', (e) => {
    const b = e.target.closest('.engine-update');
    if (b) return updateEngine(b.dataset.engine, b);
    const l = e.target.closest('[data-login]');
    if (l) loginEngineUI(l.dataset.login);
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-install]:not([disabled])');
    if (b) installEngineUI(b.dataset.install || 'claude'); // 设置里的安装按钮、建群提示里的安装按钮都走这里
    const v = e.target.closest('[data-vision-switch]');
    if (v) openModelMenuFor(v.dataset.visionSwitch); // 图片提醒里的「换成能看图的模型」
  });
  $('#custom-model-form').addEventListener('submit', submitCustomModel);
  $('#btn-custom-cancel').onclick = () => closeDialog($('#dlg-model'));
  $('#dlg-model').addEventListener('close', reportDragRegions);
  $('#model-switch').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-menu]');
    if (!chip) return;
    const again = chip.classList.contains('open');
    closeModelMenu();
    if (!again) openModelMenu(chip.dataset.menu, chip);
  });
  // 「过程」展开时才把步骤画出来，并记住展开着（重画后保持展开）
  $('#messages').addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      if (!d.matches?.('details[data-steps]')) return;
      const conv = currentConv();
      if (!conv) return;
      const seq = Number(d.dataset.steps);
      const k = `${conv.roomId}:${seq}`;
      if (!d.open) return void S.openSteps.delete(k);
      S.openSteps.add(k);
      if (!d.querySelector('ol')) {
        d.insertAdjacentHTML('beforeend', loadingStepsHtml());
        loadSteps(conv, seq, d);
      }
    },
    true,
  );
  // 编辑框：打字时记下内容和光标（消息列表重画后能接着改），Enter 发送、Shift+Enter 换行、Esc 取消
  // 编辑框里也能 @：和底部输入框一样弹成员菜单、显示成带头像的标签，标签是一个整体
  $('#messages').addEventListener('input', (e) => {
    if (!e.target.classList.contains('edit-input') || !S.editMsg) return;
    S.editMsg.text = e.target.value;
    S.editMsg.sel = e.target.selectionStart;
    fitEditor(e.target);
    renderMirror(e.target, e.target.previousElementSibling);
    updateMentionMenu(e.target);
  });
  $('#messages').addEventListener('keyup', (e) => {
    if (!e.target.classList.contains('edit-input') || !S.editMsg) return;
    S.editMsg.sel = e.target.selectionStart;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) || e.shiftKey) snapToMentions(e.target);
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateMentionMenu(e.target);
  });
  $('#messages').addEventListener('click', (e) => {
    if (e.target.classList.contains('edit-input')) updateMentionMenu(e.target);
  });
  $('#messages').addEventListener('mouseup', (e) => {
    if (e.target.classList.contains('edit-input')) setTimeout(() => snapToMentions(e.target));
  });
  $('#messages').addEventListener('focusout', (e) => {
    if (e.target.classList.contains('edit-input')) setTimeout(hideMentionMenu, 150);
  });
  $('#messages').addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('edit-input')) return;
    if (mentionKeydown(e) || selectMentionOnBackspace(e) || selectMentionOnDelete(e) || mentionArrow(e)) return;
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEdit();
    }
  });
  // 点消息里的 @Claude 这类标签：在输入框里也 @ 它（只在群里；输入框没在打字时接在最后面）
  $('#scroller').addEventListener('click', (e) => {
    const tag = e.target.closest('.mention[data-who]');
    const conv = currentConv();
    if (!tag || !conv || conv.dm || conv.room.members.length < 2 || getSelection().toString()) return;
    const who = tag.dataset.who;
    if (who !== 'all' && !conv.room.members.includes(who)) return;
    const el = document.querySelector('.edit-input') || $('#input'); // 正在改消息：填进编辑框
    if (document.activeElement !== el) el.setSelectionRange(el.value.length, el.value.length);
    insertMention(who === 'all' ? ALL_WORD : agentName(who), el);
  });
  // 文件路径：悬停看缩略图、点一下在访达里显示。挂在 #scroller 上，「正在干活」气泡（#live）里的过程也算
  $('#scroller').addEventListener('mouseover', (e) => {
    const ref = e.target.closest('.file-ref');
    if (ref && !ref.contains(e.relatedTarget)) showFilePreview(ref);
  });
  $('#scroller').addEventListener('mouseout', (e) => {
    const ref = e.target.closest('.file-ref');
    if (ref && !ref.contains(e.relatedTarget)) hideFilePreview();
  });
  $('#scroller').addEventListener('click', (e) => {
    const thumb = e.target.closest('.ref-thumbs img');
    if (thumb) return openLightbox(thumb.dataset.view, { name: thumb.alt, check: true });
    const ref = e.target.closest('.file-ref');
    if (!ref || !fileRefLive(ref) || getSelection().toString()) return; // 在选字的时候别打断
    e.preventDefault();
    hideFilePreview();
    openFileRef(ref);
  });
  $('#scroller').addEventListener('scroll', hideFilePreview, { passive: true });
  new MutationObserver(checkFileRefs).observe($('#chat'), { childList: true, subtree: true });
  // 往上翻快到顶了：接上更早的一段；也可以点最上面的「更早的 N 条消息」
  $('#scroller').addEventListener('scroll', () => S.rendered?.from && $('#scroller').scrollTop < 400 && !$('#scrollbar').dragging?.() && loadEarlier(), { passive: true });
  $('#messages').addEventListener('click', (e) => {
    if (e.target.closest('[data-earlier]')) loadEarlier();
    else if (e.target.closest('[data-later]')) loadLatestWindow();
  });
  // 消息列表变高了（比如图片慢慢加载出来）：原来贴着最底下的话（自己往上翻了就不算），继续贴着最底下
  $('#scroller').addEventListener('scroll', () => (S.pinned = nearBottom()), { passive: true });
  $('#messages').addEventListener('load', (e) => e.target.tagName === 'IMG' && S.pinned && scrollToBottom(), true);
  new ResizeObserver(() => requestAnimationFrame(() => S.pinned && scrollToBottom())).observe($('#messages'));
  $('#model-menu').addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (item) pickFromMenu(item);
  });
  $('#model-menu').addEventListener('keydown', (e) => {
    const items = [...$('#model-menu').querySelectorAll('.menu-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      const agent = $('#model-menu').dataset.agent;
      closeModelMenu();
      document.querySelector(`.model-chip[data-menu="${agent}"]`)?.focus();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#model-menu, .model-chip')) closeModelMenu();
  });
  window.addEventListener('blur', closeModelMenu);
  $('#room-folder').onclick = () => {
    const conv = currentConv();
    if (conv) api('POST', `/api/rooms/${conv.roomId}/open-folder`).catch((err) => toast(err.message));
  };
  $('#default-target').onchange = async (e) => {
    const conv = currentConv();
    try {
      const { room } = await api('PATCH', `/api/rooms/${conv.roomId}`, { defaultTarget: e.target.value });
      S.rooms = S.rooms.map((r) => (r.id === room.id ? room : r));
      renderTargets(room, conv.dm);
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
    const go = e.target.closest('[data-goto]');
    if (go) return void openConv(go.dataset.goto);
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
    // 气泡上方的「换新会话」：会结束手上这一轮，弹窗里选好谁来交代、点了确定才换
    const mini = e.target.closest('.live-fresh-mini');
    if (mini) freshAgent(mini.dataset.agent, mini);
  });
  document.querySelectorAll('[data-mention]').forEach((b) => (b.onclick = () => insertMention(b.dataset.mention === '所有人' ? ALL_WORD : b.dataset.mention)));

  // 图片：按钮选择、粘贴、拖进来
  $('#btn-image').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  };
  $('#attachments').addEventListener('click', (e) => {
    // 粘贴、拖进来还没发出去的图：点一下放大看
    const img = e.target.closest('.att img');
    if (img) return openLightbox(img.src);
    const b = e.target.closest('.att-remove');
    if (!b) return;
    const [a] = S.attachments.splice(Number(b.dataset.i), 1);
    if (a) URL.revokeObjectURL(a.url);
    renderAttachments();
  });
  const input = $('#input');
  // 粘贴的文字里有 @成员：换成带头像的标签再放进去（输入框和改消息的框都一样）
  document.addEventListener('paste', (e) => {
    const el = e.target;
    if (!(el === input || el.classList?.contains('edit-input')) || [...(e.clipboardData?.files || [])].length) return;
    const text = e.clipboardData?.getData('text/plain') || '';
    const fixed = pastedMentions(text);
    if (fixed === text) return;
    e.preventDefault();
    editInput(el, el.selectionStart, el.selectionEnd, fixed);
  });
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
  input.addEventListener('input', renderVisionHint); // @ 了谁会让这条消息换了收件人
  input.addEventListener('input', syncReplyTargets); // 回复期间又 @ 了别人：提示跟着换成 @ 的那几位
  input.addEventListener('input', () => {
    clearTimeout(saveDraft.timer);
    saveDraft.timer = setTimeout(() => saveDraft(S.current), 400);
  });
  input.addEventListener('scroll', () => ($('#input-mirror').scrollTop = input.scrollTop));
  input.addEventListener('input', updateMentionMenu);
  input.addEventListener('click', updateMentionMenu);
  input.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) || e.shiftKey) snapToMentions();
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateMentionMenu(input);
  });
  input.addEventListener('mouseup', () => setTimeout(snapToMentions));
  input.addEventListener('select', snapToMentions);
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
    if (mentionKeydown(e) || selectMentionOnBackspace(e) || selectMentionOnDelete(e) || mentionArrow(e)) return;
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
  // 按 @ 和面板里的按钮时别让输入框失去焦点：键盘不会一开一关
  $('#btn-at').addEventListener('mousedown', (e) => e.preventDefault());
  $('#btn-at').onclick = (e) => {
    e.stopPropagation();
    toggleAtPanel();
  };
  $('#at-panel').addEventListener('mousedown', (e) => {
    if (e.target.closest('.at-person, .at-target')) e.preventDefault();
  });
  $('#at-panel').addEventListener('click', (e) => {
    const person = e.target.closest('[data-at-insert]');
    if (person) {
      insertMention(person.dataset.atInsert);
      closeAtPanel();
      return;
    }
    if (e.target.closest('[data-at-all]')) {
      insertMention(ALL_WORD);
      closeAtPanel();
      return;
    }
    const target = e.target.closest('[data-at-target]');
    if (target) {
      const sel = $('#default-target');
      sel.value = target.dataset.atTarget;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      closeAtPanel();
    }
  });
  $('#btn-send').onclick = () => ($('#btn-send').classList.contains('stopping') ? stopFromSend() : sendMessage());
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
  setInterval(() => {
    document.querySelectorAll('.msg-ago').forEach((el) => {
      const t = msgAgo(Number(el.dataset.ts));
      if (el.textContent !== t) el.textContent = t;
    });
  }, 30 * 1000);
}

// Windows：快捷键和「访达」这些说法换成 Windows 的
function applyPlatformText() {
  if (!IS_WIN) return;
  $('#btn-app-settings').title = tr('设置（Ctrl+,）');
  $('#btn-open-data').textContent = tr('在资源管理器中显示');
}

// 打开时的加载画面：界面画好了就淡出（连不上服务也淡出，免得一直挡着报错）
function hideBoot() {
  const boot = $('#boot');
  if (!boot || boot.classList.contains('done')) return;
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 400);
}
setTimeout(hideBoot, 10000); // 兜底：十秒还没画好也不挡着


// ---------------- 联合群（第一期界面） ----------------
// 服务端数据形状（暂定，等主持方接口落地后对齐）：
//   room.joint = { role:'host'|'guest', peerName, peerLogin, peerOnline, permission:'discuss' }
//   room.jointMembers = [{ key, name, owner, base, online }]
//   S.jointMembers[key] 由 state 里的 room.jointMembers 汇总而来，消息的 from 就是 key
// 接口（约定）：POST /api/joint/join、GET /api/joint/join/:pairId、POST /api/rooms/:id/joint/invite、
//   POST /api/joint/pair/:pairId/approve|reject、GET /api/joint/files/inbox、POST /api/joint/files/approve、POST /api/rooms/:id/joint/leave
let jointInviteTimer = 0;
let jointJoinPoll = 0;
let jointJoinPairId = '';
let jointFileReq = null;

function jointRoom() {
  const conv = currentConv();
  return conv && !conv.dm ? conv.room : null;
}

function syncJointMembers() {
  for (const room of S.rooms || []) for (const m of room.jointMembers || []) if (m?.key) S.jointMembers[m.key] = m;
}

// 输入框上面那一排 @ 按钮：真放不下（能横着滑）时才在右边淡出，放得下就不淡
(() => {
  const tools = $('#group-tools');
  if (!tools || typeof ResizeObserver === 'undefined') return;
  const fit = () => tools.classList.toggle('overflowing', tools.scrollWidth > tools.clientWidth + 1);
  new ResizeObserver(fit).observe(tools);
  new MutationObserver(fit).observe(tools, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  fit();
})();

// 群标题下面那一条：对方老板在线状态、对方成员、讨论档、邀请入口
// 输入框上面那一排 @ 按钮：联合群里把对方的成员也补上（自己的成员本来就有）
function syncJointMentionChips(room) {
  const tools = $('#group-tools');
  if (!tools) return;
  const want = new Map((room?.jointMembers || []).filter((m) => !m.mine && m.key).map((m) => [m.key, m]));
  tools.querySelectorAll('[data-joint-chip]').forEach((el) => { if (!want.has(el.dataset.jointChip)) el.remove(); });
  const all = tools.querySelector('.mention-chip[data-mention="所有人"]');
  for (const [key, m] of want) {
    if (tools.querySelector(`[data-joint-chip="${CSS.escape(key)}"]`)) continue;
    const name = jointMemberDisplay(m);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip mention-chip';
    btn.dataset.jointChip = key;
    btn.dataset.who = key;
    btn.title = `@${name}`;
    btn.innerHTML = `${avatarHtml(key)}<span class="chip-name">@${esc(name)}</span>`;
    btn.onclick = () => insertMention(name);
    tools.insertBefore(btn, all || null);
  }
}

// 联合群里，底部 @ 快捷按钮也要写全名（@Claude·Lenka），否则对方会以为叫的是自己家的 Claude
const QUICK_MENTION_IDS = { claude: 'Claude', gpt: 'ChatGPT', deepseek: 'DeepSeek', glm: 'GLM', gemini: 'Gemini', grok: 'Grok', cursor: 'Cursor', api: 'API' };
function syncJointQuickMentions(room) {
  const tools = $('#group-tools');
  if (!tools) return;
  for (const [id, plain] of Object.entries(QUICK_MENTION_IDS)) {
    const btn = tools.querySelector(`.mention-chip[data-who="${id}"]:not([data-joint-chip])`);
    if (!btn) continue;
    const m = room?.joint ? jointMemberOf(room, id) : null;
    // 联合群里成员必须能在 jointMembers 里找到；数据没齐时宁可不显示，也不要露出没带主人的名字
    btn.hidden = room?.joint ? !m : !(room?.members || []).includes(id);
    if (!m && room?.joint) continue;
    const label = m ? jointMemberDisplay(m) : plain;
    btn.dataset.mention = label;
    btn.title = `@${label}`;
    const name = btn.querySelector('.chip-name');
    if (name) name.textContent = `@${label}`;
  }
}

function renderJointBar() {
  const bar = $('#joint-bar');
  if (!bar) return;
  const room = jointRoom();
  const joint = room?.joint;
  $('#chat').classList.toggle('joint', !!joint);
  if (!joint) return void (bar.hidden = true);
  const chip = (m) => `<span class="joint-chip${m.online === false ? ' off' : ''}" title="${esc(agentName(m.key))}">${avatarHtml(m.key)}<span class="joint-chip-name">${esc(agentName(m.key))}</span></span>`;
  const list = room.jointMembers || [];
  const mine = list.filter((m) => m.mine).map(chip).join('');
  const theirs = list.filter((m) => !m.mine).map(chip).join('');
  const line = (label, chips) => (chips ? `<span class="joint-line"><span class="joint-group">${label}</span>${chips}</span>` : '');
  const peerText = joint.peerName ? `${esc(joint.peerName)}${joint.peerOnline === false ? ` · ${tr('离线')}` : ` · ${tr('在线')}`}` : tr('等对方加入…');
  bar.innerHTML = `<span class="joint-badge">${tr('联合群')}</span><span class="joint-peer">${peerText}</span><span class="joint-perm">${tr('讨论档')}</span>${line(tr('我的'), mine)}${line(esc(joint.peerName || ''), theirs)}<span class="spacer"></span>${
    joint.role === 'host' && !joint.peerNode ? `<button type="button" class="joint-link" id="btn-joint-invite-bar">${tr('邀请同事…')}</button>` : ''
  }${joint.role === 'host' && joint.peerNode ? `<button type="button" class="joint-link" id="btn-joint-want-file-bar">${tr('向对方要文件…')}</button>` : ''}`;
  bar.hidden = false;
  document.documentElement.style.setProperty('--joint-bar-h', `${bar.offsetHeight}px`);
}

function openJointWantFile() {
  const room = jointRoom();
  const dlg = $('#dlg-joint-want-file');
  if (!dlg || !room?.joint || room.joint.role !== 'host' || !room.joint.peerNode) return;
  $('#joint-want-purpose').value = '';
  $('#btn-joint-want-send').disabled = false;
  dlg.showModal();
  reportDragRegions();
  setTimeout(() => $('#joint-want-purpose').focus(), 60);
}

async function submitJointWantFile() {
  const room = jointRoom();
  if (!room?.joint || room.joint.role !== 'host') return;
  const purpose = $('#joint-want-purpose').value.trim();
  const btn = $('#btn-joint-want-send');
  btn.disabled = true;
  try {
    await api('POST', '/api/joint/files/request-to-peer', { roomId: room.id, purpose });
    closeDialog($('#dlg-joint-want-file'));
    toast(tr('已经向对方发出文件请求'));
  } catch (err) {
    toast(err.message, 5000);
  } finally {
    btn.disabled = false;
  }
}

function openJointInvite({ code = '', expiresAt = 0, roomName = '' } = {}) {
  const dlg = $('#dlg-joint-invite');
  if (!dlg) return;
  $('#joint-invite-code').textContent = code || '—';
  $('#joint-invite-exp').textContent = '';
  clearInterval(jointInviteTimer);
  const tick = () => {
    const left = Math.max(0, expiresAt - Date.now());
    $('#joint-invite-exp').textContent = left ? tr('{n} 分钟后失效', { n: Math.max(1, Math.ceil(left / 60000)) }) : expiresAt ? tr('已失效，重新生成一个') : '';
  };
  tick();
  if (expiresAt) jointInviteTimer = setInterval(tick, 30000);
  dlg.dataset.room = roomName || '';
  dlg.showModal();
  reportDragRegions();
}

async function copyJointInvite() {
  const text = $('#joint-invite-code').textContent.trim();
  if (!text || text === '—') return;
  try {
    await navigator.clipboard.writeText(text);
    toast(tr('邀请码已复制'));
  } catch {
    const el = $('#joint-invite-code');
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast(tr('复制不了，已经选中，按 ⌘C 复制'));
  }
}

async function requestJointInvite() {
  const room = jointRoom();
  if (!room) return;
  try {
    const res = await api('POST', `/api/rooms/${room.id}/joint/invite`);
    openJointInvite({ code: res.code, expiresAt: res.expiresAt, roomName: room.name });
  } catch (err) {
    toast(err.message);
  }
}

function jointOwnerName() {
  return storeGet('clawchat.jointOwner') || '';
}

function jointMemberPickHtml(selected = null, idPrefix = 'joint-member') {
  const ready = selected || BASE_IDS.filter(memberReady);
  return BASE_IDS.map((a) => `
    <label class="joint-pick-row">
      <input type="checkbox" name="${idPrefix}" value="${esc(a)}"${ready.includes(a) ? ' checked' : ''}>
      ${avatarHtml(a)}<span>${esc(agentName(a))}</span>
      <small>${esc(memberIssue(a) || (a === 'api' ? tr('OpenAI 兼容平台') : ''))}</small>
    </label>`).join('');
}

function openJointCreate() {
  const dlg = $('#dlg-joint-create');
  if (!dlg) return;
  $('#joint-create-name').value = '';
  $('#joint-create-owner').value = jointOwnerName();
  $('#joint-create-members').innerHTML = jointMemberPickHtml(null, 'joint-create-member');
  $('#btn-joint-create-ok').disabled = false;
  dlg.showModal();
  reportDragRegions();
  setTimeout(() => $('#joint-create-name').focus(), 60);
}

async function submitJointCreate() {
  const name = $('#joint-create-name').value.trim();
  const ownerName = $('#joint-create-owner').value.trim();
  const members = [...document.querySelectorAll('input[name="joint-create-member"]:checked')].map((x) => x.value);
  if (!name) return toast(tr('先给联合群起个名字'));
  if (!ownerName) return toast(tr('先填一下同事怎么称呼你'));
  if (!members.length) return toast(tr('至少选一位自己的 AI 进去'));
  storeSet('clawchat.jointOwner', ownerName);
  const btn = $('#btn-joint-create-ok');
  btn.disabled = true;
  try {
    const res = await api('POST', '/api/joint/rooms', { name, members, ownerName });
    const room = res.room || res;
    if (!room?.id) throw new Error(tr('没有建成功，请再试一次'));
    if (!roomById(room.id)) S.rooms.unshift(room);
    closeDialog($('#dlg-joint-create'));
    closeDialog($('#dlg-room'));
    if (room) await openConv(`g:${room.id}`);
    try {
      const inv = await api('POST', `/api/rooms/${room.id}/joint/invite`);
      openJointInvite({ code: inv.code, expiresAt: inv.expiresAt, roomName: room.name });
    } catch (err) {
      toast(err.message);
    }
  } catch (err) {
    toast(err.message, 5000);
  } finally {
    btn.disabled = false;
  }
}

function openJointJoin() {
  const dlg = $('#dlg-joint-join');
  if (!dlg) return;
  clearTimeout(jointJoinPoll);
  jointJoinPairId = '';
  $('#joint-join-code').value = '';
  $('#joint-join-owner').value = jointOwnerName();
  $('#joint-join-members').innerHTML = jointMemberPickHtml(null, 'joint-join-member');
  $('#joint-join-status').hidden = true;
  $('#joint-join-verify').hidden = true;
  $('#btn-joint-join-ok').disabled = false;
  dlg.showModal();
  reportDragRegions();
  setTimeout(() => $('#joint-join-code').focus(), 60);
}

function jointJoinStatus(text, bad = false) {
  const el = $('#joint-join-status');
  el.hidden = !text;
  el.className = `hint${bad ? ' error' : ''}`;
  el.textContent = text || '';
}

function showJointJoinVerify(code, pairId) {
  jointJoinPairId = pairId || '';
  const el = $('#joint-verify-code');
  const s = String(code || '').replace(/\s+/g, '');
  el.textContent = s.length === 6 ? `${s.slice(0, 3)} ${s.slice(3)}` : String(code || '—');
  $('#joint-join-verify').hidden = false;
  jointJoinStatus('');
  clearTimeout(jointJoinPoll);
  const poll = async () => {
    if (!$('#dlg-joint-join').open || !jointJoinPairId) return;
    try {
      const res = await api('GET', `/api/joint/join/${encodeURIComponent(jointJoinPairId)}`);
      if (res.status === 'approved' && res.roomId) {
        closeDialog($('#dlg-joint-join'));
        toast(tr('已经加入联合群'));
        try {
          applyState(await api('GET', '/api/state'));
          if (roomById(res.roomId)) openConv(`g:${res.roomId}`);
        } catch {}
        return;
      }
      if (res.status === 'rejected') return jointJoinStatus(tr('对方拒绝了这个邀请'), true);
      if (res.status === 'expired') return jointJoinStatus(tr('邀请码过期了，请对方重新生成一个'), true);
    } catch (err) {
      jointJoinStatus(err.message, true);
      return;
    }
    jointJoinPoll = setTimeout(poll, 2000);
  };
  jointJoinPoll = setTimeout(poll, 1500);
}

async function submitJointJoin() {
  const code = $('#joint-join-code').value.trim();
  if (!/^clawchat-join:/.test(code)) return jointJoinStatus(tr('邀请码不对：应该是一串以 clawchat-join: 开头的文字'), true);
  const ownerName = $('#joint-join-owner').value.trim();
  const members = [...document.querySelectorAll('input[name="joint-join-member"]:checked')].map((x) => x.value);
  if (!ownerName) return jointJoinStatus(tr('先填一下你在对方那里的称呼'), true);
  if (!members.length) return jointJoinStatus(tr('至少选一位自己的 AI 进去'), true);
  storeSet('clawchat.jointOwner', ownerName);
  const btn = $('#btn-joint-join-ok');
  btn.disabled = true;
  jointJoinStatus(tr('正在联系对方…'));
  try {
    const res = await api('POST', '/api/joint/join', { code, ownerName, members });
    showJointJoinVerify(res.check, res.pairId);
  } catch (err) {
    jointJoinStatus(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function checkPendingJointPairs() {
  if ($('#dlg-joint-approve')?.open) return;
  try {
    const res = await api('GET', '/api/joint/pairs');
    const p = (res.pairs || [])[0];
    if (p) openJointApprove(p);
  } catch {}
}

function openJointApproval(info = {}) {
  const dlg = $('#dlg-joint-action');
  if (!dlg || !info.approvalId) return;
  S.jointApproval = info;
  const room = roomById(info.roomId);
  const from = info.from || room?.joint?.peerName || tr('对方');
  const name = jointDisplayFor(room, info.agentId) || info.name || info.agentId;
  $('#joint-action-title').textContent = tr('{from} 请 {name} 动手', { from, name });
  const folder = info.folder || '';
  $('#joint-action-body').innerHTML = `
    ${info.text ? `<div class="joint-quote joint-action-quote">“${esc(info.text)}”<br><b>—— ${esc(from)}</b></div>` : ''}
    ${folder ? `<div class="joint-folder-card"><span class="joint-file-icon">DIR</span><div><b>${esc(folder)}</b><small>${tr('对方只能在这个文件夹里改文件和跑命令')}</small></div></div>` : ''}
    <p class="hint">${tr('这是对方 AI 发来的请求，只有你点「允许这一次」它才开始。停止按钮仍然只停你自己的 AI。')}</p>
    <div class="joint-action-meta"><span>${tr('谁在等')}</span><b>${esc(from)}</b><small>${tr('对方的电脑')}</small></div>
    <p class="hint">${tr('对方看不到这次操作之外的文件，也不会自动继续下一步；10 分钟不点会自动拒绝。')}</p>`;
  if (!dlg.open) dlg.showModal();
  reportDragRegions();
}

async function answerJointApproval(ok) {
  const info = S.jointApproval;
  if (!info) return;
  S.jointApproval = null;
  const no = $('#btn-joint-action-no');
  const yes = $('#btn-joint-action-yes');
  no.disabled = yes.disabled = true;
  try {
    await api('POST', `/api/joint/approvals/${encodeURIComponent(info.approvalId)}`, { approve: !!ok });
    closeDialog($('#dlg-joint-action'));
    toast(ok ? tr('已允许对方动手') : tr('已拒绝这次动手请求'));
  } catch (err) {
    toast(err.message);
    closeDialog($('#dlg-joint-action'));
  } finally {
    no.disabled = yes.disabled = false;
  }
}

async function checkPendingJointApprovals() {
  if ($('#dlg-joint-action')?.open) return;
  try {
    const res = await api('GET', '/api/joint/approvals');
    const a = (res.approvals || [])[0];
    if (a) openJointApproval(a);
  } catch {}
}

function jointPeerAvatar(info = {}) {
  if (info.avatar && S.jointMembers?.[info.avatar]) return avatarHtml(info.avatar);
  const ch = String(info.peerName || info.ownerName || '?').trim().slice(0, 1) || '?';
  return `<span class="avatar av-peer">${esc(ch)}</span>`;
}

function openJointApprove(info = {}) {
  const dlg = $('#dlg-joint-approve');
  if (!dlg) return;
  const peer = info.peerName || info.ownerName || '';
  const agents = (info.agents || []).map((a) => {
    const name = a.name || agentName(a.id);
    return `<span class="joint-agent">${avatarHtml(a.base || a.id)}${esc(name.includes('·') ? name : `${name}·${peer}`)}</span>`;
  }).join('');
  const roomName = info.roomName || roomById(info.roomId)?.name || '';
  $('#joint-approve-body').innerHTML = `
    <div class="joint-approve-head">${jointPeerAvatar(info)}<div><b>${esc(info.peerName || info.ownerName || '')} 想加入「${esc(roomName)}」</b><small>Tailscale 账号 ${esc(info.peerLogin || info.login || '')} · 设备 ${esc(info.device || info.nodeName || '')}</small></div></div>
    <div class="joint-verify"><div class="joint-verify-code">${esc(String(info.check || info.code || '').replace(/(\d{3})(\d{3})/, '$1 $2') || '—')}</div><p class="hint">和对方口头核对这个号码，确认是本人再同意。</p></div>
    <div class="joint-agent-list">${agents}</div>
    <p class="hint">第一期所有 AI 只能讨论、不能改文件；对方的 AI 在对方电脑上跑，记忆和额度不出本机。</p>`;
  dlg.dataset.pairId = info.pairId || '';
  dlg.showModal();
  reportDragRegions();
}

async function answerJointApprove(ok) {
  const id = $('#dlg-joint-approve').dataset.pairId;
  try {
    if (id) await api('POST', `/api/joint/pair/${encodeURIComponent(id)}/${ok ? 'approve' : 'reject'}`);
    closeDialog($('#dlg-joint-approve'));
    toast(ok ? tr('已同意对方加入') : tr('已拒绝'));
  } catch (err) {
    toast(err.message);
  }
}

function jointFileSize(n) {
  const size = Number(n) || 0;
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

// snapshot 返回的 risk 是 { risk:'secret', reason }；老数据可能直接给字符串
function jointFileDanger(f) {
  const r = f?.risk;
  return !!(f?.danger || r === 'secret' || r?.risk === 'secret');
}

function openJointFileRequest(req = {}) {
  const dlg = $('#dlg-joint-file');
  if (!dlg) return;
  const room = roomById(req.roomId);
  jointFileReq = {
    ...req,
    peerName: req.peerName || req.from || room?.joint?.peerName || '',
    requester: req.requester || req.from || '',
    toName: req.toName || room?.joint?.peerName || '',
    toNode: req.toNode || req.node || room?.joint?.peerNode || '',
    reqName: req.reqName || req.name || '',
    reqSize: req.reqSize ?? req.size ?? 0,
    purpose: req.purpose || '',
    snap: req.snap || (req.file && req.file.staging ? req.file : null),
  };
  drawJointFileRequest();
  if (!dlg.open) dlg.showModal();
  reportDragRegions();
}

// 确认框里的内容：还没选文件时显示对方想要什么和「选择文件…」；选好以后显示快照、危险提示和确认按钮
function drawJointFileRequest() {
  const req = jointFileReq;
  if (!req) return;
  const f = req.snap;
  const danger = !!f && jointFileDanger(f);
  const onComputer = isLocalHost();
  const biometric = !!(hasNative() && nativeCaps.biometric);
  const wanted = req.reqName || '';
  const size = jointFileSize(f ? f.size : req.reqSize);
  const peer = req.peerName || '';
  const body = $('#joint-file-body');
  body.innerHTML = `
    <div class="joint-approve-head">${jointPeerAvatar(req)}<div><b>${esc(peer)} 想从你这里取一个文件</b><small>由 ${esc(req.requester || peer)} 在群里提出</small></div></div>
    ${req.purpose || req.quote ? `<div class="joint-quote">“${esc(req.purpose || req.quote)}”<br><b>—— ${esc(req.requester || peer)}${req.time ? `，${esc(req.time)}` : ''}</b></div>` : ''}
    ${
      f
        ? `<div class="joint-file${danger ? ' danger' : ''}">
      <span class="joint-file-icon">${esc((f.name || '').split('.').pop()?.toUpperCase().slice(0, 3) || 'FILE')}</span>
      <span class="joint-file-meta"><b>${esc(f.name || '')}</b><small>${[f.path, size].filter(Boolean).map((x) => esc(String(x))).join(' · ')}</small></span>
      ${danger ? `<span class="joint-file-tag">${esc(f.kind || tr('证书 / 私钥'))}</span>` : ''}
    </div>`
        : wanted
          ? `<div class="joint-file"><span class="joint-file-icon">${esc(wanted.split('.').pop()?.toUpperCase().slice(0, 3) || 'FILE')}</span><span class="joint-file-meta"><b>${esc(wanted)}</b><small>${tr('对方想要的文件')}${size ? ` · ${size}` : ''}</small></span></div>`
          : ''
    }
    ${f && danger ? `<div class="joint-warn"><b>这是证书私钥文件。</b>对方拿到后可以用它冒充你的服务或给它签名。请确认是对方本人、确实需要；发送后建议更换这份证书。</div>` : ''}
    ${f && danger && !onComputer ? `<p class="hint warn-text">${tr('请到电脑上确认')}</p>` : ''}
    ${f && danger && onComputer && biometric ? `<div class="joint-touchid"><svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M20 15c3.2-2.6 7.2-4 12-4 4.8 0 8.8 1.4 12 4"/><path d="M12 27c0-3 .7-5.7 2-8"/><path d="M52 27c0-3-.7-5.7-2-8"/><path d="M18 31v7c0 5-1 9-3 13"/><path d="M46 31v7c0 7-1.5 12-5 17"/><path d="M32 20c-5 0-8 3.3-8 8v12c0 5-.8 9-2.5 13"/><path d="M32 20c5 0 8 3.3 8 8v15c0 6-1 10-3 14"/><path d="M32 28v16c0 4.5-.7 8-2 11"/></svg><b>${tr('把手指放在 Touch ID 上')}</b><small>${tr('确认是你本人，才会把这份文件发出去')}</small></div>` : ''}
    ${f && danger && onComputer && !biometric ? `<label class="form-row block joint-confirm"><span>${tr('输入文件名确认发送')}</span><input id="joint-file-confirm" autocomplete="off" spellcheck="false" placeholder="${esc(tr('输入上面的文件名'))}"></label>` : ''}
    <div class="joint-file-pick">
      ${!f && !onComputer ? `<span class="hint">${tr('传文件请在电脑上操作')}</span>` : ''}
      ${onComputer ? `<button type="button" class="secondary" id="btn-joint-file-pick">${f ? tr('重新选择文件…') : tr('选择文件…')}</button>` : ''}
      ${f && (onComputer || !danger) ? `<span class="hint">${tr('确认后只发这一个文件')}</span>` : ''}
    </div>
    <div class="joint-dest"><span>${tr('发送到')}</span><b>${esc(req.toName || peer)} 的电脑 · ClawChat 收件箱</b><small>${tr('经 Tailscale 加密传输，文件内容不经过任何 AI，只发这一个文件')}</small></div>`;
  const pick = $('#btn-joint-file-pick');
  if (pick) pick.onclick = chooseJointFile;
  const yes = $('#btn-joint-file-yes');
  yes.textContent = f && danger && biometric ? tr('Touch ID 确认') : tr('确认发送');
  yes.hidden = !f || (danger && !onComputer);
  yes.disabled = !f || (danger && !biometric);
  if (f && danger && onComputer && !biometric) {
    const input = $('#joint-file-confirm');
    const sync = () => (yes.disabled = input.value !== (f.name || ''));
    input.addEventListener('input', sync);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  }
}

async function chooseJointFile() {
  const req = jointFileReq;
  if (!req) return;
  const btn = $('#btn-joint-file-pick');
  if (btn) btn.disabled = true;
  try {
    const path = await pickFile();
    if (!path) return;
    const snap = await api('POST', '/api/joint/files/snapshot', { path, roomId: req.roomId });
    req.snap = snap;
    drawJointFileRequest();
  } catch (err) {
    toast(err.message, 6000);
  } finally {
    const again = $('#btn-joint-file-pick');
    if (again) again.disabled = false;
  }
}

async function approveJointFile() {
  const req = jointFileReq;
  const f = req?.snap;
  if (!req || !f) return toast(tr('先选择要发送的文件'), 5000);
  const danger = jointFileDanger(f);
  const biometric = danger && hasNative() && nativeCaps.biometric;
  const confirmName = $('#joint-file-confirm')?.value || '';
  if (danger && !isLocalHost()) return toast(tr('请到电脑上确认'), 5000);
  if (danger && !biometric && confirmName !== (f.name || '')) return toast(tr('文件名对不上，没有发出去'), 5000);
  const btn = $('#btn-joint-file-yes');
  btn.disabled = true;
  try {
    let auth = null;
    if (biometric) {
      // 先拿一次性的确认串，再让 Mac 外壳按指纹签名；私钥不离开 Secure Enclave
      const { message } = await api('POST', '/api/joint/files/biometric-challenge', { hash: f.hash, toNode: req.toNode });
      const signed = await biometricSign(message);
      if (!signed?.ok || !signed.sig || !signed.pub) throw new Error(signed?.error || tr('没有完成 Touch ID 确认，文件没有发出去'));
      auth = { message, pub: signed.pub, sig: signed.sig };
    }
    const body = {
      roomId: req.roomId,
      staging: f.staging,
      hash: f.hash,
      size: f.size,
      name: f.name,
      toNode: req.toNode,
    };
    if (auth) body.auth = auth;
    else if (danger) body.confirmName = confirmName;
    await api('POST', '/api/joint/files/approve', body);
    closeDialog($('#dlg-joint-file'));
    toast(tr('文件已经发出去'));
  } catch (err) {
    toast(err.message || tr('文件没有发出去'), 5000);
  } finally {
    btn.disabled = danger && !biometric && confirmName !== (f.name || '');
  }
}

function jointNodeOwner(node) {
  const room = jointRoom();
  const m = (room?.jointMembers || []).find((x) => x.node === node);
  return m?.owner || node || '';
}

function renderJointInbox(items = []) {
  const box = $('#joint-inbox-body');
  if (!box) return;
  if (!items.length) return void (box.innerHTML = `<p class="hint">${tr('还没有收到文件。对方发来的文件会放在这里，默认不给任何 AI 看。')}</p>`);
  box.innerHTML = [...items]
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .map((it) => {
      const size = jointFileSize(it.size);
      const from = jointNodeOwner(it.fromNode);
      const when = it.at ? fmtShort(it.at) : '';
      return `<div class="joint-inbox-row"><span class="joint-file-icon">${esc((it.name || '').split('.').pop()?.toUpperCase().slice(0, 3) || 'FILE')}</span><span class="joint-file-meta"><b>${esc(it.name || '')}</b><small>${[from, when, size].filter(Boolean).map(esc).join(' · ')}</small></span><button type="button" class="secondary" data-inbox-reveal="${esc(it.transferId || '')}">${tr('在访达里显示')}</button></div>`;
    })
    .join('');
}

async function openJointInbox() {
  const room = jointRoom();
  const dlg = $('#dlg-joint-inbox');
  if (!dlg || !room) return;
  $('#joint-inbox-body').innerHTML = `<p class="hint">${tr('正在读取…')}</p>`;
  if (!dlg.open) dlg.showModal();
  reportDragRegions();
  try {
    const res = await api('GET', `/api/joint/files/inbox?roomId=${encodeURIComponent(room.id)}`);
    renderJointInbox(res.items || []);
  } catch (err) {
    $('#joint-inbox-body').innerHTML = `<p class="hint error">${esc(err.message)}</p>`;
  }
}

async function leaveJointRoom() {
  const room = jointRoom();
  if (!room) return;
  const host = room.joint?.role === 'host';
  const ok = await askConfirm({
    title: host ? tr('解散联合群？') : tr('退出联合群？'),
    text: host ? tr('解散以后对方就进不来了，这个群会恢复成只有你自己成员的普通群；本地的聊天记录不会被删。') : tr('退出以后这个群里就看不到对方的成员和消息了；本地的聊天记录不会被删。'),
    ok: host ? tr('解散联合群') : tr('退出联合群'),
  });
  if (!ok) return;
  try {
    await api('POST', `/api/rooms/${room.id}/joint/leave`);
    toast(tr('已经退出联合群'));
    closeDialog($('#dlg-room'));
  } catch (err) {
    toast(err.message);
  }
}

// 群设置里的联合群一节：只有联合群才显示；第一期只有「讨论档」
async function loadJointPolicy(room) {
  if (!room?.joint) return;
  const id = room.id;
  const list = $('#joint-policy-list');
  if (list) list.innerHTML = `<p class="hint">${tr('正在读取权限…')}</p>`;
  try {
    const res = await api('GET', `/api/rooms/${id}/joint/policy`);
    if (S.editing !== id) return;
    S.jointPolicy = { roomId: id, engines: res.engines || [], agents: res.agents || {} };
    renderJointPolicy();
  } catch (err) {
    if (S.editing === id && list) list.innerHTML = `<p class="hint error">${esc(err.message)}</p>`;
  }
}

function renderJointPolicy() {
  const room = roomById(S.editing);
  const data = S.jointPolicy;
  const list = $('#joint-policy-list');
  if (!list || !room?.joint || !data || data.roomId !== room.id) return;
  const ids = Object.keys(data.agents).sort((a, b) => {
    const ia = AGENT_IDS.indexOf(a);
    const ib = AGENT_IDS.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  if (!ids.length) {
    list.innerHTML = `<p class="hint">${tr('这个联合群里还没有自己这边的 AI。')}</p>`;
    $('#joint-confirm-all').checked = true;
    return;
  }
  $('#joint-confirm-all').checked = ids.every((a) => data.agents[a].confirm !== false);
  list.innerHTML = ids.map((id) => {
    const p = data.agents[id];
    const name = jointDisplayFor(room, id);
    const folder = p.level === 'folder';
    const note = p.available
      ? tr('已验收')
      : data.platformReady === false
        ? tr('「指定文件夹」目前只在 Mac 上验收过，这台电脑先只能讨论')
        : tr('这家 AI 还没验收，先只能讨论');
    return `<div class="joint-policy-row" data-agent="${esc(id)}">
      <div class="joint-policy-top">${avatarHtml(id)}
        <div class="joint-policy-name"><b>${esc(name)}</b><small>${esc(note)}</small></div>
        <div class="joint-level">
          <button type="button" data-level="discuss"${folder ? '' : ' class="on"'}>${tr('讨论')}</button>
          <button type="button" data-level="folder"${folder ? ' class="on"' : ''}${p.available && (isLocalHost() || p.folder) ? '' : ' disabled'}>${tr('指定文件夹')}</button>
        </div>
      </div>
      ${folder ? `<div class="joint-policy-folder">${p.folder ? `<span class="path">${esc(p.folder)}</span>` : `<span class="none">${tr('还没选文件夹')}</span>`}${isLocalHost() ? `<button type="button" class="pick" data-pick>${p.folder ? tr('更改…') : tr('选择文件夹…')}</button>` : `<span class="none">${tr('在电脑上更改')}</span>`}</div>` : ''}
    </div>`;
  }).join('');
  list.querySelectorAll('.joint-policy-row').forEach((row) => {
    const id = row.dataset.agent;
    row.querySelectorAll('[data-level]').forEach((b) => {
      b.onclick = () => {
        const p = data.agents[id];
        if (b.dataset.level === 'folder' && !p.available) return;
        p.level = b.dataset.level === 'folder' ? 'folder' : 'discuss';
        renderJointPolicy();
      };
    });
    const pick = row.querySelector('[data-pick]');
    if (pick) pick.onclick = async () => {
      try {
        const path = await pickFolder();
        if (!path) return;
        const p = data.agents[id];
        p.level = 'folder';
        p.folder = path;
        renderJointPolicy();
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

function collectJointPolicy() {
  const data = S.jointPolicy;
  if (!data) return null;
  const confirm = $('#joint-confirm-all').checked;
  const agents = {};
  for (const [id, p] of Object.entries(data.agents)) {
    agents[id] = { level: p.level === 'folder' ? 'folder' : 'discuss', folder: p.level === 'folder' ? p.folder : '', confirm };
  }
  return agents;
}

function syncJointFields(room) {
  const sec = $('#joint-fields');
  if (!sec) return;
  const joint = room?.joint || null;
  sec.hidden = !joint;
  if (!joint) S.jointPolicy = null;
  // 「新建联合群 / 加入联合群」只放在新建聊天里；改已有群时不再露出（普通群不能变成联合群）
  const entry = $('#joint-entry-row');
  if (entry) entry.hidden = !!room;
  // 联合群不适用项目文件夹和普通群那三档动手权限
  $('#perm-section').hidden = !!joint;
  $('#cwd-row').hidden = !!joint;
  $('#cwd-hint').hidden = !!joint;
  $('#btn-clone-add').hidden = !!joint; // 第一期联合群里不开放分身；普通群照常
  // 加入方：群名、成员、协作这些由主持方管，这边改了也存不上，干脆灰掉，免得以为改上了
  const guest = joint?.role === 'guest';
  formField('name').disabled = guest;
  document.querySelectorAll('#dlg-room .members input').forEach((el) => { el.disabled = guest; });
  $('#group-fields').hidden = guest;
  if (!joint) return void ($('#member-sub').textContent = tr('只选一位就是单聊'));
  $('#joint-peer').textContent = joint.peerName || tr('等对方加入…');
  $('#joint-self-name').textContent = joint.selfName || tr('我');
  $('#joint-policy-summary').textContent = tr('每位 AI 单独设置');
  $('#member-sub').textContent = guest ? tr('群名和成员由主持方管理') : tr('自己这边派谁进去');
  loadJointPolicy(room);
  $('#btn-joint-invite').hidden = joint.role === 'guest' || !!joint.peerNode;
  $('#btn-joint-inbox').hidden = false;
  $('#btn-joint-leave').hidden = false;
  $('#btn-joint-leave').textContent = joint.role === 'host' ? tr('解散联合群') : tr('退出联合群');
  $('#joint-hint').textContent = tr('对方的 AI 看不到你的私聊、别的群和本机文件；停止按钮各管各的。');
}

async function init() {
  S.drafts = loadDrafts();
  loadAttachDrafts();
  syncLang(I18N.lang).catch(() => {});
  if (hasNative()) native({ type: 'capabilities' });
  bind();
  applyPlatformText();
  applyTheme(currentTheme());
  detectIcons();
  trackChrome();
  bindScrollbar();
  bindFind();
  bindSearch();
  try {
    applyState(await api('GET', '/api/state'));
  } catch {
    toast(tr('连不上 ClawChat 服务'), 6000);
  }
  renderEngines();
  offerClaudeCode('start'); // 页面打开前程序已经检测完了的话，不会再收到 engines 事件
  let saved = storeGet('clawchat.current');
  if (saved && !saved.includes(':')) saved = `g:${saved}`; // 旧版本存的是群 id
  const list = conversations();
  const first = parseKey(saved) && roomById(parseKey(saved).roomId) ? saved : list[0]?.key;
  // 手机上从主屏幕或书签打开带 #聊天 的地址：直接进那个聊天；普通打开先停在列表
  let deep = '';
  try {
    deep = decodeURIComponent(location.hash.slice(1));
  } catch {}
  if (!deep || !parseKey(deep) || !roomById(parseKey(deep).roomId)) deep = '';
  renderConvs();
  if (deep) {
    history.replaceState(null, '', location.pathname + location.search);
    openConv(deep);
    if (!isNarrow()) history.replaceState(null, '', location.pathname + location.search);
  } else if (first) openConv(first, { stayList: true });
  else renderShell();
  bindMobileViewport();
  window.addEventListener('resize', () => renderJointBar());
  hideBoot();
  connect();
  // 启动时如果已有等确认的加入申请（页面关着时发来的），补弹一次
  setTimeout(() => {
    if (!document.querySelector('dialog[open]')) checkPendingJointPairs();
  }, 1200);
  setTimeout(() => {
    if (!document.querySelector('dialog[open]')) checkPendingJointApprovals();
  }, 1400);
  // 启动后悄悄查一次有没有新版本，之后每小时查一次
  setTimeout(() => checkForUpdate(false), 5000);
  setInterval(() => checkForUpdate(false), 60 * 60 * 1000);
}

init();
