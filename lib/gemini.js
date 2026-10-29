import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, readConfig } from './store.js';
import { tr } from './i18n.js';

// 官方 CLI 保留工具调用和 Google 登录，不把 Gemini 当成只能回文字的聊天接口。
// 协议：https://geminicli.com/docs/cli/headless/
export const GEMINI_AGENT = { id: 'gemini', name: 'Gemini', label: 'Gemini', fullName: 'Gemini（Google 的 Gemini CLI）', engine: 'gemini' };
// 模型说明要按界面语言显示，所以每次检测时现取（模块加载时还不知道界面语言）
export const geminiModels = () => [
  { id: 'auto', name: 'Gemini Auto', description: tr('由 Gemini CLI 自动选择') },
  { id: 'pro', name: 'Gemini Pro', description: tr('由 Gemini CLI 选择 Pro 模型') },
  { id: 'flash', name: 'Gemini Flash', description: tr('由 Gemini CLI 选择 Flash 模型') },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', description: tr('需要账号有对应模型权限') },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', description: tr('需要账号有对应模型权限') },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: '' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: '' },
].map((m) => ({ ...m, vision: true, context: 0, efforts: [], defaultEffort: '' }));

export function geminiKey() {
  return readConfig().geminiKey || process.env.GEMINI_API_KEY || '';
}

export async function detectGemini({ which, run }) {
  const bin = which('gemini');
  const version = bin ? (await run(bin, ['--version'], 15000)).stdout.trim().split('\n')[0] || null : null;
  const key = geminiKey();
  return {
    path: bin, version, ok: !!bin, hasKey: !!key, keyHint: key ? `…${key.slice(-4)}` : '',
    models: geminiModels(), defaultModel: 'auto', defaultLabel: 'Gemini CLI', defaultEffort: '',
  };
}

const READ_TOOLS = ['read_file', 'read_many_files', 'list_directory', 'glob', 'search_file_content', 'grep_search', 'google_web_search', 'web_fetch'];

export function geminiArgs({ room, sessionFile, uploadsDir, side = false, policy }) {
  const args = ['--output-format', 'stream-json', '--prompt', '请处理标准输入中的消息。', '--extensions', 'none', '--allowed-mcp-server-names', '__clawchat_no_mcp__'];
  // 每轮使用独立的 CLI 用户目录，由官方导入功能接上归档的记忆，避免配置和分身互相覆盖。
  if (sessionFile) args.push('--session-file', sessionFile);
  // 每轮明确选模型，切回默认时也不能继承上轮的手动选择。
  args.push('--model', room.models?.gemini || 'auto');
  const readonly = side || room.permission === 'readonly';
  args.push('--approval-mode', readonly ? 'default' : 'yolo');
  if (readonly) args.push('--include-directories', room.cwd);
  if (policy) args.push('--admin-policy', policy);
  if (!readonly && room.permission !== 'full') args.push('--sandbox');
  if (uploadsDir && fs.existsSync(uploadsDir)) {
    args.push('--include-directories', uploadsDir);
    const transcripts = path.join(path.dirname(uploadsDir), 'transcripts');
    if (fs.existsSync(transcripts)) args.push('--include-directories', transcripts);
  }
  return args;
}

function geminiHome() {
  return path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
}

// CLI 新旧版分别使用 JSON / JSONL；只查主会话，不查子任务，也不凭短 ID 猜会话。
function readGeminiSession(file, id) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    let metadata;
    if (file.endsWith('.jsonl')) {
      metadata = {};
      for (const line of raw.split('\n')) {
        try {
          const row = JSON.parse(line);
          if (row.sessionId || row.projectHash) Object.assign(metadata, row);
          if (row.$set) Object.assign(metadata, row.$set);
        } catch {} // 正在追加的末行可能还没写完
      }
    } else {
      const row = JSON.parse(raw);
      metadata = { ...row, ...row.$set };
    }
    return metadata.sessionId === id ? { file, raw, metadata } : null;
  } catch { return null; }
}

export function findGeminiSession(id, home) {
  if (!/^[\w-]+$/.test(id || '')) return null;
  if (!home) {
    for (const ext of ['jsonl', 'json']) {
      const saved = readGeminiSession(path.join(DATA_DIR, 'gemini', 'sessions', `${id}.${ext}`), id);
      if (saved) return saved;
    }
  }
  const roots = home ? [path.join(home, '.gemini', 'tmp'), path.join(home, '.cache', '.gemini', 'tmp')] : [path.join(geminiHome(), 'tmp')];
  for (const root of roots) {
    let projects;
    try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const chats = path.join(root, p.name, 'chats');
      let files;
      try { files = fs.readdirSync(chats); } catch { continue; }
      for (const name of files) {
        if (!/^session-.*\.jsonl?$/.test(name)) continue;
        const saved = readGeminiSession(path.join(chats, name), id);
        if (saved) return saved;
      }
    }
  }
  return null;
}

