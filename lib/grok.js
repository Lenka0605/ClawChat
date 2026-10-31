import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';
import { tr } from './i18n.js';

// 只通过官方账号登录使用 Grok，免费额度和订阅额度由官方账号决定。
// 单独的配置目录不加载用户的自定义模型、API Key、插件或其他 CLI 的技能。
export const GROK_AGENT = { id: 'grok', name: 'Grok', label: 'Grok', fullName: 'Grok（xAI 的 Grok Build）', engine: 'grok' };
export const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const ROOT = path.join(DATA_DIR, 'grok');
const active = new Map();
const removing = new Map();
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const DEFAULT_MODEL = 'grok-4.7';
const READ_TOOLS = 'read_file,grep,list_dir,web_search,web_fetch';
const CONFIG = `[cli]\nauto_update = false\nuse_leader = false\n[models]\ndefault = "${DEFAULT_MODEL}"\nmax_retries = 0\nsubagent_rate_limit_max_attempts = 0\n[features]\nmanaged_config = false\ntelemetry = false\nfeedback = false\ncodebase_indexing = false\nsubagent_bundle = false\nimage_gen = false\n[session]\nload_envrc = false\n[compat.claude]\nagents = false\nhooks = false\nmcps = false\nrules = false\nskills = false\n[compat.codex]\nhooks = false\nskills = false\n[compat.cursor]\nagents = false\nhooks = false\nmcps = false\nrules = false\nskills = false\n[managed_mcps]\nenabled = false\ngateway_tools_enabled = false\n[memory]\nenabled = false\n[memory_v2]\nenabled = false\n[workflows]\nenabled = false\n`;
const nativeHome = () => process.env.GROK_HOME || path.join(os.homedir(), '.grok');
const failed = (error) => ({ done: Promise.resolve({ ok: false, error, steps: [], session: null }), kill() {} });
function cleanup(temp) {
  if (!temp) return;
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch (err) { console.error('[clawchat] Grok 临时目录清理失败：', err.message); }
}
const profileFor = (room, side) => side || room.permission === 'readonly' ? 'read-only' : room.permission === 'full' ? 'off' : 'workspace';

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, value, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

// 不拷贝未知凭据类型；已有的独立目录允许保留官方刷新过的 OAuth 凭据。
function oauthCredentials(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = Object.entries(data).filter(([key, value]) =>
      /^https:\/\/(?:auth|accounts)\.x\.ai(?:::|\/|$)/.test(key) && value && /^(?:oauth2?|oidc)$/i.test(value.auth_mode || '') && value.key);
    return entries.length ? JSON.stringify(Object.fromEntries(entries)) : null;
  } catch { return null; }
}

function prepareHome(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  writePrivate(path.join(home, 'config.toml'), CONFIG);
  // 清掉开发期间旧实现的副本；登录始终由官方 CLI 共用同一个文件和刷新锁。
  for (const name of ['auth.json', 'auth-source.json']) fs.rmSync(path.join(home, name), { force: true });
}

function ownerPrefix(room) {
  return crypto.createHash('sha256').update(String(room.id || room.cwd)).digest('hex').slice(0, 24) + '-';
}
function ownerHome(room, agent = 'grok') {
  if (!/^grok[2-9]?$/.test(agent)) throw new Error('Grok 成员编号无效');
  return path.join(ROOT, 'homes', ownerPrefix(room) + agent);
}

function prepareSandbox(home, room, side) {
  const profile = profileFor(room, side);
  const authDir = path.resolve(nativeHome());
  // auth 文件必须与终端共用，否则单次使用的 refresh_token 会互相作废。
  // 官方 CLI 自己维护文件锁、刷新和原子写入；ClawChat 不读出令牌后自行刷新或回写。
  // 沙盒只额外放行认证目录，并保护那里原有的配置和插件，不能借此修改全局设置。
  const protectedNames = ['config.toml', 'managed_config.toml', 'requirements.toml', 'sandbox.toml', 'trusted_folders.toml', 'hooks', 'hooks-paths', 'plugins', 'bundled', 'bundles', 'mcp_credentials.json'];
  const deny = protectedNames.map((name) => path.join(authDir, name)).filter((file) => fs.existsSync(file));
  if (profile !== 'off') writePrivate(path.join(home, 'sandbox.toml'), `[profiles.clawchat]\nextends = ${JSON.stringify(profile)}\nread_write = [${JSON.stringify(authDir)}]\ndeny = ${JSON.stringify(deny)}\n`);
  writePrivate(path.join(home, 'requirements.toml'), `[sandbox]\nprofile = ${JSON.stringify(profile === 'off' ? 'off' : 'clawchat')}\n[grok_com_config]\ndisable_api_key_auth = true\n`);
}

