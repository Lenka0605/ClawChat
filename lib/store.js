import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { tr } from './i18n.js';

export const DATA_DIR = process.env.CLAWCHAT_HOME || path.join(os.homedir(), '.clawchat');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json'); // 侧栏的收纳组：[{ id, name, createdAt }]，群里的 folder 字段记它在哪个组
const CONFIG_FILE = path.join(DATA_DIR, 'config.json'); // 应用级设置，比如 DeepSeek 的 API Key
const AVATAR_DIR = path.join(DATA_DIR, 'folder-avatars'); // 收纳组头像的图片：<组 id>-<版本>.<扩展名>
const AVATAR_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const AVATAR_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export const ROOM_DEFAULTS = {
  members: ['claude', 'gpt'],
  permission: 'project', // project | full | readonly
  collab: true, // 成员之间能否互相 @ 接力
  maxAutoTurns: 8, // 老板不说话时，最多连续自动接力几轮
  defaultTarget: 'last', // 不 @ 时发给谁：last（接着上一位：群里最后说话的那位 AI）| all（同时开工）| sequential（依次回答）| claude | gpt | deepseek
  models: { claude: '', gpt: '', deepseek: '', glm: '', gemini: '', grok: '' }, // 留空表示跟随 Claude Code / Codex 自己的默认设置（DeepSeek、GLM 默认用各自的默认模型）
  efforts: { claude: '', gpt: '', deepseek: '', glm: '', gemini: '', grok: '' }, // 思考强度，留空同样表示跟随各自的设置
  fast: { gpt: false }, // GPT 的快速模式（Codex 的 Fast：更快，但按 2.5 倍消耗订阅额度），要老板确认过才开
  // 私聊里单独的设置：{ gpt: { model, effort, fast } }，哪项没有就跟着群里（在私聊里切换不影响群聊）
  dmSettings: {},
};

// 读出来、或者自己写过的文件：内容是好的，下次覆盖前可以拿它做备份
const healthy = new Set();
// 读不出来、改从备份恢复了的文件（启动时记进日志）
export const recovered = [];

function parseFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// backup：这份文件坏了时可以退回上一版（群列表、收纳组、每个群的记忆和读取进度）。
// 读不出来又没有备份时用 fallback；坏掉的那份不会被拿去覆盖备份
function readJson(file, fallback, backup = false) {
  try {
    const data = parseFile(file);
    healthy.add(file);
    return data;
  } catch (err) {
    if (!backup || err.code === 'ENOENT') return fallback;
    try {
      const data = parseFile(`${file}.bak`);
      recovered.push(file);
      console.error(`[clawchat] ${file} 读不出来（${err.message}），已改用备份`);
      return data;
    } catch {
      console.error(`[clawchat] ${file} 读不出来（${err.message}），也没有能用的备份`);
      return fallback;
    }
  }
}