export function geminiSessionUsage(id) {
  const source = findGeminiSession(id);
  if (!source) return null;
  let messages;
  if (source.file.endsWith('.json')) messages = source.metadata.messages || [];
  else messages = source.raw.split('\n').flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  for (const m of [...messages].reverse()) {
    // 这是最近一次模型调用的上下文用量，不是整轮所有工具调用累加的账单。
    if (m.type === 'gemini' && Number.isFinite(m.tokens?.input)) {
      return { images: 0, used: m.tokens.input + (m.tokens.output || 0) + (m.tokens.thoughts || 0), window: 0 };
    }
  }
  return null;
}

function toolStep(ev) {
  const p = ev.parameters || {};
  const text = String(p.file_path || p.path || p.dir_path || p.pattern || p.query || p.url || ev.tool_name || '');
  switch (ev.tool_name) {
    case 'run_shell_command': return { kind: 'run', text: String(p.command || '') };
    case 'write_file': case 'replace': case 'edit_file': return { kind: 'edit', text };
    case 'read_file': case 'read_many_files': case 'list_directory': return { kind: 'read', text };
    case 'glob': case 'grep_search': case 'search_file_content': return { kind: 'search', text };
    case 'google_web_search': case 'web_fetch': return { kind: 'web', text };
    default: return { kind: 'tool', text: ev.tool_name || '' };
  }
}

function failed(error) {
  return { done: Promise.resolve({ ok: false, error, steps: [], session: null }), kill() {} };
}

