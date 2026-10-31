import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, ROOM_DEFAULTS, DATA_DIR, saveConfig, readConfig, recovered } from './lib/store.js';
import { Hub, dmRoom } from './lib/hub.js';
import { AGENTS, IS_WIN, setupPath, detectEngines, probeModel, updateEngine, deepseekModels, providerModelsFor, sessionUsage, addExtraMember, removeExtraMember, ensureExtraMember, installClaudeCode } from './lib/agents.js';
import { PROVIDERS } from './lib/providers.js';
import { appInfo, checkUpdate, pullUpdate, scheduleRestart, bootCommit, takeRollback } from './lib/updater.js';
import { tr, setLang, getLang, dictScript } from './lib/i18n.js';
import { requestAccess, remoteInfo, setRemote, initRemote } from './lib/remote.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.CLAWCHAT_PORT) || 7317;
const HOST = '127.0.0.1';
const PROJECTS_DIR = path.join(os.homedir(), 'ClawChatProjects');

setLang(readConfig().uiLang); // 界面上次用的语言（系统通知、群里的提示也用它）
const store = new Store();
const hub = new Hub(store);
const clients = new Set();
let engines = {}; // 启动后异步检测，检测完之前界面显示「检测中」

hub.on('event', (ev) => {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(data);
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// 上传的图片：两位都能直接看的格式原样保存；HEIC 之类的格式、太大或尺寸太大的图用 sips 转成 JPG
// （Windows 上没有 sips：界面会先在本地把大图缩小成 JPG 再上传，HEIC 这类认不出的格式就只能请老板先转一下）
const UPLOAD_TYPES = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tiff', 'image/bmp': 'bmp',
};
const DIRECT_EXT = new Set(['png', 'jpg', 'gif', 'webp']);
const UPLOAD_NAME_RE = /^[a-f0-9]{16}s?\.(png|jpg|gif|webp)$/;
const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_DIRECT_WIN = 5 * 1024 * 1024; // Windows 上不能转换，太大的图模型收不了

function run(cmd, args) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 60000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );
}

