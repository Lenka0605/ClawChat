import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { DATA_DIR, readConfig, saveConfig } from './store.js';
import { PROVIDERS, providerKey, providerEnv, providerModel, providerModelArg, providerModels, fetchProviderModels } from './providers.js';
import { GEMINI_AGENT, detectGemini, geminiKey, geminiSessionUsage, runGemini } from './gemini.js';
import { tr } from './i18n.js';
import { runCodexServer, storedCodexUsage } from './codex.js';

export const IS_WIN = process.platform === 'win32';

export const AGENTS = {
  claude: { id: 'claude', name: 'Claude', label: 'Claude', fullName: 'Claude（Anthropic 的 Claude Code）', engine: 'claude' },
  gpt: { id: 'gpt', name: 'ChatGPT', label: 'ChatGPT', fullName: 'ChatGPT（OpenAI 的 Codex）', engine: 'codex' },
  // DeepSeek 没有自己的命令行：借 Claude Code 干活，把接口换成 DeepSeek 的 Anthropic 兼容接口（DeepSeek 官方文档推荐的接法）
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    label: 'DeepSeek',
    fullName: 'DeepSeek（深度求索的 DeepSeek）',
    engine: 'deepseek',
    provider: 'deepseek',
    note: '你是借 Claude Code 这个工具在干活，但你是 DeepSeek，不是 Claude；群里叫 Claude 的是另一位成员。',
  },
  // GLM 和 DeepSeek 一样：借 Claude Code 干活，接口换成智谱的 Anthropic 兼容接口
  glm: {
    id: 'glm',
    name: 'GLM',
    label: 'GLM',
    fullName: 'GLM（智谱的 GLM）',
    engine: 'glm',
    provider: 'glm',
    note: '你是借 Claude Code 这个工具在干活，但你是 GLM（智谱的模型），不是 Claude；群里叫 Claude 的是另一位成员。',
  },
  gemini: GEMINI_AGENT,
};

// 五位固定成员；@ 它们时认的写法（小写）
export const BASE_AGENTS = ['claude', 'gpt', 'deepseek', 'glm', 'gemini'];
const BASE_ALIASES = { claude: ['claude', '克劳德'], gpt: ['chatgpt', 'gpt', 'codex'], deepseek: ['deepseek', '深度求索'], glm: ['glm', '智谱'], gemini: ['gemini', '谷歌'] };
for (const a of BASE_AGENTS) AGENTS[a].aliases = BASE_ALIASES[a];

// 多开：同一位再开一个独立的成员（比如 ChatGPT2），用同一个程序和账号，但有自己的会话（记忆）、模型设置和私聊。
// 存在 config.json 的 extraMembers 里：[{ id: 'gpt2', base: 'gpt', n: 2 }]
function makeClone(base, n) {
  const b = AGENTS[base];
  const name = `${b.name}${n}`;
  return {
    ...b,
    id: `${base}${n}`,
    base,
    n,
    name,
    label: name,
    fullName: `${name}（${b.name} 的 ${n} 号，${b.fullName.replace(/^[^（]*（|）$/g, '')}）`,
    note:
      `你是 ${name}，是 ${b.name} 的 ${n} 号：和群里的 ${b.name} 是两个独立的成员，各有各的记忆和活。别人写 @${name} 才是叫你，写 @${b.name} 叫的是另一位。` +
      (b.note ? b.note.replace(/^你是/, '另外，你是') : ''),
    aliases: [name.toLowerCase(), ...BASE_ALIASES[base].map((x) => `${x}${n}`)],
  };
}

export function syncExtraMembers() {
  for (const id of Object.keys(AGENTS)) if (AGENTS[id].base) delete AGENTS[id];
  for (const m of readConfig().extraMembers || []) {
    if (BASE_AGENTS.includes(m.base) && Number.isInteger(m.n) && m.n >= 2 && m.n <= 9) AGENTS[`${m.base}${m.n}`] = makeClone(m.base, m.n);
  }
  return AGENTS;
}
syncExtraMembers();

// 再开一位：编号接着往后排（2 号、3 号…），最多到 9 号
export function addExtraMember(base) {
  if (!BASE_AGENTS.includes(base)) throw new Error(tr('不认识这位成员'));
  const list = readConfig().extraMembers || [];
  const used = new Set(list.filter((m) => m.base === base).map((m) => m.n));
  let n = 2;
  while (used.has(n)) n++;
  if (n > 9) throw new Error(tr('{name} 最多开到 9 号', { name: AGENTS[base].name }));
  saveConfig({ extraMembers: [...list, { id: `${base}${n}`, base, n }] });
  syncExtraMembers();
  return AGENTS[`${base}${n}`];
}

// 群里勾上了还没开出来的多开成员（比如 gpt2）：按这个编号开出来；不认识的编号返回 null
export function ensureExtraMember(id) {
  if (AGENTS[id]) return AGENTS[id];
  const m = /^([a-z]+)([2-9])$/.exec(String(id));
  if (!m || !BASE_AGENTS.includes(m[1])) return null;
  const list = readConfig().extraMembers || [];
  saveConfig({ extraMembers: [...list.filter((x) => x.id !== id), { id, base: m[1], n: Number(m[2]) }] });
  syncExtraMembers();
  return AGENTS[id];
}

