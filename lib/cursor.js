import { isJointDiscussion, jointEngineHome } from './joint-discussion.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';
import { tr } from './i18n.js';
import { agentEnv } from './agent-env.js';

// Cursor（Cursor 官方的 Cursor CLI，命令是 cursor-agent）：用 Cursor 账号自己的订阅额度，能选 Cursor 里的各家模型（包括 Grok）。
// 注意命令名只认 cursor-agent：Grok Build 也装了一个叫 agent 的命令，两个会撞名。
// 每个群、每位 Cursor 成员用 ~/.clawchat/cursor/homes/ 下单独的 CURSOR_CONFIG_DIR：
//   记忆（chats）和项目数据（CURSOR_DATA_DIR）都存在那里，不和老板终端里的 Cursor 混，也不加载老板全局的 cli-config。
//   注意：Cursor 的 MCP 列表固定从 ~/.cursor/mcp.json 读（不看 CURSOR_CONFIG_DIR），--force 会自动批准它们。
//   所以按群的权限写拒绝规则（见 cursorDeny）：只有「完全放开」能调 MCP 工具。
//   登录不在这个目录里（Mac 存在钥匙串，Windows 在 %APPDATA%\Cursor，Linux 在 ~/.config/cursor），所以终端里登录一次，这里就能用。
export const CURSOR_AGENT = { id: 'cursor', name: 'Cursor', label: 'Cursor', fullName: 'Cursor（Cursor 的 Cursor CLI）', engine: 'cursor' };
const ROOT = path.join(DATA_DIR, 'cursor');
const BIN = 'cursor-agent';
// Windows 上整条命令行最多 32767 个字符；Mac、Linux 宽得多，但太长也一样放文件里
const LONG_PROMPT = Number(process.env.CLAWCHAT_CURSOR_LONG_PROMPT) || (process.platform === 'win32' ? 12000 : 100000);
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const active = new Map();
const removing = new Map();
const failed = (error) => ({ done: Promise.resolve({ ok: false, error, steps: [], session: null }), kill() {} });

function cleanup(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
}

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
}

function ownerPrefix(room) {
  return crypto.createHash('sha256').update(String(room.id || room.cwd)).digest('hex').slice(0, 24) + '-';
}
function ownerHome(room, agent = 'cursor') {
  if (isJointDiscussion(room)) return jointEngineHome(room, 'cursor');
  if (!/^cursor[2-9]?$/.test(agent)) throw new Error('Cursor 成员编号无效');
  return path.join(ROOT, 'homes', ownerPrefix(room) + agent);
}
function prepareHome(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'cli-config.json');
  if (!fs.existsSync(file)) writePrivate(file, JSON.stringify({ version: 1, permissions: { allow: [], deny: [] } }));
}

