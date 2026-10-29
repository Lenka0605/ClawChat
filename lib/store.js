import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.CLAWCHAT_HOME || path.join(os.homedir(), '.clawchat');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json'); // 应用级设置，比如 DeepSeek 的 API Key

export const ROOM_DEFAULTS = {
  members: ['claude', 'gpt'],
  permission: 'project', // project | full | readonly
  collab: true, // 两位能否互相 @ 接力
  maxAutoTurns: 8, // 老板不说话时，最多连续自动接力几轮
  defaultTarget: 'all', // 不 @ 时发给谁：all（同时开工）| sequential（依次回答）| claude | gpt | deepseek
  models: { claude: '', gpt: '', deepseek: '' }, // 留空表示跟随 Claude Code / Codex 自己的默认设置（DeepSeek 默认用 deepseek-flash）
  efforts: { claude: '', gpt: '', deepseek: '' }, // 思考强度，留空同样表示跟随各自的设置
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
    }));
    this.messages = new Map(); // roomId -> message[]
    this.states = new Map(); // roomId -> { sessions, cursors }
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
      const pic = message.images?.length ? '[图片] ' : '';
      const last = { from: message.from, text: (pic + (message.text || '')).trim().slice(0, 120), ts: message.ts };
      if (message.dm) room.dmLast = { ...room.dmLast, [message.dm]: last }; // 私聊单独记，侧栏里是一个单独的会话
      // AI 之间的私聊：老板在两位各自的私聊里都能看到
      else if (message.pm) room.dmLast = { ...room.dmLast, [message.from]: { ...last, pm: message.pm }, [message.pm]: { ...last, pm: message.pm } };
      else room.last = last;
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
