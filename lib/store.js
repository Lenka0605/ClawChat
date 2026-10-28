import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.CLAWCHAT_HOME || path.join(os.homedir(), '.clawchat');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

export const ROOM_DEFAULTS = {
  members: ['claude', 'gpt'],
  permission: 'project', // project | full | readonly
  collab: true, // 两位能否互相 @ 接力
  maxAutoTurns: 8, // 老板不说话时，最多连续自动接力几轮
  defaultTarget: 'all', // 不 @ 时发给谁：all（同时开工）| sequential（依次回答）| claude | gpt
  models: { claude: '', gpt: '' }, // 留空表示跟随 Claude Code / Codex 自己的默认设置
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export class Store {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.rooms = readJson(ROOMS_FILE, []).map((r) => ({
      ...ROOM_DEFAULTS,
      ...r,
      models: { ...ROOM_DEFAULTS.models, ...r.models },
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
