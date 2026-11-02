import { isJointDiscussion, isJointFolder, jointCodexConfig } from './joint-discussion.js';
import fs from 'node:fs';
import path from 'node:path';
import { tr } from './i18n.js';
import { DATA_DIR } from './store.js';
import { recordCodexRateLimits } from './usage.js';

const writerConflict = (error) => /already has an active writer/i.test(String(error?.message || error || ''));

// 别把其他独立额度桶覆盖到账户的 Codex 总额度上；旧版没有 limitId 时沿用兼容格式。
function recordLimits(limits) {
  const id = limits?.limitId ?? limits?.limit_id;
  if (id && id !== 'codex') return null;
  return recordCodexRateLimits(limits);
}

// 这条连接只做 initialize 和额度查询，不触碰聊天会话。失败时保留已有用量。
export async function readCodexRateLimits(runtime) {
  let resolve;
  let settled = false;
  let expectedId = 1;
  const reply = new Promise((r) => { resolve = r; });
  const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
  const proc = runtime.spawnJsonl(runtime.bin, runtime.args, {
    cwd: process.cwd(), input: '', keepOpen: true,
    onEvent(ev) {
      if (settled || ev.method || ev.id !== expectedId) return;
      if (ev.error) { finish(null); return; }
      if (expectedId === 1) {
        expectedId = 2;
        if (!proc.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n') ||
            !proc.write(JSON.stringify({ id: 2, method: 'account/rateLimits/read' }) + '\n')) finish(null);
      } else {
        const result = ev.result || {};
        finish(recordLimits(result.rateLimitsByLimitId?.codex ?? result.rateLimits));
      }
    },
  });
  const timeout = setTimeout(() => finish(null), runtime.requestTimeout || 10000);
  const closed = proc.done.then(() => finish(null), () => finish(null));
  let exitTimer;
  try {
    if (!proc.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'clawchat', title: 'ClawChat', version: '1' } } }) + '\n')) finish(null);
    return await reply;
  } finally {
    clearTimeout(timeout);
    proc.end();
    // 有些旧版收到 EOF 仍不退出，结束整棵进程树，别留下后台查询进程。
    await Promise.race([closed, new Promise((r) => { exitTimer = setTimeout(r, runtime.closeTimeout || 1000); })]);
    clearTimeout(exitTimer);
    await proc.kill();
  }
}

// 新版会话采用分页存储，不一定再写 JSONL。用本地原图估算图片体积，结合官方用量事件保留原有提醒。
function usageFile(sid) {
  return /^[\w-]{1,128}$/.test(sid || '') ? path.join(DATA_DIR, 'codex-usage', `${sid}.json`) : null;
}

export function storedCodexUsage(sid) {
  try {
    const v = JSON.parse(fs.readFileSync(usageFile(sid), 'utf8'));
    const safe = (n) => Number.isFinite(n) && n >= 0 ? n : 0;
    return { images: safe(v.images), used: safe(v.used), window: safe(v.window) };
  } catch { return null; }
}

// 只删 ClawChat 的用量估算，不碰 Codex 会话本身。调用方先确认没有其他群仍在用。
export function removeCodexUsage(sid) {
  const file = usageFile(sid);
  if (file) { try { fs.rmSync(file, { force: true }); } catch {} }
}