async function imageSize(file) {
  try {
    const out = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
    return Math.max(...[...out.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1])));
  } catch {
    return 0;
  }
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, tr('图片太大了（最大 25MB）')));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function saveUpload(room, req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = UPLOAD_TYPES[type];
  if (!ext) throw httpError(415, tr('只支持图片（PNG、JPG、GIF、WebP、HEIC）'));
  if (IS_WIN && !DIRECT_EXT.has(ext)) throw httpError(415, tr('这种图片格式（比如 HEIC）在 Windows 上转换不了，请先另存成 JPG 或 PNG 再发'));
  const buf = await readRaw(req, MAX_UPLOAD);
  if (!buf.length) throw httpError(400, tr('图片是空的'));
  if (IS_WIN && buf.length > MAX_DIRECT_WIN) throw httpError(413, tr('图片太大了，请压缩到 5MB 以内再发'));
  const dir = store.uploadsDir(room.id);
  fs.mkdirSync(dir, { recursive: true });
  const base = crypto.randomBytes(8).toString('hex');
  let file = `${base}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  if (!IS_WIN && (!DIRECT_EXT.has(ext) || buf.length > 3 * 1024 * 1024 || (await imageSize(path.join(dir, file))) > 4000)) {
    const out = `${base}s.jpg`;
    try {
      await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', '2400', path.join(dir, file), '--out', path.join(dir, out)]);
    } catch {
      fs.rmSync(path.join(dir, file), { force: true });
      throw httpError(400, tr('这张图片处理不了，换一张试试'));
    }
    fs.rmSync(path.join(dir, file), { force: true });
    file = out;
  }
  return { id: file, type: MIME[path.extname(file)] };
}

function validModel(engine, id) {
  const models = engines[engine]?.models;
  return !id || !models?.length || models.some((m) => m.id === id);
}

// 成员用的是哪个程序（多开的 ChatGPT2 和 ChatGPT 一样用 codex）
const engineOf = (a) => AGENTS[a]?.engine;
// 存中文原文，用的时候再按当前语言翻译（模块加载时还不知道界面是什么语言）
const EFFORT_LABEL = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极限' };
const effortLabel = (id) => (EFFORT_LABEL[id] ? tr(EFFORT_LABEL[id]) : id);

// 某位在某个模型下能选哪些思考强度：Claude 固定那几档；Codex、DeepSeek 看模型目录（「默认」就看默认模型）
function effortsFor(agent, modelId) {
  if (engineOf(agent) === 'claude') return engines.claude?.efforts || [];
  const e = engines[engineOf(agent)] || {};
  const model = e.models?.find((m) => m.id === (modelId || e.defaultModel));
  return model?.efforts || [];
}

// 这个模型有没有快速模式（目前只有 GPT 有）：返回模型目录里的说明，比如「2x speed, increased usage」
function fastFor(agent, modelId) {
  if (agent !== 'gpt') return '';
  const e = engines.codex || {};
  return e.models?.find((m) => m.id === (modelId || e.defaultModel))?.fast || '';
}

function fastName(agent, on, modelId) {
  const speed = fastFor(agent, modelId).match(/([\d.]+)x speed/i)?.[1];
  if (!on) return tr('标准速度');
  return speed ? tr('快速模式（约 {speed} 倍速，额度按 2.5 倍消耗）', { speed }) : tr('快速模式（额度按 2.5 倍消耗）');
}

function effortName(agent, id) {
  if (id) return effortLabel(id);
  const def = engines[engineOf(agent)]?.defaultEffort;
  return def ? tr('默认（{label}）', { label: effortLabel(def) }) : tr('默认');
}

function modelName(agent, id) {
  const e = engines[engineOf(agent)] || {};
  if (!id) return e.defaultLabel ? tr('默认模型（{label}）', { label: e.defaultLabel }) : tr('默认模型');
  return e.models?.find((m) => m.id === id)?.name || id;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(httpError(413, tr('消息太长了')));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(httpError(400, tr('请求格式不对')));
      }
    });
    req.on('error', reject);
  });
}

function expandHome(p) {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function safeName(name) {
  return name.replace(/[\/\\:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

// 多开成员只活在群里：哪个群都没有它了（群里取消勾选、群删了），就把它清掉，免得越积越多。
// 它在各群里的记忆、设置一起清；聊天记录留着
function pruneExtraMembers(before = null) {
  const used = new Set(store.listRooms().flatMap((r) => r.members));
  const gone = Object.keys(AGENTS).filter((id) => AGENTS[id].base && !used.has(id));
  for (const id of gone) {
    hub.forgetMember(id);
    removeExtraMember(id);
  }
  // 成员表变了（开出了新的、清掉了旧的）就告诉界面
  if (gone.length || (before !== null && before !== Object.keys(AGENTS).join())) hub.emit('event', { type: 'agents', agents: AGENTS });
}

function normalizeRoom(body, creating, room = null) {
  const out = {};
  if (body.members !== undefined || creating) {
    // 多开成员是在群里勾出来的：勾上的 ChatGPT2 这类还没开出来，就先开出来
    if (Array.isArray(body.members)) for (const id of body.members) ensureExtraMember(id);
    const members = Object.keys(AGENTS).filter((id) => (Array.isArray(body.members) ? body.members : Object.keys(AGENTS)).includes(id));
    if (!members.length) throw httpError(400, tr('至少要选一位成员'));
    out.members = members;
    const target = body.defaultTarget ?? room?.defaultTarget;
    if (target && !['all', 'sequential', 'last'].includes(target) && !members.includes(target)) out.defaultTarget = 'last';
  }
  if (body.folder !== undefined) {
    if (body.folder && !store.getFolder(String(body.folder))) throw httpError(400, tr('这个收纳组不存在了'));
    out.folder = body.folder ? String(body.folder) : undefined;
  }
  if (body.name !== undefined || creating) {
    let name = String(body.name || '').trim().slice(0, 40);
    if (!name && out.members?.length === 1) name = AGENTS[out.members[0]].label; // 单聊默认用对方的名字
    if (!name) throw httpError(400, tr('名字不能为空'));
    out.name = name;
  }
  if (body.cwd !== undefined || creating) {
    let cwd = String(body.cwd || '').trim();
    if (!cwd) cwd = path.join(PROJECTS_DIR, safeName(out.name));
    cwd = path.resolve(expandHome(cwd));
    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch (err) {
      throw httpError(400, tr('项目文件夹建不了：{error}', { error: err.message }));
    }
    if (!fs.statSync(cwd).isDirectory()) throw httpError(400, tr('项目文件夹路径不是文件夹'));
    out.cwd = cwd;
  }
  if (body.permission !== undefined) {
    if (!['project', 'full', 'readonly'].includes(body.permission)) throw httpError(400, tr('权限设置不对'));
    out.permission = body.permission;
  }
  if (body.collab !== undefined) out.collab = !!body.collab;
  if (body.maxAutoTurns !== undefined) {
    const n = Math.round(Number(body.maxAutoTurns));
    out.maxAutoTurns = Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : ROOM_DEFAULTS.maxAutoTurns;
  }
  if (body.defaultTarget !== undefined) {
    if (!['all', 'sequential', 'last', ...Object.keys(AGENTS)].includes(body.defaultTarget)) throw httpError(400, tr('默认接话人设置不对'));
    out.defaultTarget = body.defaultTarget;
  }
  if (body.models !== undefined) {
    out.models = {};
    for (const a of Object.keys(AGENTS)) out.models[a] = String(body.models?.[a] || '').trim().slice(0, 80);
    // 列表外的模型只能走「自定义模型」：界面上先试过能用，才会带着 custom 标记提交
    const custom = Array.isArray(body.custom) ? body.custom : [];
    const keep = (agent) => (room?.models?.[agent] || '') === out.models[agent]; // 原来就在用的不重新校验
    const owner = { claude: 'Claude', gpt: tr('当前的 Codex'), deepseek: 'DeepSeek', glm: 'GLM', gemini: 'Gemini', grok: 'Grok' };
    for (const a of Object.keys(AGENTS)) {
      if (!custom.includes(a) && !keep(a) && !validModel(engineOf(a), out.models[a])) {
        throw httpError(400, tr('{owner}用不了 {model} 这个模型，请从列表里选一个', { owner: owner[a], model: out.models[a] }));
      }
    }
  }
  if (body.efforts !== undefined || out.models) {
    const efforts = { ...ROOM_DEFAULTS.efforts, ...room?.efforts };
    for (const a of Object.keys(AGENTS)) {
      if (body.efforts?.[a] !== undefined) efforts[a] = String(body.efforts[a] || '').trim();
      const allowed = effortsFor(a, (out.models || room?.models || {})[a]);
      if (efforts[a] && allowed.length && !allowed.includes(efforts[a])) {
        // 换了模型、新模型不支持原来的强度：退回默认，而不是报错
        if (body.efforts?.[a] !== undefined) throw httpError(400, tr('{name} 现在的模型不支持「{effort}」', { name: AGENTS[a].name, effort: effortLabel(efforts[a]) }));
        efforts[a] = '';
      }
    }
    out.efforts = efforts;
  }
  if (body.fast !== undefined || out.models) {
    const fast = { ...ROOM_DEFAULTS.fast, ...room?.fast };
    for (const a of Object.keys(ROOM_DEFAULTS.fast)) {
      if (body.fast?.[a] !== undefined) fast[a] = !!body.fast[a];
      if (fast[a] && !fastFor(a, (out.models || room?.models || {})[a])) {
        // 换了个没有快速模式的模型：退回标准速度
        if (body.fast?.[a]) throw httpError(400, tr('{name} 现在的模型没有快速模式', { name: AGENTS[a].name }));
        fast[a] = false;
      }
    }
    out.fast = fast;
  }
  // 私聊里单独的设置：{ dmSettings: { gpt: { effort: 'low' } } } 只改这几项，{ gpt: null } 恢复成跟着群里
  if (body.dmSettings !== undefined) {
    const next = { ...room?.dmSettings };
    const custom = Array.isArray(body.custom) ? body.custom : [];
    const groupModels = out.models || room?.models || {};
    for (const [a, v] of Object.entries(body.dmSettings || {})) {
      if (!AGENTS[a]) continue;
      if (!v) {
        delete next[a];
        continue;
      }
      const cur = { ...next[a] };
      if (v.model !== undefined) {
        const m = String(v.model || '').trim().slice(0, 80);
        if (!custom.includes(a) && m !== cur.model && !validModel(engineOf(a), m)) throw httpError(400, tr('{name} 用不了 {model} 这个模型，请从列表里选一个', { name: AGENTS[a].name, model: m }));
        cur.model = m;
      }
      const model = cur.model ?? groupModels[a];
      if (v.effort !== undefined) cur.effort = String(v.effort || '').trim();
      const allowed = effortsFor(a, model);
      if (cur.effort && allowed.length && !allowed.includes(cur.effort)) {
        if (v.effort !== undefined) throw httpError(400, tr('{name} 现在的模型不支持「{effort}」', { name: AGENTS[a].name, effort: effortLabel(cur.effort) }));
        cur.effort = ''; // 换了模型、新模型不支持原来的强度：退回默认
      }
      if (v.fast !== undefined) cur.fast = !!v.fast;
      if (cur.fast && !fastFor(a, model)) {
        if (v.fast) throw httpError(400, tr('{name} 现在的模型没有快速模式', { name: AGENTS[a].name }));
        cur.fast = false;
      }
      next[a] = cur;
    }
    out.dmSettings = next;
  }
  return out;
}

// Windows 选文件夹：用 PowerShell 弹系统的文件夹对话框。挂在一个看不见的置顶小窗口下面，免得对话框被 ClawChat 窗口挡住；
// 路径用 Base64 传回来，免得中文被命令行编码弄乱
const pickFolderPs = (prompt) => `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'CenterScreen'; Size = New-Object System.Drawing.Size(1, 1) }
$owner.Show(); $owner.Activate()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{ Description = '${prompt.replace(/'/g, "''")}'; ShowNewFolderButton = $true }
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)) }
$owner.Close()
`;

function pickFolder() {
  if (IS_WIN) {
    const encoded = Buffer.from(pickFolderPs(tr('选择项目文件夹')), 'utf16le').toString('base64');
    return new Promise((resolve) =>
      // 不用 windowsHide：它会连对话框一起藏起来。PowerShell 自己的黑窗口用 -WindowStyle Hidden 收起
      execFile('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { timeout: 10 * 60 * 1000 }, (err, stdout) => {
        const b64 = String(stdout || '').trim();
        resolve(err || !b64 ? null : Buffer.from(b64, 'base64').toString('utf8').replace(/(?<!:)[\\/]$/, '') || null);
      }),
    );
  }
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', 'activate', '-e', `POSIX path of (choose folder with prompt "${tr('选择项目文件夹').replace(/[\\"]/g, '\\$&')}")`],
      { timeout: 10 * 60 * 1000 },
      (err, stdout) => resolve(err ? null : stdout.trim().replace(/\/$/, '') || null),
    );
  });
}

