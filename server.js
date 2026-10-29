import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, ROOM_DEFAULTS, DATA_DIR, saveConfig } from './lib/store.js';
import { Hub, dmRoom } from './lib/hub.js';
import { AGENTS, IS_WIN, setupPath, detectEngines, probeModel, updateEngine, deepseekModels, sessionImageBytes } from './lib/agents.js';
import { appInfo, checkUpdate, pullUpdate, scheduleRestart } from './lib/updater.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.CLAWCHAT_PORT) || 7317;
const HOST = '127.0.0.1';
const PROJECTS_DIR = path.join(os.homedir(), 'ClawChatProjects');

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
        reject(httpError(413, '图片太大了（最大 25MB）'));
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
  if (!ext) throw httpError(415, '只支持图片（PNG、JPG、GIF、WebP、HEIC）');
  if (IS_WIN && !DIRECT_EXT.has(ext)) throw httpError(415, '这种图片格式（比如 HEIC）在 Windows 上转换不了，请先另存成 JPG 或 PNG 再发');
  const buf = await readRaw(req, MAX_UPLOAD);
  if (!buf.length) throw httpError(400, '图片是空的');
  if (IS_WIN && buf.length > MAX_DIRECT_WIN) throw httpError(413, '图片太大了，请压缩到 5MB 以内再发');
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
      throw httpError(400, '这张图片处理不了，换一张试试');
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

const AGENT_ENGINE = { claude: 'claude', gpt: 'codex', deepseek: 'deepseek' };
const EFFORT_LABEL = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极限' };

// 某位在某个模型下能选哪些思考强度：Claude 固定那几档；Codex、DeepSeek 看模型目录（「默认」就看默认模型）
function effortsFor(agent, modelId) {
  if (agent === 'claude') return engines.claude?.efforts || [];
  const e = engines[AGENT_ENGINE[agent]] || {};
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
  return on ? `快速模式（${speed ? `约 ${speed} 倍速，` : ''}额度按 2.5 倍消耗）` : '标准速度';
}

function effortName(agent, id) {
  if (id) return EFFORT_LABEL[id] || id;
  const def = engines[AGENT_ENGINE[agent]]?.defaultEffort;
  return `默认${def ? `（${EFFORT_LABEL[def] || def}）` : ''}`;
}

