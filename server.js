import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, ROOM_DEFAULTS, DATA_DIR } from './lib/store.js';
import { Hub } from './lib/hub.js';
import { AGENTS, setupPath, detectEngines, probeModel, updateEngine } from './lib/agents.js';
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
const UPLOAD_TYPES = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tiff', 'image/bmp': 'bmp',
};
const DIRECT_EXT = new Set(['png', 'jpg', 'gif', 'webp']);
const UPLOAD_NAME_RE = /^[a-f0-9]{16}s?\.(png|jpg|gif|webp)$/;
const MAX_UPLOAD = 25 * 1024 * 1024;

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
  const buf = await readRaw(req, MAX_UPLOAD);
  if (!buf.length) throw httpError(400, '图片是空的');
  const dir = store.uploadsDir(room.id);
  fs.mkdirSync(dir, { recursive: true });
  const base = crypto.randomBytes(8).toString('hex');
  let file = `${base}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  if (!DIRECT_EXT.has(ext) || buf.length > 3 * 1024 * 1024 || (await imageSize(path.join(dir, file))) > 4000) {
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

const AGENT_ENGINE = { claude: 'claude', gpt: 'codex' };
const EFFORT_LABEL = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极限' };

// 某位在某个模型下能选哪些思考强度：Claude 固定那几档；Codex 看模型目录（「默认」就看 Codex 的默认模型）
function effortsFor(agent, modelId) {
  if (agent === 'claude') return engines.claude?.efforts || [];
  const e = engines.codex || {};
  const model = e.models?.find((m) => m.id === (modelId || e.defaultModel));
  return model?.efforts || [];
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
    if (!['all', 'sequential', 'claude', 'gpt'].includes(body.defaultTarget)) throw httpError(400, '默认接话人设置不对');
    out.defaultTarget = body.defaultTarget;
  }
  if (body.models !== undefined) {
    out.models = {
      claude: String(body.models?.claude || '').trim().slice(0, 80),
      gpt: String(body.models?.gpt || '').trim().slice(0, 80),
    };
    // 列表外的模型只能走「自定义模型」：界面上先试过能用，才会带着 custom 标记提交
    const custom = Array.isArray(body.custom) ? body.custom : [];
    const keep = (agent) => (room?.models?.[agent] || '') === out.models[agent]; // 原来就在用的不重新校验
    if (!custom.includes('gpt') && !keep('gpt') && !validModel('codex', out.models.gpt)) {
      throw httpError(400, `当前的 Codex 用不了 ${out.models.gpt}，请从列表里选一个`);
    }
    if (!custom.includes('claude') && !keep('claude') && !validModel('claude', out.models.claude)) {
      throw httpError(400, `Claude 没有 ${out.models.claude} 这个模型，请从列表里选一个`);
    }
  }
  if (body.efforts !== undefined || out.models) {
    const efforts = { ...ROOM_DEFAULTS.efforts, ...room?.efforts };
    for (const a of ['claude', 'gpt']) {
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
  return out;
}

function pickFolder() {
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', 'activate', '-e', 'POSIX path of (choose folder with prompt "选择项目文件夹")'],
      { timeout: 10 * 60 * 1000 },
      (err, stdout) => resolve(err ? null : stdout.trim().replace(/\/$/, '') || null),
    );
  });
}

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
  if (method === 'GET' && parts[0] === 'events') return events(req, res);
  if (method === 'GET' && parts[0] === 'state') {
    return send(res, 200, { rooms: store.listRooms(), runs: hub.status(true), engines, agents: AGENTS, defaults: ROOM_DEFAULTS, projectsDir: PROJECTS_DIR });
  }
  if (method === 'POST' && parts[0] === 'pick-folder') return send(res, 200, { path: await pickFolder() });
  if (parts[0] === 'app') {
    if (method === 'GET' && !parts[1]) return send(res, 200, { ...(await appInfo()), dataDir: DATA_DIR, projectsDir: PROJECTS_DIR });
    if (method === 'POST' && parts[1] === 'check-update') return send(res, 200, await checkUpdate());
    if (method === 'POST' && parts[1] === 'update') {
      const result = await pullUpdate();
      if (result.ok && result.updated) {
        hub.emit('event', { type: 'restarting' });
        scheduleRestart(); // 正在干的活会在退出时记成「被打断」，重新打开后可以接着做
      }
      return send(res, 200, result);
    }
    if (method === 'POST' && parts[1] === 'restart') {
      hub.emit('event', { type: 'restarting' });
      scheduleRestart();
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && parts[1] === 'open-data') {
      execFile('open', [DATA_DIR]);
      return send(res, 200, { ok: true });
    }
  }
  if (method === 'POST' && parts[0] === 'engines' && parts[1] === 'refresh') {
    if (Date.now() - refreshedAt > 30 * 1000) await refreshEngines(); // 最多 30 秒查一次
    return send(res, 200, { engines });
  }
  if (method === 'POST' && parts[0] === 'engines' && parts[1] === 'update') {
    const { engine } = await readBody(req);
    if (!['claude', 'codex'].includes(engine)) return send(res, 400, { error: '不认识这个程序' });
    const result = await updateEngine(engine);
    await refreshEngines();
    return send(res, 200, { ...result, engines });
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
      store.updateRoom(room.id, patch);
      const when = (a) => (hub.runs.has(hub.key(room.id, a)) ? '，它手上这一轮做完后' : '，下一轮');
      for (const a of switched) hub.notice(room.id, `${AGENTS[a].name} 换成了 ${modelName(a, patch.models[a])}${when(a)}开始生效`);
      for (const a of effortSwitched) hub.notice(room.id, `${AGENTS[a].name} 的思考强度换成了「${effortName(a, patch.efforts[a])}」${when(a)}开始生效`);
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
      hub.postUserMessage(room.id, text, images, dm, replyTo);
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
      const { agent } = await readBody(req);
      hub.stop(room.id, AGENTS[agent] ? agent : undefined);
      return send(res, 200, { ok: true });
    }
    if (sub === 'open-folder' && method === 'POST') {
      execFile('open', [room.cwd]);
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: '没有这个接口' });
}

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
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

setupPath();
server.listen(PORT, HOST, () => {
  console.log(`[clawchat] 已启动：http://${HOST}:${PORT}  数据目录：${DATA_DIR}`);
  hub.noticeInterrupted();
  refreshEngines().then(() => console.log('[clawchat] 引擎：', JSON.stringify(engines)));
  setInterval(refreshEngines, 5 * 60 * 1000); // 定时重新读模型目录：出了新模型不用重启就能看到
});

// 重新检测两边的版本和模型列表，有变化就推给界面
let refreshing = null;
let refreshedAt = 0;
function refreshEngines() {
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
