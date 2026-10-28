import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, execFileSync } from 'node:child_process';

export const AGENTS = {
  claude: { id: 'claude', name: 'Claude', label: 'Claude', fullName: 'Claude（Anthropic 的 Claude Code）', engine: 'claude' },
  gpt: { id: 'gpt', name: 'GPT', label: 'GPT (Codex)', fullName: 'GPT（OpenAI 的 Codex）', engine: 'codex' },
};

// 「项目内放手干」模式下，Claude 沙盒里的命令只能访问这些开发常用网站（装依赖、拉代码）
const DEV_DOMAINS = [
  'registry.npmjs.org', '*.npmjs.org', 'registry.yarnpkg.com', 'registry.npmmirror.com', '*.npmmirror.com',
  'pypi.org', 'files.pythonhosted.org', 'pypi.tuna.tsinghua.edu.cn', 'mirrors.aliyun.com',
  'github.com', '*.github.com', '*.githubusercontent.com',
  'crates.io', '*.crates.io', 'proxy.golang.org', 'sum.golang.org', 'goproxy.cn',
  'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
];

// 从 .app 启动时 PATH 很短，找不到 claude / codex，所以补上登录 shell 的 PATH 和常见目录
export function setupPath() {
  const home = os.homedir();
  let shellPath = '';
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__CLAWCHAT__%s__CLAWCHAT__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    shellPath = out.match(/__CLAWCHAT__(.*?)__CLAWCHAT__/s)?.[1] || '';
  } catch {}
  const extra = [
    path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin',
    path.join(home, '.npm-global/bin'), path.join(home, '.bun/bin'),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
  const parts = [...shellPath.split(':'), ...(process.env.PATH || '').split(':'), ...extra].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(':');
}

export function which(name) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

// 用别名，Claude Code 会解析成当前最新的版本（实际用的版本会记在每条回复上）
export const CLAUDE_MODELS = [
  { id: 'fable', name: 'Fable', description: '最强' },
  { id: 'opus', name: 'Opus', description: '又强又稳' },
  { id: 'sonnet', name: 'Sonnet', description: '均衡' },
  { id: 'haiku', name: 'Haiku', description: '最快' },
];

// claude-opus-5-5 → Opus 5.5
export function prettyClaudeModel(id) {
  const m = String(id || '').match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  const alias = CLAUDE_MODELS.find((x) => x.id === id);
  return alias ? alias.name : String(id || '');
}

// 别名（opus 等）现在对应哪个版本：Claude Code 程序里带着一张 latest_per_family 表，直接读，不花额度
const aliasCache = { path: null, map: {} };
async function claudeAliases(bin) {
  let real = bin;
  try {
    real = fs.realpathSync(bin);
  } catch {}
  if (aliasCache.path === real) return aliasCache.map;
  const { stdout } = await run('grep', ['-aoE', 'latest_per_family:\\{[^}]*\\}', real], 60000);
  const map = {};
  for (const m of stdout.matchAll(/(\w+):"(claude-[a-z]+-\d+-\d+)"/g)) map[m[1]] = m[2];
  aliasCache.path = real;
  aliasCache.map = map;
  return map;
}

function claudeDefaultModel() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).model || '';
  } catch {
    return '';
  }
}

// 「默认」= Claude Code 设置里的模型；设置里没写就用 Claude Code 自己的 default
export function claudeModel(room) {
  return room.models?.claude || claudeDefaultModel() || 'default';
}

// 「默认」= Codex 配置里的模型；配置里没写就不传，让 Codex 自己决定
export function codexModel(room) {
  return room.models?.gpt || codexDefaultModel();
}

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) =>
    execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err }),
    ),
  );
}

// Codex 能用哪些模型取决于命令行版本和账号，直接问它要模型目录（OpenAI 出了新模型，这里会自动出现）
async function codexModels(bin) {
  const { stdout } = await run(bin, ['debug', 'models']);
  try {
    return (JSON.parse(stdout).models || [])
      .filter((m) => m.visibility === 'list')
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => ({
        id: m.slug,
        name: m.display_name || m.slug,
        description: m.description || '',
        // 这个模型支持的思考强度（不同模型不一样，比如 Luna 没有 ultra）
        efforts: (m.supported_reasoning_levels || []).map((x) => x.effort).filter(Boolean),
        defaultEffort: m.default_reasoning_level || '',
      }));
  } catch {
    return [];
  }
}

function codexConfig(key) {
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    return fs.readFileSync(path.join(home, 'config.toml'), 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1] || '';
  } catch {
    return '';
  }
}

function codexDefaultModel() {
  return codexConfig('model');
}

// 思考强度：Claude Code 的 --effort 和 Codex 的 model_reasoning_effort
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function claudeDefaultEffort() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).effortLevel || '';
  } catch {
    return '';
  }
}

