import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, readConfig } from './store.js';

// 官方 CLI 保留工具调用和 Google 登录，不把 Gemini 当成只能回文字的聊天接口。
// 协议：https://geminicli.com/docs/cli/headless/
export const GEMINI_AGENT = { id: 'gemini', name: 'Gemini', label: 'Gemini', fullName: 'Gemini（Google 的 Gemini CLI）', engine: 'gemini' };
export const GEMINI_MODELS = [
  { id: 'auto', name: 'Gemini Auto', description: '由 Gemini CLI 自动选择' },
  { id: 'pro', name: 'Gemini Pro', description: '由 Gemini CLI 选择 Pro 模型' },
  { id: 'flash', name: 'Gemini Flash', description: '由 Gemini CLI 选择 Flash 模型' },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', description: '需要账号有对应模型权限' },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', description: '需要账号有对应模型权限' },
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
    models: GEMINI_MODELS, defaultModel: 'auto', defaultLabel: 'Gemini CLI', defaultEffort: '',
  };
}

const READ_TOOLS = ['read_file', 'read_many_files', 'list_directory', 'glob', 'search_file_content', 'grep_search', 'google_web_search', 'web_fetch'];

export function geminiArgs({ room, session, uploadsDir, side = false, policy }) {
  const args = ['--output-format', 'stream-json', '--prompt', '请处理标准输入中的消息。', '--extensions', 'none'];
  if (session) args.push('--resume', session);
  // 每轮明确选模型，切回默认时也不能继承上轮的手动选择。
  args.push('--model', room.models?.gemini || 'auto');
  const readonly = side || room.permission === 'readonly';
  args.push('--approval-mode', readonly ? 'default' : 'yolo');
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
export function findGeminiSession(id) {
  if (!/^[\w-]+$/.test(id || '')) return null;
  const root = path.join(geminiHome(), 'tmp');
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const chats = path.join(root, p.name, 'chats');
    let files;
    try { files = fs.readdirSync(chats); } catch { continue; }
    for (const name of files) {
      if (!/^session-.*\.jsonl?$/.test(name) || !name.includes(id.slice(0, 8))) continue;
      const file = path.join(chats, name);
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const first = JSON.parse(name.endsWith('.jsonl') ? raw.split('\n')[0] : raw);
        if (first.sessionId === id) return { file, raw, metadata: first };
      } catch {}
    }
  }
  return null;
}

// 分身复制会话文件、换 ID；绝不直接 --resume 本体的会话，否则私聊会写回本体。
export function forkGeminiSession(id) {
  const source = findGeminiSession(id);
  if (!source) throw new Error('找不到 Gemini 的本体会话，暂时无法创建分身；本体的任务不受影响');
  const fork = crypto.randomUUID();
  const jsonl = source.file.endsWith('.jsonl');
  const file = path.join(path.dirname(source.file), `session-${new Date().toISOString().slice(0, 16).replaceAll(':', '-')}-${fork.slice(0, 8)}.${jsonl ? 'jsonl' : 'json'}`);
  const replace = (record) => {
    if (record.sessionId === id) record.sessionId = fork;
    if (record.$set?.sessionId === id) record.$set.sessionId = fork;
    return record;
  };
  let raw;
  if (jsonl) {
    // 本体可能正在追加，末尾未写完的一行不算有效记录。
    raw = source.raw.split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.stringify(replace(JSON.parse(line)))]; } catch { return []; }
    }).join('\n') + '\n';
  } else raw = JSON.stringify(replace(JSON.parse(source.raw)));
  fs.writeFileSync(file, raw, { mode: 0o600, flag: 'wx' });
  return { session: fork, cleanup() { fs.rmSync(file, { force: true }); fs.rmSync(file.replace(/\.json$/, '.jsonl'), { force: true }); } };
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
  if (!bin) return failed('找不到 gemini 命令，请先安装 Gemini CLI，并运行 gemini 完成 Google 登录，或在设置中填写 API Key');
  const { room, prompt, systemPrompt = '', images = [], uploadsDir, onStep = () => {}, onActivity, side = false } = opts;
  let session = opts.session;
  let fork;
  let temp;
  let settings;
  let policy;
  try {
    if (side && session) { fork = forkGeminiSession(session); session = fork.session; }
    const root = path.join(DATA_DIR, 'gemini', 'runs');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    temp = fs.mkdtempSync(path.join(root, 'run-'));
    settings = path.join(temp, 'settings.json');
    let base = {};
    const systemFile = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || (process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'gemini-cli', 'settings.json') : process.platform === 'darwin' ? '/Library/Application Support/GeminiCli/settings.json' : '/etc/gemini-cli/settings.json');
    if (fs.existsSync(systemFile)) base = JSON.parse(fs.readFileSync(systemFile, 'utf8'));
    const key = geminiKey();
    const readonly = side || room.permission === 'readonly';
    const config = {
      ...base,
      general: { ...base.general, enableAutoUpdate: false },
      hooksConfig: { ...base.hooksConfig, enabled: false },
      admin: { ...base.admin, mcp: { ...base.admin?.mcp, enabled: false }, extensions: { ...base.admin?.extensions, enabled: false } },
      ...(key ? { security: { ...base.security, auth: { ...base.security?.auth, selectedType: 'gemini-api-key' } } } : {}),
      ...(readonly ? { tools: { ...base.tools, core: READ_TOOLS, allowed: READ_TOOLS, discoveryCommand: '', callCommand: '' } } : {}),
    };
    fs.writeFileSync(settings, JSON.stringify(config), { mode: 0o600 });
    if (readonly) {
      policy = path.join(temp, 'readonly.toml');
      // 管理员级默认拒绝，只有内建只读工具放行；不能被用户的「始终允许」规则覆盖。
      const rules = [{ toolName: '*', decision: 'deny', priority: 998 }, ...READ_TOOLS.map((toolName) => ({ toolName, decision: 'allow', priority: 999 }))];
      fs.writeFileSync(policy, rules.map((r) => `[[rule]]\ntoolName = ${JSON.stringify(r.toolName)}\ndecision = ${JSON.stringify(r.decision)}\npriority = ${r.priority}\n`).join('\n'), { mode: 0o600 });
    }
  } catch (e) {
    fork?.cleanup();
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
    return failed(`Gemini 启动失败：${e.message}`);
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
  const key = geminiKey();
  const proc = spawnJsonl(bin, geminiArgs({ room, session, uploadsDir, side, policy }), {
    cwd: room.cwd, input,
    env: {
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings,
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
          if (ev.severity === 'error') error = ev.message || 'Gemini 这一轮失败了';
          else if (ev.message) step({ kind: 'tool', text: ev.message });
          break;
        case 'result':
          completed = ev.status === 'success';
          if (!completed) error = ev.error?.message || 'Gemini 这一轮失败了';
          break;
      }
    },
  });
  const done = proc.done.then(({ code, stderr }) => {
    if (!stopped && code === 0 && completed && !error && sid) {
      return { ok: true, text: text.trim(), steps, session: sid, model, effort: '' };
    }
    return { ok: false, error: stopped ? 'Gemini 已停止' : error || String(stderr || '').trim().split('\n').pop() || 'Gemini 未完成回复，请检查安装、登录和模型权限', steps, session: sid };
  }).finally(() => {
    fork?.cleanup();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { done, kill() { stopped = true; proc.kill(); } };
}