// 没有本机官方应用可取图标的几位：从官方账号下载一份存在本机（和 Claude、ChatGPT 的图标一样，不放进代码仓库）。
// DeepSeek、GLM 是官方 GitHub 账号（DeepSeek、智谱 Z.ai）的头像；Gemini 在 Mac 上打包时从 Gemini.app 取，取不到就用 Google 官方的图标。
// Mac 打包、Windows 安装时也会下载；这里是兜底。下载不到就用界面里内置的简笔头像
const ICON_URLS = {
  // Claude、ChatGPT 在 Mac 上打包时从本机的 Claude.app、ChatGPT.app 取；Windows 和没装官方应用的电脑用这两张（claude.ai 上的 Claude 应用图标、OpenAI 官方 GitHub 头像）
  claude: 'https://claude.ai/images/claude_app_icon.png',
  gpt: 'https://avatars.githubusercontent.com/u/14957082?s=256',
  deepseek: 'https://avatars.githubusercontent.com/u/148330874?s=256',
  glm: 'https://avatars.githubusercontent.com/u/223098841?s=256',
  gemini: 'https://www.gstatic.com/lamda/images/gemini_favicon_f069958c85030456e93de685481c559f160ea06b.png',
  // Grok 是 grok.com 网站自己的图标（黑底白标）。grok.com 拦着不让程序直接下载，从 Google 缓存的网站图标里取
  grok: 'https://www.google.com/s2/favicons?domain=grok.com&sz=256',
};
// 换过图的：记在 icons/versions.json 里，旧的那张会重新下载一次（Grok 0.7.32 用的是 App Store 里的立体图标，不对）
const ICON_VERSIONS = { grok: 2 };
async function ensureIcons() {
  let added = false;
  const versionsFile = path.join(PUBLIC, 'icons', 'versions.json');
  let versions = {};
  try {
    versions = JSON.parse(fs.readFileSync(versionsFile, 'utf8'));
  } catch {}
  for (const [name, url] of Object.entries(ICON_URLS)) {
    const file = path.join(PUBLIC, 'icons', `${name}.png`);
    const want = ICON_VERSIONS[name] || 1;
    if (fs.existsSync(file) && (versions[name] || 1) >= want) continue;
    try {
      const src = typeof url === 'function' ? await url() : url;
      if (!src) continue;
      const res = await fetch(src, { signal: AbortSignal.timeout(20000) });
      const buf = Buffer.from(await res.arrayBuffer());
      const png = buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
      if (!res.ok || !png || buf.length > 2 * 1024 * 1024) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      if (ICON_VERSIONS[name]) {
        versions[name] = ICON_VERSIONS[name];
        fs.writeFileSync(versionsFile, JSON.stringify(versions));
      }
      added = true;
    } catch {}
  }
  if (added) hub.emit('event', { type: 'icons' }); // 已经打开的窗口换上新头像
}

// 在访达 / 资源管理器里打开
function openPath(p) {
  execFile(IS_WIN ? 'explorer.exe' : 'open', [p], () => {});
}

// 在访达 / 资源管理器里显示某个文件（打开它所在的文件夹，并选中它）
function revealPath(p) {
  if (IS_WIN) execFile('explorer.exe', [`/select,${p}`], () => {});
  else execFile('open', ['-R', p], () => {});
}

// 消息、过程里提到的文件：相对路径按项目文件夹算，~ 开头的按家目录；不存在返回 null。
// AI 常常只写文件名，或者写的是相对某个子文件夹的路径（比如前面说了「图片都在 design-requests/dark-mode-art 里」，
// 后面只写「图片对比.html」）：项目根目录下找不到时，先到同一条消息里提到的文件夹下找，再在整个项目文件夹里找同名的
async function roomFile(room, p, near = []) {
  p = String(p || '').trim();
  if (!p || p.length > 1000) return null;
  const abs = path.resolve(room.cwd, expandHome(p));
  if (fs.existsSync(abs)) return abs;
  if (path.isAbsolute(expandHome(p)) || !room.cwd) return null;
  for (const h of near.slice(0, 20)) {
    const dir = path.resolve(room.cwd, expandHome(String(h || '').trim()));
    const base = isDir(dir) ? dir : path.dirname(dir);
    const file = path.join(base, p);
    if (base !== room.cwd && fs.existsSync(file)) return file;
  }
  return findInProject(room.cwd, p);
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// 项目文件夹里所有文件和文件夹的索引（按名字分组），用来按名字找文件。跳过依赖和构建产物；建一次管 30 秒
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'Pods', 'DerivedData', 'target', '__pycache__', 'venv']);
const projectIndex = new Map(); // 项目文件夹 -> { at, byName, building }

async function indexProject(root) {
  const byName = new Map();
  const queue = [[root, 0]];
  let seen = 0;
  while (queue.length && seen < 60000) {
    const [dir, depth] = queue.shift();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      seen++;
      if (e.name.startsWith('.')) continue;
      const name = e.name.normalize('NFC');
      const full = path.join(dir, e.name);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(full);
      if (e.isDirectory() && depth < 10 && !SKIP_DIRS.has(e.name)) queue.push([full, depth + 1]);
    }
  }
  return byName;
}

async function projectNames(root, fresh = false) {
  const hit = projectIndex.get(root);
  if (hit && !fresh && Date.now() - hit.at < 30000) return hit.building || hit.byName;
  if (hit?.building) return hit.building;
  const building = indexProject(root).then((byName) => {
    projectIndex.set(root, { at: Date.now(), byName });
    return byName;
  });
  projectIndex.set(root, { ...hit, at: hit?.at || 0, building });
  return building;
}

// 按名字找：路径的最后几级要对得上；找到好几个就取最近改过的。索引是旧的、又没找到，就重建一次再找（可能是刚生成的文件）
async function findInProject(root, rel) {
  const want = path.normalize(rel.normalize('NFC')).replace(/^(\.\/)+/, '').replace(/[\\/]+$/, '');
  if (!want || want.startsWith('..')) return null;
  const base = path.basename(want);
  const pick = (byName) => {
    const hits = (byName.get(base) || []).filter((f) => f.normalize('NFC').endsWith(path.sep + want));
    const mtime = (f) => {
      try {
        return fs.statSync(f).mtimeMs;
      } catch {
        return 0;
      }
    };
    return hits.sort((a, b) => mtime(b) - mtime(a))[0] || null;
  };
  const found = pick(await projectNames(root));
  if (found) return found;
  const age = Date.now() - (projectIndex.get(root)?.at || 0);
  return age > 3000 ? pick(await projectNames(root, true)) : null;
}

// 鼠标移到文件名上时显示的缩略图：只给这几种浏览器能直接显示的图片
const PREVIEW_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