// 「默认」= 各自设置里的强度；每轮都明确传，免得接着旧会话时沿用上次的
export function claudeEffort(room) {
  return room.efforts?.claude || claudeDefaultEffort();
}

export function codexEffort(room) {
  return room.efforts?.gpt || codexConfig('model_reasoning_effort');
}

export async function detectEngines() {
  const out = {};
  for (const bin of ['claude', 'codex']) {
    const p = which(bin);
    const version = p ? (await run(p, ['--version'], 15000)).stdout.trim().split('\n')[0] || null : null;
    out[bin] = { path: p, version, ok: !!p };
  }
  // 每个选项都带上现在对应的具体版本，界面上显示成「Opus 5.5」
  const aliases = out.claude.path ? await claudeAliases(out.claude.path) : {};
  out.claude.models = CLAUDE_MODELS.map((m) => ({ ...m, model: aliases[m.id] || '', name: aliases[m.id] ? prettyClaudeModel(aliases[m.id]) : m.name }));
  out.claude.defaultModel = claudeDefaultModel();
  out.claude.defaultLabel = prettyClaudeModel(aliases[out.claude.defaultModel] || out.claude.defaultModel);
  out.codex.models = out.codex.path ? await codexModels(out.codex.path) : [];
  out.codex.defaultModel = codexDefaultModel();
  out.codex.defaultLabel = out.codex.models.find((m) => m.id === out.codex.defaultModel)?.name || out.codex.defaultModel;
  out.claude.efforts = CLAUDE_EFFORTS;
  out.claude.defaultEffort = claudeDefaultEffort();
  out.codex.defaultEffort = codexConfig('model_reasoning_effort');
  return out;
}

// 更新命令行（新模型常常要新版本才看得到）
export async function updateEngine(bin) {
  const p = which(bin);
  if (!p) return { ok: false, output: `找不到 ${bin} 命令` };
  const res = await run(p, ['update'], 5 * 60 * 1000);
  const output = `${res.stdout}\n${res.stderr}`.trim().split('\n').slice(-6).join('\n');
  return { ok: res.ok, output };
}

// 用一句最短的话试一下某个模型能不能用：返回实际用的模型，或者报错原因
export function probeModel(agentId, id) {
  const engine = AGENTS[agentId].engine;
  const bin = which(engine);
  if (!bin) return Promise.resolve({ ok: false, error: `找不到 ${engine} 命令` });
  const args =
    engine === 'claude'
      ? ['-p', '--model', id, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--no-session-persistence']
      : ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-m', id, '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '-c', 'suppress_unstable_features_warning=true', '-'];
  let resolved = engine === 'codex' ? id : '';
  let ok = false;
  let error = '';
  const proc = spawnJsonl(bin, args, {
    cwd: os.tmpdir(),
    input: '只回复 ok',
    onEvent(ev) {
      if (ev.type === 'system' && ev.subtype === 'init' && ev.model) resolved = ev.model;
      if (ev.type === 'result') ok = ev.subtype === 'success' && !ev.is_error;
      if (ev.type === 'result' && !ok) error = String(ev.result || ev.subtype || '');
      if (ev.type === 'turn.completed') ok = true;
      if (ev.type === 'turn.failed') error = codexError(ev.error?.message || '');
      if (ev.type === 'error') error = codexError(ev.message || '');
    },
  });
  const timer = setTimeout(proc.kill, 90 * 1000);
  return proc.done.then(({ stderr }) => {
    clearTimeout(timer);
    return ok ? { ok: true, model: resolved } : { ok: false, error: error || lastLine(stderr) || '这个模型用不了' };
  });
}

// 启动子进程，逐行解析 JSONL 输出
function spawnJsonl(cmd, args, { cwd, input, onEvent }) {
  const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let buf = '';
  let stderr = '';
  const flush = (all) => {
    let i;
    while ((i = buf.indexOf('\n')) >= 0 || (all && buf.trim())) {
      const line = (i >= 0 ? buf.slice(0, i) : buf).trim();
      buf = i >= 0 ? buf.slice(i + 1) : '';
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        onEvent(ev);
      } catch (err) {
        console.error('[clawchat] 处理事件出错', err);
      }
    }
  };
  child.stdout.on('data', (d) => {
    buf += d;
    flush(false);
  });
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-6000);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const done = new Promise((resolve) => {
    child.on('error', (err) => resolve({ code: -1, stderr: String(err.message || err) }));
    child.on('close', (code, signal) => {
      flush(true);
      resolve({ code, signal, stderr });
    });
  });
  // Codex 会把命令放进单独的进程组，只杀进程组会留下孤儿进程，所以先找出整棵进程树再逐个结束
  const kill = () => {
    const pids = [child.pid, ...descendants(child.pid)];
    for (const p of pids) {
      try {
        process.kill(p, 'SIGTERM');
      } catch {}
    }
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    setTimeout(() => {
      for (const p of pids) {
        try {
          process.kill(p, 'SIGKILL');
        } catch {}
      }
    }, 3000).unref();
  };
  return { done, kill };
}

