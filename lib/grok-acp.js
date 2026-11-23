// 一次只打开一轮。历史回放、其他会话的通知不能混进这一轮的回复。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { tr } from './i18n.js';

export function grokPrompt(text, images = []) {
  const attached = images.map((img) => `图 #${img.n}：${img.label || ''}\n${img.path}`);
  return [text, attached.length && `用户附图如下，请用读图工具查看这些本地文件：\n${attached.join('\n\n')}`].filter(Boolean).join('\n\n');
}

export function startGrokAcp({ bin, spawnJsonl, env, args, cwd, session, prompt, rules, model, effort, onActivity, onSession, onTool, onSay, onThink, updatesFile, mapError }) {
  let completed = false, closingAfterResult = false;
  const ready = Promise.withResolvers();
  let sid, phase = 'setup', seq = 0, pendingSteer, closed, closeTimer, lastErr = '';
  let text = '', modelText = '', thought = '';
  const calls = new Map(), tools = new Set();
  const mismatch = () => new Error(tr('Grok 返回的会话编号不一致，本轮已停止，原记忆已保留'));
  function settleSteer(ok) {
    if (!pendingSteer) return;
    clearInterval(pendingSteer.poll);
    pendingSteer.resolve(ok);
    pendingSteer = null;
  }
  function stopCalls(error) {
    closed = error;
    for (const p of calls.values()) p.reject(error);
    calls.clear();
    settleSteer(false);
  }
  function request(method, params, timeout = 15000) {
    if (closed) return Promise.reject(closed);
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = timeout && setTimeout(() => {
        calls.delete(id);
        reject(new Error(tr('Grok 请求超时：{method}', { method })));
      }, timeout);
      calls.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(err) { clearTimeout(timer); reject(err); },
      });
      if (!proc.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')) {
        calls.get(id).reject(new Error(tr('Grok 已停止')));
        calls.delete(id);
      }
    });
  }
  function flushThought() {
    if (thought.trim()) onThink(thought.trim());
    thought = '';
  }
  // 1.0.88 有时只在本地会话记录里回显已读的插话。每次只读新增字节；
  // 很长的工具输出行直接跳过，不把整份历史读进内存。
  async function readDelivery(entry) {
    const file = updatesFile(sid);
    if (!file || entry !== pendingSteer || entry.consumed) return;
    const size = (await fs.promises.stat(file)).size;
    if (size <= entry.offset) return;
    const stream = fs.createReadStream(file, { start: entry.offset, end: size - 1 });
    for await (const chunk of stream) {
      if (entry !== pendingSteer) break;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        if (entry.partial !== null) {
          const slice = chunk.subarray(start, end);
          entry.partial = entry.partial.length + slice.length <= entry.maxLine
            ? Buffer.concat([entry.partial, slice]) : null;
        }
        if (newline >= 0) {
          if (entry.partial?.includes('user_message_chunk')) {
            let event;
            try { event = JSON.parse(entry.partial.toString()); } catch {}
            if (event?.method === 'session/update' && event.params?.sessionId === sid && consumed(event.params.update, entry)) {
              entry.consumed = true;
              if (entry.accepted) settleSteer(true);
              return;
            }
          }
          entry.partial = Buffer.alloc(0);
        }
        start = end + 1;
      }
      entry.offset += chunk.length;
    }
  }
  function checkDelivery(entry) {
    if (!entry) return;
    entry.scan = entry.scan.then(() => readDelivery(entry)).catch(() => {});
    return entry.scan;
  }
  function consumed(u, entry) {
    return u?.sessionUpdate === 'user_message_chunk' && u._meta?.interjection === true &&
      u.content?._meta?.displayText === entry.text;
  }
  function update(u) {
    if (pendingSteer && consumed(u, pendingSteer)) {
      pendingSteer.consumed = true;
      if (pendingSteer.accepted) settleSteer(true);
    }
    if (u.sessionUpdate === 'agent_thought_chunk') {
      thought += u.content?.text || '';
      return;
    }
    flushThought();
    if (u.sessionUpdate === 'agent_message_chunk' && typeof u.content?.text === 'string') modelText += u.content.text;
    if (!['tool_call', 'tool_call_update'].includes(u.sessionUpdate) || !u.toolCallId || tools.has(u.toolCallId)) return;
    const tool = u._meta?.['x.ai/tool'];
    const input = { ...u.rawInput, ...tool?.input };
    if (!Object.keys(input).length) return;
    tools.add(u.toolCallId);
    if (modelText.trim()) { text = modelText; onSay(modelText.trim()); modelText = ''; }
    onTool({ name: tool?.name || u.title, input });
  }
  function event(ev) {
    if (ev.method && ev.id != null) {
      // 工具在 Grok 自己的沙盒内执行。客户端不代读文件、不执行命令。
      proc.write(JSON.stringify({ jsonrpc: '2.0', id: ev.id, error: { code: -32601, message: 'Unsupported client method' } }) + '\n');
      return;
    }
    if (!ev.method) {
      const p = calls.get(ev.id);
      if (!p) return;
      calls.delete(ev.id);
      if (ev.error) p.reject(new Error(mapError([ev.error.message, typeof ev.error.data === 'string' && ev.error.data].filter(Boolean).join(' '))));
      else p.resolve(ev.result);
      return;
    }
    if (phase !== 'running') return;
    if (ev.method === '_x.ai/session/interjection' && ev.params?.sessionId === sid && pendingSteer?.id === ev.params.interjectionId) {
      void checkDelivery(pendingSteer);
      return;
    }
    if (ev.method !== 'session/update') return;
    if (ev.params?.sessionId !== sid) { stopCalls(mismatch()); proc.kill(); return; }
    onActivity?.();
    update(ev.params.update || {});
  }
  const proc = spawnJsonl(bin, args, { cwd, env, input: '', keepOpen: true, inheritEnv: false, onEvent: event,
    onStderr(s) {
      const mapped = mapError(s);
      if (mapped !== s) { lastErr = mapped; stopCalls(new Error(mapped)); proc.kill(); }
    },
  });
  const exit = proc.done.then((r) => {
    stopCalls(new Error(lastErr || mapError(r.stderr?.trim().split('\n').pop() || tr('Grok 已停止'))));
    return r;
  });
  const done = (async () => {
    try {
      await request('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { 'x.ai/userMessageEcho': true } }, clientInfo: { name: 'clawchat', version: '1' } });
      const auth = await request('_x.ai/auth/info', {});
      if (auth?.methodId !== 'cached_token' || auth.principalType !== 'User') throw new Error(tr('Grok 没有使用官方账号登录，本轮已停止，防止按 API 计费；请运行 grok login'));
      const expected = session || crypto.randomUUID();
      // 失败时只清理本地分配的这个编号，不使用对端未经核对的编号。
      onSession(expected);
      const open = await request(session ? 'session/load' : 'session/new', {
        cwd, mcpServers: [], ...(session && { sessionId: session }),
        _meta: { yoloMode: true, rules, ...(!session && { sessionId: expected }) },
      }, 60000);
      sid = open?.sessionId || open?._meta?.sessionId;
      if (sid !== expected || (open._meta?.sessionId && open._meta.sessionId !== sid)) throw mismatch();
      let options = open.configOptions || [];
      for (const [configId, value] of [['model', model], ['reasoning_effort', effort]]) {
        if (options.find(o => o.id === configId)?.currentValue === value) continue;
        const changed = await request('session/set_config_option', { sessionId: sid, configId, value });
        options = changed?.configOptions || [];
        if (options.find(o => o.id === configId)?.currentValue !== value) throw new Error(tr('Grok 未确认所选的模型或思考强度'));
      }
      phase = 'running';
      ready.resolve(true);
      // 旧版本恢复会话时可能沿用开场规则，所以续聊也带上本轮的群规。
      const body = session && rules ? rules + '\n\n' + prompt : prompt;
      const result = await request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: body }] }, 0);
      phase = 'ending';
      flushThought();
      await checkDelivery(pendingSteer);
      // 收尾时已读到的插话有效，尚未读到的交给 hub 排到下一轮。
      settleSteer(!!pendingSteer?.consumed);
      if (result?._meta?.sessionId !== sid) throw mismatch();
      if (result.stopReason !== 'end_turn') throw new Error(mapError(result.stopReason || tr('Grok 已停止')));
      let info;
      try { info = (await request('_x.ai/session/info', { sessionId: sid }, 3000))?.result; } catch {}
      if (info && info.sessionId !== sid) throw mismatch();
      completed = true;
      return { text: modelText.trim() || text.trim(), model: result._meta.modelId || model, used: info?.context?.used ?? result._meta.totalTokens, window: info?.context?.total };
    } finally {
      phase = 'ending'; ready.resolve(false); settleSteer(false);
      proc.end();
      closeTimer = setTimeout(() => { closingAfterResult = completed; proc.kill(); }, 1800);
      const r = await exit;
      clearTimeout(closeTimer);
      if (completed && !closingAfterResult && (r.code !== 0 || r.signal)) throw closed;
    }
  })();
  async function steer(message, images) {
    if (phase === 'setup') await ready.promise;
    if (phase !== 'running' || closed || pendingSteer) return false;
    const value = grokPrompt(message, images);
    return new Promise(resolve => {
      const file = updatesFile(sid);
      let start = 0;
      try { start = fs.statSync(file).size; } catch {}
      const entry = {
        id: crypto.randomUUID(), text: value, resolve, accepted: false, consumed: false,
        offset: start, partial: Buffer.alloc(0), maxLine: 16384 + Buffer.byteLength(value) * 16,
        scan: Promise.resolve(),
      };
      pendingSteer = entry;
      request('_x.ai/interject', { sessionId: sid, interjectionId: entry.id, text: value }, 0)
        .then(r => {
          if (pendingSteer !== entry) return;
          if (r?.result?.status !== 'queued') return settleSteer(false);
          entry.accepted = true;
          if (entry.consumed) settleSteer(true);
          else {
            entry.poll = setInterval(() => { if (!entry.reading) {
              entry.reading = true;
              checkDelivery(entry).finally(() => { entry.reading = false; });
            } }, 1000);
            entry.poll.unref();
            void checkDelivery(entry);
          }
        }, () => { if (pendingSteer === entry) settleSteer(false); });
    });
  }
  return { done, steer, kill() { phase = 'ending'; stopCalls(new Error(tr('Grok 已停止'))); return proc.kill(); } };
}