function events(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'status', runs: hub.status() })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

async function api(req, res, url, access = 'local') {
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  const method = req.method;

  // commit：跑的是哪个版本（升级后的重启脚本用它确认起来的是新版本，不是还没退出的旧服务）
  if (method === 'GET' && parts[0] === 'health') return send(res, 200, { ok: true, commit: await bootCommit });
  // 搜聊天内容：所有群、私聊里的消息，最新的在前；每条只带命中位置前后的一小段，再带上同一个会话里的上一条（看得出是在聊什么）。
  // 可以按谁说的（from）、哪个群（room）筛；facets 是筛选前每个人、每个群各命中几条，给筛选菜单用
  if (method === 'GET' && parts[0] === 'search') {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
    const onlyFrom = String(url.searchParams.get('from') || '');
    const onlyRoom = String(url.searchParams.get('room') || '');
    if (!q) return send(res, 200, { hits: [], total: 0, facets: { from: {}, rooms: {} } });
    // 消息显示在哪个会话：和用户的私聊、AI 之间的私聊（放在被找的那一位那里），其余在群里（和前端的 convOf 一样）
    const convOf = (m) => (m.dm ? `d:${m.dm}` : m.pm ? `d:${m.pmIn || m.pm}` : 'g');
    const flat = (t) => String(t).replace(/\s+/g, ' ').trim();
    const facets = { from: {}, rooms: {} };
    const found = [];
    for (const room of store.listRooms()) {
      const msgs = store.getMessages(room.id);
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.from === 'system' || !m.text || !m.text.toLowerCase().includes(q)) continue;
        facets.from[m.from] = (facets.from[m.from] || 0) + 1;
        facets.rooms[room.id] = (facets.rooms[room.id] || 0) + 1;
        if ((onlyFrom && m.from !== onlyFrom) || (onlyRoom && room.id !== onlyRoom)) continue;
        found.push({ room, msgs, i });
      }
    }
    found.sort((x, y) => y.msgs[y.i].ts - x.msgs[x.i].ts);
    const hits = found.slice(0, 200).map(({ room, msgs, i }) => {
      const m = msgs[i];
      const at = m.text.toLowerCase().indexOf(q);
      const start = Math.max(0, at - 40);
      const end = at + q.length + 140;
      const conv = convOf(m);
      let prev = null;
      for (let j = i - 1; j >= 0; j--) {
        const p = msgs[j];
        if (p.from === 'system' || !p.text || convOf(p) !== conv) continue;
        const t = flat(p.text);
        prev = { from: p.from, pm: p.pm || null, text: t.length > 80 ? t.slice(-80) : t, cut: t.length > 80 };
        break;
      }
      return { roomId: room.id, seq: m.seq, from: m.from, dm: m.dm || null, pm: m.pm || null, pmIn: m.pmIn || null, ts: m.ts, text: m.text.slice(start, end), cut: start > 0, tail: end < m.text.length, prev };
    });
    return send(res, 200, { hits, total: found.length, more: found.length > hits.length, facets });
  }
  if (method === 'GET' && parts[0] === 'events') return events(req, res);
  if (method === 'GET' && parts[0] === 'state') {
    return send(res, 200, {
      rooms: store.listRooms(),
      folders: store.listFolders(),
      runs: hub.status(true),
      engines,
      agents: AGENTS,
      defaults: ROOM_DEFAULTS,
      projectsDir: PROJECTS_DIR,
      platform: process.platform,
      inApp: process.env.CLAWCHAT_APP === '1',
      restartPending: pendingRestart,
      updateRollback, // 上次升级后新版本没能启动，已经退回原来的版本：{ from, to, fromVersion, toVersion }
    });
  }
  if (method === 'POST' && parts[0] === 'lang') {
    // 前端告诉服务端现在界面是什么语言：群里的提示、AI 的回复语言都跟着它
    const body = await readBody(req);
    const was = getLang();
    const lang = setLang(body.lang);
    if (readConfig().uiLang !== lang) saveConfig({ uiLang: lang });
    // 程序状态里的出错提示、模型说明是检测时按当时的语言写的，换了语言就重新检测一遍（有变化会推给界面）
    if (lang !== was) refreshEngines(true);
    return send(res, 200, { lang });
  }
  // 选文件夹会在电脑上弹系统对话框：手机上点了只会把电脑那边卡住
  if (method === 'POST' && parts[0] === 'pick-folder') {
    if (access !== 'local') return send(res, 400, { error: tr('手机上选不了文件夹，请直接填路径，或者回到电脑上操作') });
    return send(res, 200, { path: await pickFolder() });
  }
  // 手机远程访问（Tailscale）：看状态、开关。打开只能在电脑上点（手机这时还连不进来）
  if (parts[0] === 'remote' && !parts[1]) {
    if (method === 'GET') return send(res, 200, await remoteInfo());
    if (method === 'POST') {
      const { enabled } = await readBody(req);
      if (enabled && access !== 'local') return send(res, 403, { error: 'forbidden' });
      return send(res, 200, await setRemote(!!enabled, PORT));
    }
  }
  if (parts[0] === 'app') {
    if (method === 'GET' && !parts[1]) return send(res, 200, { ...(await appInfo()), dataDir: DATA_DIR, projectsDir: PROJECTS_DIR });
    if (method === 'POST' && parts[1] === 'check-update') return send(res, 200, await checkUpdate());
    // when：'idle' 等大家这一轮都干完再重启；不传就马上重启（正在干的活重启后自动接着做）
    // 等大家干完再更新的：先不拉新代码（免得页面先换成新的、服务还是旧的），干完了再拉、再重启
    if (method === 'POST' && parts[1] === 'update') {
      const { when } = await readBody(req);
      if (when === 'idle' && !allIdle()) return send(res, 200, { ok: true, waiting: waitForIdle('update') });
      const result = await pullUpdate();
      if (result.ok && result.updated) restartNow();
      return send(res, 200, result);
    }
    if (method === 'POST' && parts[1] === 'restart') {
      const { when } = await readBody(req);
      if (when === 'idle' && !allIdle()) return send(res, 200, { ok: true, waiting: waitForIdle('restart') });
      restartNow();
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && parts[1] === 'restart-cancel') {
      pendingRestart = false;
      hub.emit('event', { type: 'restart-pending', waiting: false });
      return send(res, 200, { ok: true });
    }
    // 彻底退出（Windows 和浏览器里用；Mac 应用按 ⌘Q）
    if (method === 'POST' && parts[1] === 'quit') {
      hub.emit('event', { type: 'quitting' });
      setTimeout(shutdown, 200);
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && parts[1] === 'open-data') {
      openPath(DATA_DIR);
      return send(res, 200, { ok: true });
    }
  }
  if (method === 'POST' && parts[0] === 'engines' && parts[1] === 'refresh') {
    if (Date.now() - refreshedAt > 30 * 1000) await refreshEngines(); // 最多 30 秒查一次
    return send(res, 200, { engines });
  }
  // 帮用户装 Claude Code（界面上先问过用户）：装好后重新检测一遍程序
  if (method === 'POST' && parts[0] === 'engines' && parts[1] === 'install') {
    const { engine } = await readBody(req);
    if (engine !== 'claude') return send(res, 400, { error: tr('不认识这个程序') });
    hub.emit('event', { type: 'installing', engine, on: true });
    const result = await installClaudeCode();
    hub.emit('event', { type: 'installing', engine, on: false });
    await refreshEngines(true);
    return send(res, 200, { ...result, engines });
  }
  if (method === 'POST' && parts[0] === 'engines' && parts[1] === 'update') {
    // DeepSeek 用的就是 Claude Code，更新它就是更新 Claude Code
    const { engine } = await readBody(req);
    if (!['claude', 'codex', 'grok'].includes(engine)) return send(res, 400, { error: tr('不认识这个程序') });
    const result = await updateEngine(engine);
    await refreshEngines();
    return send(res, 200, { ...result, engines });
  }
  // 借外部接口那几位的 API Key（DeepSeek、GLM）：先用它读一次模型目录，Key 不对就不存；空的就是删掉。Key 只存在本机，不会再发回界面
  if (method === 'POST' && PROVIDERS[parts[0]] && parts[1] === 'key') {
    const p = PROVIDERS[parts[0]];
    const key = String((await readBody(req)).key || '').trim();
    if (key && !/^[\x21-\x7e]{8,200}$/.test(key)) return send(res, 400, { error: tr('这不像 {name} 的 API Key（一般是一串字母数字）', { name: p.name }) });
    let warning = '';
    if (key) {
      const check = await providerModelsFor(p.id, key);
      if (check.badKey) return send(res, 400, { error: tr('{name} 说这个 API Key 不对，请检查一下有没有复制完整', { name: p.name }) });
      if (check.error) warning = tr('已保存，但现在{error}，等网络好了会自动用上', { error: check.error });
    }
    saveConfig({ [p.keyField]: key });
    await refreshEngines(true);
    return send(res, 200, { ok: true, warning, engines });
  }
  // Gemini 也可以不填 Key（用 Gemini CLI 自己的登录），所以这里只存不校验
  if (method === 'POST' && parts[0] === 'gemini' && parts[1] === 'key') {
    const key = String((await readBody(req)).key || '').trim();
    if (key && !/^[\x21-\x7e]{8,200}$/.test(key)) return send(res, 400, { error: tr('这不像 {name} 的 API Key（一般是一串字母数字）', { name: 'Gemini' }) });
    saveConfig({ geminiKey: key });
    await refreshEngines(true);
    return send(res, 200, { ok: true, warning: '', engines });
  }
  // 多开成员：同一位再开一个独立的（比如 ChatGPT2），有自己的记忆和设置
  if (parts[0] === 'members' && parts[1] === 'extra') {
    if (method === 'POST' && !parts[2]) {
      const { base } = await readBody(req);
      let member;
      try {
        member = addExtraMember(base);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      hub.emit('event', { type: 'agents', agents: AGENTS });
      return send(res, 200, { member });
    }
    if (method === 'DELETE' && AGENTS[parts[2]]?.base) {
      const id = parts[2];
      // 和它的单聊删不了成员（删了就没人了）：先让老板自己删掉那个单聊
      const solo = store.listRooms().find((r) => r.members.length === 1 && r.members[0] === id);
      if (solo) return send(res, 400, { error: tr('还有和 {name} 的单聊「{room}」，先把那个单聊删掉再删 {name}', { name: AGENTS[id].name, room: solo.name }) });
      hub.forgetMember(id); // 从所有群里请出去，记忆和进度清掉，聊天记录留着
      removeExtraMember(id);
      hub.emit('event', { type: 'agents', agents: AGENTS });
      hub.emitRooms();
      return send(res, 200, { ok: true });
    }
  }
  if (method === 'POST' && parts[0] === 'models' && parts[1] === 'check') {
    const { agent, id } = await readBody(req);
    const model = String(id || '').trim();
    if (!AGENTS[agent] || !/^[\w.:@/-]{1,80}$/.test(model)) return send(res, 400, { error: tr('模型名不对') });
    return send(res, 200, await probeModel(agent, model));
  }

  // 收纳组：新建（可以顺便把几个群放进去）、改名、解散（里面的群回到最外层）
  if (parts[0] === 'folders') {
    const emitFolders = () => {
      hub.emit('event', { type: 'folders', folders: store.listFolders() });
      hub.emitRooms();
    };
    // 自定义头像：颜色是第几种（0-7）、上面写的字（最多两个字或一个表情）、或者一张小图片（界面上已经缩成 160×160）。
    // 图片：image 传 data URL 是换新图；带上现在的 imageV 是留着原来那张；都不带就是去掉图片
    const folderAvatar = (v, folder) => {
      if (!v) return { avatar: null, image: null };
      const out = {};
      if (Number.isInteger(v.color) && v.color >= 0 && v.color < 8) out.color = v.color;
      const text = [...new Intl.Segmenter().segment(String(v.text || '').trim())].map((x) => x.segment).slice(0, 2).join(''); // 按字切，组合表情算一个
      if (text) out.text = text;
      let image = null;
      if (v.image) {
        if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v.image) || v.image.length > 400000) throw httpError(400, tr('头像图片不对，换一张试试'));
        image = v.image;
      } else if (v.imageV && v.imageV === folder?.avatar?.imageV) image = 'keep';
      return { avatar: out, image };
    };
    const folderName = (v) => {
      const name = String(v || '').trim().slice(0, 30);
      if (!name) throw httpError(400, tr('收纳组的名字不能为空'));
      return name;
    };
    if (method === 'POST' && !parts[1]) {
      const body = await readBody(req);
      const folder = store.createFolder(folderName(body.name));
      for (const id of Array.isArray(body.rooms) ? body.rooms : []) if (store.getRoom(id)) store.updateRoom(id, { folder: folder.id });
      emitFolders();
      return send(res, 201, { folder });
    }
    const folder = store.getFolder(parts[1]);
    if (!folder) return send(res, 404, { error: tr('这个收纳组不存在了') });
    // 头像图片：地址里带版本号，换了图地址就变，可以放心缓存
    if (method === 'GET' && parts[2] === 'avatar') {
      const hit = folder.avatar?.imageV && store.folderAvatarFile(folder.id, folder.avatar.imageV);
      if (!hit) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': hit.type, 'cache-control': 'private, max-age=31536000, immutable' });
      return fs.createReadStream(hit.file).pipe(res);
    }
    if (method === 'PATCH' && !parts[2]) {
      const body = await readBody(req);
      if (body.name !== undefined) store.renameFolder(folder.id, folderName(body.name));
      if (body.avatar !== undefined) {
        const { avatar, image } = folderAvatar(body.avatar, folder);
        store.setFolderAvatar(folder.id, avatar, image);
      }
      emitFolders();
      return send(res, 200, { folder });
    }
    if (method === 'DELETE' && !parts[2]) {
      store.deleteFolder(folder.id);
      emitFolders();
      return send(res, 200, { ok: true });
    }
  }
  if (parts[0] === 'rooms') {
    if (parts.length === 1 && method === 'POST') {
      const before = Object.keys(AGENTS).join();
      let room;
      try {
        room = store.createRoom(normalizeRoom(await readBody(req), true));
      } finally {
        pruneExtraMembers(before); // 建群失败时，刚开出来的多开成员也别留着
      }
      hub.notice(room.id, room.members.length > 1 ? tr('群聊已创建。项目文件夹：{cwd}', { cwd: room.cwd }) : tr('聊天已创建。项目文件夹：{cwd}', { cwd: room.cwd }));
      hub.emitRooms();
      return send(res, 201, { room });
    }
    const room = store.getRoom(parts[1]);
    if (!room) return send(res, 404, { error: tr('群聊不存在') });
    const sub = parts[2];
    if (!sub && method === 'PATCH') {
      const before = Object.keys(AGENTS).join();
      let patch;
      try {
        patch = normalizeRoom(await readBody(req), false, room);
      } catch (err) {
        pruneExtraMembers(before);
        throw err;
      }
      const cwdChanged = patch.cwd && patch.cwd !== room.cwd;
      for (const a of room.members) if (patch.members && !patch.members.includes(a)) hub.stop(room.id, a);
      const switched = patch.models
        ? Object.keys(AGENTS).filter((a) => (patch.members || room.members).includes(a) && (patch.models[a] || '') !== (room.models?.[a] || ''))
        : [];
      const effortSwitched = patch.efforts
        ? Object.keys(AGENTS).filter((a) => (patch.members || room.members).includes(a) && (patch.efforts[a] || '') !== (room.efforts?.[a] || ''))
        : [];
      // 私聊里的设置：改之前每位实际用的是什么，改完对比，提示只发在私聊里
      // （复制一份：保存时房间对象会被原地改掉）
      const dmBefore = Object.fromEntries(
        room.members.map((a) => {
          const r = dmRoom(room, a);
          return [a, { models: { ...r.models }, efforts: { ...r.efforts }, fast: { ...r.fast }, own: !!room.dmSettings?.[a] }];
        }),
      );
      const fastSwitched = patch.fast
        ? Object.keys(ROOM_DEFAULTS.fast).filter((a) => (patch.members || room.members).includes(a) && !!patch.fast[a] !== !!room.fast?.[a])
        : [];
      store.updateRoom(room.id, patch);
      pruneExtraMembers(before);
      // 什么时候生效（「，下一轮开始生效」这样的半句，拼在提示后面）
      const when = (a) => (hub.runs.has(hub.key(room.id, a)) ? tr('，它手上这一轮做完后开始生效') : tr('，下一轮开始生效'));
      for (const a of switched) hub.notice(room.id, tr('{name} 换成了 {model}{when}', { name: AGENTS[a].name, model: modelName(a, patch.models[a]), when: when(a) }));
      for (const a of effortSwitched) hub.notice(room.id, tr('{name} 的思考强度换成了「{effort}」{when}', { name: AGENTS[a].name, effort: effortName(a, patch.efforts[a]), when: when(a) }));
      for (const a of fastSwitched) hub.notice(room.id, tr('{name} 换成了{speed}{when}', { name: AGENTS[a].name, speed: fastName(a, room.fast[a], room.models?.[a]), when: when(a) }));
      if (patch.dmSettings && room.members.length > 1) {
        for (const a of room.members) {
          const was = dmBefore[a];
          if (!was) continue; // 这次才加进群的成员：之前没有私聊设置可比，不用提示
          const now = dmRoom(room, a);
          const name = AGENTS[a].name;
          const tail = when(a) + tr('（只改私聊，群里不变）');
          if (!room.dmSettings[a] && was.own) hub.notice(room.id, tr('私聊里的 {name} 恢复成和群里一样的设置{when}', { name, when: when(a) }), a);
          else {
            if ((now.models[a] || '') !== (was.models[a] || '')) hub.notice(room.id, tr('私聊里的 {name} 换成了 {model}{when}', { name, model: modelName(a, now.models[a]), when: tail }), a);
            if ((now.efforts[a] || '') !== (was.efforts[a] || '')) hub.notice(room.id, tr('私聊里的 {name} 的思考强度换成了「{effort}」{when}', { name, effort: effortName(a, now.efforts[a]), when: tail }), a);
            if (!!now.fast?.[a] !== !!was.fast?.[a]) hub.notice(room.id, tr('私聊里的 {name} 换成了{speed}{when}', { name, speed: fastName(a, now.fast[a], now.models[a]), when: tail }), a);
          }
        }
      }
      if (cwdChanged) {
        hub.resetSessions(room.id);
        hub.notice(room.id, tr('项目文件夹改成了：{cwd}', { cwd: patch.cwd }));
      }
      hub.emitRooms();
      return send(res, 200, { room });
    }
    if (!sub && method === 'DELETE') {
      const oldSessions = Object.values(store.getState(room.id).sessions);
      hub.stop(room.id);
      store.deleteRoom(room.id);
      hub.removeGrok(room); // Grok 的记忆目录跟着群一起删
      hub.cleanupCodexUsage(oldSessions);
      pruneExtraMembers();
      hub.emitRooms();
      return send(res, 200, { ok: true });
    }
    // 某条回复的干活过程（分页取消息时不带，点开「过程」时再要）
    if (sub === 'messages' && parts[4] === 'steps' && method === 'GET') {
      const seq = Number(parts[3]);
      const m = store.getMessages(room.id).find((x) => x.seq === seq);
      if (!m || m.lost) return send(res, 404, { error: tr('这条消息找不到了') });
      return send(res, 200, { steps: m.steps || [] });
    }
    // 聊天记录。不带参数：全部（以前的界面用）。带 limit / before / around：只取一段，干活过程换成步数（stepCount），
    // 大群打开时不用一次传几 MB。before：这条之前的；around：这条前后的（从搜索跳过去）
    if (sub === 'messages' && !parts[3] && method === 'GET') {
      const q = url.searchParams;
      // conv：只取某一个会话的（g 群里、d:<成员> 和它的私聊，算法和搜索里的 convOf 一样），私聊翻页不会被群消息挤掉
      const conv = q.get('conv');
      const convOf = (m) => (m.dm ? `d:${m.dm}` : m.pm ? `d:${m.pmIn || m.pm}` : 'g');
      const all = store.getMessages(room.id).filter((m) => !m.lost && (!conv || convOf(m) === conv));
      if (!q.has('limit') && !q.has('before') && !q.has('around')) return send(res, 200, { messages: all });
      const limit = Math.min(1000, Math.max(1, Math.round(Number(q.get('limit'))) || 150));
      const at = (seq) => {
        const i = all.findIndex((m) => m.seq >= seq);
        return i < 0 ? all.length : i;
      };
      let start;
      let end;
      if (q.has('around')) {
        const i = at(Number(q.get('around')));
        start = Math.max(0, i - Math.floor(limit / 2));
        end = Math.min(all.length, start + limit);
        start = Math.max(0, end - limit);
      } else {
        end = q.has('before') ? at(Number(q.get('before'))) : all.length;
        start = Math.max(0, end - limit);
      }
      const light = (m) => {
        if (!m.steps) return m;
        const { steps, ...rest } = m;
        return { ...rest, stepCount: steps.length };
      };
      return send(res, 200, { messages: all.slice(start, end).map(light), hasEarlier: start > 0, hasLater: end < all.length });
    }
    // 清空聊天记录（forget：连 AI 的记忆也清掉）
    if (sub === 'clear' && method === 'POST') {
      hub.clearRoom(room.id, !!(await readBody(req)).forget);
      return send(res, 200, { ok: true });
    }
    if (sub === 'messages' && method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      const ids = Array.isArray(body.images) ? body.images.slice(0, 20) : [];
      const images = [];
      for (const id of ids) {
        if (!UPLOAD_NAME_RE.test(String(id)) || !fs.existsSync(path.join(store.uploadsDir(room.id), id))) {
          return send(res, 400, { error: tr('有图片没上传成功，请重新添加') });
        }
        images.push({ id, type: MIME[path.extname(id)] });
      }
      if (!text && !images.length) return send(res, 400, { error: tr('消息是空的') });
      const dm = AGENTS[body.dm] && room.members.includes(body.dm) ? body.dm : null;
      // 回复：只能回复同一个会话里的消息（群里回群里的，私聊里回私聊的），存一段原话摘要
      let replyTo = null;
      if (body.replyTo !== undefined && body.replyTo !== null) {
        const target = store.getMessages(room.id)[Number(body.replyTo)];
        const sameConv = target && (target.pm ? !!dm && (target.pmIn || target.pm) === dm : (target.dm || null) === (room.members.length > 1 ? dm : null));
        if (!target || target.from === 'system' || !sameConv) return send(res, 400, { error: tr('要回复的消息找不到了') });
        replyTo = { seq: target.seq, from: target.from, text: (target.text || (target.images?.length ? tr('[图片]') : '')).slice(0, 140) };
      }
      // 编辑：老板改了自己之前的一条消息，作为新消息发出去，并注明改的是哪条（大家已经看过原来那条了，没法真的改掉）
      let editOf = null;
      if (body.editOf !== undefined && body.editOf !== null) {
        const target = store.getMessages(room.id)[Number(body.editOf)];
        const sameConv = target && (target.dm || null) === (room.members.length > 1 ? dm : null);
        if (!target || target.from !== 'user' || !sameConv) return send(res, 400, { error: tr('要修改的消息找不到了') });
        editOf = { seq: target.seq, text: (target.text || (target.images?.length ? tr('[图片]') : '')).slice(0, 140) };
      }
      hub.postUserMessage(room.id, text, images, dm, replyTo, editOf);
      return send(res, 200, { ok: true });
    }
    if (sub === 'uploads' && !parts[3] && method === 'POST') return send(res, 201, await saveUpload(room, req));
    if (sub === 'uploads' && parts[3] && method === 'GET') {
      const name = parts[3];
      if (!UPLOAD_NAME_RE.test(name)) return send(res, 404, { error: 'not found' });
      return fs.readFile(path.join(store.uploadsDir(room.id), name), (err, data) => {
        if (err) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME[path.extname(name)], 'cache-control': 'private, max-age=31536000, immutable' });
        res.end(data);
      });
    }
    if (sub === 'stop' && method === 'POST') {
      const { agent, only } = await readBody(req);
      hub.stop(room.id, AGENTS[agent] ? agent : undefined, ['side', 'main'].includes(only) ? only : null);
      return send(res, 200, { ok: true });
    }
    // 换新会话：正在干活就把这一轮换个新会话重来；空着就直接换。by 是老板选的谁来交代情况（某位 AI、self 它自己看记录、boss 老板自己来）
    if (sub === 'fresh' && method === 'POST') {
      const { agent, by } = await readBody(req);
      if (!AGENTS[agent] || !room.members.includes(agent)) return send(res, 400, { error: tr('群里没有这位') });
      const pick = ['self', 'boss'].includes(by) || (room.members.includes(by) && by !== agent) ? by : undefined;
      return send(res, 200, { ok: true, result: hub.resetAgent(room.id, agent, pick) });
    }
    // 「换新会话」弹窗打开时问一下：默认请谁来交代
    if (sub === 'fresh' && method === 'GET') {
      const agent = url.searchParams.get('agent');
      if (!AGENTS[agent] || !room.members.includes(agent)) return send(res, 400, { error: tr('群里没有这位') });
      return send(res, 200, { briefer: hub.suggestBriefer(room.id, agent) });
    }
    // 每位现在的会话：有没有、在不在干活、记了多少（上下文用了多少、上限多少，ChatGPT 还有存着的图片），群设置里显示，方便判断要不要换新会话
    if (sub === 'sessions' && method === 'GET') {
      const state = store.getState(room.id);
      const sessions = {};
      for (const a of room.members) {
        const id = state.sessions[a] || null;
        const u = id ? await sessionUsage(a, id) : null;
        sessions[a] = { has: !!id, busy: hub.runs.has(hub.key(room.id, a)), images: u?.images || 0, used: u?.used || 0, window: u?.window || 0 };
      }
      return send(res, 200, { sessions });
    }
    if (sub === 'open-folder' && method === 'POST') {
      openPath(room.cwd);
      return send(res, 200, { ok: true });
    }
    // 上次退出时被打断的活：老板点了「让它接着做」
    if (sub === 'resume' && method === 'POST') {
      const { agents } = await readBody(req);
      const list = (Array.isArray(agents) ? agents : []).filter((a) => AGENTS[a] && room.members.includes(a));
      for (const a of list) hub.wake(room.id, a);
      return send(res, 200, { ok: true });
    }
    // 把某位在私聊里的回复转到群里（老板点了「发到群里」）
    if (sub === 'forward' && method === 'POST') {
      const { seq } = await readBody(req);
      if (!hub.forwardToGroup(room.id, Number(seq))) return send(res, 400, { error: tr('这条消息转不了') });
      return send(res, 200, { ok: true });
    }
    // 消息里提到的文件哪些找得到：找不到的，界面上就不显示成能点的样子
    if (sub === 'exists' && method === 'POST') {
      const { items } = await readBody(req);
      const list = Array.isArray(items) ? items.slice(0, 400) : [];
      const found = [];
      for (const it of list) found.push(!!(await roomFile(room, it?.path, Array.isArray(it?.near) ? it.near : [])));
      return send(res, 200, { found });
    }
    if (sub === 'reveal' && method === 'POST') {
      const body = await readBody(req);
      const file = await roomFile(room, body.path, Array.isArray(body.near) ? body.near : []);
      if (!file) return send(res, 404, { error: tr('找不到这个文件，可能已经被移走或删掉了') });
      if (fs.statSync(file).isDirectory()) openPath(file); // 文件夹直接打开，进到里面
      else revealPath(file);
      return send(res, 200, { ok: true });
    }
    // 读本机的图片给缩略图用：只认 ClawChat 自己页面发来的请求（别的网站用 <img> 嵌进来时浏览器会标成跨站），只给图片
    if (sub === 'preview' && method === 'GET') {
      const site = req.headers['sec-fetch-site'];
      if (site && !['same-origin', 'none'].includes(site)) return send(res, 403, { error: 'forbidden' });
      const file = await roomFile(room, url.searchParams.get('path'), url.searchParams.getAll('near'));
      const type = file && PREVIEW_MIME[path.extname(file).toLowerCase()];
      if (!type) return send(res, 404, { error: 'not found' });
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 50 * 1024 * 1024) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(file).pipe(res);
    }
  }
  return send(res, 404, { error: tr('没有这个接口') });
}

