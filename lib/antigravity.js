import { isJointDiscussion } from './joint-discussion.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';
import { tr } from './i18n.js';
import { agentEnv } from './agent-env.js';
import { recordAgyUsage } from './usage.js';

// Antigravity CLI 1.4.10 的 stdin / stream-json 协议；订阅入口与 Gemini API 分开。
// https://antigravity.google/docs/cli/headless/
const PREFIX = 'agy:';
const DEFAULT_MODEL = 'gemini-3.8-flash-medium';
// 实测过的最低版本：stream-json 输入是 1.1.15 才有的，--settings 文档里没写、按 1.4.10 的行为写的；更旧的版本直接拦下，不硬跑
export const AGY_MIN_VERSION = '1.4.10';
export function agyVersionOk(version) {
  const v = String(version || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!v) return false;
  const min = AGY_MIN_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (Number(v[i + 1]) !== min[i]) return Number(v[i + 1]) > min[i];
  return true;
}
// 最近一次检测到的 agy 版本（detectGemini 记下）：太旧时每轮都直接报错，提示升级
// models：这个账号实际能用的模型（detectGemini 跑 agy models 拿到的）；拿不到时为 null，用下面内置的那几个
export const agyState = { version: null, models: null };
// 解析 agy models 的输出：每行「模型编号<Tab>显示名」，开头那行「Fetching available models...」跳过
export function parseAgyModels(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const [id, name] = line.split('\t').map((x) => (x || '').trim());
    if (id && name && /^[\w.-]+$/.test(id) && !out.some((m) => m.id === id)) out.push({ id, name });
  }
  return out.length ? out : null;
}
// 群里选的模型这个账号用不了（比如选过 Gemini 4 Argon、账号没开通）：退回默认的，不让每一轮都报错
function agyModelFor(room) {
  const want = agyModelId(room);
  const list = agyState.models;
  if (!list || list.some((m) => m.id === want)) return { model: want, fallback: false };
  const model = list.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : list[0].id;
  return { model, fallback: want !== DEFAULT_MODEL, wanted: want };
}
export const agyTooOldText = (version) => tr('Antigravity CLI 版本太旧（{version}），请在终端运行 agy update 升级到 {min} 或更新的版本，再刷新程序列表', { version, min: AGY_MIN_VERSION });

const historyFile = (id) => /^[\w-]+$/.test(id || '') ? path.join(DATA_DIR, 'gemini', 'antigravity', `${id}.json`) : null;
export const isAntigravitySession = (id) => String(id || '').startsWith(PREFIX);

// agy models 把每个思考强度都列成一个型号（gemini-4-hydrogen-high、-low…）。界面上合成一项（Gemini 4 Hydrogen），
// 思考强度放到旁边的「思考」下拉里选，跑的时候再拼回完整型号；同时按家族分组（Gemini / Claude / 其他）
const AGY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const AGY_EFFORT_RE = new RegExp(`^(.+)-(${AGY_EFFORTS.join('|')})$`);
const AGY_NAME_RE = / \((Low|Medium|High|XHigh|Max)\)$/i;
function agyFamily(id, name) {
  if (/^claude/i.test(id) || /^claude/i.test(name)) return 'Claude';
  if (/^gemini|orchestrator/i.test(id) || /^gemini|orchestrator/i.test(name)) return 'Gemini';
  return tr('其他');
}
export function agyGroupedModels(list) {
  const groups = new Map(); // 基础型号 -> { id, name, efforts: [] }
  for (const m of list) {
    const hit = AGY_EFFORT_RE.exec(m.id);
    const base = hit ? hit[1] : m.id;
    const g = groups.get(base) || { id: base, name: String(m.name || base).replace(AGY_NAME_RE, ''), efforts: [], variants: [] };
    if (hit) g.efforts.push(hit[2]);
    g.variants.push(m.id);
    groups.set(base, g);
  }
  const out = [];
  for (const g of groups.values()) {
    // 只有一档的（比如 GPT-OSS 120B (Medium)）不拆，照原样列出来
    if (g.efforts.length < 2) {
      const only = list.find((m) => m.id === g.variants[0]);
      out.push({ id: only.id, name: only.name, efforts: [], defaultEffort: '', group: agyFamily(only.id, only.name) });
      continue;
    }
    const efforts = AGY_EFFORTS.filter((e) => g.efforts.includes(e));
    const defaultEffort = efforts.includes('high') ? 'high' : efforts.includes('medium') ? 'medium' : efforts[0];
    out.push({ id: g.id, name: g.name, efforts, defaultEffort, group: agyFamily(g.id, g.name) });
  }
  const order = ['Gemini', 'Claude'];
  return out.sort((a, b) => (order.indexOf(a.group) + 1 || 9) - (order.indexOf(b.group) + 1 || 9));
}

