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
// Claude 的配置目录同时决定 macOS 钥匙串条目，改目录会丢失订阅登录。
// 讨论档保留原认证入口，配置/工具隔离由 restricted、空 setting-sources 和空 tools 强制执行。
// Codex 仍使用独立 home，只导入认证文件，不复制配置、插件或会话。
export function jointAuthEnv(room, engine, env) {
  if (!isJointDiscussion(room) || engine === 'claude') return env;
  const home = jointEngineHome(room, engine);
  const source = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  const target = path.join(home, 'auth.json');
  if (!fs.existsSync(target) && fs.existsSync(source)) {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
  }
  return { ...env, CODEX_HOME: home };
}

export function codexDiscussionFeaturesSupported(output) {
  const known = new Set(String(output).split('\n').map((line) => line.trim().split(/\s+/)[0]));
  return Object.keys(JOINT_CODEX_CONFIG).filter((key) => key.startsWith('features.')).every((key) => known.has(key.slice(9)));
}
