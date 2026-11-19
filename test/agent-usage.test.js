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
process.env.GROK_HOME = path.join(root, 'grok');
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
const grokCli = `
const readline = require('node:readline');
const fs = require('node:fs');
const emit = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
if (process.argv[2] === 'agent' && process.argv[3] === 'stdio') {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    if (process.env.FAKE_USAGE_LOG) fs.appendFileSync(process.env.FAKE_USAGE_LOG, JSON.stringify(m) + '\\n');
    if (m.method === 'initialize') emit({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
    if (m.method === '_x.ai/billing') emit({ jsonrpc: '2.0', id: m.id, result: JSON.parse(process.env.FAKE_USAGE_RESULT) });
  });
}
`;
const agyCli = `
const fs = require('node:fs');
if (process.argv.includes('-p') && process.argv.includes('/usage')) {
  if (process.env.FAKE_USAGE_LOG) fs.appendFileSync(process.env.FAKE_USAGE_LOG, JSON.stringify({ args: process.argv.slice(2), hasKey: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) }) + '\\n');
  process.stdout.write(process.env.FAKE_USAGE_RESULT || '');
}
`;
for (const [name, code] of [['grok', grokCli], ['agy', agyCli]]) {
  fs.writeFileSync(path.join(bin, `${name}.js`), code);
  fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${code}`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\n"%~dp0\\${name}.js" %*\r\n`);
}
const { runAgent, which, readCodexRateLimits: readFromAgents, readGrokRateLimits, readGeminiRateLimits } = await import('../lib/agents.js');
const { runCodexServer, readCodexRateLimits } = await import('../lib/codex.js');
const { readGrokUsage } = await import('../lib/grok.js');
const { readAgyUsage } = await import('../lib/antigravity.js');
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

test('主动读 Grok 额度：未登录不启进程；已登录通过 _x.ai/billing 读取并并发共用同一进程；晚到回执不写入', async () => {
  fs.rmSync(process.env.GROK_HOME, { recursive: true, force: true });
  assert.equal(await readGrokRateLimits(), null, '未登录直接返回 null');
  fs.mkdirSync(process.env.GROK_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.GROK_HOME, 'auth.json'), JSON.stringify({ 'https://auth.x.ai::test': { auth_mode: 'oauth2', key: 'fake-token' } }));
  const futureIso = new Date(Date.now() + 86400000).toISOString();
  process.env.FAKE_USAGE_LOG = path.join(root, 'grok-rpc.jsonl');
  process.env.FAKE_USAGE_RESULT = JSON.stringify({
    config: { creditUsagePercent: 25, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: futureIso } },
    subscription_tier: 'SuperGrok',
  });
  const a = readGrokRateLimits();
  const b = readGrokRateLimits();
  assert.equal(a, b, '并发刷新共用同一次读取');
  const got = await a;
  assert.equal(got.plan, 'SuperGrok');
  assert.equal(got.windows[0].usedPercent, 25);
  const sent = fs.readFileSync(process.env.FAKE_USAGE_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(sent.map((m) => m.method), ['initialize', '_x.ai/billing']);
  // 超时或错误后，晚到的回执不能把旧值覆盖掉
  const before = JSON.stringify(getUsage());
  let lateEmit;
  const fakeProc = {
    write: () => true,
    end() {},
    kill: async () => {},
    done: Promise.resolve({ code: 0 }),
  };
  const res = await readGrokUsage({
    bin: 'grok',
    spawnJsonl: (_b, _a, { onEvent }) => { lateEmit = onEvent; return fakeProc; },
  });
  assert.equal(res, null);
  lateEmit({ jsonrpc: '2.0', id: 2, result: { config: { creditUsagePercent: 99, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: futureIso } } } });
  assert.equal(JSON.stringify(getUsage()), before);
});

test('主动读 Gemini (agy) 额度：剥离 API Key 环境变量，并发共用一次查询；有配置 API Key 时跳过', async () => {
  const futureIso = new Date(Date.now() + 86400000).toISOString();
  process.env.FAKE_USAGE_LOG = path.join(root, 'agy-usage.jsonl');
  process.env.FAKE_USAGE_RESULT = JSON.stringify({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: { groups: [{ name: 'Gemini Models', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.75, reset_time: futureIso }] }] },
    },
  });
  process.env.GEMINI_API_KEY = 'should-not-leak';
  const resDirect = await readAgyUsage({
    which: () => path.join(bin, process.platform === 'win32' ? 'agy.cmd' : 'agy'),
    run: async (cmd, args, _t, env) => {
      fs.appendFileSync(process.env.FAKE_USAGE_LOG, JSON.stringify({ args, hasKey: !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY) }) + '\n');
      return { ok: true, stdout: process.env.FAKE_USAGE_RESULT };
    },
  });
  assert.equal(resDirect.windows[0].usedPercent, 25);
  const logRow = JSON.parse(fs.readFileSync(process.env.FAKE_USAGE_LOG, 'utf8').trim());
  assert.deepEqual(logRow.args, ['-p', '/usage', '--output-format', 'json']);
  assert.equal(logRow.hasKey, false, '订阅查询必须剥离 GEMINI_API_KEY');
  // 配了 GEMINI_API_KEY 时 readGeminiRateLimits 直接返回 null，不走订阅查询
  assert.equal(await readGeminiRateLimits(), null);
  delete process.env.GEMINI_API_KEY;
  // 无 API Key 时走真（假）子进程且并发共用一次读取
  fs.rmSync(process.env.FAKE_USAGE_LOG, { force: true });
  const r1 = readGeminiRateLimits();
  const r2 = readGeminiRateLimits();
  assert.equal(r1, r2);
  assert.equal((await r1).windows[0].usedPercent, 25);
});