export function runCodexServer({ room, prompt, images = [], session, systemPrompt, onStep = () => {}, onActivity, side = false, jointBeforeStart }, runtime) {
  const { bin, args, spawnJsonl, unwrapShell, model: selectedModel, effort: selectedEffort } = runtime;
  let sid = session;
  let model = selectedModel;
  let effort = selectedEffort;
  let turnId = null;
  let active = false;
  let stopped = false;
  let exited = false;
  let booting = true;
  let outcome = null;
  let error = '';
  let lastMessage = '';
  let finalMessage = '';
  let nextId = 0;
  let steering = 0;
  let exitTimer;
  const pending = new Map();
  const seen = new Set();
  const steps = [];
  let usage = { images: 0, used: 0, window: 0 };
  let usageEpoch = 0;
  let usageWarning = '';
  let usageTimer;
  let usageDirty = false;
  let writerFork = false;
  let preparingWriterFork = false;
  const flushUsage = () => {
    clearTimeout(usageTimer);
    usageTimer = null;
    if (!usageDirty) return;
    usageDirty = false;
    if (side || !sid || stopped) return; // 换会话/删群已经清理后，晚到的事件不能把旧记录写回来。
    let tmp;
    try {
      const file = usageFile(sid);
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(usage), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch {} }
      usageWarning = tr('ChatGPT 的用量记录没能保存，聊天和会话不受影响');
    }
  };
  const saveUsage = () => {
    if (side || !sid || stopped) return;
    usageDirty = true;
    // 一批工具/用量事件合并写一次，收尾和停止前仍立即落盘。
    usageTimer ||= setTimeout(flushUsage, 250).unref();
  };
  const addImages = (imgs) => {
    let bytes = 0;
    for (const img of imgs) {
      try { bytes += 4 * Math.ceil(fs.statSync(img.path).size / 3); } catch {}
    }
    usage.images += bytes;
    saveUsage();
    return { bytes, epoch: usageEpoch };
  };
  const undoImages = ({ bytes, epoch }) => {
    if (epoch !== usageEpoch) return; // 等回执时已经压缩过，旧图早已清掉，不能减到后来的新图上。
    usage.images = Math.max(0, usage.images - bytes);
    saveUsage();
  };
  const step = (s) => { steps.push(s); onStep(s); };
  const input = (text, imgs) => [
    { type: 'text', text },
    ...imgs.filter((img) => fs.existsSync(img.path)).map((img) => ({ type: 'localImage', path: path.resolve(img.path) })),
  ];
  const message = (data) => proc.write(`${JSON.stringify(data)}\n`);
  const errorText = (err) => {
    const info = err?.codexErrorInfo || err?.data?.codexErrorInfo;
    const tag = typeof info === 'string' ? info : info && Object.keys(info)[0];
    const text = err?.message || tr('Codex 这一轮失败了');
    // 保留协议错误类别：上下文超限的文案可能变化，hub 仍能按 contextWindowExceeded 自动恢复。
    return tag ? `${text} (${tag})` : text;
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(tr('Codex 接口没有及时回应：{method}', { method })));
    }, runtime.requestTimeout || (/^(initialize|thread\/)/.test(method) ? 120000 : 30000));
    pending.set(id, { resolve, reject, timer });
    if (!message({ id, method, params })) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error(tr('Codex 连接已关闭')));
    }
  });
  // 先等已发出的插话回执，再关 stdin；否则完成通知先到时，插话的确认可能被自己截掉。
  const close = () => {
    if (!outcome || steering || booting || exitTimer || exited) return;
    proc.end();
    // EOF 后仍不退出的进程也要收干净，沿用整棵进程树的结束逻辑。
    exitTimer = setTimeout(proc.kill, 3000);
  };
  const fail = (err) => {
    if (outcome) return;
    active = false;
    outcome = { ok: false, error: String(err?.message || err), ...(err?.sessionMismatch ? { sessionMismatch: true } : {}) };
    close();
  };
  const item = (it, completed) => {
    const key = `${completed ? 'done' : 'start'}:${it.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!completed) {
      if (it.type === 'commandExecution') step({ kind: 'run', text: unwrapShell(it.command) });
      else if (it.type === 'mcpToolCall') step({ kind: 'tool', text: [it.server, it.tool].filter(Boolean).join('.') });
      else if (it.type === 'dynamicToolCall') step({ kind: 'tool', text: [it.namespace, it.tool].filter(Boolean).join('.') });
      return;
    }
    if (it.type === 'agentMessage' && it.text?.trim()) {
      lastMessage = it.text.trim();
      if (it.phase === 'final_answer') finalMessage = lastMessage;
      step({ kind: 'say', text: lastMessage });
    } else if (it.type === 'fileChange') {
      step({ kind: 'edit', text: (it.changes || []).map((c) => path.relative(room.cwd, c.path) || c.path).join(', ') });
    } else if (it.type === 'reasoning') {
      const text = (it.summary || []).join('\n').trim();
      if (text) step({ kind: 'think', text });
    } else if (it.type === 'webSearch') {
      step({ kind: 'web', text: it.query || it.action?.url || '' });
    } else if (it.type === 'contextCompaction') {
      usageEpoch++;
      usage.images = 0;
      saveUsage();
      step({ kind: 'compact', text: tr('正在压缩记忆') });
    } else if (it.type === 'imageView' && it.path) {
      // 官方协议中这是工具再次看图，区别于 userMessage 的附件。只按上面的 item.id 去重，不能按文件路径去重。
      addImages([{ path: it.path }]);
    }
  };
  const proc = spawnJsonl(bin, args, {
    cwd: room.cwd, input: '', keepOpen: true, ...(runtime.env ? { env: runtime.env, inheritEnv: false } : {}),
    onEvent(ev) {
      onActivity?.();
      // 账号额度不属于某个 thread；分身、老版 token_count 和新版通知都要记录。
      if (ev.method === 'account/rateLimits/updated') recordLimits(ev.params?.rateLimits);
      const legacy = ev.type === 'event_msg' ? ev.payload : ev.params?.msg || ev;
      if (legacy?.type === 'token_count') recordLimits(legacy.rate_limits);
      if (ev.id !== undefined && !ev.method) {
        const p = pending.get(ev.id);
        if (!p) return;
        pending.delete(ev.id);
        clearTimeout(p.timer);
        if (ev.error) p.reject(new Error(errorText(ev.error)));
        else p.resolve(ev.result);
        return;
      }
      if (ev.id !== undefined && ev.method) {
        // 无人值守：从不代用户批准额外权限，也不留一个没有界面能回答的审批挂着。
        if (/requestApproval$/.test(ev.method) && ev.method !== 'item/permissions/requestApproval') message({ id: ev.id, result: { decision: 'decline' } });
        else if (ev.method === 'item/permissions/requestApproval') message({ id: ev.id, result: { permissions: {}, scope: 'turn' } });
        else if (ev.method === 'item/tool/requestUserInput') message({ id: ev.id, result: { answers: {} } });
        else if (ev.method === 'mcpServer/elicitation/request') message({ id: ev.id, result: { action: 'cancel', content: null } });
        else message({ id: ev.id, error: { code: -32601, message: 'ClawChat 未提供这个交互接口' } });
        return;
      }
      const p = ev.params || {};
      if (p.threadId && sid && p.threadId !== sid) return;
      if (ev.method === 'turn/started') {
        turnId = p.turn?.id || turnId;
        active = !!turnId && !outcome && !stopped;
      } else if (ev.method === 'item/started' || ev.method === 'item/completed') {
        if (!turnId || !p.turnId || p.turnId === turnId) item(p.item || {}, ev.method === 'item/completed');
      } else if (ev.method === 'turn/plan/updated') {
        step({ kind: 'todo', text: (p.plan || []).map((x) => `${x.status === 'completed' ? '✓' : '·'} ${x.step}`).join('\n') });
      } else if (ev.method === 'thread/tokenUsage/updated') {
        usage.used = p.tokenUsage?.last?.totalTokens ?? usage.used;
        usage.window = p.tokenUsage?.modelContextWindow ?? usage.window;
        saveUsage();
      } else if (ev.method === 'error') {
        error = errorText(p.error);
      } else if (ev.method === 'turn/completed' && (!turnId || p.turn?.id === turnId)) {
        active = false;
        for (const it of p.turn?.items || []) item(it, true);
        outcome = p.turn?.status === 'completed' && !stopped
          ? { ok: true }
          : { ok: false, error: p.turn?.error ? errorText(p.turn.error) : error || tr('Codex 这一轮失败了') };
        close();
      }
    },
  });
  // 任何初始化错误都接到 done 上，不产生悬空的 rejected Promise。
  const ready = (async () => {
    if (!side && session) usage = (await runtime.loadUsage?.(session)) || usage;
    await request('initialize', { clientInfo: { name: 'clawchat', title: 'ClawChat', version: '1' }, ...(isJointFolder(room) ? { capabilities: { experimentalApi: true } } : {}) });
    if (stopped) return;
    message({ method: 'initialized', params: {} });
    if (isJointFolder(room) && (typeof jointBeforeStart !== 'function' || jointBeforeStart() !== true)) throw new Error(tr('联合群授权已改变，请重新发起任务'));
    if (isJointFolder(room)) {
      // 空 MCP 表会合并，不能作为「已经清空」的证据；建会话之前核对实际生效的配置。
      const effective = await request('config/read', { cwd: room.cwd, includeLayers: false });
      const config = effective?.config;
      if (!config || typeof config !== 'object' || Array.isArray(config)
          || Object.values({ ...config.mcpServers, ...config.mcp_servers }).some((server) => !server || server.enabled !== false)) {
        throw new Error(tr('联合群的 MCP 无法关闭，已停止；请检查 Codex 的托管设置'));
      }
      if (stopped) return;
    }
    const sandbox = isJointDiscussion(room) || side || room.permission === 'readonly' ? 'read-only' : room.permission === 'full' ? 'danger-full-access' : 'workspace-write';
    const config = { 'features.fast_mode': !!room.fast?.gpt, ...(isJointDiscussion(room) ? jointCodexConfig(room) : {}) };
    const permissions = isJointFolder(room) ? { permissions: 'clawchat-joint-folder' } : { sandbox };
    const common = { cwd: room.cwd, approvalPolicy: 'never', ...permissions, config, ...(model ? { model } : {}) };
    const params = {
      ...common,
      // 旧会话只按原 threadId 续上，不覆盖原有指令。historyMode 是 0.165.0 的返回字段，不能当请求参数。
      ...(session ? { threadId: session, excludeTurns: true, ...(side ? { ephemeral: true } : {}) } : { ephemeral: side, ...(systemPrompt ? { developerInstructions: systemPrompt } : {}) }),
    };
    let thread;
    try {
      thread = await request(session ? (side ? 'thread/fork' : 'thread/resume') : 'thread/start', params);
    } catch (err) {
      // 桌面 App 即使空闲，只要加载着会话也会持有写锁。只在续聊尚未开始回合时分叉一次，不能重做已执行的工具。
      if (!session || side || !writerConflict(err)) throw err;
      if (stopped) return;
      preparingWriterFork = true;
      let forkModel = model;
      let forkEffort = selectedEffort;
      // fork 保留历史和群规，但模型/思考配置可能回到默认。群里没明确选的，从原会话只读元数据补齐。
      if (!forkModel || !forkEffort) {
        const saved = await request('thread/read', { threadId: session, includeTurns: false });
        if (saved.thread?.id !== session) throw new Error(tr('Codex 返回的会话编号与原会话不一致，已停止'));
        forkModel ||= saved.thread.model;
        forkEffort ||= saved.thread.reasoningEffort;
      }
      if (stopped) return;
      thread = await request('thread/fork', {
        ...common, threadId: session, excludeTurns: true, ephemeral: false,
        ...(forkModel ? { model: forkModel } : {}),
        config: { ...config, ...(forkEffort ? { model_reasoning_effort: forkEffort } : {}) },
      });
      writerFork = true;
    }
    if (stopped) return;
    // 只放行本次明确请求的分叉；回给原编号或指向别的来源时，不开始回合，也不让 hub 自动丢掉原会话。
    if (writerFork && (thread.thread?.id === session || (thread.thread?.forkedFromId && thread.thread.forkedFromId !== session))) {
      throw new Error(tr('Codex 返回的会话编号与原会话不一致，已停止'));
    }
    sid = thread.thread?.id;
    if (!sid) throw new Error(tr('Codex 没有返回会话编号'));
    if (session && !side && sid !== session && !writerFork) throw Object.assign(new Error(tr('Codex 返回的会话编号与原会话不一致，已停止')), { sessionMismatch: true });
    if (session && side && sid === session) throw new Error(tr('ChatGPT 分身没有得到独立会话，已停止'));
    preparingWriterFork = false; // 后面的回合错误仍保留真实类别，不能把上下文超限等都误报成写锁。
    model = thread.model || model;
    effort = selectedEffort || thread.reasoningEffort || effort;
    const sandboxPolicy = sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
      : sandbox === 'read-only' ? { type: 'readOnly', ...(isJointDiscussion(room) ? { networkAccess: false } : {}) }
        : { type: 'workspaceWrite', writableRoots: [room.cwd], networkAccess: true };
    const counted = addImages(images);
    let started;
    try {
      if (isJointFolder(room) && (typeof jointBeforeStart !== 'function' || jointBeforeStart() !== true)) throw new Error(tr('联合群授权已改变，请重新发起任务'));
      started = await request('turn/start', {
        threadId: sid, input: input(prompt, images), cwd: room.cwd, approvalPolicy: 'never',
        ...(isJointFolder(room) ? { permissions: 'clawchat-joint-folder' } : { sandboxPolicy }),
        serviceTierForTurn: room.fast?.gpt ? 'fast' : 'default',
        ...(model ? { model } : {}), ...(selectedEffort ? { effort: selectedEffort } : {}),
      });
    } catch (err) { undoImages(counted); throw err; }
    turnId = started.turn?.id || turnId;
    if (!turnId) throw new Error(tr('Codex 没有返回回合编号'));
    active = !outcome && !stopped;
  })().catch(fail).finally(() => { booting = false; close(); });
  const done = proc.done.then(async ({ code, stderr }) => {
    exited = true;
    active = false;
    clearTimeout(exitTimer);
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(tr('Codex 连接已关闭')));
    }
    pending.clear();
    await ready;
    flushUsage();
    if (!outcome?.ok && !stopped) await proc.kill();
    // 首轮失败不能保存会话，hub 也没有编号可以留给之后删群时清理。
    if (!side && !session && (!outcome?.ok || stopped)) removeCodexUsage(sid);
    const text = finalMessage || lastMessage;
    const kept = steps.filter((s) => !(s.kind === 'say' && s.text.trim() === text.trim()));
    const failure = outcome?.error || error || stderr?.trim().split('\n').at(-1) || tr('{bin} 异常退出（{code}）', { bin: 'codex', code });
    const unsupported = /(?:unrecognized|unknown|unexpected|invalid).*(?:app-server)|(?:app-server).*(?:unrecognized|unknown|not found|not supported)/i.test(`${stderr}\n${failure}`);
    const warning = [
      ...(writerFork ? [tr('原会话被其他程序占用，已保留历史并切到独立会话继续。')] : []), usageWarning,
    ].filter(Boolean).join('\n');
    return outcome?.ok && !stopped
      ? { ok: true, text, steps: kept, session: sid, model, effort, ...(warning ? { warning } : {}) }
      : { ok: false, error: unsupported ? tr('Codex 版本太旧，请在设置 → 程序与模型里点 Codex 的更新')
        : preparingWriterFork || writerConflict(failure) || writerConflict(stderr) ? tr('ChatGPT 的会话正被另一个程序占用，暂时无法接上。请关闭桌面 App 中的这个会话后重试，或使用「换新会话」。')
          : failure, steps, session: sid, ...(outcome?.sessionMismatch ? { sessionMismatch: true } : {}) };
  });
  // Promise<boolean>：必须等 turn/steer 回执成功才算收到；写入管道成功不等于模型收到。
  const steer = async (text, imgs = []) => {
    if (side || stopped || outcome) return false;
    if (booting) await ready; // 卡片刚出现、CLI 还在初始化：等回合编号就绪再插，不提前误判成只能排下一轮。
    if (!active || stopped || outcome) return false;
    steering++;
    const counted = addImages(imgs);
    try {
      const accepted = await request('turn/steer', { threadId: sid, expectedTurnId: turnId, input: input(text, imgs) });
      if (accepted?.turnId !== turnId) { undoImages(counted); return false; }
      return true;
    } catch {
      undoImages(counted);
      return false;
    } finally {
      steering--;
      close();
    }
  };
  const kill = () => {
    flushUsage();
    stopped = true;
    active = false;
    // 先请 Codex 自己收掉当前回合；强制结束仍是兜底，不依赖接口能正常回应。
    if (turnId && sid && !exited && !outcome) message({ id: ++nextId, method: 'turn/interrupt', params: { threadId: sid, turnId } });
    return proc.kill();
  };
  return { done, kill, steer };
}