function descendants(rootPid) {
  let out = '';
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const result = [];
  const stack = [rootPid];
  while (stack.length) {
    for (const c of children.get(stack.pop()) || []) {
      result.push(c);
      stack.push(c);
    }
  }
  return result;
}

function failed(error) {
  return { done: Promise.resolve({ ok: false, error, steps: [], session: null }), kill() {} };
}

function rel(p, cwd) {
  if (!p) return '';
  const r = path.relative(cwd, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p;
}

function lastLine(s) {
  return (s || '').trim().split('\n').filter(Boolean).pop() || '';
}

export function unwrapShell(cmd) {
  if (Array.isArray(cmd)) cmd = cmd.join(' ');
  const m = String(cmd || '').match(/^\/bin\/(?:zsh|bash|sh) -lc (['"])([\s\S]*)\1$/);
  if (!m) return String(cmd || '');
  return m[1] === '"' ? m[2].replace(/\\(["\\$`])/g, '$1') : m[2];
}

function dropFinalSay(steps, finalText) {
  const t = (finalText || '').trim();
  const out = [...steps];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].kind === 'say' && out[i].text.trim() === t) {
      out.splice(i, 1);
      break;
    }
  }
  return out;
}

// ---------------- Claude Code ----------------

function claudeArgs(room, session, systemPrompt, uploadsDir) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--append-system-prompt', systemPrompt];
  if (session) args.push('--resume', session);
  if (uploadsDir && fs.existsSync(uploadsDir)) args.push('--add-dir', uploadsDir); // 让它能读到原图文件
  // 每轮都明确传模型：接着旧会话时不传的话，Claude Code 会沿用这个会话上次用的模型，切回「默认」就不生效
  args.push('--model', claudeModel(room));
  const effort = claudeEffort(room);
  if (effort) args.push('--effort', effort);
  if (room.permission === 'full') {
    args.push('--dangerously-skip-permissions');
  } else if (room.permission === 'readonly') {
    args.push('--permission-mode', 'dontAsk', '--allowedTools', 'Read,Grep,Glob,WebSearch,WebFetch');
  } else {
    const settings = {
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: DEV_DOMAINS },
      },
    };
    args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'WebSearch,WebFetch', '--settings', JSON.stringify(settings));
  }
  return args;
}

function describeClaudeTool(block, cwd) {
  const i = block.input || {};
  switch (block.name) {
    case 'Bash':
      return { kind: 'run', text: i.command || '' };
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { kind: 'edit', text: rel(i.file_path || i.notebook_path, cwd) };
    case 'Read':
      return { kind: 'read', text: rel(i.file_path, cwd) };
    case 'Grep':
    case 'Glob':
      return { kind: 'search', text: i.pattern || '' };
    case 'WebSearch':
      return { kind: 'web', text: i.query || '' };
    case 'WebFetch':
      return { kind: 'web', text: i.url || '' };
    case 'Task':
    case 'Agent':
      return { kind: 'task', text: i.description || String(i.prompt || '').slice(0, 80) };
    case 'TodoWrite':
      return { kind: 'todo', text: (i.todos || []).map((t) => `${t.status === 'completed' ? '✓' : '·'} ${t.content}`).join('\n') };
    default:
      return { kind: 'tool', text: block.name };
  }
}