// 每一轮按群的权限重写一次拒绝规则（Cursor 官方的 permissions，拒绝优先，--force 也绕不过去）：
//   完全放开：不拦，可以用老板自己在 Cursor 里配的 MCP；
//   项目内：不让调 MCP 工具（MCP 能改远程的东西，文件沙盒管不到）；
//   只读、分身：MCP、命令、写文件都不让。
export function cursorDeny(room, side) {
  if (isJointDiscussion(room)) return ['Mcp(*:*)', 'Shell(*)', 'Write(**)', 'Read(**)', 'WebFetch(*)'];
  if (side || room.permission === 'readonly') return ['Mcp(*:*)', 'Shell(*)', 'Write(**)'];
  if (room.permission === 'full') return [];
  return ['Mcp(*:*)'];
}
function applyPolicy(home, room, side) {
  const file = path.join(home, 'cli-config.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  config.version ??= 1;
  config.permissions = { allow: [], deny: cursorDeny(room, side) };
  writePrivate(file, JSON.stringify(config));
}

// Cursor 把每段对话存在 <配置目录>/chats/<工作目录的 md5>/<会话编号>/ 下
function chatDir(home, cwd, id) {
  if (!UUID.test(id || '')) return null;
  const exact = path.join(home, 'chats', crypto.createHash('md5').update(path.resolve(cwd)).digest('hex'), id);
  if (fs.existsSync(exact)) return exact;
  try {
    for (const d of fs.readdirSync(path.join(home, 'chats'), { withFileTypes: true })) {
      const p = path.join(home, 'chats', d.name, id);
      if (d.isDirectory() && fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

// 删群、清空并忘掉记忆时：这一群的 Cursor 记忆一起删。agent 不传就是这个群的所有 Cursor 成员
export async function removeCursorHome(room, agent) {
  const root = path.join(ROOT, 'homes');
  const prefix = ownerPrefix(room);
  const homes = new Set([...active.keys()].filter((h) => path.basename(h).startsWith(prefix)));
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && d.name.startsWith(prefix)) homes.add(path.join(root, d.name));
  } catch {}
  if (agent) {
    const target = ownerHome(room, agent);
    for (const h of homes) if (h !== target) homes.delete(h);
  }
  await Promise.all([...homes].map((home) => {
    if (removing.has(home)) return removing.get(home);
    const handles = [...(active.get(home) || [])];
    const pending = (async () => {
      for (const h of handles) h.kill();
      await Promise.allSettled(handles.map((h) => h.done));
      cleanup(home);
    })();
    removing.set(home, pending);
    return pending.finally(() => { if (removing.get(home) === pending) removing.delete(home); });
  }));
}

// 去掉别家的 Key 和接口地址；CURSOR_API_KEY 保留（那也是同一个 Cursor 账号的额度）
export function cursorEnv(home, source = process.env) {
  const env = agentEnv('cursor', source);
  // 项目数据（CURSOR_DATA_DIR）也放进这个群自己的目录，不落到老板的 ~/.cursor/projects
  return { ...env, CURSOR_CONFIG_DIR: home, CURSOR_DATA_DIR: path.join(home, 'data'), NO_OPEN_BROWSER: '1' };
}

const strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');

// cursor-agent models 的输出：「模型编号 - 显示名 (current, default)」一行一个
export function parseCursorModels(stdout) {
  const models = [];
  let defaultModel = '';
  for (const line of strip(stdout).split('\n')) {
    const m = line.trim().match(/^([\w.[\]=,:-]+)\s+-\s+(.+?)(?:\s+\(([^)]*)\))?$/);
    if (!m || models.some((x) => x.id === m[1])) continue;
    if (/\bdefault\b/.test(m[3] || '')) defaultModel = m[1];
    models.push({ id: m[1], name: m[2].trim(), description: '', vision: true, context: 0, efforts: [], defaultEffort: '' });
  }
  return { models, defaultModel: defaultModel || models[0]?.id || '' };
}

export async function detectCursor({ which, run }) {
  const bin = which(BIN);
  const info = { path: bin, cli: BIN, authMode: 'subscription', version: null, ok: false, loggedIn: false, models: [], efforts: [], defaultModel: '', defaultLabel: '', defaultEffort: '' };
  if (!bin) return info;
  let temp;
  try {
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    temp = fs.mkdtempSync(path.join(ROOT, 'detect-'));
    prepareHome(temp);
    const env = cursorEnv(temp);
    const version = await run(bin, ['--version'], 20000, env);
    info.version = strip(version.stdout).trim().split('\n')[0] || null;
    info.ok = !!version.ok;
    const status = await run(bin, ['status', '--format', 'json'], 20000, env);
    try { info.loggedIn = JSON.parse(strip(status.stdout)).isAuthenticated === true; } catch {}
    if (info.loggedIn) {
      const list = await run(bin, ['models'], 30000, env);
      Object.assign(info, parseCursorModels(list.stdout));
      info.defaultLabel = info.models.find((m) => m.id === info.defaultModel)?.name || info.defaultModel;
    } else info.error = tr('Cursor 还没登录：在终端运行 cursor-agent login，用你的 Cursor 账号登录');
  } catch (err) { info.error = tr('Cursor 检测失败：{error}', { error: err.message }); }
  finally { cleanup(temp); }
  return info;
}

export function cursorSessionUsage(id) {
  if (!UUID.test(id || '')) return null;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'usage', `${id}.json`), 'utf8')); } catch { return null; }
}

export function cursorError(value) {
  const text = strip(typeof value === 'string' ? value : JSON.stringify(value || '')).trim();
  if (/authentication required|api key is invalid|not logged in|unauthenticated|unauthorized|\b401\b/i.test(text)) return tr('Cursor 还没登录或登录过期了：在终端运行 cursor-agent login 重新登录');
  if (/usage limit|quota|rate.?limit|out of (?:credits|requests)|insufficient|exceeded|\b(?:402|429)\b/i.test(text)) return tr('Cursor 的额度用完了，或者请求太频繁，等额度恢复后再试');
  if (/cannot use this model/i.test(text)) return tr('Cursor 用不了这个模型：{error}', { error: text.split('\n')[0] });
  if (/(?:chat|session|conversation).{0,40}not found|no (?:chat|session) found/i.test(text)) return tr('Cursor session not found：找不到上一轮的记忆');
  return text;
}

