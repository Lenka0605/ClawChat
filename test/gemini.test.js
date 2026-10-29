import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-gemini-test-'));
process.env.CLAWCHAT_HOME = path.join(root, 'clawchat');
process.env.GEMINI_CLI_HOME = path.join(root, 'gemini-home');
delete process.env.GEMINI_API_KEY;
const { runGemini, geminiArgs, forkGeminiSession, findGeminiSession, geminiSessionUsage, detectGemini } = await import('../lib/gemini.js');
const { saveConfig } = await import('../lib/store.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const room = { cwd: root, permission: 'full', models: {} };

function fakeRuntime(events, result = { code: 0, stderr: '' }) {
  const capture = { killed: false };
  return {
    capture,
    which: () => '/假的/gemini',
    spawnJsonl(bin, args, opts) {
      Object.assign(capture, { bin, args, opts });
      capture.settings = JSON.parse(fs.readFileSync(opts.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
      if (args.includes('--admin-policy')) capture.policy = fs.readFileSync(args[args.indexOf('--admin-policy') + 1], 'utf8');
      return {
        kill() { capture.killed = true; },
        done: Promise.resolve().then(() => {
          events.forEach(opts.onEvent);
          return result;
        }),
      };
    },
  };
}

const success = [
  { type: 'init', session_id: 'session-test-1234', model: 'gemini-2.5-pro' },
  { type: 'message', role: 'user', content: '用户文字不能当作回复' },
  { type: 'message', role: 'assistant', content: '你好，', delta: true },
  { type: 'message', role: 'assistant', content: '老板', delta: true },
  { type: 'result', status: 'success' },
];

test('Gemini：合并增量回复，记录会话和实际模型，清理临时设置', async () => {
  const runtime = fakeRuntime(success);
  const result = await runGemini({ room, prompt: '测试' }, runtime).done;
  assert.equal(result.ok, true);
  assert.equal(result.text, '你好，老板');
  assert.equal(result.session, 'session-test-1234');
  assert.equal(result.model, 'gemini-2.5-pro');
  assert.equal(fs.existsSync(runtime.capture.opts.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH), false);
});

test('Gemini：续接精确会话，切回默认也明确传模型，权限分开处理', () => {
  const args = geminiArgs({ room, session: 'exact-session' });
  assert.equal(args[args.indexOf('--resume') + 1], 'exact-session');
  assert.equal(args[args.indexOf('--model') + 1], 'auto');
  assert.ok(args.includes('yolo'));
  assert.equal(args.includes('--sandbox'), false);
  assert.ok(geminiArgs({ room: { ...room, permission: 'project' } }).includes('--sandbox'));
  const readonly = geminiArgs({ room, side: true, policy: '/只读策略' });
  assert.equal(readonly.includes('yolo'), false);
  assert.equal(readonly[readonly.indexOf('--approval-mode') + 1], 'default');
  assert.ok(readonly.includes('--admin-policy'));
});

test('Gemini：过程文字和工具不混进最后回复', async () => {
  const events = [success[0],
    { type: 'message', role: 'assistant', content: '我先检查文件', delta: true },
    { type: 'tool_use', tool_name: 'read_file', parameters: { file_path: '/项目/a.js' } },
    { type: 'tool_result', status: 'success' },
    { type: 'message', role: 'assistant', content: '检查完了', delta: true },
    { type: 'result', status: 'success' },
  ];
  const steps = [];
  const res = await runGemini({ room, prompt: '测试', onStep: (s) => steps.push(s) }, fakeRuntime(events)).done;
  assert.equal(res.text, '检查完了');
  assert.deepEqual(steps, [{ kind: 'say', text: '我先检查文件' }, { kind: 'read', text: '/项目/a.js' }]);
});

test('Gemini：工具已成功、没有最终文字的一轮仍然成功，保留会话以免重发命令', async () => {
  const events = [success[0],
    { type: 'tool_use', tool_name: 'run_shell_command', parameters: { command: '执行过的命令' } },
    { type: 'tool_result', status: 'success' },
    { type: 'result', status: 'success' },
  ];
  const res = await runGemini({ room, prompt: '测试' }, fakeRuntime(events)).done;
  assert.equal(res.ok, true);
  assert.equal(res.text, '');
  assert.equal(res.session, 'session-test-1234');
  assert.deepEqual(res.steps, [{ kind: 'run', text: '执行过的命令' }]);
});

test('Gemini：CLI 出错、无最终结果和停止都不能误报成功', async () => {
  for (const [events, exit] of [
    [success, { code: 1, stderr: '登录失效' }],
    [success.slice(0, -1), { code: 0 }],
    [[success[0], { type: 'result', status: 'error', error: { message: '余额不足' } }], { code: 1 }],
  ]) assert.equal((await runGemini({ room, prompt: '测试' }, fakeRuntime(events, exit)).done).ok, false);
  const runtime = fakeRuntime(success);
  const handle = runGemini({ room, prompt: '测试' }, runtime);
  handle.kill();
  assert.equal((await handle.done).ok, false);
  assert.equal(runtime.capture.killed, true);
  const missing = runGemini({ room, prompt: '测试' }, { which: () => null });
  assert.equal((await missing.done).session, null);
});

test('Gemini：只读限制由工具白名单和管理员策略落实，不沿用可写工具或 MCP', async () => {
  const runtime = fakeRuntime(success);
  await runGemini({ room: { ...room, permission: 'readonly' }, prompt: '测试' }, runtime).done;
  assert.equal(runtime.capture.settings.tools.core.includes('run_shell_command'), false);
  assert.equal(runtime.capture.settings.tools.core.includes('write_file'), false);
  assert.equal(runtime.capture.settings.admin.mcp.enabled, false);
  assert.equal(runtime.capture.settings.hooksConfig.enabled, false);
  assert.match(runtime.capture.policy, /toolName = "\*"\ndecision = "deny"/);
});

test('Gemini：成员点名保持文字，只有图片显式作为附件，原图文件不进命令行参数', async () => {
  const file = path.join(root, '图片 有空格.png');
  fs.writeFileSync(file, '假的图片');
  const runtime = fakeRuntime(success);
  await runGemini({ room, prompt: '@Claude 看看 user@example.com', systemPrompt: '@Gemini 是群成员', images: [{ path: file, n: 1 }] }, runtime).done;
  assert.match(runtime.capture.opts.input, /\\@Claude/);
  assert.match(runtime.capture.opts.input, /\\@Gemini/);
  assert.ok(runtime.capture.opts.input.includes(`@"${file}"`));
  assert.equal(runtime.capture.args.includes(file), false);
});

function writeSession(id, jsonl) {
  const chats = path.join(process.env.GEMINI_CLI_HOME, '.gemini', 'tmp', 'project', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  const file = path.join(chats, `session-2026-10-30T00-00-${id.slice(0, 8)}.${jsonl ? 'jsonl' : 'json'}`);
  const metadata = { sessionId: id, projectHash: 'project', startTime: '2026-10-30' };
  const message = { id: 'message-1', type: 'gemini', content: '本体的记忆', tokens: { input: 100, output: 20, thoughts: 3 } };
  fs.writeFileSync(file, jsonl ? `${JSON.stringify(metadata)}\n${JSON.stringify(message)}\n` : JSON.stringify({ ...metadata, messages: [message] }));
  return file;
}

test('Gemini：JSON 和 JSONL 会话都能复制，分身不会改写本体', async () => {
  for (const [id, jsonl] of [['11111111-main-session', false], ['22222222-main-session', true]]) {
    const file = writeSession(id, jsonl);
    const original = fs.readFileSync(file, 'utf8');
    const fork = forkGeminiSession(id);
    assert.notEqual(fork.session, id);
    assert.ok(findGeminiSession(fork.session));
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    fork.cleanup();
    assert.equal(findGeminiSession(fork.session), null);
    assert.deepEqual(geminiSessionUsage(id), { images: 0, used: 123, window: 0 });
    const runtime = fakeRuntime(success);
    await runGemini({ room, session: id, side: true, prompt: '私聊' }, runtime).done;
    assert.notEqual(runtime.capture.args[runtime.capture.args.indexOf('--resume') + 1], id);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('Gemini：找不到本体会话时不冒险续接，检测程序不调用模型', async () => {
  const runtime = fakeRuntime(success);
  const res = await runGemini({ room, session: 'missing-session', side: true, prompt: '私聊' }, runtime).done;
  assert.equal(res.ok, false);
  assert.equal(runtime.capture.args, undefined);
  const calls = [];
  const engine = await detectGemini({ which: () => '/fake/gemini', run: async (...args) => { calls.push(args); return { stdout: '1.2.3\n' }; } });
  assert.equal(engine.version, '1.2.3');
  assert.deepEqual(calls[0][1], ['--version']);
  assert.equal(engine.hasKey, false);
});

test('Gemini：设置里的 Key 只传给子进程，临时认证覆盖 Google 登录，不在状态里返回明文', async () => {
  const key = 'gemini-test-key-1234';
  saveConfig({ geminiKey: key });
  try {
    const runtime = fakeRuntime(success);
    await runGemini({ room, prompt: '测试' }, runtime).done;
    assert.equal(runtime.capture.opts.env.GEMINI_API_KEY, key);
    assert.equal(runtime.capture.settings.security.auth.selectedType, 'gemini-api-key');
    assert.equal(JSON.stringify(runtime.capture.settings).includes(key), false);
    const engine = await detectGemini({ which: () => '/fake/gemini', run: async () => ({ stdout: 'fake' }) });
    assert.equal(engine.hasKey, true);
    assert.equal(engine.keyHint, '…1234');
    assert.equal(JSON.stringify(engine).includes(key), false);
  } finally { saveConfig({ geminiKey: null }); }
});
