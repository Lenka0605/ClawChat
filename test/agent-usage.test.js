import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-agent-usage-'));
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
process.env.CLAWCHAT_HOME = path.join(root, 'data');
process.env.CODEX_HOME = path.join(root, 'codex');
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
process.env.DEEPSEEK_API_KEY = process.env.GLM_API_KEY = 'fake';
process.env.CLAWCHAT_DEEPSEEK_API = process.env.CLAWCHAT_GLM_API = 'http://127.0.0.1:1';
// 每个入口都指向本测试生成的假程序；不调用任何真实 CLI 或模型。
const cli = `
const readline = require('node:readline');
const fs = require('node:fs');
const emit = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
const rpc = process.argv.includes('app-server');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (rpc) {
    fs.appendFileSync(process.env.FAKE_USAGE_LOG, JSON.stringify(m) + '\\n');
    if (m.method === 'initialize') emit({ id: m.id, result: {} });
    if (m.method === 'account/rateLimits/read') emit({ id: m.id, result: JSON.parse(process.env.FAKE_USAGE_RESULT) });
  } else {
    emit({ type: 'system', subtype: 'init', session_id: 'fake-session', apiKeySource: process.env.FAKE_USAGE_KEY_SOURCE || 'none' });
    emit({ type: 'rate_limit_event', rate_limit_info: JSON.parse(process.env.FAKE_USAGE_RESULT) });
    emit({ type: 'result', subtype: 'success', result: '完成', session_id: 'fake-session' });
  }
});
`;
for (const name of ['claude', 'codex']) {
  fs.writeFileSync(path.join(bin, `${name}.js`), cli);
  fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${cli}`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\n"%~dp0\\${name}.js" %*\r\n`);
}
const { runAgent, which, readCodexRateLimits: readFromAgents } = await import('../lib/agents.js');
const { runCodexServer, readCodexRateLimits } = await import('../lib/codex.js');
const { getUsage, _resetUsage } = await import('../lib/usage.js');
const room = { cwd: root, permission: 'readonly' };
const resetAt = Math.floor(Date.now() / 1000) + 3600;
const snapshot = (pct = 42) => ({ limitId: 'codex', primary: { usedPercent: pct, windowDurationMins: 300, resetsAt: resetAt }, planType: 'pro' });
const claudeInfo = { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: resetAt } } };
after(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(process.env.CLAWCHAT_HOME, { recursive: true, force: true });
  _resetUsage();
  delete process.env.FAKE_USAGE_KEY_SOURCE;
});

