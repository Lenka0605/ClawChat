import fs from 'node:fs';
import path from 'node:path';
import { tr } from './i18n.js';
import { DATA_DIR } from './store.js';

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

export function runCodexServer({ room, prompt, images = [], session, systemPrompt, onStep = () => {}, onActivity, side = false }, runtime) {
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
  const attachmentPaths = new Map(); // 附件有时还会回报 imageView，同一路径的查看事件不能再算一次。
  let usageWarning = '';
  const saveUsage = () => {
    if (side || !sid) return;
    try {
      const file = usageFile(sid);
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(usage), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { usageWarning = tr('ChatGPT 的用量记录没能保存，聊天和会话不受影响'); }
  };
  const addImages = (imgs, attachment = false) => {
    let bytes = 0;
    const paths = [];
    for (const img of imgs) {
      try {
        const file = path.resolve(img.path);
        if (!attachment && attachmentPaths.has(file)) continue;
        bytes += 4 * Math.ceil(fs.statSync(file).size / 3);
        if (attachment) {
          attachmentPaths.set(file, (attachmentPaths.get(file) || 0) + 1);
          paths.push(file);
        }
      } catch {}
    }
    usage.images += bytes;
    saveUsage();
    return { bytes, epoch: usageEpoch, paths };
  };
  const undoImages = ({ bytes, epoch, paths }) => {
    if (epoch !== usageEpoch) return; // 等回执时已经压缩过，旧图早已清掉，不能减到后来的新图上。
    for (const file of paths) {
      const count = attachmentPaths.get(file) || 0;
      if (count > 1) attachmentPaths.set(file, count - 1);
      else attachmentPaths.delete(file);
    }
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
    outcome = { ok: false, error: String(err?.message || err) };
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
      attachmentPaths.clear();
      saveUsage();
      step({ kind: 'compact', text: tr('正在压缩记忆') });
    } else if (it.type === 'imageView' && it.path) {
      addImages([{ path: it.path }]);
    }
  };
  const proc = spawnJsonl(bin, args, {
    cwd: room.cwd, input: '', keepOpen: true,
    onEvent(ev) {
      onActivity?.();
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
    await request('initialize', { clientInfo: { name: 'clawchat', title: 'ClawChat', version: '1' } });
    if (stopped) return;
    message({ method: 'initialized', params: {} });
    const sandbox = side || room.permission === 'readonly' ? 'read-only' : room.permission === 'full' ? 'danger-full-access' : 'workspace-write';
    const config = { 'features.fast_mode': !!room.fast?.gpt };
    const common = { cwd: room.cwd, approvalPolicy: 'never', sandbox, config, ...(model ? { model } : {}) };
    const thread = await request(session ? (side ? 'thread/fork' : 'thread/resume') : 'thread/start', {
      ...common,
      // 旧会话只按原 threadId 续上，不覆盖原有指令。historyMode 是 0.165.0 的返回字段，不能当请求参数。
      ...(session ? { threadId: session, excludeTurns: true, ...(side ? { ephemeral: true } : {}) } : { ephemeral: side, ...(systemPrompt ? { developerInstructions: systemPrompt } : {}) }),
    });
    if (stopped) return;
    sid = thread.thread?.id;
    if (!sid) throw new Error(tr('Codex 没有返回会话编号'));
    if (session && !side && sid !== session) throw new Error(tr('Codex 返回的会话编号与原会话不一致，已停止'));
    if (session && side && sid === session) throw new Error(tr('ChatGPT 分身没有得到独立会话，已停止'));
    model = thread.model || model;
    effort = selectedEffort || thread.reasoningEffort || effort;
    const sandboxPolicy = sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
      : sandbox === 'read-only' ? { type: 'readOnly' }
        : { type: 'workspaceWrite', writableRoots: [room.cwd], networkAccess: true };
    const counted = addImages(images, true);
    let started;
    try {
      started = await request('turn/start', {
        threadId: sid, input: input(prompt, images), cwd: room.cwd, approvalPolicy: 'never', sandboxPolicy,
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
    const text = finalMessage || lastMessage;
    const kept = steps.filter((s) => !(s.kind === 'say' && s.text.trim() === text.trim()));
    const failure = outcome?.error || error || stderr?.trim().split('\n').at(-1) || tr('{bin} 异常退出（{code}）', { bin: 'codex', code });
    const unsupported = /(?:unrecognized|unknown|unexpected|invalid).*(?:app-server)|(?:app-server).*(?:unrecognized|unknown|not found|not supported)/i.test(`${stderr}\n${failure}`);
    return outcome?.ok && !stopped
      ? { ok: true, text, steps: kept, session: sid, model, effort, ...(usageWarning ? { warning: usageWarning } : {}) }
      : { ok: false, error: unsupported ? tr('Codex 版本太旧，不支持后台会话，请先升级 Codex') : failure, steps, session: sid };
  });
  // Promise<boolean>：必须等 turn/steer 回执成功才算收到；写入管道成功不等于模型收到。
  const steer = async (text, imgs = []) => {
    if (side || stopped || outcome) return false;
    if (booting) await ready; // 卡片刚出现、CLI 还在初始化：等回合编号就绪再插，不提前误判成只能排下一轮。
    if (!active || stopped || outcome) return false;
    steering++;
    const counted = addImages(imgs, true);
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
  const kill = () => { stopped = true; active = false; proc.kill(); };
  return { done, kill, steer };
}
