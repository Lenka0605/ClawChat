import fs from 'node:fs';
import path from 'node:path';
import { tr } from './i18n.js';

// app-server 和 exec 共用启动器、进程树清理；只替换本体的通讯协议，分身继续用原来的只读 fork。
export function runCodexServer({ room, prompt, images = [], session, systemPrompt, onStep = () => {}, onActivity }, runtime) {
  const { bin, args, spawnJsonl, unwrapShell, model: selectedModel, effort: selectedEffort } = runtime;
  let sid = session;
  let model = selectedModel;
  let effort = selectedEffort;
  let turnId = null;
  let active = false;
  let stopped = false;
  let exited = false;
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
  const step = (s) => { steps.push(s); onStep(s); };
  const input = (text, imgs) => [
    { type: 'text', text },
    ...imgs.filter((img) => fs.existsSync(img.path)).map((img) => ({ type: 'localImage', path: path.resolve(img.path) })),
  ];
  const message = (data) => proc.write(`${JSON.stringify(data)}\n`);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(tr('Codex 接口没有及时回应：{method}', { method })));
    }, runtime.requestTimeout || 30000);
    pending.set(id, { resolve, reject, timer });
    if (!message({ id, method, params })) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error(tr('Codex 连接已关闭')));
    }
  });
  // 先等已发出的插话回执，再关 stdin；否则完成通知先到时，插话的确认可能被自己截掉。
  const close = () => {
    if (!outcome || steering || exitTimer || exited) return;
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
      step({ kind: 'compact', text: tr('正在压缩记忆') });
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
        if (ev.error) p.reject(new Error(ev.error.message || JSON.stringify(ev.error)));
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
      } else if (ev.method === 'error') {
        error = p.error?.message || '';
      } else if (ev.method === 'turn/completed' && (!turnId || p.turn?.id === turnId)) {
        active = false;
        for (const it of p.turn?.items || []) item(it, true);
        outcome = p.turn?.status === 'completed' && !stopped
          ? { ok: true }
          : { ok: false, error: p.turn?.error?.message || error || tr('Codex 这一轮失败了') };
        close();
      }
    },
  });
  // 任何初始化错误都接到 done 上，不产生悬空的 rejected Promise。
  const ready = (async () => {
    await request('initialize', { clientInfo: { name: 'clawchat', title: 'ClawChat', version: '1' }, capabilities: { experimentalApi: true } });
    if (stopped) return;
    message({ method: 'initialized', params: {} });
    const sandbox = room.permission === 'full' ? 'danger-full-access' : room.permission === 'readonly' ? 'read-only' : 'workspace-write';
    const config = { 'features.fast_mode': !!room.fast?.gpt };
    const common = { cwd: room.cwd, approvalPolicy: 'never', sandbox, config, ...(model ? { model } : {}) };
    const thread = await request(session ? 'thread/resume' : 'thread/start', {
      ...common,
      // 保留 JSONL 会话存储，现有图片体积提醒和只读 exec fork 都依赖它；新版本不能悄悄切到另一种历史存储。
      ...(session ? { threadId: session, excludeTurns: true } : { ephemeral: false, historyMode: 'legacy', ...(systemPrompt ? { developerInstructions: systemPrompt } : {}) }),
    });
    if (stopped) return;
    sid = thread.thread?.id;
    if (!sid) throw new Error(tr('Codex 没有返回会话编号'));
    model = thread.model || model;
    effort = selectedEffort || thread.reasoningEffort || effort;
    const sandboxPolicy = sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
      : sandbox === 'read-only' ? { type: 'readOnly' }
        : { type: 'workspaceWrite', writableRoots: [room.cwd], networkAccess: true };
    const started = await request('turn/start', {
      threadId: sid, input: input(prompt, images), cwd: room.cwd, approvalPolicy: 'never', sandboxPolicy,
      serviceTierForTurn: room.fast?.gpt ? 'fast' : 'default',
      ...(model ? { model } : {}), ...(selectedEffort ? { effort: selectedEffort } : {}),
    });
    turnId = started.turn?.id || turnId;
    if (!turnId) throw new Error(tr('Codex 没有返回回合编号'));
    active = !outcome && !stopped;
  })().catch(fail);
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
    return outcome?.ok && !stopped
      ? { ok: true, text, steps: kept, session: sid, model, effort }
      : { ok: false, error: outcome?.error || error || stderr?.trim().split('\n').at(-1) || tr('{bin} 异常退出（{code}）', { bin: 'codex', code }), steps, session: sid };
  });
  // Promise<boolean>：必须等 turn/steer 回执成功才算收到；写入管道成功不等于模型收到。
  const steer = async (text, imgs = []) => {
    if (!active || stopped || outcome) return false;
    steering++;
    try {
      const accepted = await request('turn/steer', { threadId: sid, expectedTurnId: turnId, input: input(text, imgs) });
      return accepted?.turnId === turnId;
    } catch {
      return false;
    } finally {
      steering--;
      close();
    }
  };
  const kill = () => { stopped = true; active = false; proc.kill(); };
  return { done, kill, steer };
}
