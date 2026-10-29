import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { DATA_DIR, readConfig } from './store.js';

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
    note: '你是借 Claude Code 这个工具在干活，但你是 DeepSeek，不是 Claude；群里叫 Claude 的是另一位成员。',
  },
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
  if (IS_WIN) {
    // Windows：补上 Claude Code 官方安装脚本、npm 全局命令、WinGet、Node.js、Git 的默认目录（刚装好、PATH 还没刷新时也能找到）
    const env = process.env;
    const extra = [
      path.join(home, '.local', 'bin'),
      env.APPDATA && path.join(env.APPDATA, 'npm'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
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

// npm 在 Windows 上生成的 .cmd 包装脚本里，真正要跑的文件（一般是 JS，也可能直接是 .exe）
export function cmdShimTarget(text) {
  return String(text || '').match(/"%~?dp0%?\\([^"%]+?\.(?:[cm]?js|exe))"/i)?.[1] || null;
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
const imageBytesCache = new Map(); // 会话文件 -> { mtimeMs, size, bytes }：文件没变就不用再读一遍（有的有几十 MB）

export async function sessionImageBytes(agentId, id) {
  if (AGENTS[agentId]?.engine !== 'codex' || !id) return 0;
  const file = codexSessionFile(id);
  if (!file) return 0;
  let text;
  let stat;
  try {
    stat = await fs.promises.stat(file);
    const hit = imageBytesCache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.bytes;
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    return 0;
  }
  const re = /data:image\/[a-z+.-]+;base64,/g;
  re.lastIndex = Math.max(0, text.lastIndexOf('"type":"compacted"'));
  let total = 0;
  for (let m; (m = re.exec(text)); ) {
    const end = text.indexOf('"', re.lastIndex);
    const stop = end < 0 ? text.length : end;
    // 只算真正发给模型的那份（同一张图在界面事件里还会再记一遍）
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    if (text.slice(lineStart, lineStart + 200).includes('"type":"response_item"')) total += stop - re.lastIndex;
    re.lastIndex = stop;
  }
  imageBytesCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, bytes: total });
  return total;
}

// ---------------- DeepSeek 的模型和 Key ----------------

const DEEPSEEK_API = process.env.CLAWCHAT_DEEPSEEK_API || 'https://api.deepseek.com'; // 测试时可以指向本地的假接口
const DEEPSEEK_DEFAULT = 'deepseek-flash';
// 连不上 DeepSeek 时先用这份（2026 年 10 月官方文档里的两个模型）；连上以后以接口返回的模型目录为准，出了新模型会自动出现
const DEEPSEEK_FALLBACK = [
  { id: 'deepseek-flash', name: 'DeepSeek Flash', description: '快、便宜，能看图 · 1M 上下文', vision: true, context: 1000000, efforts: [], defaultEffort: '' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: '更强，不能看图 · 1M 上下文', vision: false, context: 1000000, efforts: [], defaultEffort: '' },
];
let deepseekCatalog = DEEPSEEK_FALLBACK;

// Key 填错、余额不足时，Claude Code 会重试十次、等好几分钟；看到这两种就马上停下告诉老板
const DEEPSEEK_FATAL = {
  401: 'DeepSeek 的 API Key 不对，请在「设置 → 程序与模型」里重新填一下',
  402: 'DeepSeek 账户余额不足，去 platform.deepseek.com 充值后再叫它',
};

export function deepseekKey() {
  return readConfig().deepseekKey || process.env.DEEPSEEK_API_KEY || '';
}

export function keyHint(key) {
  return key ? `${key.slice(0, 3)}…${key.slice(-4)}` : '';
}

export function deepseekModel(room) {
  return room.models?.deepseek || DEEPSEEK_DEFAULT;
}

function deepseekEffort(room) {
  return room.efforts?.deepseek || '';
}

function deepseekInfo(id) {
  return deepseekCatalog.find((m) => m.id === id) || null;
}

// 这一位现在用的模型能不能看图：看不了的（比如 deepseek-v4-pro），图片只告诉它文件在哪
export function canSeeImages(agentId, room) {
  if (AGENTS[agentId]?.engine !== 'deepseek') return true;
  return !!deepseekInfo(deepseekModel(room))?.vision;
}

// DeepSeek 的模型目录：带着显示名、能不能看图、上下文多大、支持哪些思考强度
export async function deepseekModels(key) {
  try {
    const res = await fetch(`${DEEPSEEK_API}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401) return { models: [], badKey: true, error: 'API Key 不对' };
    if (!res.ok) return { models: [], error: `DeepSeek 返回了 ${res.status}` };
    const models = ((await res.json()).data || [])
      .filter((m) => m.id)
      .map((m) => {
        const vision = (m.input_modalities || []).includes('image');
        const context = Number(m.context_window) || 0;
        const size = context >= 1000000 ? `${Math.round(context / 100000) / 10}M` : context ? `${Math.round(context / 1000)}K` : '';
        return {
          id: m.id,
          name: m.name || m.id,
          description: [vision ? '能看图' : '不能看图', size && `${size} 上下文`].filter(Boolean).join(' · '),
          vision,
          context,
          // 只留 Claude Code 的 --effort 认得的档位
          efforts: (m.effort?.supported_levels || []).filter((e) => CLAUDE_EFFORTS.includes(e)),
          defaultEffort: m.effort?.default_level || '',
        };
      });
    return { models };
  } catch {
    return { models: [], error: '连不上 DeepSeek' };
  }
}

// 跑 DeepSeek 时给 Claude Code 的环境：接口和 Key 换成 DeepSeek 的。
// 用单独的配置目录：不沿用 Claude 的模型、思考强度、插件这些设置，会话也分开放，也碰不到 Claude 账号的登录
function deepseekEnv(model) {
  const big = (deepseekInfo(model)?.context || 0) >= 1000000;
  return {
    ANTHROPIC_BASE_URL: `${DEEPSEEK_API}/anthropic`,
    ANTHROPIC_AUTH_TOKEN: deepseekKey(),
    ANTHROPIC_API_KEY: undefined, // 别把 Anthropic 的 Key 一起发给 DeepSeek
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CONFIG_DIR: path.join(DATA_DIR, 'deepseek', 'claude-home'),
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: DEEPSEEK_DEFAULT, // 子任务、总结网页这类小活用快的
    CLAUDE_CODE_SUBAGENT_MODEL: DEEPSEEK_DEFAULT,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(big ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432' } : {}), // DeepSeek 文档推荐的值
  };
}

// 1M 上下文的模型要加 [1m]，Claude Code 才知道窗口有多大（发给 DeepSeek 时会去掉）
function deepseekModelArg(model) {
  return (deepseekInfo(model)?.context || 0) >= 1000000 ? `${model}[1m]` : model;
}

export async function detectEngines() {
  const out = {};
  for (const bin of ['claude', 'codex']) {
    const p = which(bin);
    const version = p ? (await run(p, ['--version'], 15000)).stdout.trim().split('\n')[0] || null : null;
    out[bin] = { path: p, version, ok: !!p };
  }
  // DeepSeek 借 Claude Code 干活：要有 claude 命令，还要填了 API Key（不用登录 Claude 账号）
  const key = deepseekKey();
  const ds = key ? await deepseekModels(key) : { models: [] };
  if (ds.models.length) deepseekCatalog = ds.models;
  out.deepseek = {
    path: out.claude.path,
    version: out.claude.version,
    ok: !!out.claude.path && !!key && !ds.badKey,
    hasKey: !!key,
    keyHint: keyHint(key),
    keyError: ds.error || '',
    models: deepseekCatalog,
    defaultModel: DEEPSEEK_DEFAULT,
    defaultLabel: deepseekInfo(DEEPSEEK_DEFAULT)?.name || DEEPSEEK_DEFAULT,
    defaultEffort: '',
  };
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
  const bin = which(engine === 'codex' ? 'codex' : 'claude');
  if (!bin) return Promise.resolve({ ok: false, error: `找不到 ${engine === 'codex' ? 'codex' : 'claude'} 命令` });
  if (engine === 'deepseek' && !deepseekKey()) return Promise.resolve({ ok: false, error: '还没填 DeepSeek 的 API Key' });
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
    env: engine === 'deepseek' ? deepseekEnv(id) : {},
    onEvent(ev) {
      if (engine === 'deepseek' && ev.type === 'system' && ev.subtype === 'api_retry' && DEEPSEEK_FATAL[ev.error_status]) {
        error = DEEPSEEK_FATAL[ev.error_status];
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
    return ok ? { ok: true, model: resolved } : { ok: false, error: error || lastLine(stderr) || '这个模型用不了' };
  });
}

// 启动子进程，逐行解析 JSONL 输出
function spawnJsonl(cmd, args, { cwd, input, onEvent, env = {} }) {
  const { cmd: exe, pre } = launcher(cmd);
  let child;
  try {
    // Windows 上 detached 会弹出一个黑色命令行窗口，所以只在 Mac 上用（方便按进程组结束）
    child = spawn(exe, [...pre, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WIN, windowsHide: true });
  } catch (err) {
    return { done: Promise.resolve({ code: -1, stderr: String(err.message || err) }), kill() {} };
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

// agent：claude 或 deepseek（DeepSeek 也是用 Claude Code 跑，只是接口和模型换成 DeepSeek 的）
// onActivity：进程有任何输出都会调一下（界面用它判断是不是卡住了）
function runClaude({ agent = 'claude', room, prompt, images = [], uploadsDir, session, systemPrompt, onStep, onActivity, side = false }) {
  const ds = agent === 'deepseek';
  const bin = which('claude');
  if (!bin) {
    return failed(ds ? '找不到 claude 命令：DeepSeek 要借 Claude Code 干活，请先安装 Claude Code（不用登录 Claude 账号）' : '找不到 claude 命令，请先安装并登录 Claude Code');
  }
  if (ds && !deepseekKey()) return failed('还没填 DeepSeek 的 API Key：点左下角「设置 → 程序与模型」填一下');
  let sid = session;
  let result = null;
  let fatal = '';
  let model = ds ? deepseekModel(room) : claudeModel(room);
  const effort = ds ? deepseekEffort(room) : claudeEffort(room); // 开始时就记下，中途切换不影响这一轮
  const steps = [];
  const step = (s) => {
    steps.push(s);
    onStep(s);
  };
  const proc = spawnJsonl(bin, claudeArgs(room, session, systemPrompt, uploadsDir, side, ds ? deepseekModelArg(model) : model, effort), {
    cwd: room.cwd,
    input: claudeInput(prompt, images),
    // 不让 Claude 把命令丢到后台再用 Monitor 盯着：那样这一轮会提前结束，最后的回复就丢了
    env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', ...(ds ? deepseekEnv(model) : {}) },
    onEvent(ev) {
      onActivity?.();
      if (ev.session_id) sid = ev.session_id;
      if (ds && ev.type === 'system' && ev.subtype === 'api_retry' && DEEPSEEK_FATAL[ev.error_status]) {
        fatal = DEEPSEEK_FATAL[ev.error_status];
        proc.kill();
      }
      if (ev.type === 'system' && ev.subtype === 'init' && ev.model) model = ev.model.replace(/\[1m\]$/i, '');
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
    const error = fatal || (result && (result.result || result.subtype)) || lastLine(stderr) || `claude 异常退出（${code}）`;
    return { ok: false, error: String(error), steps, session: sid };
  });
  return { done, kill: proc.kill };
}

// ---------------- Codex ----------------

export function codexArgs(room, session, images, side = false) {
  const args = ['exec'];
  // 分身用 exec fork：带着原会话的记忆开一个新会话，原会话的记录不会被改
  if (session) args.push(side ? 'fork' : 'resume', session);
  if (side) args.push('--ephemeral');
  for (const img of images) args.push('-i', img.path); // 按 #1、#2… 的顺序附上
  args.push('--json', '--skip-git-repo-check', '-c', 'suppress_unstable_features_warning=true');
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

function runCodex({ room, prompt, images = [], session, systemPrompt, onStep, onActivity, side = false }) {
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
  const proc = spawnJsonl(bin, codexArgs(room, session, existing, side), {
    cwd: room.cwd,
    input,
    onEvent(ev) {
      onActivity?.();
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
  return AGENTS[agentId].engine === 'codex' ? runCodex(opts) : runClaude({ ...opts, agent: agentId });
}