// 权限：完全放开 = 自动批准 + 不用沙盒；项目内 = 自动批准 + 沙盒（只能改工作目录里的东西）；
// 只读、分身 = ask 模式（只回答、不改东西），也不自动批准命令
export function cursorArgs({ room, session, side, newId }) {
  const readonly = isJointDiscussion(room) || side || room.permission === 'readonly';
  const args = ['-p', '--output-format', 'stream-json', '--trust', '--disable-auto-update', '--workspace', room.cwd];
  if (readonly) args.push('--mode', 'ask', '--sandbox', 'enabled');
  else args.push('--force', '--sandbox', room.permission === 'full' ? 'disabled' : 'enabled');
  if (room.models?.cursor) args.push('--model', room.models.cursor);
  if (session) args.push('--resume', session);
  else if (newId) args.push('--new-session-id', newId);
  return args;
}

function toolStep(call, cwd) {
  const [key] = Object.keys(call || {});
  const a = call?.[key]?.args || {};
  const file = a.path || a.filePath || a.targetFile || '';
  const relative = file ? path.relative(cwd, file) : '';
  const text = relative && !relative.startsWith('..') ? relative : file;
  if (/^shell/.test(key || '')) return { kind: 'run', text: a.command || '' };
  if (/^(?:edit|delete|applyAgentDiff)/.test(key || '')) return { kind: 'edit', text };
  if (/^(?:read|ls)ToolCall/.test(key || '')) return { kind: 'read', text };
  if (/^(?:grep|glob|semSearch)/.test(key || '')) return { kind: 'search', text: a.pattern || a.query || a.globPattern || '' };
  if (/^web/.test(key || '')) return { kind: 'web', text: a.searchTerm || a.query || a.url || '' };
  if (/^task/.test(key || '')) return { kind: 'task', text: a.description || '' };
  return { kind: 'tool', text: String(key || '').replace(/ToolCall$/, '') };
}