export function antigravityModels() {
  // 列表以 agy models 为准（每个账号开通的不一样）；拿不到时只给一定能用的 Gemini 3.8 Flash 三档
  const list = agyState.models || [
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { id: DEFAULT_MODEL, name: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
  ];
  // 「默认」那项（不指定模型）就是 Gemini 3.8 Flash，不再单列一个 auto，免得菜单里出现两个 Gemini 3.8 Flash
  return agyGroupedModels(list).map((m) => ({ ...m, description: '' }))
    .map((m) => ({ ...m, vision: true, context: 0 }));
}

// 群里选的模型 + 思考强度 → agy 认的完整型号。也认以前存下的完整型号（gemini-4-hydrogen-high），
// 那种情况下如果另外选了思考强度，就换成那一档
export function agyModelId(room) {
  const effort = String(room.efforts?.gemini || '');
  // 没选模型（「默认」= Gemini 3.8 Flash）：选了思考强度就用那一档
  const chosen = room.models?.gemini && room.models.gemini !== 'auto' ? room.models.gemini : effort ? 'gemini-3.8-flash' : '';
  if (!chosen) return DEFAULT_MODEL;
  const list = agyState.models;
  // 连存下的列表都没有（新装、从没拿到过）：Gemini / Claude 家族的按「型号-强度」拼，免得把不带档位的写法交给 agy
  if (!list) return AGY_EFFORT_RE.test(chosen) || !/^(gemini-\d|claude-)/.test(chosen) ? chosen : `${chosen}-${effort || 'high'}`;
  const exists = (id) => !list || list.some((m) => m.id === id);
  const legacy = AGY_EFFORT_RE.exec(chosen);
  const base = legacy && exists(chosen) ? legacy[1] : chosen;
  const variants = (list || []).filter((m) => AGY_EFFORT_RE.exec(m.id)?.[1] === base).map((m) => m.id);
  if (!variants.length) return chosen; // 本来就没有档位的型号（或者拿不到列表）：原样用
  if (effort && variants.includes(`${base}-${effort}`)) return `${base}-${effort}`;
  if (legacy && exists(chosen)) return chosen;
  for (const e of ['high', 'medium', 'low', 'xhigh', 'max']) if (variants.includes(`${base}-${e}`)) return `${base}-${e}`;
  return variants[0];
}

// 回给界面的模型名：gemini-4-hydrogen-high → 模型 gemini-4-hydrogen、思考 high（消息上显示「Gemini 4 Hydrogen · 思考 高」）
export function agyShown(id) {
  const hit = AGY_EFFORT_RE.exec(String(id || ''));
  if (!hit) return { model: id, effort: '' };
  if (!agyState.models) return /^(gemini-\d|claude-)/.test(hit[1]) ? { model: hit[1], effort: hit[2] } : { model: id, effort: '' };
  const siblings = agyState.models.filter((m) => AGY_EFFORT_RE.exec(m.id)?.[1] === hit[1]).length;
  return siblings >= 2 ? { model: hit[1], effort: hit[2] } : { model: id, effort: '' };
}

function savedHistory(session) {
  const id = String(session || '').replace(/^agy:/, '');
  const file = historyFile(id);
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// agy 的输出、缓存里都没有上下文上限（查过），只能按模型家族认：Gemini 这几代都是 1,048,576，
// 按「gemini-数字」整个家族认，以后出 Gemini 5 不用改代码也能显示；GPT-OSS 120B 是 131,072。
// 查不到的（比如 Antigravity 里的 Claude）给 0，界面上就不画进度条，不瞎写
export function agyModelWindow(model) {
  const m = String(model || '');
  if (/^gemini-\d|^gemini-pro-orchestrator/.test(m)) return 1048576;
  if (/^gpt-oss-120b/.test(m)) return 131072;
  return 0;
}

export function antigravityUsage(session) {
  const saved = savedHistory(session);
  const u = saved?.usage;
  if (!Number.isFinite(u?.input_tokens)) return null;
  const used = u.input_tokens + (u.output_tokens || 0) + (u.thinking_tokens || 0);
  const window = agyModelWindow(saved.model);
  return { images: 0, used, window: window >= used ? window : 0 };
}

export function antigravityArgs({ room, session, side, uploadsDir }) {
  const readonly = isJointDiscussion(room) || side || room.permission === 'readonly';
  const full = !readonly && room.permission === 'full';
  // 用会话级覆盖强制关掉点数回退和 API provider，不修改用户的 settings.json。
  // 项目模式不允许 command(*)：该规则会连沙盒外的命令也一起放行。
  const settings = {
    useG1Credits: false, modelProvider: '', model: agyModelFor(room).model,
    agentMode: '', artifactReviewPolicy: 'always-proceed',
    toolPermission: full ? 'always-proceed' : readonly ? 'request-review' : 'proceed-in-sandbox',
    enableTerminalSandbox: !full, allowNonWorkspaceAccess: full,
    permissions: {
      allow: isJointDiscussion(room) ? [] : ['read_url(*)', ...(readonly ? ['read_file(*)'] : [])],
      ask: [],
      deny: isJointDiscussion(room) ? ['read_file(*)', 'read_url(*)', 'write_file(*)', 'command(*)', 'unsandboxed(*)', 'mcp(*)', 'execute_url(*)'] : readonly ? ['write_file(*)', 'command(*)', 'unsandboxed(*)', 'mcp(*)', 'execute_url(*)'] : full ? [] : ['unsandboxed(*)', 'mcp(*)', 'execute_url(*)'],
    },
  };
  // 明确设置后台运行上限，给改代码、跑测试等长任务留出时间。
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--print-timeout', '6h', '--settings', JSON.stringify(settings), '--model', settings.model];
  if (session && !side) args.push('--conversation', session.slice(PREFIX.length));
  else args.push('--new-project');
  if (!full) args.push('--sandbox');
  if (readonly && !isJointDiscussion(room)) args.push('--add-dir', room.cwd);
  if (uploadsDir && fs.existsSync(uploadsDir)) {
    args.push('--add-dir', uploadsDir);
    const transcripts = path.join(path.dirname(uploadsDir), 'transcripts');
    if (fs.existsSync(transcripts)) args.push('--add-dir', transcripts);
  }
  return args;
}

function failed(error) {
  return { done: Promise.resolve({ ok: false, error, steps: [], session: null }), kill() {} };
}

function toolStep(name, p, roots) {
  const kind = /command|terminal/.test(name) ? 'run' : /write|edit|replace|patch/.test(name) ? 'edit' : /search|grep|find/.test(name) ? 'search' : /read_url|web|browser/.test(name) ? 'web' : /read|view|list/.test(name) ? 'read' : 'tool';
  if (kind === 'read' || kind === 'edit') {
    // agy 的 read_file、edit_file、write_file 用 Path；Target 和 Replacement 是文件内容。
    const file = [p.Path, p.TargetFile, p.AbsolutePath, p.DirectoryPath, p.file_path, p.path].find((v) => typeof v === 'string' && v.trim());
    if (file) {
      if (path.isAbsolute(file)) {
        for (const root of roots) {
          const rel = path.relative(root, file);
          if (rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) return { kind, text: rel };
        }
      }
      return { kind, text: file };
    }
  }
  const text = String(p.CommandLine || p.TargetFile || p.AbsolutePath || p.DirectoryPath || p.SearchPath || p.Query || p.Url || p.URL || name);
  return { kind, text };
}

// agy 报「The stream was interrupted」的对话（只记在内存里，重启就清掉，没关系：最多多报一次）
const STREAM_CUT_RE = /stream was interrupted/i;
const cutSessions = new Set();

export function runAntigravity(opts, { which, spawnJsonl }) {
  const bin = which('agy');
  if (!bin) return failed(tr('个人订阅需要 Antigravity CLI：请先安装 agy，运行 agy 登录购买订阅的 Google 账号，再刷新程序列表。'));
  if (!agyVersionOk(agyState.version)) return failed(agyTooOldText(agyState.version || '?'));
  const { room, prompt, systemPrompt = '', session, side = false, images = [], uploadsDir, onStep = () => {}, onActivity } = opts;
  // 旧的 Gemini CLI 会话接不上：报「session not found」，hub 会自动开新会话、带上最近的聊天记录重来，不用老板手动换
  if (session && !isAntigravitySession(session)) return failed('session not found: 旧的 Gemini CLI 会话，订阅入口接不上');
  const previous = session ? savedHistory(session) : null;
  if (side && session && !previous) return failed(tr('找不到 Gemini 分身需要的对话备份，本体任务不受影响。'));
  let temp;
  try {
    const dir = path.join(DATA_DIR, 'gemini', 'runs');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    temp = fs.mkdtempSync(path.join(dir, 'agy-'));
  } catch (e) { return failed(tr('Gemini 启动失败：{error}', { error: e.message })); }
  // 分身不 --conversation 本体：后台协议不提供安全的原生 fork，使用成功回合的文字备份开独立会话。
  const context = side && previous ? `[本体最近保存的对话，仅供参考]\n${previous.history}\n\n` : '';
  const attachments = images.filter((img) => fs.existsSync(img.path)).map((img) => `图 #${img.n}：${img.path}`);
  const content = [systemPrompt, context, prompt, attachments.length ? `请按下面的绝对路径读取图片附件：\n${attachments.join('\n')}` : ''].filter(Boolean).join('\n\n');
  const steps = [];
  const toolSeen = new Set();
  // 项目目录可能是软链接，agy 也可能按真实目录报告路径（例如 macOS 的 /tmp 和 /private/tmp）。
  const roots = new Set(room.cwd ? [room.cwd] : []);
  try { roots.add(fs.realpathSync(room.cwd)); } catch {}
  const chunks = new Map();
  let sid = '';
  const picked = agyModelFor(room);
  let model = picked.model;
  if (picked.fallback) {
    const note = { kind: 'warning', text: tr('这个账号用不了 {wanted}，这一轮先用 {model}；可以在群设置里换一个能用的模型', { wanted: picked.wanted, model }) };
    steps.push(note);
    onStep(note);
  }
  // 同一步先报名、后报路径。预留它在过程里的位置，路径到齐再按原顺序推给界面。
  const pendingFiles = new Map(); // step_index -> steps 里的位置
  let shown = steps.length;
  const publishSteps = () => {
    const firstPending = pendingFiles.values().next().value ?? steps.length;
    while (shown < firstPending) onStep(steps[shown++]);
  };
  let finalResult;
  let latestUsage;
  let stopped = false;
  // 中途插话：agy 的 stream-json 一行读一条消息，每条跑一轮。干活时再写一条，它做完手上这一轮就在同一个对话里接着做（实测 0.1 秒内开始）。
  // 写了几条就等几个 result，都回来了再关 stdin 让它退出；分身不收
  let accepting = !side;
  let sent = 1;
  let results = 0;
  let successes = 0;
  const responses = [];
  const steered = [];
  let mark = 0; // 上一个 result 之后的步骤从这里算起
  // 这一轮（从上一个 result 到现在）的回复：以 result 里的正文为准，没有就用还没收进步骤的文字，再没有就用这一轮最后说的那句
  const turnText = (response) => {
    const said = steps.slice(mark).filter((st) => st.kind === 'say').map((st) => st.text);
    return (typeof response === 'string' && response.trim()) || [...chunks.values()].join('').trim() || said[said.length - 1] || '';
  };
  const line = (text) => `${JSON.stringify({ event: 'user', message: { content: text } })}\n`;
  const proc = spawnJsonl(bin, antigravityArgs(opts), {
    cwd: side || room.permission === 'readonly' ? temp : room.cwd,
    input: line(content),
    keepOpen: true,
    // 订阅进程不继承 API Key；没有订阅额度时只报错，绝不自动切到 API。
    env: { GEMINI_API_KEY: '', GOOGLE_API_KEY: '', AGY_CLI_DISABLE_AUTO_UPDATE: '1' },
    onEvent(ev) {
      onActivity?.();
      if (ev.event === 'init') { sid = ev.conversation_id || ''; model = ev.init?.model || model; }
      if (ev.event === 'step_update') {
        const s = ev.step_update || {};
        if (s.step_type === 'agent_response' && typeof s.text_delta === 'string') {
          chunks.set(s.step_index, (chunks.get(s.step_index) || '') + s.text_delta);
          // result.usage 是会话累计值，不能拿来冒充当前上下文用量。
          if (Number.isFinite(s.usage?.input_tokens)) latestUsage = s.usage;
        }
        if (s.step_type === 'tool' && !toolSeen.has(s.step_index)) {
          const pending = pendingFiles.get(s.step_index);
          const name = s.tool_name || s.tool_info?.name || steps[pending]?.text;
          if (!name) return;
          if (pending === undefined) {
            for (const text of chunks.values()) if (text.trim()) steps.push({ kind: 'say', text: text.trim() });
            chunks.clear();
          }
          const step = toolStep(name, s.tool_info?.parameters || {}, roots);
          const slot = pending ?? steps.length;
          steps[slot] = step;
          if (step.text === name && (step.kind === 'read' || step.kind === 'edit') && s.state !== 'DONE') {
            pendingFiles.set(s.step_index, slot);
          } else {
            pendingFiles.delete(s.step_index);
            toolSeen.add(s.step_index);
          }
          publishSteps();
        }
      }
      if (ev.event === 'result') {
        pendingFiles.clear();
        publishSteps();
        finalResult = ev.result;
        results++;
        // 做完的这一轮记下回复，chunks 清掉、步骤从这里重新算：免得插话那一轮出错时把上一轮的话当成救回来的（出错的那一轮留着，断线时要救）
        if (ev.result?.status === 'SUCCESS') {
          successes++;
          const t = turnText(ev.result.response);
          if (t) responses.push(t);
          chunks.clear();
          toolSeen.clear(); // 下一轮的步骤编号可能从头算
          mark = steps.length;
        }
        if (results >= sent || ev.result?.status !== 'SUCCESS') {
          accepting = false;
          proc?.end?.();
        }
      }
    },
  });
  // agy 跑长命令、操作模拟器这类活时，进度事件有时好几分钟才从输出里出来，界面就误以为它卡住了。
  // 它自己会把每一步记在 ~/.gemini/antigravity-cli/brain/<对话>/ 下面：每 15 秒看一眼这几个目录有没有更新，有就算「还有动静」
  let brainSeen = 0;
  const brainWatch = setInterval(() => {
    if (!sid) return;
    const dir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', sid);
    let t = 0;
    const mtime = (p) => { try { t = Math.max(t, fs.statSync(p).mtimeMs); } catch {} };
    for (const sub of ['.system_generated/steps', '.system_generated/messages', '.system_generated/logs', 'scratch']) mtime(path.join(dir, sub));
    // 长命令一直往同一个文件里追加输出时目录时间不变：再看最近 3 个步骤里的文件和日志文件
    try {
      const stepsDir = path.join(dir, '.system_generated', 'steps');
      const recent = fs.readdirSync(stepsDir).filter((n) => /^\d+$/.test(n)).sort((a, b) => b - a).slice(0, 3);
      for (const n of recent) for (const f of fs.readdirSync(path.join(stepsDir, n))) mtime(path.join(stepsDir, n, f));
    } catch {}
    for (const f of ['transcript.jsonl', 'transcript_full.jsonl']) mtime(path.join(dir, '.system_generated', 'logs', f));
    // 后台任务（长命令）的输出写在 tasks/task-*.log 里，跑着的时候一直在追加
    try {
      const tasksDir = path.join(dir, '.system_generated', 'tasks');
      for (const f of fs.readdirSync(tasksDir)) if (f.endsWith('.log')) mtime(path.join(tasksDir, f));
    } catch {}
    if (t > brainSeen) {
      if (brainSeen) onActivity?.();
      brainSeen = t;
    }
  }, 15000);
  brainWatch.unref?.();
  const done = proc.done.then(({ code, stderr }) => {
    clearInterval(brainWatch);
    pendingFiles.clear();
    publishSteps();
    sid = finalResult?.conversation_id || sid;
    // cut：这一轮报了「连接中途断了」，但它已经说了话、干了活：照常把说的话发出来，后面标一句可能不完整，不整轮作废。
    // cutAgain：同一个对话接连断（多半卡在 Google 那边的中断状态了）：这一轮的话照发，下一轮换新会话
    let cut = false;
    let cutAgain = false;
    let salvage = '';
    let steerFailed = '';
    if (stopped || code !== 0 || finalResult?.status !== 'SUCCESS') {
      const raw = finalResult?.error || String(stderr || '').trim();
      // 和 Google 的连接中途断了（多半是网络把挂太久的请求掐了，agy 自己重试一次也没接上）：
      // 第一次照常报错（中文），让老板叫它「继续」；同一个对话「继续」以后又断，多半是对话在 Google 那边卡在了中断状态，
      // 交给 hub 换新会话、带上最近的聊天记录重来（sessionMismatch 走的就是那条路，只重来一次）
      if (!stopped && STREAM_CUT_RE.test(raw)) {
        const key = sid ? `${PREFIX}${sid}` : session;
        // 分身是用 --new-project 开的独立会话，不读写本体的 cutSessions 标记
        const again = !side && !!session && cutSessions.has(session);
        salvage = turnText(finalResult?.response);
        if (salvage || responses.length) {
          cut = true;
          cutAgain = again;
          if (!side) {
            if (again) cutSessions.delete(session);
            else if (key) cutSessions.add(key);
          }
        } else {
          if (again) {
            cutSessions.delete(session);
            return { ok: false, sessionMismatch: true, error: 'stream was interrupted twice', notice: tr('Gemini 原来的对话接连中断，换成新会话、带上最近的聊天记录重来'), steps, session: session || null };
          }
          if (!side && key) cutSessions.add(key);
          return { ok: false, error: tr('和 Google 的连接中途断了（多半是网络问题），可以直接让它「继续」'), steps, session: session || null };
        }
      } else if (!stopped && responses.length) {
        // 前面几轮做完了、插话那一轮出错（不是断线）：做完的照常发出去，说一声插话那一轮没做完
        steerFailed = raw;
      } else return { ok: false, error: stopped ? tr('Gemini 已停止') : raw || tr('Gemini 未完成回复，请检查安装、登录和模型权限'), steps, session: session || null };
    }
    if (!side && !cut && session) cutSessions.delete(session);
    // 插过话的：每一轮的回复都发出去（合在一起）
    const raw = cut ? [...responses, salvage].filter(Boolean).join('\n\n') : responses.join('\n\n');
    // 一轮里每一步都回一次 [PASS]、最后一步才说正事：把单独成行的 [PASS] 去掉，只留正事；全是 [PASS] 的照旧算没话说
    // 只认带方括号的大写 [PASS]，代码里单独一行的 pass 不能删
    const kept = raw.split('\n').filter((l) => !/^\s*\[\s*PASS\s*\]\s*$/.test(l)).join('\n').trim();
    const text = kept || raw;
    // 插进去的几条里做完了几条（断线但救回了话的那条也算做完，话已经发出去了）；没做完的交给 hub 下一轮再给它
    const steersDone = Math.max(0, successes - 1) + (cut && salvage && successes >= 1 ? 1 : 0);
    const lost = !stopped && sent > 1 && steersDone < sent - 1 ? { steerLost: { done: steersDone } } : {};
    if (cutAgain) {
      return { ok: true, text, steps, session: null, ...agyShown(model), resetSession: true, ...lost,
        warning: tr('原来的对话接连中断，这一轮的回复可能不完整；下一轮换新会话、带上最近的聊天记录') };
    }
    const cutWarning = cut ? tr('和 Google 的连接中途断过，这一轮的回复可能不完整') : steerFailed ? tr('中途插的话那一轮没做完：{error}', { error: steerFailed.slice(0, 200) }) : '';
    // 做完了但拿不到能接着用的会话 id：不算失败（免得把做过的事再做一遍），清掉会话、下一轮带聊天记录重来
    if (!historyFile(sid)) return { ok: true, text, steps, session: null, ...agyShown(model), ...lost, ...(side ? {} : { resetSession: true, warning: tr('Gemini 这一轮做完了，但没拿到会话编号，下一轮会带上最近的聊天记录重新开始') }) };
    let warning;
    if (!side) {
      try {
        const file = historyFile(sid);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        // 原生完整记忆由 agy 保存；这份最近文字仅供分身参考，不冒充完整会话克隆。
        const history = `${previous?.history || ''}\n[收到的消息]\n${[prompt, ...steered].join('\n')}\n[执行步骤]\n${steps.map((s) => s.text).join('\n')}\n[回复]\n${text}`.slice(-160000);
        const pending = `${file}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(pending, JSON.stringify({ history, usage: latestUsage || previous?.usage, model }), { mode: 0o600 });
        fs.renameSync(pending, file);
      } catch (e) { warning = tr('Gemini 已完成任务，原生会话仍保留，但分身的文字备份保存失败：{message}', { message: e.message }); }
    }
    const warn = [cutWarning, warning].filter(Boolean).join('；');
    return { ok: true, text, steps, session: `${PREFIX}${sid}`, ...agyShown(model), ...lost, ...(warn ? { warning: warn } : {}) };
  }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
  // 中途插话：这一轮还没收尾就写进去，返回 true；已经在收尾了返回 false（由 hub 排到下一轮）
  const steer = (text, imgs = []) => {
    if (!accepting) return false;
    const files = imgs.filter((img) => fs.existsSync(img.path)).map((img) => `图 #${img.n}：${img.path}`);
    const body = [text, files.length ? `请按下面的绝对路径读取图片附件：\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n');
    if (!proc.write?.(line(body))) return false;
    sent++;
    steered.push(text);
    return true;
  };
  return { done, kill() { stopped = true; accepting = false; proc.kill(); }, steer };
}

// 通过官方 `agy -p /usage --output-format json` 只读查询订阅账号剩余额度（不消耗模型点数、不建会话）。
export async function readAgyUsage({ bin, which, run, env, timeout = 12000 } = {}) {
  const cmd = bin || which?.('agy');
  if (!cmd) return null;
  if (agyState.version && !agyVersionOk(agyState.version)) return null;
  try {
    const res = await run(cmd, ['-p', '/usage', '--output-format', 'json'], timeout, {
      ...(env || agentEnv('agy')),
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    });
    if (!res?.ok || !res.stdout) return null;
    const text = res.stdout.trim();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      for (const line of text.split('\n').reverse()) {
        const s = line.trim();
        if (!s.startsWith('{')) continue;
        try {
          const obj = JSON.parse(s);
          if (obj && typeof obj === 'object') { parsed = obj; break; }
        } catch {}
      }
    }
    return parsed ? recordAgyUsage(parsed) : null;
  } catch {
    return null;
  }
}