export function removeExtraMember(id) {
  const list = readConfig().extraMembers || [];
  saveConfig({ extraMembers: list.filter((m) => m.id !== id) });
  syncExtraMembers();
}

// 多开的那位跑起来时，把它自己的模型、思考强度、速度放到本体的位置上：下面按本体读设置的代码不用改
export function cloneRoom(room, agentId) {
  const base = AGENTS[agentId]?.base;
  if (!base || !room) return room;
  const pick = (map) => ({ ...(map || {}), [base]: map?.[agentId] ?? '' });
  return { ...room, models: pick(room.models), efforts: pick(room.efforts), fast: { ...(room.fast || {}), [base]: !!room.fast?.[agentId] } };
}

// 这一位是不是借外部接口跑的（DeepSeek、GLM），是的话返回对应的提供方
export function agentProvider(agentId) {
  const p = AGENTS[agentId]?.provider;
  return p ? PROVIDERS[p] || null : null;
}

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
  if (IS_WIN) {
    // Windows：补上 Claude Code 官方安装脚本、npm 全局命令、WinGet、Node.js、Git 的默认目录（刚装好、PATH 还没刷新时也能找到）
    const env = process.env;
    const extra = [
      path.join(home, '.local', 'bin'),
      env.APPDATA && path.join(env.APPDATA, 'npm'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'agy', 'bin'),
      path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
      path.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd'),
    ];
    const parts = [...(env.PATH || '').split(';'), ...extra].filter(Boolean);
    env.PATH = [...new Set(parts)].join(';');
    return;
  }
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
  // Windows 上的命令带扩展名：官方安装的是 claude.exe，npm 装的是 claude.cmd
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        fs.accessSync(p, IS_WIN ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

// npm 在 Windows 上生成的 .cmd 包装脚本里，真正要跑的文件（一般是 JS，也可能直接是 .exe）。
// 脚本里常常先写一句「npm 目录里有 node.exe 就用它」（IF EXIST "%dp0%\node.exe"），那个 node.exe 不是要找的：
// 跳过它，优先取 JS（用 ClawChat 自己的 node 跑）；没有 JS、脚本指向的就是一个独立的 .exe 时才用那个 .exe
export function cmdShimTarget(text) {
  const found = [...String(text || '').matchAll(/"%~?dp0%?\\([^"%]+?\.(?:[cm]?js|exe))"/gi)].map((m) => m[1]).filter((p) => !/(^|\\)node\.exe$/i.test(p));
  return found.find((p) => /\.[cm]?js$/i.test(p)) || found[0] || null;
}

// 怎么启动一个命令。Node 不能直接启动 .cmd（要经过 cmd.exe，参数里的换行和引号会被弄坏），
// 所以找到它背后的 JS 文件，用 node 直接跑
function launcher(bin) {
  if (!IS_WIN || !/\.(cmd|bat)$/i.test(bin)) return { cmd: bin, pre: [] };
  try {
    const target = cmdShimTarget(fs.readFileSync(bin, 'utf8'));
    const file = target && path.join(path.dirname(bin), target);
    if (file && /\.exe$/i.test(file)) return { cmd: file, pre: [] };
    if (file) return { cmd: process.execPath, pre: [file] };
  } catch {}
  return { cmd: bin, pre: [] };
}

// 用别名，Claude Code 会解析成当前最新的版本（实际用的版本会记在每条回复上）
// 说明写成 getter：模块加载时还不知道界面语言，用到时再翻译
export const CLAUDE_MODELS = [
  { id: 'fable', name: 'Fable', get description() { return tr('最强'); } },
  { id: 'opus', name: 'Opus', get description() { return tr('又强又稳'); } },
  { id: 'sonnet', name: 'Sonnet', get description() { return tr('均衡'); } },
  { id: 'haiku', name: 'Haiku', get description() { return tr('最快'); } },
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
  let real = launcher(bin).pre[0] || bin; // Windows 上 npm 装的是 .cmd，表在它指向的 cli.js 里
  try {
    real = fs.realpathSync(real);
  } catch {}
  if (aliasCache.path === real) return aliasCache.map;
  const stdout = IS_WIN
    ? await scanFile(real, /latest_per_family:\{[^}]*\}/g)
    : (await run('grep', ['-aoE', 'latest_per_family:\\{[^}]*\\}', real], 60000)).stdout;
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

// Windows 上没有 grep：分块读文件找匹配（相邻两块留一段重叠，免得正好被切断）
function scanFile(file, re) {
  return new Promise((resolve) => {
    const found = new Set();
    let tail = '';
    const stream = fs.createReadStream(file, { encoding: 'latin1', highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => {
      const text = tail + chunk;
      for (const m of text.matchAll(re)) found.add(m[0]);
      tail = text.slice(-4096);
    });
    stream.on('end', () => resolve([...found].join('\n')));
    stream.on('error', () => resolve(''));
  });
}

function run(cmd, args, timeout = 30000) {
  const { cmd: exe, pre } = launcher(cmd);
  return new Promise((resolve) => {
    try {
      execFile(exe, [...pre, ...args], { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
        resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err }),
      );
    } catch (err) {
      // Windows 上直接启动 .cmd 会立刻报 EINVAL：当成这个命令用不了，别让整个检测失败
      resolve({ ok: false, stdout: '', stderr: String(err.message || err), error: err });
    }
  });
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
        // 支持快速模式的模型会写着「2x speed, increased usage」这样的说明；没有就是不支持
        fast: (m.service_tiers || []).find((t) => t.id === 'priority' || t.id === 'fast')?.description || '',
      }));
  } catch {
    return [];
  }
}