function serveStatic(res, pathname) {
  let file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
  // 应用图标是 Mac 打包时生成的；没打过包（比如 Windows）就用仓库里自带的那张
  if (pathname === '/app-icon.png' && !fs.existsSync(file)) file = path.join(PUBLIC, 'favicon.png');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // 只接受本机地址访问，防止别的网页借浏览器调用这个服务；打开了手机访问的话，老板自己 Tailscale 账号的设备也能进来
    const access = requestAccess(req, PORT);
    if (!access) return send(res, 403, { error: 'forbidden' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers['x-clawchat'] !== '1') return send(res, 403, { error: 'forbidden' });
      return await api(req, res, url, access);
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    if (url.pathname === '/i18n-dict.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(dictScript());
    }
    return serveStatic(res, url.pathname);
  } catch (err) {
    if (!res.headersSent) send(res, err.status || 500, { error: err.message });
  }
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `端口 ${PORT} 被占用了，ClawChat 可能已经在运行。` : err);
  process.exit(1);
});

// 日志里只记一行摘要（整份模型清单有好几千字，每次启动都记一遍太啰嗦）
function engineSummary() {
  const one = (label, e) => {
    if (!e?.path) return `${label} 没装`;
    const n = e.models?.length ? `（${e.models.length} 个模型）` : '';
    return `${label} ${String(e.version || '').match(/\d+\.\d+[\w.-]*/)?.[0] || '?'}${n}${e.ok ? '' : `，${e.error || '用不了'}`}`;
  };
  const ds = engines.deepseek;
  const deepseek = !ds?.hasKey ? 'DeepSeek 没填 Key' : `DeepSeek（借 Claude Code，${ds.models?.length || 0} 个模型）${ds.ok ? '' : `，${ds.error || '用不了'}`}`;
  const glm = !engines.glm?.hasKey ? 'GLM 没填 Key' : `GLM（借 Claude Code，${engines.glm.models?.length || 0} 个模型）${engines.glm.ok ? '' : `，${engines.glm.error || '用不了'}`}`;
  const gem = engines.gemini;
  const gemini = !gem?.path ? 'Gemini 没装' : `Gemini（${gem.cli === 'agy' ? 'Antigravity 订阅' : 'Gemini CLI API'} ${gem.version || '?'}）${gem.ok ? '' : `，${gem.error || '用不了'}`}`;
  const gk = engines.grok;
  const grok = !gk?.path ? 'Grok 没装' : `Grok Build ${String(gk.version || '').match(/\d+\.\d+[\w.-]*/)?.[0] || '?'}（${gk.loggedIn ? '已登录' : '没登录'}）${gk.ok ? '' : `，${gk.error || '用不了'}`}${gk.apiKeyWarning ? '，配了 API Key' : ''}`;
  return [one('Claude Code', engines.claude), one('Codex', engines.codex), deepseek, glm, gemini, grok].join(' · ');
}