function modelName(agent, id) {
  const e = engines[AGENT_ENGINE[agent]] || {};
  if (!id) return `默认模型${e.defaultLabel ? `（${e.defaultLabel}）` : ''}`;
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
        reject(httpError(413, '消息太长了'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(httpError(400, '请求格式不对'));
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

function normalizeRoom(body, creating, room = null) {
  const out = {};
  if (body.members !== undefined || creating) {
    const members = Object.keys(AGENTS).filter((id) => (Array.isArray(body.members) ? body.members : Object.keys(AGENTS)).includes(id));
    if (!members.length) throw httpError(400, '至少要选一位成员');
    out.members = members;
    const target = body.defaultTarget ?? room?.defaultTarget;
    if (target && !['all', 'sequential'].includes(target) && !members.includes(target)) out.defaultTarget = 'all';
  }
  if (body.name !== undefined || creating) {
    let name = String(body.name || '').trim().slice(0, 40);
    if (!name && out.members?.length === 1) name = AGENTS[out.members[0]].label; // 单聊默认用对方的名字
    if (!name) throw httpError(400, '名字不能为空');
    out.name = name;
  }
  if (body.cwd !== undefined || creating) {
    let cwd = String(body.cwd || '').trim();
    if (!cwd) cwd = path.join(PROJECTS_DIR, safeName(out.name));
    cwd = path.resolve(expandHome(cwd));
    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch (err) {
      throw httpError(400, `项目文件夹建不了：${err.message}`);
    }
    if (!fs.statSync(cwd).isDirectory()) throw httpError(400, '项目文件夹路径不是文件夹');
    out.cwd = cwd;
  }
  if (body.permission !== undefined) {
    if (!['project', 'full', 'readonly'].includes(body.permission)) throw httpError(400, '权限设置不对');
    out.permission = body.permission;
  }
  if (body.collab !== undefined) out.collab = !!body.collab;
  if (body.maxAutoTurns !== undefined) {
    const n = Math.round(Number(body.maxAutoTurns));
    out.maxAutoTurns = Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : ROOM_DEFAULTS.maxAutoTurns;
  }
  if (body.defaultTarget !== undefined) {
    if (!['all', 'sequential', ...Object.keys(AGENTS)].includes(body.defaultTarget)) throw httpError(400, '默认接话人设置不对');
    out.defaultTarget = body.defaultTarget;
  }
  if (body.models !== undefined) {
    out.models = {};
    for (const a of Object.keys(AGENTS)) out.models[a] = String(body.models?.[a] || '').trim().slice(0, 80);
    // 列表外的模型只能走「自定义模型」：界面上先试过能用，才会带着 custom 标记提交
    const custom = Array.isArray(body.custom) ? body.custom : [];
    const keep = (agent) => (room?.models?.[agent] || '') === out.models[agent]; // 原来就在用的不重新校验
    const owner = { claude: 'Claude', gpt: '当前的 Codex', deepseek: 'DeepSeek' };
    for (const a of Object.keys(AGENTS)) {
      if (!custom.includes(a) && !keep(a) && !validModel(AGENT_ENGINE[a], out.models[a])) {
        throw httpError(400, `${owner[a]}用不了 ${out.models[a]} 这个模型，请从列表里选一个`);
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
        if (body.efforts?.[a] !== undefined) throw httpError(400, `${AGENTS[a].name} 现在的模型不支持「${EFFORT_LABEL[efforts[a]] || efforts[a]}」`);
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
        if (body.fast?.[a]) throw httpError(400, `${AGENTS[a].name} 现在的模型没有快速模式`);
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
        if (!custom.includes(a) && m !== cur.model && !validModel(AGENT_ENGINE[a], m)) throw httpError(400, `${AGENTS[a].name} 用不了 ${m} 这个模型，请从列表里选一个`);
        cur.model = m;
      }
      const model = cur.model ?? groupModels[a];
      if (v.effort !== undefined) cur.effort = String(v.effort || '').trim();
      const allowed = effortsFor(a, model);
      if (cur.effort && allowed.length && !allowed.includes(cur.effort)) {
        if (v.effort !== undefined) throw httpError(400, `${AGENTS[a].name} 现在的模型不支持「${EFFORT_LABEL[cur.effort] || cur.effort}」`);
        cur.effort = ''; // 换了模型、新模型不支持原来的强度：退回默认
      }
      if (v.fast !== undefined) cur.fast = !!v.fast;
      if (cur.fast && !fastFor(a, model)) {
        if (v.fast) throw httpError(400, `${AGENTS[a].name} 现在的模型没有快速模式`);
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
const PICK_FOLDER_PS = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'CenterScreen'; Size = New-Object System.Drawing.Size(1, 1) }
$owner.Show(); $owner.Activate()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{ Description = '选择项目文件夹'; ShowNewFolderButton = $true }
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)) }
$owner.Close()
`;

function pickFolder() {
  if (IS_WIN) {
    const encoded = Buffer.from(PICK_FOLDER_PS, 'utf16le').toString('base64');
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
      ['-e', 'activate', '-e', 'POSIX path of (choose folder with prompt "选择项目文件夹")'],
      { timeout: 10 * 60 * 1000 },
      (err, stdout) => resolve(err ? null : stdout.trim().replace(/\/$/, '') || null),
    );
  });
}

// DeepSeek 的头像：从 DeepSeek 官方 GitHub 账号下载一份存在本机（和 Claude、GPT 的图标一样，不放进代码仓库）。
// Mac 打包、Windows 安装时也会下载；这里是兜底。下载不到就用界面里内置的简笔头像
const DEEPSEEK_ICON_URL = 'https://avatars.githubusercontent.com/u/148330874?s=256';
async function ensureDeepseekIcon() {
  const file = path.join(PUBLIC, 'icons', 'deepseek.png');
  if (fs.existsSync(file)) return;
  try {
    const res = await fetch(DEEPSEEK_ICON_URL, { signal: AbortSignal.timeout(20000) });
    const buf = Buffer.from(await res.arrayBuffer());
    const png = buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    if (!res.ok || !png || buf.length > 2 * 1024 * 1024) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    hub.emit('event', { type: 'icons' }); // 已经打开的窗口换上新头像
  } catch {}
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

// 消息、过程里提到的文件：相对路径按项目文件夹算，~ 开头的按家目录；不存在返回 null
function roomFile(room, p) {
  p = String(p || '').trim();
  if (!p || p.length > 1000) return null;
  const abs = path.resolve(room.cwd, expandHome(p));
  return fs.existsSync(abs) ? abs : null;
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

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  const method = req.method;

  if (method === 'GET' && parts[0] === 'health') return send(res, 200, { ok: true });
  // 搜聊天内容：所有群、私聊里的消息，最新的在前；每条只带命中位置前后的一小段
  if (method === 'GET' && parts[0] === 'search') {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
    if (!q) return send(res, 200, { hits: [] });
    const hits = [];
    for (const room of store.listRooms()) {
      const msgs = store.getMessages(room.id);
      let found = 0;
      for (let i = msgs.length - 1; i >= 0 && found < 50; i--) {
        const m = msgs[i];
        if (m.from === 'system' || !m.text) continue;
        const at = m.text.toLowerCase().indexOf(q);
        if (at < 0) continue;
        found++;
        const start = Math.max(0, at - 30);
        hits.push({ roomId: room.id, seq: m.seq, from: m.from, dm: m.dm || null, ts: m.ts, text: m.text.slice(start, at + q.length + 90), cut: start > 0 });
      }
    }
    hits.sort((a, b) => b.ts - a.ts);
    return send(res, 200, { hits: hits.slice(0, 60), more: hits.length > 60 });
  }
  if (method === 'GET' && parts[0] === 'events') return events(req, res);
  if (method === 'GET' && parts[0] === 'state') {
    return send(res, 200, {
      rooms: store.listRooms(),
      runs: hub.status(true),
      engines,
      agents: AGENTS,
      defaults: ROOM_DEFAULTS,
      projectsDir: PROJECTS_DIR,
      platform: process.platform,
      inApp: process.env.CLAWCHAT_APP === '1',
    });
  }
  if (method === 'POST' && parts[0] === 'pick-folder') return send(res, 200, { path: await pickFolder() });
  if (parts[0] === 'app') {
    if (method === 'GET' && !parts[1]) return send(res, 200, { ...(await appInfo()), dataDir: DATA_DIR, projectsDir: PROJECTS_DIR });
    if (method === 'POST' && parts[1] === 'check-update') return send(res, 200, await checkUpdate());
    if (method === 'POST' && parts[1] === 'update') {
      const result = await pullUpdate();
      if (result.ok && result.updated) {
        hub.emit('event', { type: 'restarting' });
        scheduleRestart(shutdown); // 正在干的活会在退出时记成「被打断」，重新打开后可以接着做
      }
      return send(res, 200, result);
    }
    if (method === 'POST' && parts[1] === 'restart') {
      hub.emit('event', { type: 'restarting' });
      scheduleRestart(shutdown);
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
  if (method === 'POST' && parts[0] === 'engines' && parts[1] === 'update') {
    // DeepSeek 用的就是 Claude Code，更新它就是更新 Claude Code
    const { engine } = await readBody(req);
    if (!['claude', 'codex'].includes(engine)) return send(res, 400, { error: '不认识这个程序' });
    const result = await updateEngine(engine);
    await refreshEngines();
    return send(res, 200, { ...result, engines });
  }
  // DeepSeek 的 API Key：先用它读一次模型目录，Key 不对就不存；空的就是删掉。Key 只存在本机，不会再发回界面
  if (method === 'POST' && parts[0] === 'deepseek' && parts[1] === 'key') {
    const key = String((await readBody(req)).key || '').trim();
    if (key && !/^[\x21-\x7e]{8,200}$/.test(key)) return send(res, 400, { error: '这不像 DeepSeek 的 API Key（一般是 sk- 开头的一串字母数字）' });
    let warning = '';
    if (key) {
      const check = await deepseekModels(key);
      if (check.badKey) return send(res, 400, { error: 'DeepSeek 说这个 API Key 不对，请检查一下有没有复制完整' });
      if (check.error) warning = `已保存，但现在${check.error}，等网络好了会自动用上`;
    }
    saveConfig({ deepseekKey: key });
    await refreshEngines(true);
    return send(res, 200, { ok: true, warning, engines });
  }
  if (method === 'POST' && parts[0] === 'models' && parts[1] === 'check') {
    const { agent, id } = await readBody(req);
    const model = String(id || '').trim();
    if (!AGENTS[agent] || !/^[\w.:@/-]{1,80}$/.test(model)) return send(res, 400, { error: '模型名不对' });
    return send(res, 200, await probeModel(agent, model));
  }

  if (parts[0] === 'rooms') {
    if (parts.length === 1 && method === 'POST') {
      const room = store.createRoom(normalizeRoom(await readBody(req), true));
      hub.notice(room.id, `${room.members.length > 1 ? '群聊' : '聊天'}已创建。项目文件夹：${room.cwd}`);
      hub.emitRooms();
      return send(res, 201, { room });
    }
    const room = store.getRoom(parts[1]);
    if (!room) return send(res, 404, { error: '群聊不存在' });
    const sub = parts[2];
    if (!sub && method === 'PATCH') {
      const patch = normalizeRoom(await readBody(req), false, room);
      const cwdChanged = patch.cwd && patch.cwd !== room.cwd;
      for (const a of room.members) if (patch.members && !patch.members.includes(a)) hub.stop(room.id, a);
      const switched = patch.models
        ? Object.keys(AGENT_ENGINE).filter((a) => (patch.members || room.members).includes(a) && (patch.models[a] || '') !== (room.models?.[a] || ''))
        : [];
      const effortSwitched = patch.efforts
        ? Object.keys(AGENT_ENGINE).filter((a) => (patch.members || room.members).includes(a) && (patch.efforts[a] || '') !== (room.efforts?.[a] || ''))
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
      const when = (a) => (hub.runs.has(hub.key(room.id, a)) ? '，它手上这一轮做完后' : '，下一轮');
      for (const a of switched) hub.notice(room.id, `${AGENTS[a].name} 换成了 ${modelName(a, patch.models[a])}${when(a)}开始生效`);
      for (const a of effortSwitched) hub.notice(room.id, `${AGENTS[a].name} 的思考强度换成了「${effortName(a, patch.efforts[a])}」${when(a)}开始生效`);
      for (const a of fastSwitched) hub.notice(room.id, `${AGENTS[a].name} 换成了${fastName(a, room.fast[a], room.models?.[a])}${when(a)}开始生效`);
      if (patch.dmSettings && room.members.length > 1) {
        for (const a of room.members) {
          const was = dmBefore[a];
          const now = dmRoom(room, a);
          const tail = `${when(a)}开始生效（只改私聊，群里不变）`;
          if (!room.dmSettings[a] && was.own) hub.notice(room.id, `私聊里的 ${AGENTS[a].name} 恢复成和群里一样的设置${when(a)}开始生效`, a);
          else {
            if ((now.models[a] || '') !== (was.models[a] || '')) hub.notice(room.id, `私聊里的 ${AGENTS[a].name} 换成了 ${modelName(a, now.models[a])}${tail}`, a);
            if ((now.efforts[a] || '') !== (was.efforts[a] || '')) hub.notice(room.id, `私聊里的 ${AGENTS[a].name} 的思考强度换成了「${effortName(a, now.efforts[a])}」${tail}`, a);
            if (!!now.fast?.[a] !== !!was.fast?.[a]) hub.notice(room.id, `私聊里的 ${AGENTS[a].name} 换成了${fastName(a, now.fast[a], now.models[a])}${tail}`, a);
          }
        }
      }
      if (cwdChanged) {
        hub.resetSessions(room.id);
        hub.notice(room.id, `项目文件夹改成了：${patch.cwd}`);
      }
      hub.emitRooms();
      return send(res, 200, { room });
    }
    if (!sub && method === 'DELETE') {
      hub.stop(room.id);
      store.deleteRoom(room.id);
      hub.emitRooms();
      return send(res, 200, { ok: true });
    }
    if (sub === 'messages' && method === 'GET') return send(res, 200, { messages: store.getMessages(room.id) });
    if (sub === 'messages' && method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      const ids = Array.isArray(body.images) ? body.images.slice(0, 20) : [];
      const images = [];
      for (const id of ids) {
        if (!UPLOAD_NAME_RE.test(String(id)) || !fs.existsSync(path.join(store.uploadsDir(room.id), id))) {
          return send(res, 400, { error: '有图片没上传成功，请重新添加' });
        }
        images.push({ id, type: MIME[path.extname(id)] });
      }
      if (!text && !images.length) return send(res, 400, { error: '消息是空的' });
      const dm = AGENTS[body.dm] && room.members.includes(body.dm) ? body.dm : null;
      // 回复：只能回复同一个会话里的消息（群里回群里的，私聊里回私聊的），存一段原话摘要
      let replyTo = null;
      if (body.replyTo !== undefined && body.replyTo !== null) {
        const target = store.getMessages(room.id)[Number(body.replyTo)];
        const sameConv = target && (target.dm || null) === (room.members.length > 1 ? dm : null);
        if (!target || target.from === 'system' || !sameConv) return send(res, 400, { error: '要回复的消息找不到了' });
        replyTo = { seq: target.seq, from: target.from, text: (target.text || (target.images?.length ? '[图片]' : '')).slice(0, 140) };
      }
      // 编辑：老板改了自己之前的一条消息，作为新消息发出去，并注明改的是哪条（大家已经看过原来那条了，没法真的改掉）
      let editOf = null;
      if (body.editOf !== undefined && body.editOf !== null) {
        const target = store.getMessages(room.id)[Number(body.editOf)];
        const sameConv = target && (target.dm || null) === (room.members.length > 1 ? dm : null);
        if (!target || target.from !== 'user' || !sameConv) return send(res, 400, { error: '要修改的消息找不到了' });
        editOf = { seq: target.seq, text: (target.text || (target.images?.length ? '[图片]' : '')).slice(0, 140) };
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
    // 换新会话：正在干活就把这一轮换个新会话重来；空着就直接换。有 AI 给它派过活的，会先请那位重新交代情况
    if (sub === 'fresh' && method === 'POST') {
      const { agent } = await readBody(req);
      if (!AGENTS[agent] || !room.members.includes(agent)) return send(res, 400, { error: '群里没有这位' });
      return send(res, 200, { ok: true, result: hub.resetAgent(room.id, agent) });
    }
    // 每位现在的会话：有没有、在不在干活、GPT 的会话里存了多少图片（群设置里显示，方便判断要不要换新会话）
    if (sub === 'sessions' && method === 'GET') {
      const state = store.getState(room.id);
      const sessions = {};
      for (const a of room.members) {
        const id = state.sessions[a] || null;
        sessions[a] = { has: !!id, busy: hub.runs.has(hub.key(room.id, a)), images: id ? await sessionImageBytes(a, id) : 0 };
      }
      return send(res, 200, { sessions });
    }
    if (sub === 'open-folder' && method === 'POST') {
      openPath(room.cwd);
      return send(res, 200, { ok: true });
    }
    // 把某位在私聊里的回复转到群里（老板点了「发到群里」）
    if (sub === 'forward' && method === 'POST') {
      const { seq } = await readBody(req);
      if (!hub.forwardToGroup(room.id, Number(seq))) return send(res, 400, { error: '这条消息转不了' });
      return send(res, 200, { ok: true });
    }
    if (sub === 'reveal' && method === 'POST') {
      const file = roomFile(room, (await readBody(req)).path);
      if (!file) return send(res, 404, { error: '找不到这个文件，可能已经被移走或删掉了' });
      if (fs.statSync(file).isDirectory()) openPath(file); // 文件夹直接打开，进到里面
      else revealPath(file);
      return send(res, 200, { ok: true });
    }
    // 读本机的图片给缩略图用：只认 ClawChat 自己页面发来的请求（别的网站用 <img> 嵌进来时浏览器会标成跨站），只给图片
    if (sub === 'preview' && method === 'GET') {
      const site = req.headers['sec-fetch-site'];
      if (site && !['same-origin', 'none'].includes(site)) return send(res, 403, { error: 'forbidden' });
      const file = roomFile(room, url.searchParams.get('path'));
      const type = file && PREVIEW_MIME[path.extname(file).toLowerCase()];
      if (!type) return send(res, 404, { error: 'not found' });
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 50 * 1024 * 1024) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(file).pipe(res);
    }
  }
  return send(res, 404, { error: '没有这个接口' });
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
    // 只接受本机地址访问，防止别的网页借浏览器调用这个服务
    if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) return send(res, 403, { error: 'forbidden' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers['x-clawchat'] !== '1') return send(res, 403, { error: 'forbidden' });
      return await api(req, res, url);
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
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
  return [one('Claude Code', engines.claude), one('Codex', engines.codex), deepseek].join(' · ');
}

setupPath();
server.listen(PORT, HOST, () => {
  console.log(`[clawchat] 已启动：http://${HOST}:${PORT}  数据目录：${DATA_DIR}`);
  hub.noticeInterrupted();
  ensureDeepseekIcon();
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

function shutdown() {
  hub.shutdown();
  for (const res of clients) res.end();
  server.close();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
