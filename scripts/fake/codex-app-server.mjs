// 假 app-server：只读写测试目录，不连接 OpenAI；模拟回执、续聊和收尾竞态。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const home = process.env.CLAWCHAT_HOME;
if (!home) throw new Error('假 Codex 必须指定 CLAWCHAT_HOME');
const dir = path.join(home, 'fake-codex');
fs.mkdirSync(dir, { recursive: true });
const scenario = process.env.FAKE_CODEX_RPC_SCENARIO || '';
const log = process.env.FAKE_CODEX_RPC_LOG;
const send = (data) => process.stdout.write(`${JSON.stringify(data)}\n`);
const reply = (id, result) => send({ id, result });
const reject = (id, message) => send({ id, error: { code: -32602, message } });
let sid, turn, timer, text = '', extras = [];
const event = (method, data) => send({ method, params: { threadId: sid, turnId: turn, ...data } });
const finish = (status = 'completed') => {
  if (!turn) return;
  const extra = extras.length ? `\n（中途收到 ${extras.length} 条新消息，最后一条：${extras.at(-1).slice(0, 3000)}）` : '';
  if (['usage', 'compact'].includes(scenario)) event('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 42 }, total: { totalTokens: 100 }, modelContextWindow: 65536 } });
  if (status === 'completed' && scenario !== 'no-final') event('item/completed', { item: { type: 'agentMessage', id: 'final', phase: 'final_answer', text: text + extra } });
  const error = scenario === 'context-exceeded' ? { message: '发生错误', codexErrorInfo: 'contextWindowExceeded' } : { message: '假 Codex 这一轮失败' };
  event('turn/completed', { turn: { id: turn, status, items: [], error: status === 'failed' ? error : null } });
  turn = null;
};
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (log) fs.appendFileSync(log, `${JSON.stringify(m)}\n`);
  const p = m.params || {};
  if (!m.method) return;
  if (m.method === 'initialize') reply(m.id, { userAgent: 'clawchat-fake' });
  else if (m.method === 'initialized') return;
  else if (['thread/start', 'thread/resume', 'thread/fork'].includes(m.method)) {
    if ('historyMode' in p) return reject(m.id, 'historyMode is not a ThreadStartParams field');
    if (p.threadId && (!fs.existsSync(path.join(dir, `${p.threadId}.json`)) || scenario === 'missing-session')) return reject(m.id, 'session not found');
    sid = m.method === 'thread/resume' ? p.threadId : `fake-codex-${crypto.randomUUID()}`;
    if (scenario === 'wrong-session') sid = `fake-codex-${crypto.randomUUID()}`;
    if (scenario === 'fork-reuses-parent' && m.method === 'thread/fork') sid = p.threadId;
    if (!p.ephemeral && m.method === 'thread/start') fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify(p));
    reply(m.id, { thread: { id: sid, historyMode: 'paginated' }, model: p.model || 'gpt-fake', reasoningEffort: 'medium' });
  } else if (m.method === 'turn/start') {
    turn = crypto.randomUUID();
    extras = [];
    const file = path.join(home, 'fake-replies', 'codex.txt');
    text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '（假的 ChatGPT）做完了';
    fs.rmSync(file, { force: true });
    reply(m.id, { turn: { id: turn, status: 'inProgress', items: [] } });
    event('turn/started', { turn: { id: turn, status: 'inProgress', items: [] } });
    event('item/started', { item: { id: 'cmd', type: 'commandExecution', command: 'echo 假的 ChatGPT 在干活' } });
    if (scenario === 'usage') {
      const img = p.input.find((x) => x.type === 'localImage');
      if (img) event('item/completed', { item: { id: 'view', type: 'imageView', path: img.path } });
    }
    if (scenario === 'compact') event('item/completed', { item: { id: 'compact', type: 'contextCompaction' } });
    if (scenario === 'events') {
      event('item/completed', { item: { id: 'thinking', type: 'reasoning', summary: ['正在检查要求'] } });
      event('item/completed', { item: { id: 'edit', type: 'fileChange', changes: [{ path: path.join(p.cwd, 'a.js') }] } });
      event('item/started', { item: { id: 'mcp', type: 'mcpToolCall', server: 'fake', tool: 'test' } });
      event('item/completed', { item: { id: 'web', type: 'webSearch', query: '假搜索' } });
      event('item/completed', { item: { id: 'compact', type: 'contextCompaction' } });
      event('turn/plan/updated', { plan: [{ step: '检查', status: 'completed' }] });
      event('item/completed', { item: { id: 'comment', type: 'agentMessage', text: '我先看一下', phase: 'commentary' } });
      send({ method: 'item/commandExecution/requestApproval', id: 900, params: { threadId: sid, turnId: turn } });
      send({ method: 'item/permissions/requestApproval', id: 901, params: { threadId: sid, turnId: turn } });
      send({ method: 'item/tool/requestUserInput', id: 902, params: { threadId: sid, turnId: turn } });
    }
    if (scenario === 'crash') return process.exit(2);
    if (scenario === 'stop-tree') {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
      fs.writeFileSync(path.join(dir, 'child.pid'), String(child.pid));
    }
    timer = setTimeout(() => finish(['fail-turn', 'context-exceeded'].includes(scenario) ? 'failed' : 'completed'), Number(process.env.FAKE_CODEX_SECS || process.env.FAKE_SECS || 6) * 1000);
  } else if (m.method === 'turn/steer') {
    if (!turn || p.expectedTurnId !== turn) return reject(m.id, 'no active turn');
    if (scenario === 'reject-steer') return reject(m.id, 'no active turn');
    const accepted = turn;
    if (scenario === 'usage') {
      const img = p.input.find((x) => x.type === 'localImage');
      if (img) event('item/completed', { item: { id: `steer-view-${m.id}`, type: 'imageView', path: img.path } });
    }
    if (scenario === 'reject-after-complete') {
      clearTimeout(timer);
      finish();
      return setTimeout(() => reject(m.id, 'no active turn'), 40);
    }
    const raw = (p.input || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    const summary = raw.match(/^\[[^\]\n]*\] .*$/m)?.[0] || raw;
    // 只报告收到什么，不把提示词里的私聊标签、@ 原样回显成真的私聊或接力。
    extras.push(summary.replace(/@/g, '＠').replace(/</g, '＜').replace(/>/g, '＞'));
    if (scenario === 'complete-before-steer-reply') {
      clearTimeout(timer);
      finish();
      setTimeout(() => reply(m.id, { turnId: accepted }), 40);
    } else reply(m.id, { turnId: accepted });
  } else if (m.method === 'turn/interrupt') {
    clearTimeout(timer);
    reply(m.id, {});
    finish('interrupted');
  } else if (m.id !== undefined) reject(m.id, 'unknown method');
});
rl.on('close', () => { clearTimeout(timer); });