// 上次升级后新版本没能启动、重启脚本已经退回原来的版本：告诉界面（只说一次）
const updateRollback = takeRollback();
if (updateRollback) console.error(`[clawchat] 升级到 ${updateRollback.toVersion || updateRollback.to} 后没能启动，已经退回 ${updateRollback.fromVersion || updateRollback.from}`);
for (const file of recovered) console.error(`[clawchat] 用备份恢复了 ${file}`);

setupPath();
server.listen(PORT, HOST, () => {
  console.log(`[clawchat] 已启动：http://${HOST}:${PORT}  数据目录：${DATA_DIR}`);
  initRemote();
  // 传上来、最后没发出去的图片：启动一分钟后清一次（放了一天以上的）
  setTimeout(() => {
    try {
      const n = store.pruneUploads();
      if (n) console.log(`[clawchat] 清掉了 ${n} 张没发出去的图片`);
    } catch (err) {
      console.error('[clawchat] 清理图片失败', err);
    }
  }, 60 * 1000).unref();
  hub.noticeInterrupted();
  pruneExtraMembers(); // 以前在设置里开了、但哪个群都没用上的多开成员
  ensureIcons();
  refreshEngines().then(() => console.log(`[clawchat] 程序：${engineSummary()}`));
  setInterval(refreshEngines, 5 * 60 * 1000); // 定时重新读模型目录：出了新模型不用重启就能看到
});