export function runGemini(opts, { which, spawnJsonl }) {
  const bin = which('gemini');
  if (!bin) return failed(tr('找不到 gemini 命令，请先安装 Gemini CLI，再运行 gemini 完成登录，或在设置里填写 Gemini API Key'));
  const { room, prompt, systemPrompt = '', images = [], uploadsDir, onStep = () => {}, onActivity, side = false } = opts;
  const session = opts.session;
  const key = geminiKey();
  let temp;
  let settings;
  let policy;
  let sessionFile;
  try {
    const root = path.join(DATA_DIR, 'gemini', 'runs');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    temp = fs.mkdtempSync(path.join(root, 'run-'));
    const configDir = path.join(temp, '.gemini');
    fs.mkdirSync(configDir, { mode: 0o700 });
    settings = path.join(configDir, 'settings.json');
    let auth;
    try { auth = JSON.parse(fs.readFileSync(path.join(geminiHome(), 'settings.json'), 'utf8')).security?.auth; } catch {}
    // 只复制 Google 登录凭据；不复制用户的插件、MCP、hooks 或自定义工具权限。
    if (!key) {
      for (const name of ['oauth_creds.json', 'google_accounts.json']) {
        const original = path.join(geminiHome(), name);
        const cache = path.join(DATA_DIR, 'gemini', 'auth', name);
        const source = fs.existsSync(original) && (!fs.existsSync(cache) || fs.statSync(original).mtimeMs > fs.statSync(cache).mtimeMs) ? original : cache;
        if (fs.existsSync(source)) { fs.copyFileSync(source, path.join(configDir, name)); fs.chmodSync(path.join(configDir, name), 0o600); }
      }
    }
    const readonly = side || room.permission === 'readonly';
    const config = {
      general: { enableAutoUpdate: false },
      hooksConfig: { enabled: false },
      security: { auth: key ? { selectedType: 'gemini-api-key' } : auth || { selectedType: 'oauth-personal' } },
      telemetry: { enabled: false },
      ...(readonly ? { tools: { core: READ_TOOLS, allowed: READ_TOOLS } } : {}),
    };
    fs.writeFileSync(settings, JSON.stringify(config), { mode: 0o600 });
    if (session) {
      const source = findGeminiSession(session);
      if (!source) throw new Error(tr('Gemini session not found：找不到上一轮的记忆'));
      sessionFile = path.join(temp, `history${path.extname(source.file)}`);
      fs.writeFileSync(sessionFile, source.raw, { mode: 0o600 });
    }
    if (readonly) {
      policy = path.join(temp, 'readonly.toml');
      // 管理员级默认拒绝，只有内建只读工具放行；不能被用户的「始终允许」规则覆盖。
      const rules = [{ toolName: '*', decision: 'deny', priority: 998 }, ...READ_TOOLS.map((toolName) => ({ toolName, decision: 'allow', priority: 999 }))];
      fs.writeFileSync(policy, rules.map((r) => `[[rule]]\ntoolName = ${JSON.stringify(r.toolName)}\ndecision = ${JSON.stringify(r.decision)}\npriority = ${r.priority}\n`).join('\n'), { mode: 0o600 });
    }
  } catch (e) {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
    return failed(tr('Gemini 启动失败：{error}', { error: e.message }));
  }

  const steps = [];
  const step = (s) => { steps.push(s); onStep(s); };
  let text = '';
  let sid = session;
  let model = room.models?.gemini || 'auto';
  let completed = false;
  let error = '';
  let stopped = false;
  // 普通文字里的 @ 是群成员、邮箱或代码，不能被 CLI 当作文件或子代理引用。
  const literal = [systemPrompt, prompt].filter(Boolean).join('\n\n').replace(/(?<!\\)@/g, '\\@');
  // 只有显式图片附件走 CLI 的 @文件语法，路径引号兼容空格与 Windows。
  const attached = images.filter((img) => fs.existsSync(img.path)).map((img) => `图 #${img.n}：@"${img.path.replaceAll('\\', '/')}"`);
  const input = [literal, ...attached].filter(Boolean).join('\n\n');
  const proc = spawnJsonl(bin, geminiArgs({ room, sessionFile, uploadsDir, side, policy }), {
    // 只读/分身从空的工作目录启动，把真实项目作为附加只读目录，避免加载项目 hooks。
    cwd: side || room.permission === 'readonly' ? temp : room.cwd, input,
    env: {
      GEMINI_CLI_HOME: temp,
      // CLI 的无界面模式必须信任启动目录；只读任务使用的是上面新建的空目录。
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      GEMINI_TELEMETRY_ENABLED: 'false',
      ...(key ? { GEMINI_API_KEY: key } : {}),
      // macOS 的内建沙盒限制写入项目；其余平台由 CLI 选择可用的沙盒。
      ...(room.permission !== 'full' && room.permission !== 'readonly' && !side && process.platform === 'darwin' ? { SEATBELT_PROFILE: 'permissive-open' } : {}),
    },
    onEvent(ev) {
      onActivity?.();
      switch (ev.type) {
        case 'init': sid = ev.session_id || sid; model = ev.model || model; break;
        case 'message':
          if (ev.role === 'assistant' && typeof ev.content === 'string') {
            text = ev.delta ? text + ev.content : ev.content;
          }
          break;
        case 'tool_use':
          if (text.trim()) step({ kind: 'say', text: text.trim() });
          text = '';
          step(toolStep(ev));
          break;
        case 'error':
          if (ev.severity === 'error') error = ev.message || tr('Gemini 这一轮失败了');
          else if (ev.message) step({ kind: 'tool', text: ev.message });
          break;
        case 'result':
          completed = ev.status === 'success';
          if (!completed) error = ev.error?.message || tr('Gemini 这一轮失败了');
          break;
      }
    },
  });
  const done = proc.done.then(({ code, stderr }) => {
    if (!stopped && code === 0 && completed && !error && sid) {
      if (!side) {
        try {
          const saved = findGeminiSession(sid, temp);
          if (!saved) throw new Error(tr('CLI 没有写出会话文件，请检查 CLI 版本或磁盘空间'));
          const archive = path.join(DATA_DIR, 'gemini', 'sessions');
          fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
          const file = path.join(archive, `${sid}${path.extname(saved.file)}`);
          const pending = `${file}.${path.basename(temp)}.tmp`;
          fs.writeFileSync(pending, saved.raw, { mode: 0o600 });
          fs.renameSync(pending, file);
        } catch (e) {
          // 工具已经执行，不能把整轮退回重跑。由调度层清空会话、下轮带聊天记录恢复。
          const warning = tr('Gemini 已完成这次任务，但记忆没有保存。下次将从聊天记录恢复，请勿重复发送刚才的操作。原因：{message}', { message: e.message });
          return { ok: true, text: text.trim(), steps, session: null, resetSession: true, warning, model, effort: '' };
        }
      }
      return { ok: true, text: text.trim(), steps, session: sid, model, effort: '' };
    }
    const lines = String(stderr || '').trim().split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('at '));
    const detail = lines.find((s) => /^[\w]+Error:/.test(s)) || lines.at(-1);
    return { ok: false, error: stopped ? tr('Gemini 已停止') : error || detail || tr('Gemini 未完成回复，请检查安装、登录和模型权限'), steps, session: sid };
  }).finally(() => {
    try {
      if (!key) {
        const cache = path.join(DATA_DIR, 'gemini', 'auth');
        fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
        for (const name of ['oauth_creds.json', 'google_accounts.json']) {
          const file = path.join(temp, '.gemini', name);
          if (fs.existsSync(file)) { fs.copyFileSync(file, path.join(cache, name)); fs.chmodSync(path.join(cache, name), 0o600); }
        }
      }
    } catch (e) { console.error('[clawchat] Gemini 登录缓存保存失败：', e.message); }
    finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
  return { done, kill() { stopped = true; proc.kill(); } };
}