// agent 不传：整个群的所有 Grok 成员；传 grok/grok2：只清这一位。
// 正在退出的命令收尾后再删，新的同名成员等清理完再启动，避免旧任务删掉新记忆。
export async function removeGrokHome(room, agent) {
  const root = path.join(ROOT, 'homes');
  const prefix = ownerPrefix(room);
  const homes = new Set([...active.keys(), ...removing.keys()].filter((home) => path.basename(home).startsWith(prefix)));
  try {
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) if (dir.isDirectory() && dir.name.startsWith(prefix)) homes.add(path.join(root, dir.name));
  } catch {}
  if (agent) {
    const target = ownerHome(room, agent);
    for (const home of homes) if (home !== target) homes.delete(home);
  }
  await Promise.all([...homes].map((home) => {
    if (removing.has(home)) return removing.get(home);
    const handles = [...(active.get(home) || [])];
    const pending = (async () => {
      for (const handle of handles) handle.kill();
      await Promise.allSettled(handles.map((handle) => handle.done));
      // 用量记录跟着原生会话一起清；其他群、其他成员不受影响。
      const sessions = path.join(home, 'sessions');
      try {
        for (const group of fs.readdirSync(sessions, { withFileTypes: true })) {
          if (!group.isDirectory()) continue;
          for (const id of fs.readdirSync(path.join(sessions, group.name))) if (UUID.test(id)) fs.rmSync(path.join(ROOT, 'usage', `${id}.json`), { force: true });
        }
      } catch {}
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    })();
    removing.set(home, pending);
    return pending.finally(() => { if (removing.get(home) === pending) removing.delete(home); });
  }));
}

export function grokEnv(home, source = process.env) {
  // 不只删 XAI_API_KEY：GROK_CONFIG、代理地址、外部登录助手也会改变计费或认证入口。
  const env = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^(?:GROK_|XAI_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_API_KEY$)/i.test(key)));
  return { ...env, GROK_HOME: home, GROK_AUTH_PATH: path.join(nativeHome(), 'auth.json'), GROK_DISABLE_API_KEY_AUTH: '1', GROK_DISABLE_AUTOUPDATER: '1', GROK_MEMORY: '0', GROK_WORKFLOWS: '0', GROK_CAMPAIGNS: '0', GROK_DISABLE_EXPERIMENTS: '1' };
}

export function grokApiKeyWarning(home = nativeHome()) {
  try {
    const text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    if (/^\s*(?:api_key|env_key|base_url|auth_provider)\s*=/m.test(text) || /^\s*\[(?:model\.|model_providers\.|auth_provider\.|endpoints\b)/m.test(text)) {
      return tr('Grok 的个人配置里有自定义接口或 API Key；ClawChat 已隔离这些设置，只使用官方账号登录');
    }
  } catch {}
  return '';
}

export function parseGrokModels(stdout) {
  const text = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const models = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*[*•-]\s+(grok-[\w.-]+)(?:\s|$)/);
    if (!m || models.some((x) => x.id === m[1])) continue;
    models.push({ id: m[1], name: m[1], description: '', vision: true, context: 0, efforts: [...GROK_EFFORTS], defaultEffort: 'low' });
  }
  const defaultModel = text.match(/Default model:\s*(grok-[\w.-]+)/i)?.[1] || models[0]?.id || DEFAULT_MODEL;
  return { models, defaultModel, loggedIn: /You are logged in with grok\.com\./i.test(text) && !/not authenticated|not logged in/i.test(text) };
}