// 重新检测各位的版本和模型列表，有变化就推给界面。force：等正在进行的那次查完再查一次（比如刚换了 Key）
let refreshing = null;
let refreshedAt = 0;
async function refreshEngines(force = false) {
  if (refreshing && force) await refreshing;
  if (refreshing) return refreshing;
  refreshing = detectEngines()
    .then((next) => {
      refreshedAt = Date.now();
      if (JSON.stringify(next) !== JSON.stringify(engines)) {
        engines = next;
        hub.emit('event', { type: 'engines', engines });
      }
    })
    .catch((err) => console.error('[clawchat] 检测引擎失败', err))
    .finally(() => (refreshing = null));
  return refreshing;
}

// 重启：马上重启时，正在干的活记成「被打断」，重启后自动接着做。
// 等大家干完再重启（pendingRestart 是 'update' 或 'restart'）：每次有人干完都看一眼是不是全空了
// （空下来后再等两秒：一位干完、下一位被叫醒之间有一小段空当）
let pendingRestart = false;
let pendingTimer = null;
const allIdle = () => !hub.runs.size && !hub.sideRuns.size;

function restartNow() {
  pendingRestart = false;
  hub.restarting = true;
  hub.emit('event', { type: 'restarting' });
  scheduleRestart(shutdown);
}