function writeJson(file, data, mode, backup = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 覆盖前把上一版（确认是好的）留一份 .bak：这份万一写坏了，下次启动还能退回去
  if (backup && healthy.has(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {}
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  // Windows 上目标文件偶尔被杀毒软件或索引服务占着，覆盖会失败：等一下再试
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      healthy.add(file);
      return;
    } catch (err) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

// 聊天记录的一行读不出来（多半是上次写到一半时断电、崩溃了，下一条又接在了后面）：
// 每条都是以 {"seq": 开头写进去的，按这个切开，能救回来的都救回来
function parseLine(line) {
  try {
    return [JSON.parse(line)];
  } catch {
    return line
      .split(/(?=\{"seq":)/)
      .map((part) => {
        try {
          return JSON.parse(part);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
}

export function readConfig() {
  return readJson(CONFIG_FILE, {});
}

// 里面有 API Key：只让自己能读
export function saveConfig(patch) {
  const next = { ...readConfig(), ...patch };
  for (const k of Object.keys(next)) if (next[k] === '' || next[k] == null) delete next[k];
  writeJson(CONFIG_FILE, next, 0o600);
  return next;
}

// AI 之间的私聊放在谁的私聊里（pmIn）：A 主动找 B，放在 B 的私聊里；B 回 A、A 再接着说，都留在这个私聊。
// 0.6.1 之前的消息没记这一项，按同样的规则补上（只在内存里补，不改文件）：上一条是对方发给它的，就是在接着那段对话
function fillPmIn(list) {
  const last = new Map();
  for (const m of list) {
    if (!m.pm) continue;
    const pair = [m.from, m.pm].sort().join('|');
    const prev = last.get(pair);
    if (!m.pmIn) m.pmIn = prev && prev.from === m.pm ? prev.pmIn : m.pm;
    last.set(pair, m);
  }
}

// 侧栏要显示的最后一条：群里的记在 last，老板和某位的私聊、别的 AI 私下找它的对话记在 dmLast[它]
function noteLast(room, message) {
  const pic = message.images?.length ? `${tr('[图片]')} ` : '';
  const last = { from: message.from, text: (pic + (message.text || '')).trim().slice(0, 120), ts: message.ts };
  if (message.dm) room.dmLast = { ...room.dmLast, [message.dm]: last };
  else if (message.pm) room.dmLast = { ...room.dmLast, [message.pmIn || message.pm]: { ...last, pm: message.pm, pmIn: message.pmIn || message.pm } };
  else room.last = last;
}

export class Store {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.rooms = readJson(ROOMS_FILE, [], true).map((r) => ({
      ...ROOM_DEFAULTS,
      ...r,
      models: { ...ROOM_DEFAULTS.models, ...r.models },
      efforts: { ...ROOM_DEFAULTS.efforts, ...r.efforts },
      fast: { ...ROOM_DEFAULTS.fast, ...r.fast },
      dmSettings: { ...r.dmSettings },
      ...(r.name === 'GPT (Codex)' && String(r.members) === 'gpt' ? { name: 'ChatGPT' } : {}), // 以前的叫法
      // 0.6.8 起不 @ 时默认「接着上一位」（以前默认大家同时开工，老板常常刚发出去就得停掉不该开工的）：以前默认的群换过来一次
      ...(!r.targetV ? { targetV: 2, defaultTarget: !r.defaultTarget || r.defaultTarget === 'all' ? 'last' : r.defaultTarget } : {}),
    }));
    this.folders = readJson(FOLDERS_FILE, [], true);
    this.messages = new Map(); // roomId -> message[]（下标就是 seq）
    this.states = new Map(); // roomId -> { sessions, cursors }
    this.unterminated = new Set(); // 聊天记录文件最后一行没写完（没有换行）的群：下一条先补一个换行
    const migrated = readJson(ROOMS_FILE, [], true).some((r) => !r.targetV);
    // 0.6.1 以前 AI 之间的私聊在两位的私聊里都算：侧栏的最后一条按新规则重算一遍
    const stale = this.rooms.filter((r) => Object.values(r.dmLast || {}).some((v) => v?.pm && !v.pmIn));
    for (const room of stale) {
      room.dmLast = {};
      for (const m of this.getMessages(room.id)) if (m.from !== 'system' && (m.dm || m.pm)) noteLast(room, m);
    }
    if (stale.length || migrated) this.saveRooms();
    // 0.7.31 以前收纳组头像的图片直接存在 folders.json 里（每次推送都带着）：搬到单独的文件
    const inline = this.folders.filter((f) => f.avatar?.image);
    for (const f of inline) {
      const { image, ...rest } = f.avatar;
      this.setFolderAvatar(f.id, rest, image, false);
    }
    if (inline.length) this.saveFolders();
  }

  roomDir(id) {
    return path.join(DATA_DIR, 'rooms', id);
  }

  uploadsDir(id) {
    return path.join(this.roomDir(id), 'uploads');
  }

  saveRooms() {
    writeJson(ROOMS_FILE, this.rooms, undefined, true);
  }

  listRooms() {
    return [...this.rooms];
  }

  getRoom(id) {
    return this.rooms.find((r) => r.id === id);
  }

  createRoom(fields) {
    const room = {
      ...ROOM_DEFAULTS,
      ...fields,
      targetV: 2,
      models: { ...ROOM_DEFAULTS.models, ...fields.models },
      efforts: { ...ROOM_DEFAULTS.efforts, ...fields.efforts },
      fast: { ...ROOM_DEFAULTS.fast, ...fields.fast },
      dmSettings: { ...fields.dmSettings },
      id: crypto.randomBytes(6).toString('hex'),
      createdAt: Date.now(),
      last: null,
    };
    this.rooms.push(room);
    fs.mkdirSync(this.roomDir(room.id), { recursive: true });
    this.saveRooms();
    return room;
  }

  updateRoom(id, patch) {
    const room = this.getRoom(id);
    if (!room) return null;
    Object.assign(room, patch);
    if (patch.models) room.models = { ...ROOM_DEFAULTS.models, ...patch.models };
    if (patch.efforts) room.efforts = { ...ROOM_DEFAULTS.efforts, ...patch.efforts };
    if (patch.fast) room.fast = { ...ROOM_DEFAULTS.fast, ...patch.fast };
    this.saveRooms();
    return room;
  }

  // ---- 收纳组：侧栏里把几个群收在一起（只是归类，群各自的项目文件夹、成员、记忆都不变） ----
  listFolders() {
    return [...this.folders];
  }

  getFolder(id) {
    return this.folders.find((f) => f.id === id);
  }

  saveFolders() {
    writeJson(FOLDERS_FILE, this.folders, undefined, true);
  }

  createFolder(name) {
    const folder = { id: crypto.randomBytes(6).toString('hex'), name, createdAt: Date.now() };
    this.folders.push(folder);
    this.saveFolders();
    return folder;
  }

  renameFolder(id, name) {
    const folder = this.getFolder(id);
    if (!folder) return null;
    folder.name = name;
    this.saveFolders();
    return folder;
  }

  // 收纳组的头像：{ color: 第几种颜色, text: 头像上的字, imageV: 图片的版本 }，null 就是回到默认（组名的第一个字）。
  // image：新传的图片（data URL）；'keep' 留着原来那张；不传就去掉图片。图片存成单独的文件，列表里只带版本号
  setFolderAvatar(id, avatar, image = null, save = true) {
    const folder = this.getFolder(id);
    if (!folder) return null;
    const next = { ...avatar };
    delete next.image;
    delete next.imageV;
    if (image === 'keep' && folder.avatar?.imageV && this.folderAvatarFile(id, folder.avatar.imageV)) next.imageV = folder.avatar.imageV;
    else if (typeof image === 'string') {
      const m = image.match(/^data:(image\/[a-z]+);base64,(.+)$/);
      const ext = m && AVATAR_TYPES[m[1]];
      if (ext) {
        const buf = Buffer.from(m[2], 'base64');
        const v = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
        fs.mkdirSync(AVATAR_DIR, { recursive: true });
        fs.writeFileSync(path.join(AVATAR_DIR, `${id}-${v}.${ext}`), buf);
        next.imageV = v;
      }
    }
    this.removeFolderAvatars(id, next.imageV);
    if (Object.keys(next).length) folder.avatar = next;
    else delete folder.avatar;
    if (save) this.saveFolders();
    return folder;
  }

  // 某个收纳组头像的图片文件：{ file, type }，没有就是 null
  folderAvatarFile(id, v) {
    for (const ext of Object.keys(AVATAR_MIME)) {
      const file = path.join(AVATAR_DIR, `${id}-${v}.${ext}`);
      if (fs.existsSync(file)) return { file, type: AVATAR_MIME[ext] };
    }
    return null;
  }

  // 删掉这个组用不上的头像图片（keep：正在用的那个版本）
  removeFolderAvatars(id, keep = null) {
    let files = [];
    try {
      files = fs.readdirSync(AVATAR_DIR);
    } catch {}
    for (const f of files) if (f.startsWith(`${id}-`) && (!keep || !f.startsWith(`${id}-${keep}.`))) fs.rmSync(path.join(AVATAR_DIR, f), { force: true });
  }

  // 解散收纳组：里面的群回到最外层，群本身不动
  deleteFolder(id) {
    this.folders = this.folders.filter((f) => f.id !== id);
    this.removeFolderAvatars(id);
    let moved = false;
    for (const r of this.rooms) {
      if (r.folder !== id) continue;
      delete r.folder;
      moved = true;
    }
    this.saveFolders();
    if (moved) this.saveRooms();
  }

  deleteRoom(id) {
    this.rooms = this.rooms.filter((r) => r.id !== id);
    this.messages.delete(id);
    this.states.delete(id);
    this.unterminated.delete(id);
    this.saveRooms();
    fs.rmSync(this.roomDir(id), { recursive: true, force: true });
  }

  // 聊天记录按 seq 放：下标就是 seq（读取进度、回复、转发都按这个找）。
  // 有一行坏了救不回来的话，那个位置放一条看不见的空记录（lost），后面的消息不会错位
  getMessages(id) {
    if (!this.messages.has(id)) {
      const file = path.join(this.roomDir(id), 'messages.jsonl');
      const list = [];
      let raw = '';
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {}
      if (raw && !raw.endsWith('\n')) this.unterminated.add(id);
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        for (const m of parseLine(line)) {
          if (!Number.isInteger(m?.seq) || m.seq < 0) continue;
          if (list[m.seq]) {
            console.error(`[clawchat] 群 ${id} 的聊天记录里有两条 seq=${m.seq}，后一条没读进来`);
            continue;
          }
          list[m.seq] = m;
        }
      }
      for (let i = 0; i < list.length; i++) if (!list[i]) list[i] = { seq: i, ts: list[i - 1]?.ts || 0, from: 'system', text: '', lost: true };
      fillPmIn(list);
      this.messages.set(id, list);
    }
    return this.messages.get(id);
  }

  appendMessage(id, msg) {
    const list = this.getMessages(id);
    const message = { seq: list.length, ts: Date.now(), ...msg };
    list.push(message);
    fs.mkdirSync(this.roomDir(id), { recursive: true });
    // 上一行没写完（断电、崩溃）：先换行，别让这一条接在半行后面一起读不出来
    const lead = this.unterminated.delete(id) ? '\n' : '';
    fs.appendFileSync(path.join(this.roomDir(id), 'messages.jsonl'), lead + JSON.stringify(message) + '\n');
    const room = this.getRoom(id);
    if (room && msg.from !== 'system') {
      noteLast(room, message);
      this.saveRooms();
    }
    return message;
  }

  // 没发出去的图片（传上来了、最后没发送）：没有任何消息用到、放了七天以上的删掉
  // （输入框里没发出去的图会留在草稿里，关掉再打开还在，所以多留几天）
  pruneUploads(maxAge = 7 * 24 * 3600 * 1000) {
    let removed = 0;
    for (const room of this.rooms) {
      const dir = this.uploadsDir(room.id);
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      let text = '';
      try {
        text = fs.readFileSync(path.join(this.roomDir(room.id), 'messages.jsonl'), 'utf8');
      } catch {}
      for (const f of files) {
        if (text.includes(f)) continue;
        const file = path.join(dir, f);
        try {
          if (Date.now() - fs.statSync(file).mtimeMs < maxAge) continue;
          fs.rmSync(file, { force: true });
          removed++;
        } catch {}
      }
    }
    return removed;
  }

  // 清空聊天记录：消息、图片、给 AI 看的完整记录都删掉；群本身、成员、项目文件夹不动
  clearMessages(id) {
    this.messages.set(id, []);
    this.unterminated.delete(id);
    const dir = this.roomDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '');
    for (const sub of ['uploads', 'transcripts']) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
    const room = this.getRoom(id);
    if (room) {
      room.last = null;
      room.dmLast = {};
      this.saveRooms();
    }
  }

  getState(id) {
    if (!this.states.has(id)) {
      const state = readJson(path.join(this.roomDir(id), 'state.json'), {}, true);
      this.states.set(id, { sessions: {}, cursors: {}, ...state });
    }
    return this.states.get(id);
  }

  saveState(id) {
    writeJson(path.join(this.roomDir(id), 'state.json'), this.getState(id), undefined, true);
  }
}