// 一条用户消息：文字 + 图片（base64），每张图前面加一行说明它是 #几
function claudeInput(prompt, images) {
  const content = [{ type: 'text', text: prompt }];
  for (const img of images) {
    let data;
    try {
      data = fs.readFileSync(img.path).toString('base64');
    } catch {
      continue;
    }
    content.push({ type: 'text', text: `图 #${img.n}：${img.label}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.type, data } });
  }
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

function runClaude({ room, prompt, images = [], uploadsDir, session, systemPrompt, onStep }) {
  const bin = which('claude');
  if (!bin) return failed('找不到 claude 命令，请先安装并登录 Claude Code');
  let sid = session;
  let result = null;
  let model = claudeModel(room);
  const effort = claudeEffort(room); // 开始时就记下，中途切换不影响这一轮
  const steps = [];
  const step = (s) => {
    steps.push(s);
    onStep(s);
  };
  const proc = spawnJsonl(bin, claudeArgs(room, session, systemPrompt, uploadsDir), {
    cwd: room.cwd,
    input: claudeInput(prompt, images),
    onEvent(ev) {
      if (ev.session_id) sid = ev.session_id;
      if (ev.type === 'system' && ev.subtype === 'init' && ev.model) model = ev.model;
      if (ev.parent_tool_use_id) return; // 子任务内部的细节不展示
      if (ev.type === 'assistant') {
        for (const b of ev.message?.content || []) {
          if (b.type === 'text' && b.text?.trim()) step({ kind: 'say', text: b.text.trim() });
          else if (b.type === 'thinking' && b.thinking?.trim()) step({ kind: 'think', text: b.thinking.trim() });
          else if (b.type === 'tool_use') step(describeClaudeTool(b, room.cwd));
        }
      } else if (ev.type === 'result') {
        result = ev;
      }
    },
  });
  const done = proc.done.then(({ code, stderr }) => {
    if (result && result.subtype === 'success' && !result.is_error) {
      const text = String(result.result || '');
      return { ok: true, text, steps: dropFinalSay(steps, text), session: sid, model, effort };
    }
    const error = (result && (result.result || result.subtype)) || lastLine(stderr) || `claude 异常退出（${code}）`;
    return { ok: false, error: String(error), steps, session: sid };
  });
  return { done, kill: proc.kill };
}

// ---------------- Codex ----------------

function codexArgs(room, session, images) {
  const args = ['exec'];
  if (session) args.push('resume', session);
  for (const img of images) args.push('-i', img.path); // 按 #1、#2… 的顺序附上
  args.push('--json', '--skip-git-repo-check', '-c', 'suppress_unstable_features_warning=true');
  const model = codexModel(room);
  if (model) args.push('-m', model);
  const effort = codexEffort(room);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (room.permission === 'full') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (room.permission === 'readonly') {
    args.push('-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"');
  } else {
    args.push('-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=true');
  }
  args.push('-'); // 从 stdin 读取消息
  return args;
}

function codexError(msg) {
  try {
    const inner = JSON.parse(msg);
    return inner?.error?.message || inner?.message || msg;
  } catch {
    return msg;
  }
}

function runCodex({ room, prompt, images = [], session, systemPrompt, onStep }) {
  const bin = which('codex');
  if (!bin) return failed('找不到 codex 命令，请先安装并登录 Codex');
  let sid = session;
  let completed = false;
  let error = null;
  let lastMessage = '';
  const steps = [];
  const step = (s) => {
    steps.push(s);
    onStep(s);
  };
  // Codex 没有追加系统提示的参数，新会话时把群聊说明放在第一条消息里
  const input = session ? prompt : `${systemPrompt}\n\n${prompt}`;
  // Codex 的事件里没有模型名，开始时就记下用的哪个（中途切换模型不影响这一轮）
  const model = codexModel(room);
  const effort = codexEffort(room);
  const existing = images.filter((img) => fs.existsSync(img.path));
  const proc = spawnJsonl(bin, codexArgs(room, session, existing), {
    cwd: room.cwd,
    input,
    onEvent(ev) {
      const it = ev.item || {};
      switch (ev.type) {
        case 'thread.started':
          sid = ev.thread_id || sid;
          break;
        case 'item.started':
          if (it.type === 'command_execution') step({ kind: 'run', text: unwrapShell(it.command) });
          else if (it.type === 'mcp_tool_call') step({ kind: 'tool', text: [it.server, it.tool].filter(Boolean).join('.') });
          break;
        case 'item.completed':
          if (it.type === 'agent_message' && it.text?.trim()) {
            lastMessage = it.text.trim();
            step({ kind: 'say', text: lastMessage });
          } else if (it.type === 'file_change') {
            step({ kind: 'edit', text: (it.changes || []).map((c) => rel(c.path, room.cwd)).join(', ') });
          } else if (it.type === 'reasoning' && (it.text || '').trim()) {
            step({ kind: 'think', text: it.text.trim() }); // GPT 的思考摘要
          } else if (it.type === 'web_search') {
            step({ kind: 'web', text: it.query || '' });
          } else if (it.type === 'todo_list') {
            step({ kind: 'todo', text: (it.items || []).map((t) => `${t.completed ? '✓' : '·'} ${t.text}`).join('\n') });
          }
          break;
        case 'turn.completed':
          completed = true;
          break;
        case 'turn.failed':
          error = codexError(ev.error?.message || 'Codex 这一轮失败了');
          break;
        case 'error':
          error = codexError(ev.message || '');
          break;
      }
    },
  });
  const done = proc.done.then(({ code, stderr }) => {
    if (completed) return { ok: true, text: lastMessage, steps: dropFinalSay(steps, lastMessage), session: sid, model, effort };
    return { ok: false, error: error || lastLine(stderr) || `codex 异常退出（${code}）`, steps, session: sid };
  });
  return { done, kill: proc.kill };
}

export function runAgent(agentId, opts) {
  return AGENTS[agentId].engine === 'claude' ? runClaude(opts) : runCodex(opts);
}