function waitForIdle(kind) {
  pendingRestart = kind;
  hub.emit('event', { type: 'restart-pending', waiting: kind });
  return true;
}

async function restartWhenIdle() {
  const kind = pendingRestart;
  if (!kind || !allIdle()) return;
  if (kind === 'update') {
    pendingRestart = false;
    const result = await pullUpdate().catch((err) => ({ ok: false, error: err.message }));
    if (!result.ok || !result.updated) {
      hub.emit('event', { type: 'restart-pending', waiting: false, error: result.ok ? tr('已经是最新版了') : result.error || tr('更新失败') });
      return;
    }
  }
  restartNow();
}

hub.on('event', (ev) => {
  if (ev.type !== 'status' || !pendingRestart || !allIdle()) return;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(restartWhenIdle, 2000);
});

function shutdown() {
  hub.shutdown();
  for (const res of clients) res.end();
  server.close();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// 兜底：哪里漏接了的错误。服务的状态可能已经不对了，不硬撑着接着跑：记进日志，正在干的活记成「被打断」，
// 然后重启（重启后自动接着做）。十分钟里连着出了三次就不再重启，免得一直重启
let crashing = false;
function fatal(kind, err) {
  console.error(`[clawchat] ${kind}`, err);
  if (crashing) return;
  crashing = true;
  const file = path.join(DATA_DIR, 'crashes.json');
  let recent = [];
  try {
    recent = JSON.parse(fs.readFileSync(file, 'utf8')).filter((t) => Date.now() - t < 10 * 60 * 1000);
  } catch {}
  recent.push(Date.now());
  try {
    fs.writeFileSync(file, JSON.stringify(recent));
  } catch {}
  try {
    if (recent.length > 3) {
      console.error('[clawchat] 十分钟里连着出错，不再自动重启');
      shutdown();
    } else restartNow();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
process.on('uncaughtException', (err) => fatal('没接住的错误', err));
process.on('unhandledRejection', (err) => fatal('没接住的 Promise 错误', err));
