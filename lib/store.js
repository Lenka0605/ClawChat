import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { tr } from './i18n.js';

export const DATA_DIR = process.env.CLAWCHAT_HOME || path.join(os.homedir(), '.clawchat');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json'); // 侧栏的收纳组：[{ id, name, createdAt }]，群里的 folder 字段记它在哪个组
const CONFIG_FILE = path.join(DATA_DIR, 'config.json'); // 应用级设置，比如 DeepSeek 的 API Key

export const ROOM_DEFAULTS = {
  members: ['claude', 'gpt'],
  permission: 'project', // project | full | readonly
  collab: true, // 成员之间能否互相 @ 接力
  maxAutoTurns: 8, // 老板不说话时，最多连续自动接力几轮
  defaultTarget: 'last', // 不 @ 时发给谁：last（接着上一位：群里最后说话的那位 AI）| all（同时开工）| sequential（依次回答）| claude | gpt | deepseek
  models: { claude: '', gpt: '', deepseek: '', glm: '', gemini: '' }, // 留空表示跟随 Claude Code / Codex 自己的默认设置（DeepSeek、GLM 默认用各自的默认模型）
  efforts: { claude: '', gpt: '', deepseek: '', glm: '', gemini: '' }, // 思考强度，留空同样表示跟随各自的设置
  fast: { gpt: false }, // GPT 的快速模式（Codex 的 Fast：更快，但按 2.5 倍消耗订阅额度），要老板确认过才开
  // 私聊里单独的设置：{ gpt: { model, effort, fast } }，哪项没有就跟着群里（在私聊里切换不影响群聊）
  dmSettings: {},
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  // Windows 上目标文件偶尔被杀毒软件或索引服务占着，覆盖会失败：等一下再试
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
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
    this.rooms = readJson(ROOMS_FILE, []).map((r) => ({
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
    this.folders = readJson(FOLDERS_FILE, []);
    this.messages = new Map(); // roomId -> message[]
    this.states = new Map(); // roomId -> { sessions, cursors }
    const migrated = readJson(ROOMS_FILE, []).some((r) => !r.targetV);
    // 0.6.1 以前 AI 之间的私聊在两位的私聊里都算：侧栏的最后一条按新规则重算一遍
    const stale = this.rooms.filter((r) => Object.values(r.dmLast || {}).some((v) => v?.pm && !v.pmIn));
    for (const room of stale) {
      room.dmLast = {};
      for (const m of this.getMessages(room.id)) if (m.from !== 'system' && (m.dm || m.pm)) noteLast(room, m);
    }
    if (stale.length || migrated) this.saveRooms();
  }

  roomDir(id) {
    return path.join(DATA_DIR, 'rooms', id);
  }

  uploadsDir(id) {
    return path.join(this.roomDir(id), 'uploads');
  }

  saveRooms() {
    writeJson(ROOMS_FILE, this.rooms);
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
    writeJson(FOLDERS_FILE, this.folders);
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

  // 解散收纳组：里面的群回到最外层，群本身不动
  deleteFolder(id) {
    this.folders = this.folders.filter((f) => f.id !== id);
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
    this.saveRooms();
    fs.rmSync(this.roomDir(id), { recursive: true, force: true });
  }

  getMessages(id) {
    if (!this.messages.has(id)) {
      const file = path.join(this.roomDir(id), 'messages.jsonl');
      let list = [];
      try {
        list = fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      } catch {}
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
    fs.appendFileSync(path.join(this.roomDir(id), 'messages.jsonl'), JSON.stringify(message) + '\n');
    const room = this.getRoom(id);
    if (room && msg.from !== 'system') {
      noteLast(room, message);
      this.saveRooms();
    }
    return message;
  }

  getState(id) {
    if (!this.states.has(id)) {
      const state = readJson(path.join(this.roomDir(id), 'state.json'), {});
      this.states.set(id, { sessions: {}, cursors: {}, ...state });
    }
    return this.states.get(id);
  }

  saveState(id) {
    writeJson(path.join(this.roomDir(id), 'state.json'), this.getState(id));
  }
}