function codexConfigText() {
  try {
    return fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8');
  } catch {
    return '';
  }
}

function codexConfig(key) {
  return codexConfigText().match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1] || '';
}

// Codex 配置里自己选过 Windows 沙盒没有（[windows] 下的 sandbox，或者顶层的 windows.sandbox）
export function codexPicksWindowsSandbox(text = codexConfigText()) {
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(/^\[([^\]]+)\]/);
    if (head) section = head[1].trim();
    else if ((section === 'windows' && /^sandbox\s*=/.test(line)) || (!section && /^windows\.sandbox\s*=/.test(line))) return true;
  }
  return false;
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

// ---------------- 会话记录有多大 ----------------

// Codex 会把看过的图整张存进会话记录（~/.codex/sessions/年/月/日/rollout-…-<会话 id>.jsonl），每一轮都要整个重发。
// 记录太大（20MB 左右）就会卡住不动，所以要看着它的大小
const codexFiles = new Map();
function codexSessionFile(id) {
  if (codexFiles.has(id)) return codexFiles.get(id);
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const newest = (dir) => {
    try {
      return fs.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const y of newest(root)) {
    for (const m of newest(path.join(root, y))) {
      for (const d of newest(path.join(root, y, m))) {
        const name = newest(path.join(root, y, m, d)).find((n) => n.endsWith(`${id}.jsonl`));
        if (name) {
          const file = path.join(root, y, m, d, name);
          codexFiles.set(id, file);
          return file;
        }
      }
    }
  }
  codexFiles.set(id, null); // 一轮跑完才来查，那时文件早就有了；找不到就是没有（比如分身的临时会话），别每次都翻一遍
  return null;
}

// 会话里现在还存着多少图片数据（最后一次自动压缩之后的；压缩会把旧图丢掉）。
// 真正让 GPT 卡住的是这个，不是记录文件本身多大：文字多的会话 40 多 MB 也照样能用。
// 只看 GPT（Claude Code 会自己缩小图片、自动压缩，不会这样越滚越大）
// 顺便读出上下文用了多少：最后一条带数据的 token_count 事件里，最近一次请求的用量和上限
const codexCache = new Map(); // 会话文件 -> { mtimeMs, size, usage }：文件没变就不用再读一遍（有的有几十 MB）

async function codexUsage(id) {
  const paginated = storedCodexUsage(id);
  if (paginated) return paginated;
  const file = codexSessionFile(id);
  if (!file) return null;
  let text;
  let stat;
  try {
    stat = await fs.promises.stat(file);
    const hit = codexCache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.usage;
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const re = /data:image\/[a-z+.-]+;base64,/g;
  re.lastIndex = Math.max(0, text.lastIndexOf('"type":"compacted"'));
  let images = 0;
  for (let m; (m = re.exec(text)); ) {
    const end = text.indexOf('"', re.lastIndex);
    const stop = end < 0 ? text.length : end;
    // 只算真正发给模型的那份（同一张图在界面事件里还会再记一遍）
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    if (text.slice(lineStart, lineStart + 200).includes('"type":"response_item"')) images += stop - re.lastIndex;
    re.lastIndex = stop;
  }
  let used = 0;
  let window = 0;
  for (let at = text.length, tries = 0; tries < 50 && (at = text.lastIndexOf('"type":"token_count"', at - 1)) >= 0; tries++) {
    const lineEnd = text.indexOf('\n', at);
    try {
      const info = JSON.parse(text.slice(text.lastIndexOf('\n', at) + 1, lineEnd < 0 ? undefined : lineEnd)).payload?.info;
      if (!info?.last_token_usage) continue; // 有的只带额度信息
      used = info.last_token_usage.total_tokens || 0;
      window = info.model_context_window || 0;
      break;
    } catch {}
  }
  const usage = { images, used, window };
  codexCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, usage });
  return usage;
}

export async function sessionImageBytes(agentId, id) {
  if (AGENTS[agentId]?.engine !== 'codex' || !id) return 0;
  return (await codexUsage(id))?.images || 0;
}

