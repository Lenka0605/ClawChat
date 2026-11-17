import { isJointDiscussion } from './joint-discussion.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';
import { tr } from './i18n.js';

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
  const want = room.models?.gemini && room.models.gemini !== 'auto' ? room.models.gemini : DEFAULT_MODEL;
  const list = agyState.models;
  if (!list || list.some((m) => m.id === want)) return { model: want, fallback: false };
  const model = list.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : list[0].id;
  return { model, fallback: want !== DEFAULT_MODEL, wanted: want };
}
export const agyTooOldText = (version) => tr('Antigravity CLI 版本太旧（{version}），请在终端运行 agy update 升级到 {min} 或更新的版本，再刷新程序列表', { version, min: AGY_MIN_VERSION });

const historyFile = (id) => /^[\w-]+$/.test(id || '') ? path.join(DATA_DIR, 'gemini', 'antigravity', `${id}.json`) : null;
export const isAntigravitySession = (id) => String(id || '').startsWith(PREFIX);

export function antigravityModels() {
  const auto = { id: 'auto', name: 'Gemini 3.8 Flash', description: tr('订阅默认模型，不使用额外点数') };
  // 列表以 agy models 为准（每个账号开通的不一样）；拿不到时只给一定能用的 Gemini 3.8 Flash 三档
  const list = agyState.models || [
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { id: DEFAULT_MODEL, name: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
  ];
  return [auto, ...list.map((m) => ({ id: m.id, name: m.name, description: '' }))]
    .map((m) => ({ ...m, vision: true, context: 0, efforts: [], defaultEffort: '' }));
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

function toolStep(s) {
  const name = s.tool_name || s.tool_info?.name || '';
  const p = s.tool_info?.parameters || {};
  const text = String(p.CommandLine || p.TargetFile || p.AbsolutePath || p.DirectoryPath || p.SearchPath || p.Query || p.Url || p.URL || name);
  const kind = /command|terminal/.test(name) ? 'run' : /write|edit|replace|patch/.test(name) ? 'edit' : /search|grep|find/.test(name) ? 'search' : /read_url|web|browser/.test(name) ? 'web' : /read|view|list/.test(name) ? 'read' : 'tool';
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
  const chunks = new Map();
  let sid = '';
  const picked = agyModelFor(room);
  let model = picked.model;
  if (picked.fallback) {
    const note = { kind: 'warning', text: tr('这个账号用不了 {wanted}，这一轮先用 {model}；可以在群设置里换一个能用的模型', { wanted: picked.wanted, model }) };
    steps.push(note);
    onStep(note);
  }
  let finalResult;
  let latestUsage;
  let stopped = false;
  const proc = spawnJsonl(bin, antigravityArgs(opts), {
    cwd: side || room.permission === 'readonly' ? temp : room.cwd,
    input: `${JSON.stringify({ event: 'user', message: { content } })}\n`,
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
        if (s.step_type === 'tool' && (s.tool_name || s.tool_info?.name) && !toolSeen.has(s.step_index)) {
          toolSeen.add(s.step_index);
          for (const [i, text] of chunks) { if (text.trim()) { const say = { kind: 'say', text: text.trim() }; steps.push(say); onStep(say); } chunks.delete(i); }
          const step = toolStep(s); steps.push(step); onStep(step);
        }
      }
      if (ev.event === 'result') finalResult = ev.result;
    },
  });
  const done = proc.done.then(({ code, stderr }) => {
    sid = finalResult?.conversation_id || sid;
    if (stopped || code !== 0 || finalResult?.status !== 'SUCCESS') {
      const raw = finalResult?.error || String(stderr || '').trim();
      // 和 Google 的连接中途断了（多半是网络把挂太久的请求掐了，agy 自己重试一次也没接上）：
      // 第一次照常报错（中文），让老板叫它「继续」；同一个对话「继续」以后又断，多半是对话在 Google 那边卡在了中断状态，
      // 交给 hub 换新会话、带上最近的聊天记录重来（sessionMismatch 走的就是那条路，只重来一次）
      if (!stopped && STREAM_CUT_RE.test(raw)) {
        const key = sid ? `${PREFIX}${sid}` : session;
        if (session && cutSessions.has(session)) {
          cutSessions.delete(session);
          return { ok: false, sessionMismatch: true, error: 'stream was interrupted twice', notice: tr('Gemini 原来的对话接连中断，换成新会话、带上最近的聊天记录重来'), steps, session: session || null };
        }
        if (key) cutSessions.add(key);
        return { ok: false, error: tr('和 Google 的连接中途断了（多半是网络问题），可以直接让它「继续」'), steps, session: session || null };
      }
      return { ok: false, error: stopped ? tr('Gemini 已停止') : raw || tr('Gemini 未完成回复，请检查安装、登录和模型权限'), steps, session: session || null };
    }
    if (session) cutSessions.delete(session);
    const raw = typeof finalResult.response === 'string' ? finalResult.response.trim() : [...chunks.values()].join('').trim();
    // 一轮里每一步都回一次 [PASS]、最后一步才说正事：把单独成行的 [PASS] 去掉，只留正事；全是 [PASS] 的照旧算没话说
    // 只认带方括号的大写 [PASS]，代码里单独一行的 pass 不能删
    const kept = raw.split('\n').filter((l) => !/^\s*\[\s*PASS\s*\]\s*$/.test(l)).join('\n').trim();
    const text = kept || raw;
    // 做完了但拿不到能接着用的会话 id：不算失败（免得把做过的事再做一遍），清掉会话、下一轮带聊天记录重来
    if (!historyFile(sid)) return { ok: true, text, steps, session: null, model, effort: '', ...(side ? {} : { resetSession: true, warning: tr('Gemini 这一轮做完了，但没拿到会话编号，下一轮会带上最近的聊天记录重新开始') }) };
    let warning;
    if (!side) {
      try {
        const file = historyFile(sid);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        // 原生完整记忆由 agy 保存；这份最近文字仅供分身参考，不冒充完整会话克隆。
        const history = `${previous?.history || ''}\n[收到的消息]\n${prompt}\n[执行步骤]\n${steps.map((s) => s.text).join('\n')}\n[回复]\n${text}`.slice(-160000);
        const pending = `${file}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(pending, JSON.stringify({ history, usage: latestUsage, model }), { mode: 0o600 });
        fs.renameSync(pending, file);
      } catch (e) { warning = tr('Gemini 已完成任务，原生会话仍保留，但分身的文字备份保存失败：{message}', { message: e.message }); }
    }
    return { ok: true, text, steps, session: `${PREFIX}${sid}`, model, effort: '', ...(warning ? { warning } : {}) };
  }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { done, kill() { stopped = true; proc.kill(); } };
}