export async function detectGrok({ which, run }) {
  const bin = which('grok');
  const info = { path: bin, cli: 'grok', authMode: 'subscription', version: null, ok: false, loggedIn: false, apiKeyWarning: grokApiKeyWarning(), models: [], efforts: [...GROK_EFFORTS], defaultModel: DEFAULT_MODEL, defaultLabel: DEFAULT_MODEL, defaultEffort: 'low' };
  if (!bin) return info;
  let temp;
  try {
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    temp = fs.mkdtempSync(path.join(ROOT, 'detect-'));
    prepareHome(temp);
    const env = grokEnv(temp);
    const version = await run(bin, ['--version'], 15000, env);
    info.version = version.stdout.trim().split('\n')[0] || null;
    info.ok = !!version.ok;
    const list = await run(bin, ['models'], 15000, env);
    Object.assign(info, parseGrokModels(`${list.stdout}\n${list.stderr}`));
    info.defaultLabel = info.defaultModel;
    if (!info.loggedIn) info.error = tr('请在终端运行 grok login 登录 Grok；免费或订阅额度由账号决定');
  } catch (err) { info.error = tr('Grok 检测失败：{error}', { error: err.message }); }
  finally { cleanup(temp); }
  return info;
}

function sessionDir(home, id) {
  if (!UUID.test(id || '')) return null;
  const root = path.join(home, 'sessions');
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, id);
    if (fs.existsSync(path.join(file, 'summary.json'))) return file;
  }
  return null;
}

export function grokSessionUsage(id) {
  if (!UUID.test(id || '')) return null;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'usage', `${id}.json`), 'utf8')); } catch { return null; }
}

export function grokError(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  if (/not authenticated|not logged in|not signed in|unauthenticated|unauthorized|invalid.{0,20}(?:token|credential)|token.{0,20}expir|\b401\b/i.test(text)) return tr('Grok 登录已失效，请在终端运行 grok login 重新登录；不会自动改用 API Key');
  if (/quota|usage.{0,30}(?:limit|exhaust)|(?:weekly|credit|subscription).{0,30}(?:limit|exhaust|insufficient)|rate.?limit|\b(?:402|429)\b/i.test(text)) return tr('Grok 的免费或订阅额度暂时用完了，或请求过于频繁，请等额度恢复后再试；不会自动改用付费 API');
  if (/sandbox.{0,100}(?:differ|mismatch|chang)|(?:differ|mismatch).{0,100}sandbox/i.test(text)) return tr('Grok 无法在保留当前记忆时切换权限，原会话已保留，请先恢复原权限再试');
  return text;
}

export function grokArgs({ room, session, side, systemPrompt, promptFile, newId }) {
  const args = ['--prompt-file', promptFile, '--output-format', 'streaming-messages-json', '--no-subagents', '--always-approve', '--rules', systemPrompt || '', '--reasoning-effort', room.efforts?.grok || 'low'];
  // CLI 会在读取策略 pin 之前检查旧会话，续聊不能显式传与旧值冲突的 --sandbox。
  if (!session) args.push('--sandbox', profileFor(room, side) === 'off' ? 'off' : 'clawchat');
  if (room.models?.grok) args.push('--model', room.models.grok);
  if (session) args.push('--resume', session);
  if (session && side) args.push('--fork-session');
  if (newId) args.push('--session-id', newId);
  if (side || room.permission === 'readonly') args.push('--tools', READ_TOOLS);
  return args;
}

function toolStep(block, cwd) {
  const i = block.input || {};
  const name = block.name || '';
  const file = i.file_path || i.path || i.target_file || '';
  const relative = file ? path.relative(cwd, file) : '';
  const text = relative && !relative.startsWith('..') ? relative : file;
  if (/bash|terminal|shell|command/i.test(name)) return { kind: 'run', text: i.command || i.cmd || '' };
  if (/edit|write|replace|patch/i.test(name)) return { kind: 'edit', text };
  if (/read|list_dir/i.test(name)) return { kind: 'read', text };
  if (/grep|glob|search_file/i.test(name)) return { kind: 'search', text: i.pattern || i.query || '' };
  if (/web|fetch/i.test(name)) return { kind: 'web', text: i.query || i.url || '' };
  if (/task|agent/i.test(name)) return { kind: 'task', text: i.description || name };
  return { kind: 'tool', text: name };
}