test('Claude 订阅事件：本体和分身都记录，DeepSeek、GLM 和 API Key 不混入', async () => {
  assert.equal(which('claude'), path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'));
  process.env.FAKE_USAGE_RESULT = JSON.stringify(claudeInfo);
  for (const agent of ['deepseek', 'glm']) {
    for (const side of [false, true]) {
      assert.equal((await runAgent(agent, { room, prompt: '假事件', systemPrompt: '', side, onStep() {} }).done).ok, true);
      assert.equal(getUsage().claude, undefined);
    }
  }
  process.env.FAKE_USAGE_KEY_SOURCE = 'ANTHROPIC_API_KEY';
  assert.equal((await runAgent('claude', { room, prompt: 'API', systemPrompt: '', onStep() {} }).done).ok, true);
  assert.equal(getUsage().claude, undefined);
  delete process.env.FAKE_USAGE_KEY_SOURCE;
  for (const side of [false, true]) {
    fs.rmSync(process.env.CLAWCHAT_HOME, { recursive: true, force: true });
    _resetUsage();
    assert.equal((await runAgent('claude', { room, prompt: '订阅', systemPrompt: '', side, onStep() {} }).done).ok, true);
    assert.equal(getUsage().claude.windows[0].usedPercent, 42);
  }
});

// 模拟 app-server 的协议和进程生命周期，故障场景也不启动真 CLI。
function fakeRuntime({ events = [], result = { rateLimits: snapshot() }, errorAt, hangAt, exitAt, writeFails = false, hangExit = false } = {}) {
  const sent = [];
  let kills = 0;
  let onEvent;
  return {
    sent, get kills() { return kills; }, emit(ev) { onEvent(ev); },
    bin: '假程序', args: [], unwrapShell: (s) => s, requestTimeout: 30, closeTimeout: 10,
    spawnJsonl(_bin, _args, opts) {
      onEvent = opts.onEvent;
      let finish;
      const done = new Promise((resolve) => { finish = () => resolve({ code: 0, stderr: '' }); });
      return {
        done, end() { if (!hangExit) finish(); }, kill() { kills++; finish(); },
        write(line) {
          const m = JSON.parse(line);
          sent.push(m);
          if (writeFails) return false;
          queueMicrotask(() => {
            if (m.method === exitAt) return finish();
            if (m.method === hangAt) return;
            if (m.method === errorAt) return onEvent({ id: m.id, error: { message: '假失败' } });
            if (m.method === 'initialize') onEvent({ id: m.id, result: {} });
            else if (m.method === 'account/rateLimits/read') onEvent({ id: m.id, result });
            else if (/^thread\//.test(m.method)) onEvent({ id: m.id, result: { thread: { id: 'fake-thread' } } });
            else if (m.method === 'turn/start') {
              onEvent({ id: m.id, result: { turn: { id: 'fake-turn' } } });
              for (const ev of events) onEvent(ev);
              onEvent({ method: 'turn/completed', params: { turn: { id: 'fake-turn', status: 'completed' } } });
            }
          });
          return true;
        },
      };
    },
  };
}

test('Codex 额度通知：本体和分身都接收，独立额度桶不覆盖总额度', async () => {
  for (const side of [false, true]) {
    const runtime = fakeRuntime({ events: [
      { method: 'account/rateLimits/updated', params: { rateLimits: snapshot() } },
      { method: 'account/rateLimits/updated', params: { rateLimits: { ...snapshot(99), limitId: 'codex_other' } } },
    ] });
    assert.equal((await runCodexServer({ room, prompt: '假额度', side }, runtime).done).ok, true);
    assert.equal(getUsage().codex.windows[0].usedPercent, 42);
  }
});

test('Codex 旧 token_count：直接事件、JSONL 包装和旧版 app-server 通知均可接收', async () => {
  const payload = { type: 'token_count', rate_limits: { primary: { used_percent: 33, window_minutes: 300, resets_at: resetAt } } };
  for (const ev of [payload, { type: 'event_msg', payload }, { method: 'codex/event/token_count', params: { msg: payload } }]) {
    fs.rmSync(process.env.CLAWCHAT_HOME, { recursive: true, force: true });
    _resetUsage();
    assert.equal((await runCodexServer({ room, prompt: '假额度' }, fakeRuntime({ events: [ev] })).done).ok, true);
    assert.equal(getUsage().codex.windows[0].usedPercent, 33);
  }
});

test('主动读 Codex 额度：只握手和查询，优先 codex 桶，不创建聊天；退出卡住时清理', async () => {
  const runtime = fakeRuntime({ result: { rateLimits: { ...snapshot(99), limitId: 'codex_other' }, rateLimitsByLimitId: { codex: snapshot() } }, hangExit: true });
  const got = await readCodexRateLimits(runtime);
  assert.equal(got.windows[0].usedPercent, 42);
  assert.deepEqual(runtime.sent.map((m) => m.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.equal(runtime.kills, 1);
});

test('主动读 Codex 额度：不支持、未登录、超时和进程退出都保留已有用量；晚到回执不写入', async () => {
  await readCodexRateLimits(fakeRuntime());
  const before = JSON.stringify(getUsage());
  for (const scenario of [
    { errorAt: 'initialize' }, { errorAt: 'account/rateLimits/read' },
    { hangAt: 'initialize' }, { hangAt: 'account/rateLimits/read' },
    { exitAt: 'initialize' }, { exitAt: 'account/rateLimits/read' },
    { writeFails: true }, { result: {} },
  ]) {
    const runtime = fakeRuntime(scenario);
    assert.equal(await readCodexRateLimits(runtime), null);
    runtime.emit({ id: 2, result: { rateLimits: snapshot(99) } });
    assert.equal(JSON.stringify(getUsage()), before);
    assert.equal(runtime.kills, 1);
  }
});

test('设置页读取接口：并发刷新共用一个假进程，命令缺失返回空值', async () => {
  process.env.FAKE_USAGE_LOG = path.join(root, 'rpc.jsonl');
  process.env.FAKE_USAGE_RESULT = JSON.stringify({ rateLimits: snapshot() });
  const one = readFromAgents();
  const two = readFromAgents();
  assert.equal(one, two);
  assert.equal((await one).windows[0].usedPercent, 42);
  const sent = fs.readFileSync(process.env.FAKE_USAGE_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(sent.map((m) => m.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = path.join(root, '没有程序');
    assert.equal(await readFromAgents(), null);
  } finally { process.env.PATH = oldPath; }
});