// Claude Code 的会话记录：<配置目录>/projects/<项目文件夹改写成的名字>/<会话 id>.jsonl（DeepSeek 用自己那份配置目录）
const claudeFiles = new Map();
function claudeSessionFile(agentId, id) {
  const key = `${agentId}:${id}`;
  if (claudeFiles.has(key)) return claudeFiles.get(key);
  const p = agentProvider(agentId);
  const home = p ? path.join(DATA_DIR, p.homeDir, 'claude-home') : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  let dirs = [];
  try {
    dirs = fs.readdirSync(path.join(home, 'projects'));
  } catch {}
  for (const d of dirs) {
    const file = path.join(home, 'projects', d, `${id}.jsonl`);
    if (fs.existsSync(file)) {
      claudeFiles.set(key, file);
      return file;
    }
  }
  return null;
}

// 上下文用了多少：最后一条主线（不算子任务）回复里的用量。记录可能有几十 MB，只从末尾往前读，读不到再多读一些
const claudeCache = new Map(); // 会话文件 -> { mtimeMs, size, usage }

async function claudeUsage(agentId, id) {
  const file = claudeSessionFile(agentId, id);
  if (!file) return null;
  let stat;
  let fh;
  try {
    stat = await fs.promises.stat(file);
    const hit = claudeCache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.usage;
    fh = await fs.promises.open(file, 'r');
  } catch {
    return null;
  }
  let usage = null;
  try {
    for (const span of [4 << 20, 32 << 20, stat.size]) {
      const len = Math.min(span, stat.size);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, stat.size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= (len < stat.size ? 1 : 0) && !usage; i--) {
        if (!lines[i].includes('"type":"assistant"') || !lines[i].includes('"usage"')) continue; // 第一行可能读了半截，不看
        try {
          const e = JSON.parse(lines[i]);
          const u = e.message?.usage;
          if (e.type !== 'assistant' || e.isSidechain || !u || e.message.model === '<synthetic>') continue;
          const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
          usage = { used, model: e.message.model || '' };
        } catch {}
      }
      if (usage || len >= stat.size) break;
    }
  } catch {
  } finally {
    await fh.close().catch(() => {});
  }
  claudeCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, usage });
  return usage;
}

// 各个模型的上下文上限：Claude Code 每轮结束时会报（不同账号、不同模型不一样），记下来给群设置用
const WINDOWS_FILE = path.join(DATA_DIR, 'context-windows.json');
let knownWindows = null;
const windowKey = (model) => String(model || '').toLowerCase().replace(/\[1m\]$/, '');

function rememberWindows(modelUsage) {
  knownWindows ??= readWindows();
  let changed = false;
  for (const [model, u] of Object.entries(modelUsage || {})) {
    const k = windowKey(model);
    if (u?.contextWindow > 0 && knownWindows[k] !== u.contextWindow) {
      knownWindows[k] = u.contextWindow;
      changed = true;
    }
  }
  if (!changed) return;
  try {
    fs.writeFileSync(WINDOWS_FILE, JSON.stringify(knownWindows, null, 2));
  } catch {}
}