export function runGrok(opts, { which, spawnJsonl }) {
  const bin = which('grok');
  if (!bin) return failed(tr('找不到 grok 命令，请先安装官方 Grok Build，再运行 grok login 登录'));
  const { room, session, side = false, prompt, systemPrompt = '', images = [], onStep = () => {}, onActivity } = opts;
  if (session && !UUID.test(session)) return failed(tr('Grok session not found：会话编号无效'));
  // 一个成员在一个群里只有一个本体任务；独立目录防止并行群之间的权限策略串用。
  const ownedHome = ownerHome(room, opts.agent);
  let home = ownedHome;
  if (removing.has(ownedHome)) {
    let stopped = false;
    let child;
    const done = removing.get(ownedHome).then(() => {
      if (stopped) return { ok: false, error: tr('Grok 已停止'), steps: [], session: session || null };
      child = runGrok(opts, { which, spawnJsonl });
      return child.done;
    });
    return { done, kill() { stopped = true; return child?.kill(); } };
  }
  let temp;
  let promptFile;
  try {
    prepareHome(home);
    if (!oauthCredentials(path.join(nativeHome(), 'auth.json'))) return failed(tr('请在终端运行 grok login 登录 Grok；免费或订阅额度由账号决定'));
    const source = session && sessionDir(home, session);
    if (session && !source) return failed(tr('Grok session not found：找不到上一轮的记忆'));
    fs.mkdirSync(path.join(ROOT, 'runs'), { recursive: true, mode: 0o700 });
    temp = fs.mkdtempSync(path.join(ROOT, 'runs', 'run-'));
    if (side) {
      home = path.join(temp, 'home');
      prepareHome(home);
      if (source) {
        const target = path.join(home, 'sessions', path.basename(path.dirname(source)), session);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.cpSync(source, target, { recursive: true });
      }
    }
    // 官方支持的策略 pin 优先于会话原来的沙盒，切权限无需丢弃或改写记忆。
    // 每群每成员独立；分身用临时目录，不会把只读策略写回本体。
    prepareSandbox(home, room, side);
    promptFile = path.join(temp, 'prompt.txt');
    // 图片留在文件里，由官方读图工具打开，避免几 MB 的 base64 塞进启动参数。
    const attached = images.map((img) => `图 #${img.n}：${img.label || ''}\n${img.path}`);
    writePrivate(promptFile, [prompt, attached.length ? `用户附图如下，请用读图工具查看这些本地文件：\n${attached.join('\n\n')}` : ''].filter(Boolean).join('\n\n'));
  } catch (err) {
    cleanup(temp);
    return failed(tr('Grok 启动失败：{error}', { error: err.message }));
  }
  const steps = [];
  let sid = session || null;
  let model = room.models?.grok || DEFAULT_MODEL;
  let result;
  let fatal = '';
  let stopped = false;
  let authenticated = false;
  let lastUsage;
  let lastWindow = 0;
  const newId = !session || side ? crypto.randomUUID() : null;
  const expectedId = newId || session;
  const step = (s) => { steps.push(s); onStep(s); };
  let proc;
  const reject = (message) => { fatal ||= message; queueMicrotask(() => proc?.kill()); };
  const inspectError = (value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value || '');
    const mapped = grokError(text);
    if (mapped !== text) reject(mapped);
    return mapped;
  };
  try {
    proc = spawnJsonl(bin, grokArgs({ room, session, side, systemPrompt, promptFile, newId }), {
      cwd: room.cwd, input: '', env: grokEnv(home), inheritEnv: false,
      onStderr(text) { onActivity?.(); inspectError(text); },
      onEvent(ev) {
        onActivity?.();
        if (ev.session_id) {
          if (ev.session_id !== expectedId) reject(tr('Grok 返回的会话编号不一致，本轮已停止，原记忆已保留'));
          else sid = ev.session_id;
        }
        if (ev.type === 'system' && ev.subtype === 'init') {
          authenticated = ev.apiKeySource === 'oauth';
          // 启动失败时 CLI 也会发一个空的占位 init，真正原因在 result.errors 里。
          if (!authenticated && ev.session_id) reject(tr('Grok 没有使用官方账号登录，本轮已停止，防止按 API 计费；请运行 grok login'));
          if (ev.model && ev.model !== 'unknown') model = ev.model;
        }
        if (ev.type === 'system' && ev.subtype === 'api_retry') inspectError(ev);
        if (ev.type === 'error') reject(inspectError(ev.message || ev.error || ev));
        if (ev.type === 'system' && ev.subtype === 'status' && ev.status === 'compacting') step({ kind: 'compact', text: tr('Grok 正在整理记忆，请稍等'), busy: true });
        if (ev.type === 'system' && ev.subtype === 'compact_boundary') step({ kind: 'compact', text: tr('记忆整理好了，接着干') });
        if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
          const u = ev.message?.usage;
          if (u) lastUsage = u;
          if (ev.message?.model && ev.message.model !== 'unknown') model = ev.message.model;
          for (const block of ev.message?.content || []) {
            if (block.type === 'text' && block.text?.trim()) step({ kind: 'say', text: block.text.trim() });
            else if (block.type === 'thinking' && block.thinking?.trim()) step({ kind: 'think', text: block.thinking.trim() });
            else if (block.type === 'tool_use') step(toolStep(block, room.cwd));
          }
        }
        if (ev.type === 'result') {
          result = ev;
          lastWindow = ev.modelUsage?.[model]?.contextWindow || 0;
          if (ev.is_error || ev.subtype !== 'success') reject(inspectError(ev.result || ev.errors || ev.subtype));
        }
      },
    });
  } catch (err) {
    cleanup(temp);
    return failed(tr('Grok 启动失败：{error}', { error: err.message }));
  }
  const done = proc.done.then(async ({ code, signal, stderr }) => {
    const ok = !removing.has(ownedHome) && !stopped && !fatal && authenticated && code === 0 && !signal && result?.subtype === 'success' && !result.is_error;
    // 只用最后一次主模型调用算上下文，不能用整轮累计 token 当上下文长度。
    if (!removing.has(ownedHome) && !side && (ok || session) && UUID.test(sid || '') && lastUsage) {
      const used = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'].reduce((sum, k) => sum + (Number(lastUsage[k]) || 0), 0);
      try { writePrivate(path.join(ROOT, 'usage', `${sid}.json`), JSON.stringify({ used, window: lastWindow >= used ? lastWindow : 0, images: 0, model })); } catch {}
    }
    if (ok) {
      const text = String(result.result || '');
      const index = steps.findLastIndex((s) => s.kind === 'say' && s.text.trim() === text.trim());
      if (index >= 0) steps.splice(index, 1);
      if (!side && !sessionDir(home, sid)) {
        // 工具已经做完，不能为了补存记忆重跑这一轮。下轮由 hub 带聊天记录恢复。
        return { ok: true, text, steps, session: null, resetSession: true, model, effort: room.efforts?.grok || 'low', warning: tr('Grok 已完成这次任务，但记忆没有保存。下次将从聊天记录恢复，请勿重复发送刚才的操作。') };
      }
      return { ok: true, text, steps, session: sid, model, effort: room.efforts?.grok || 'low' };
    }
    await proc.kill();
    if (newId) {
      const created = sessionDir(home, newId);
      if (created) fs.rmSync(created, { recursive: true, force: true });
    }
    return { ok: false, error: fatal || grokError(result?.result || result?.errors || stderr.trim().split('\n').pop() || tr('{bin} 异常退出（{code}）', { bin: 'grok', code })), steps, session: session || null };
  }).finally(() => cleanup(temp));
  const handle = { done, kill() { stopped = true; return proc.kill(); } };
  const handles = active.get(ownedHome) || new Set();
  active.set(ownedHome, handles);
  handles.add(handle);
  const release = () => {
    handles.delete(handle);
    if (!handles.size && active.get(ownedHome) === handles) active.delete(ownedHome);
  };
  done.then(release, release);
  return handle;
}
