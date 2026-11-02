import { tr } from './i18n.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';

export const isJointDiscussion = (room) => room?.jointDiscussion === true;
// 未验收文件工具的读边界，一律不提供；不能因为是「只读」就继承本机的任意读取能力。
export const JOINT_CODEX_CONFIG = {
  'features.shell_tool': false, 'features.view_image': false, 'features.multi_agent': false,
  'features.apps': false, 'features.plugins': false, 'features.remote_plugin': false,
  'features.memories': false, 'features.hooks': false, 'features.goals': false,
  'features.browser_use': false, 'features.browser_use_external': false, 'features.computer_use': false,
  'features.code_mode': false, 'features.code_mode_host': false, 'features.code_mode_only': false,
  'features.request_permissions_tool': false, 'features.skill_search': false,
  'web_search': 'disabled', 'project_doc_max_bytes': 0,
  'skills.bundled.enabled': false, 'skills.include_instructions': false,
};
function privateDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
export function jointSessionDirectory(room, agent) {
  const root = path.resolve(DATA_DIR, 'joint');
  const fallback = path.join(root, crypto.createHash('sha256').update(String(room.id)).digest('hex'), 'sessions', agent);
  const dir = path.resolve(room.jointSessionDir || fallback);
  const relative = path.relative(root, dir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(tr('联合群会话目录不在专用数据区'));
  return privateDir(dir);
}
export function prepareJointRoom(room, agent) {
  const dir = jointSessionDirectory(room, agent);
  const cwd = privateDir(path.join(dir, 'workspace'));
  return { ...room, permission: 'readonly', cwd, jointSessionDir: dir, fast: { gpt: false } };
}
export function jointEngineHome(room, engine) {
  return privateDir(path.join(room.jointSessionDir, 'cli', engine));
}
// 只导入认证文件，不导入原来的配置、插件、会话或自动记忆；不读取/打印其中的任何值。
export function jointAuthEnv(room, engine, env) {
  if (!isJointDiscussion(room)) return env;
  const home = jointEngineHome(room, engine);
  const sources = engine === 'codex'
    ? [[path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'), 'auth.json']]
    : [[path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), '.credentials.json']];
  for (const [source, name] of sources) {
    const target = path.join(home, name);
    if (!fs.existsSync(target) && fs.existsSync(source)) { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600); }
  }
  return { ...env, ...(engine === 'codex' ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: home }) };
}

export function codexDiscussionFeaturesSupported(output) {
  const known = new Set(String(output).split('\n').map((line) => line.trim().split(/\s+/)[0]));
  return Object.keys(JOINT_CODEX_CONFIG).filter((key) => key.startsWith('features.')).every((key) => known.has(key.slice(9)));
}