export function runCursor(opts, { which, spawnJsonl }) {
  const bin = which(BIN);
  if (!bin) return failed(tr('找不到 cursor-agent 命令：先装 Cursor CLI（curl https://cursor.com/install -fsS | bash），再运行 cursor-agent login 登录'));
  const { room, session, side = false, prompt, systemPrompt = '', images = [], onStep = () => {}, onActivity } = opts;
  if (session && !UUID.test(session)) return failed(tr('Cursor session not found：会话编号无效'));
  const ownedHome = ownerHome(room, opts.agent);
  if (removing.has(ownedHome)) {
    let stopped = false;
    let child;
    const done = removing.get(ownedHome).then(() => {
      if (stopped) return { ok: false, error: tr('Cursor 已停止'), steps: [], session: session || null };
      child = runCursor(opts, { which, spawnJsonl });
      return child.done;
    });
    return { done, kill() { stopped = true; return child?.kill(); } };
  }
  let home = ownedHome;
  let temp;
  let resume = session;
  try {
    prepareHome(ownedHome);
    if (side) {
      // 分身：把本体的这段记忆复制到临时目录里接着聊，聊完就扔，不会写回本体的记忆
      fs.mkdirSync(path.join(ROOT, 'runs'), { recursive: true, mode: 0o700 });
      temp = fs.mkdtempSync(path.join(ROOT, 'runs', 'run-'));
      home = path.join(temp, 'home');
      prepareHome(home);
      const source = session && chatDir(ownedHome, room.cwd, session);
      if (source) fs.cpSync(source, path.join(home, path.relative(ownedHome, source)), { recursive: true });
      else resume = null; // 找不到本体的记忆就开一段新的，靠这一轮带的聊天记录
    }
    applyPolicy(home, room, side);
  } catch (err) {
    cleanup(temp);
    return failed(tr('Cursor 启动失败：{error}', { error: err.message }));
  }
  // Cursor CLI 没有对外开放「系统提示词」参数：新会话把群规放在第一条消息前面，续上的会话里已经有了
  const attached = images.map((img) => `图 #${img.n}：${img.label || ''}\n${img.path}`);
  const input = [
    !resume && systemPrompt ? `[群规和你的身份，请一直遵守]\n${systemPrompt}` : '',
    prompt,
    attached.length ? `用户附图如下，需要看就用读文件工具打开这些本地图片：\n${attached.join('\n\n')}` : '',
  ].filter(Boolean).join('\n\n');
  // Windows 一整条命令行最多 32767 个字符：消息太长时写进临时文件，参数里只放一句「先读这个文件」
  let arg = input;
  if (isJointDiscussion(room) && input.length > LONG_PROMPT) return failed(tr('联合群讨论内容太长，请缩短消息后重试'));
  if (input.length > LONG_PROMPT) {
    try {
      if (!temp) {
        fs.mkdirSync(path.join(ROOT, 'runs'), { recursive: true, mode: 0o700 });
        temp = fs.mkdtempSync(path.join(ROOT, 'runs', 'run-'));
      }
      const file = path.join(temp, 'message.md');
      writePrivate(file, input);
      arg = `这一轮的消息比较长，完整内容放在这个文件里：${file}\n请先用读文件工具把它从头到尾读完（文件很长就分几次读），然后按里面的内容做，里面的要求和直接发给你的一样。`;
    } catch (err) {
      cleanup(temp);
      return failed(tr('Cursor 启动失败：{error}', { error: err.message }));
    }
  }
  const newId = resume ? null : crypto.randomUUID();
  const steps = [];
  const step = (s) => { steps.push(s); onStep(s); };
  let sid = resume || null;
  let model = room.models?.cursor || '';
  let result;
  let fatal = '';
  let stopped = false;
  let thinking = '';
  let proc;
  const reject = (message) => { fatal ||= message; queueMicrotask(() => proc?.kill()); };
  try {
    // 提示词放在最后一个参数里（cursor-agent 不从 stdin 读题目）
    proc = spawnJsonl(bin, [...cursorArgs({ room, session: resume, side, newId }), arg], {
      cwd: room.cwd, input: '', env: { ...cursorEnv(home), ...(isJointDiscussion(room) ? { HOME: home, USERPROFILE: home } : {}) }, inheritEnv: false,
      onStderr(text) {
        onActivity?.();
        const mapped = cursorError(text);
        if (mapped !== strip(text).trim() && !/session not found/.test(mapped)) reject(mapped);
      },
      onEvent(ev) {
        onActivity?.();
        if (ev.session_id && UUID.test(ev.session_id)) sid = ev.session_id;
        if (ev.type === 'system' && ev.subtype === 'init' && ev.model) model = ev.model;
        if (ev.type === 'thinking' && ev.subtype === 'delta') thinking += ev.text || '';
        if (ev.type === 'thinking' && ev.subtype === 'completed') {
          if (thinking.trim()) step({ kind: 'think', text: thinking.trim() });
          thinking = '';
        }
        if (ev.type === 'assistant') {
          for (const b of ev.message?.content || []) if (b.type === 'text' && b.text?.trim()) step({ kind: 'say', text: b.text.trim() });
        }
        if (ev.type === 'tool_call' && ev.subtype === 'started') step(toolStep(ev.tool_call, room.cwd));
        if (ev.type === 'result') {
          result = ev;
          if (ev.is_error || ev.subtype !== 'success') reject(cursorError(ev.result || ev.subtype));
        }
      },
    });
  } catch (err) {
    cleanup(temp);
    return failed(tr('Cursor 启动失败：{error}', { error: err.message }));
  }
  const done = proc.done.then(async ({ code, signal, stderr }) => {
    const ok = !removing.has(ownedHome) && !stopped && !fatal && code === 0 && !signal && result?.subtype === 'success' && !result.is_error;
    if (ok) {
      const text = String(result.result || '').trim();
      // 最后几段话就是最终回复，过程里不再重复显示
      while (steps.length && steps[steps.length - 1].kind === 'say' && text.endsWith(steps[steps.length - 1].text)) steps.pop();
      const u = result.usage;
      if (!side && UUID.test(sid || '') && u) {
        const used = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'input_tokens', 'output_tokens'].reduce((s, k) => s + (Number(u[k]) || 0), 0);
        try { writePrivate(path.join(ROOT, 'usage', `${sid}.json`), JSON.stringify({ used, window: 0, images: 0, model })); } catch {}
      }
      return { ok: true, text, steps, session: side ? session || null : sid, model, effort: '' };
    }
    await proc.kill();
    const error = fatal || cursorError(result?.result || stderr.trim().split('\n').filter(Boolean).pop() || tr('{bin} 异常退出（{code}）', { bin: BIN, code }));
    return { ok: false, error, steps, session: session || null };
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