function readWindows() {
  try {
    return JSON.parse(fs.readFileSync(WINDOWS_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

// 群设置里显示：每位的会话记了多少（上下文用了多少、上限多少），ChatGPT 还有存着的图片。上限不知道时 window 是 0
export async function sessionUsage(agentId, id) {
  if (!id || !AGENTS[agentId]) return null;
  if (AGENTS[agentId].engine === 'gemini') return geminiSessionUsage(id);
  if (AGENTS[agentId].engine === 'codex') return codexUsage(id);
  const u = await claudeUsage(agentId, id);
  if (!u) return null;
  knownWindows ??= readWindows();
  const p = agentProvider(agentId);
  const window = (p && providerModel(p, u.model)?.context) || knownWindows[windowKey(u.model)] || 0;
  return { images: 0, used: u.used, window: window >= u.used ? window : 0 };
}

// ---------------- 借外部接口干活的成员（DeepSeek、GLM）：模型和 Key ----------------
// 接口地址、Key、模型目录都在 lib/providers.js，这里只负责接到成员的房间设置上

export function keyHint(key) {
  return key ? `${key.slice(0, 3)}…${key.slice(-4)}` : '';
}

export function agentModel(room, agentId) {
  const p = agentProvider(agentId);
  return p ? room.models?.[agentId] || p.defaultModel : '';
}

function agentEffort(room, agentId) {
  return room.efforts?.[agentId] || '';
}

// 这一位现在用的模型能不能看图：看不了的（比如 deepseek-v4-pro），图片只告诉它文件在哪
export function canSeeImages(agentId, room) {
  const p = agentProvider(agentId);
  if (!p) return true;
  return !!providerModel(p, agentModel(room, agentId))?.vision;
}

// 某个提供方的模型目录（带显示名、能不能看图、上下文多大、支持哪些思考强度）
export async function providerModelsFor(id, key) {
  return fetchProviderModels(PROVIDERS[id], key);
}

// 老名字，server.js 还在用
export async function deepseekModels(key) {
  return providerModelsFor('deepseek', key);
}

// 老名字，别的地方还在用
export function deepseekKey() {
  return providerKey(PROVIDERS.deepseek);
}

export function deepseekModel(room) {
  return agentModel(room, 'deepseek');
}

// 跑这一位时给 Claude Code 的环境：接口、Key、模型都换成它的。
// 用单独的配置目录：不沿用 Claude 的模型、思考强度、插件这些设置，会话也分开放，也碰不到 Claude 账号的登录
function providerEnvFor(agent, model) {
  return providerEnv(agentProvider(agent), model);
}

// 1M 上下文的模型要加 [1m]，Claude Code 才知道窗口有多大（发给接口时会去掉）
function providerModelArgFor(agent, model) {
  return providerModelArg(agentProvider(agent), model);
}

// 有没有登录：只装了 Claude Code 给 DeepSeek、GLM 借用、自己没登录 Claude 账号的电脑，群里默认就不出现 Claude。
// 查不出来（命令太旧、超时）时当成登录了，免得把能用的人藏起来
async function loggedIn(bin, p) {
  if (bin === 'claude') {
    if (process.env.ANTHROPIC_API_KEY) return true;
    const res = await run(p, ['auth', 'status'], 15000);
    try {
      return JSON.parse(res.stdout).loggedIn !== false;
    } catch {
      return true;
    }
  }
  const res = await run(p, ['login', 'status'], 15000);
  const text = `${res.stdout}\n${res.stderr}`;
  if (/not logged in/i.test(text)) return false;
  return res.ok || /logged in/i.test(text);
}

export async function detectEngines() {
  const out = {};
  for (const bin of ['claude', 'codex']) {
    const p = which(bin);
    const version = p ? (await run(p, ['--version'], 15000)).stdout.trim().split('\n')[0] || null : null;
    out[bin] = { path: p, version, ok: !!p, loggedIn: p ? await loggedIn(bin, p) : false };
  }
  // 借 Claude Code 干活的成员（DeepSeek、GLM）：要有 claude 命令，还要填了 API Key（不用登录 Claude 账号）
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const key = providerKey(p);
    const res = key ? await fetchProviderModels(p, key) : { models: [] };
    out[id] = {
      path: out.claude.path,
      version: out.claude.version,
      ok: !!out.claude.path && !!key && !res.badKey,
      hasKey: !!key,
      keyHint: keyHint(key),
      keyError: res.error || '',
      models: providerModels(p),
      defaultModel: p.defaultModel,
      defaultLabel: providerModel(p, p.defaultModel)?.name || p.defaultModel,
      defaultEffort: '',
    };
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
  out.gemini = await detectGemini({ which, run });
  return out;
}

// 帮用户装 Claude Code：用官方安装脚本（装在自己的用户目录 ~/.local/bin，不用管理员权限，也不用先装 npm）。
// Claude、DeepSeek、GLM 都要借它干活；DeepSeek、GLM 不用登录 Claude 账号
let installing = null;
export function installClaudeCode() {
  if (installing) return installing;
  // CLAWCHAT_CLAUDE_INSTALL_CMD：测试时换成假的安装命令，别真去装（会覆盖本机已经装好的 Claude Code）
  const [cmd, args] = process.env.CLAWCHAT_CLAUDE_INSTALL_CMD
    ? ['/bin/bash', ['-c', process.env.CLAWCHAT_CLAUDE_INSTALL_CMD]]
    : IS_WIN
    ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex']]
    : ['/bin/bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash']];
  installing = new Promise((resolve) => {
    let out = '';
    let child;
    try {
      // 单独一个进程组：超时要连下载、解压的子进程一起结束
      child = spawn(cmd, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !IS_WIN });
    } catch (err) {
      resolve({ ok: false, output: String(err.message || err) });
      return;
    }
    const keep = (d) => (out = (out + d).slice(-4000));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const killTree = () => {
      try {
        if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      keep('\n' + tr('装了 10 分钟还没装完，先停下了，可以再点一次「安装 Claude Code」重试'));
      killTree();
    }, Number(process.env.CLAWCHAT_INSTALL_TIMEOUT_MS) || 10 * 60 * 1000); // 测试时可以调短
    child.on('error', (err) => keep(String(err.message || err)));
    child.on('close', (code) => {
      clearTimeout(timer);
      setupPath(); // 刚装好的目录补进 PATH，不用重启就能找到
      const found = which('claude');
      resolve({ ok: !!found, path: found, output: out.trim().split('\n').slice(-6).join('\n'), code });
    });
  }).finally(() => (installing = null));
  return installing;
}

// 更新命令行（新模型常常要新版本才看得到）
export async function updateEngine(bin) {
  if (bin === 'gemini') return { ok: false, output: geminiKey() ? tr('请在终端运行 npm install -g @google/gemini-cli@latest 更新 Gemini CLI，然后刷新程序列表') : tr('请在终端运行 agy update 更新 Antigravity CLI，然后刷新程序列表') };
  const p = which(bin);
  if (!p) return { ok: false, output: tr('找不到 {bin} 命令', { bin }) };
  const res = await run(p, ['update'], 5 * 60 * 1000);
  const output = `${res.stdout}\n${res.stderr}`.trim().split('\n').slice(-6).join('\n');
  return { ok: res.ok, output };
}

// 用一句最短的话试一下某个模型能不能用：返回实际用的模型，或者报错原因
export function probeModel(agentId, id) {
  const engine = AGENTS[agentId].engine;
  if (engine === 'gemini') {
    const proc = runGemini({ room: { cwd: os.tmpdir(), permission: 'readonly', models: { gemini: id } }, prompt: '只回复 ok' }, { which, spawnJsonl });
    const timer = setTimeout(proc.kill, 90 * 1000);
    return proc.done.then((res) => res.ok ? { ok: true, model: res.model } : { ok: false, error: res.error }).finally(() => clearTimeout(timer));
  }
  const provider = agentProvider(agentId);
  const bin = which(engine === 'codex' ? 'codex' : 'claude');
  if (!bin) return Promise.resolve({ ok: false, error: tr('找不到 {bin} 命令', { bin: engine === 'codex' ? 'codex' : 'claude' }) });
  if (provider && !providerKey(provider)) return Promise.resolve({ ok: false, error: tr('还没填 {name} 的 API Key', { name: provider.name }) });
  const args =
    engine !== 'codex'
      ? ['-p', '--model', id, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--no-session-persistence']
      : ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-m', id, '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '-c', 'suppress_unstable_features_warning=true', '-'];
  let resolved = engine === 'codex' ? id : '';
  let ok = false;
  let error = '';
  const proc = spawnJsonl(bin, args, {
    cwd: os.tmpdir(),
    input: '只回复 ok',
    env: provider ? providerEnv(provider, id) : {},
    onEvent(ev) {
      if (provider && ev.type === 'system' && ev.subtype === 'api_retry' && provider.fatal[ev.error_status]) {
        error = provider.fatal[ev.error_status];
        proc.kill();
      }
      if (ev.type === 'system' && ev.subtype === 'init' && ev.model) resolved = ev.model.replace(/\[1m\]$/i, '');
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
    return ok ? { ok: true, model: resolved } : { ok: false, error: error || lastLine(stderr) || tr('这个模型用不了') };
  });
}

// 启动子进程，逐行解析 JSONL 输出
// keepOpen：写完第一条消息不关 stdin，返回的 write / end 可以在跑的过程中再写（中途插话用）
function spawnJsonl(cmd, args, { cwd, input, onEvent, env = {}, keepOpen = false }) {
  const { cmd: exe, pre } = launcher(cmd);
  let child;
  try {
    // Windows 上 detached 会弹出一个黑色命令行窗口，所以只在 Mac 上用（方便按进程组结束）
    child = spawn(exe, [...pre, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WIN, windowsHide: true });
  } catch (err) {
    return { done: Promise.resolve({ code: -1, stderr: String(err.message || err) }), kill() {}, write: () => false, end() {} };
  }
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
  // 按 UTF-8 解码整条流：一块数据正好在汉字中间断开时，不会变成乱码
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    flush(false);
  });
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-6000);
  });
  child.stdin.on('error', () => {});
  let open = keepOpen;
  if (keepOpen) child.stdin.write(input);
  else child.stdin.end(input);
  // 中途再写一条：stdin 已经关了（这一轮收尾了）就写不进去，返回 false
  const write = (data) => {
    if (!open || child.stdin.destroyed || child.exitCode !== null) return false;
    child.stdin.write(data);
    return true;
  };
  const end = () => {
    if (!open) return;
    open = false;
    child.stdin.end();
  };
  const done = new Promise((resolve) => {
    child.on('error', (err) => resolve({ code: -1, stderr: String(err.message || err) }));
    child.on('close', (code, signal) => {
      flush(true);
      resolve({ code, signal, stderr });
    });
  });
  // Codex 会把命令放进单独的进程组，只杀进程组会留下孤儿进程，所以先找出整棵进程树再逐个结束
  const kill = () => {
    if (IS_WIN) {
      // Windows：taskkill /T 连同它启动的命令一起结束
      if (child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      return;
    }
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
  return { done, kill, write, end };
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

function failed(error, extra = {}) {
  return { done: Promise.resolve({ ok: false, error, steps: [], session: null, ...extra }), kill() {} };
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
  // Windows 上 Codex 用 PowerShell 跑命令：去掉 powershell.exe -Command 外壳
  const ps = String(cmd || '').match(/^"?(?:[^"]*\\)?(?:powershell|pwsh)(?:\.exe)?"?(?:\s+-(?:NoProfile|NoLogo|NonInteractive))*\s+-Command\s+([\s\S]+)$/i);
  if (ps) return ps[1].replace(/^(['"])([\s\S]*)\1$/, '$2');
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

// side：分身。本体在忙时，复制一份当前记忆来回私聊：只读、不写回原会话
// model / effort：这一轮用的模型和思考强度（Claude 和 DeepSeek 都走这里）
function claudeArgs(room, session, systemPrompt, uploadsDir, side, model, effort) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--append-system-prompt', systemPrompt];
  if (session) args.push('--resume', session);
  if (side) args.push(...(session ? ['--fork-session'] : []), '--no-session-persistence');
  if (uploadsDir && fs.existsSync(uploadsDir)) args.push('--add-dir', uploadsDir); // 让它能读到原图文件
  // 换新会话后要读的完整聊天记录（只有它自己能看到的部分）
  const transcripts = uploadsDir && path.join(path.dirname(uploadsDir), 'transcripts');
  if (transcripts && fs.existsSync(transcripts)) args.push('--add-dir', transcripts);
  // 每轮都明确传模型：接着旧会话时不传的话，Claude Code 会沿用这个会话上次用的模型，切回「默认」就不生效
  args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (room.permission === 'full' && !side) {
    args.push('--dangerously-skip-permissions');
  } else if (room.permission === 'readonly' || side) {
    args.push('--permission-mode', 'dontAsk', '--allowedTools', 'Read,Grep,Glob,WebSearch,WebFetch');
  } else if (IS_WIN) {
    // Windows 上 Claude Code 没有沙盒（官方文档：原生 Windows 不支持），命令没法限制在项目文件夹里。
    // 不放行的话一条命令都跑不了，所以直接放行，提示词里会要求它只在项目文件夹里动手
    args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,PowerShell,WebSearch,WebFetch');
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

// 过程里显示的提示，按界面语言现取
export const compactingText = () => tr('正在整理记忆：上下文快满了，把前面的内容压缩一下，大约要一两分钟');

// agent：claude 或 deepseek（DeepSeek 也是用 Claude Code 跑，只是接口和模型换成 DeepSeek 的）
// onActivity：进程有任何输出都会调一下（界面用它判断是不是卡住了）
function runClaude({ agent = 'claude', room, prompt, images = [], uploadsDir, session, systemPrompt, onStep, onActivity, side = false }) {
  const p = agentProvider(agent);
  const bin = which('claude');
  if (!bin) {
    // missing：群里的出错提示下面带一个「安装 Claude Code」按钮
    return failed(p ? tr('找不到 claude 命令：{name} 要借 Claude Code 干活，请先安装 Claude Code（不用登录 Claude 账号）', { name: p.name }) : tr('找不到 claude 命令，请先安装并登录 Claude Code'), { missing: 'claude' });
  }
  if (p && !providerKey(p)) return failed(tr('还没填 {name} 的 API Key：点左下角「设置 → 程序与模型」填一下', { name: p.name }));
  let sid = session;
  let result = null;
  let fatal = '';
  let model = p ? agentModel(room, agent) : claudeModel(room);
  const effort = p ? agentEffort(room, agent) : claudeEffort(room); // 开始时就记下，中途切换不影响这一轮
  const steps = [];
  const step = (s) => {
    steps.push(s);
    onStep(s);
  };
  // 中途插话：Claude Code 用 stream-json 读消息，干活时再写一条，它在下一步之前就能看到，并进这一轮一起做（分身不收）。
  // 这一轮收尾（result）以后就关 stdin 让它退出；插过话的多等一会儿：万一插进去的那条赶在收尾之后，它会再开一轮
  let accepting = !side;
  let steered = false;
  let endTimer = null;
  const texts = [];
  const proc = spawnJsonl(bin, claudeArgs(room, session, systemPrompt, uploadsDir, side, p ? providerModelArg(p, model) : model, effort), {
    cwd: room.cwd,
    input: claudeInput(prompt, images),
    // 不让 Claude 把命令丢到后台再用 Monitor 盯着：那样这一轮会提前结束，最后的回复就丢了
    env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', ...(p ? providerEnv(p, model) : {}) },
    keepOpen: true,
    onEvent(ev) {
      onActivity?.();
      // 收尾之后又有动静：是插进去的消息开了新的一轮，等它这一轮也做完
      if (endTimer && (ev.type === 'assistant' || (ev.type === 'system' && ev.subtype === 'init'))) {
        clearTimeout(endTimer);
        endTimer = null;
      }
      if (ev.session_id) sid = ev.session_id;
      if (p && ev.type === 'system' && ev.subtype === 'api_retry' && p.fatal[ev.error_status]) {
        fatal = p.fatal[ev.error_status];
        proc.kill();
      }
      if (ev.type === 'system' && ev.subtype === 'init' && ev.model) model = ev.model.replace(/\[1m\]$/i, '');
      // 上下文快满时 Claude Code 会自动整理（压缩）记忆，要一两分钟、中间没有别的动静：在过程里说一声，免得看着像卡住了
      if (ev.type === 'system' && ev.subtype === 'status' && ev.status === 'compacting') step({ kind: 'compact', text: compactingText(), busy: true });
      if (ev.type === 'system' && ev.subtype === 'compact_boundary') step({ kind: 'compact', text: tr('记忆整理好了，接着干') });
      if (ev.parent_tool_use_id) return; // 子任务内部的细节不展示
      if (ev.type === 'assistant') {
        for (const b of ev.message?.content || []) {
          if (b.type === 'text' && b.text?.trim()) step({ kind: 'say', text: b.text.trim() });
          else if (b.type === 'thinking' && b.thinking?.trim()) step({ kind: 'think', text: b.thinking.trim() });
          else if (b.type === 'tool_use') step(describeClaudeTool(b, room.cwd));
        }
      } else if (ev.type === 'result') {
        result = ev;
        rememberWindows(ev.modelUsage);
        accepting = false;
        if (ev.subtype === 'success' && String(ev.result || '').trim()) texts.push(String(ev.result).trim());
        clearTimeout(endTimer);
        if (steered) endTimer = setTimeout(() => proc.end(), 1500);
        else proc.end();
      }
    },
  });
  const done = proc.done.then(({ code, stderr }) => {
    clearTimeout(endTimer);
    if (result && result.subtype === 'success' && !result.is_error) {
      // 插进去的消息另开了一轮的话，有两段回复：都发出去（[PASS] 的那段不要）
      const kept = texts.filter((t) => t !== '[PASS]');
      const text = texts.length > 1 ? kept.join('\n\n') || '[PASS]' : String(result.result || '');
      return { ok: true, text, steps: dropFinalSay(steps, text), session: sid, model, effort };
    }
    const error = fatal || (result && (result.result || result.subtype)) || lastLine(stderr) || tr('{bin} 异常退出（{code}）', { bin: 'claude', code });
    return { ok: false, error: String(error), steps, session: sid };
  });
  // 中途插话：这一轮还没收尾就写进去，返回 true；已经在收尾了返回 false（由 hub 排到下一轮）
  const steer = (prompt, images = []) => {
    if (!accepting) return false;
    if (!proc.write(claudeInput(prompt, images))) return false;
    steered = true;
    return true;
  };
  return { done, kill: proc.kill, steer };
}

// ---------------- Codex ----------------

export function codexArgs(room, session, images, side = false, systemPrompt = '') {
  const args = ['exec'];
  // exec 的兼容参数（模型探测等仍使用 exec）；本体、分身的正式运行已走 app-server。
  // fork 带着原会话的记忆开一个新会话，原会话的记录不会被改。
  if (session) args.push(side ? 'fork' : 'resume', session);
  if (side) args.push('--ephemeral');
  for (const img of images) args.push('-i', img.path); // 按 #1、#2… 的顺序附上
  args.push('--json', '--skip-git-repo-check', '-c', 'suppress_unstable_features_warning=true');
  // 新会话：群聊说明作为开发者指令交给它（和 Claude 的系统提示词一样分量，压缩会话时也会一直保留）。
  // 只在新会话开头生效，续上的会话会沿用开头那份，所以续的时候不用再传；JSON 字符串正好是合法的 TOML 字符串
  if (!session && systemPrompt) args.push('-c', `developer_instructions=${JSON.stringify(systemPrompt)}`);
  const model = codexModel(room);
  if (model) args.push('-m', model);
  const effort = codexEffort(room);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  // 速度每次都明确指定：老板自己的 Codex 配置里开着快速模式（service_tier = "priority"）的话，不指定就会一直按 2.5 倍扣额度
  if (room.fast?.gpt) args.push('-c', 'service_tier="fast"', '-c', 'features.fast_mode=true');
  else args.push('-c', 'features.fast_mode=false');
  if (room.permission === 'full' && !side) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (room.permission === 'readonly' || side) {
    args.push('-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"');
  } else {
    args.push('-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=true');
  }
  // Windows 10 没有 MXC 沙盒，Codex 默认会要管理员授权去装 elevated 沙盒；没自己选过的话用不需要管理员的 unelevated
  const sandboxed = room.permission !== 'full' || side;
  if (IS_WIN && sandboxed && !codexPicksWindowsSandbox()) args.push('-c', 'windows.sandbox="unelevated"');
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

// app-server 接着沿用 exec 的临时配置，尤其是速度档和 Windows 沙盒；模型、权限、提示词通过协议逐轮指定。
export function codexServerArgs(room, side = false) {
  const args = ['app-server'];
  const old = codexArgs(room, null, [], side);
  for (let i = 0; i < old.length; i++) if (old[i] === '-c') args.push('-c', old[++i]);
  return args;
}


export function runAgent(agentId, opts) {
  opts = { ...opts, room: cloneRoom(opts.room, agentId) };
  if (AGENTS[agentId].engine === 'gemini') return runGemini(opts, { which, spawnJsonl });
  if (AGENTS[agentId].engine !== 'codex') return runClaude({ ...opts, agent: agentId });
  const bin = which('codex');
  if (!bin) return failed(tr('找不到 codex 命令，请先安装并登录 Codex'));
  return runCodexServer(opts, { bin, args: codexServerArgs(opts.room, opts.side), spawnJsonl, unwrapShell, model: codexModel(opts.room), effort: codexEffort(opts.room), loadUsage: codexUsage });
}
