import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-gemini-process-'));
const fake = fileURLToPath(new URL('../scripts/fake/', import.meta.url));
process.env.CLAWCHAT_HOME = path.join(root, 'data');
process.env.GEMINI_CLI_HOME = path.join(root, 'gemini-cli');
process.env.CODEX_HOME = path.join(root, 'codex');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
process.env.PATH = `${fake}${path.delimiter}${process.env.PATH}`;
process.env.FAKE_SECS = '0.01';
delete process.env.GEMINI_API_KEY;
const { Store, saveConfig } = await import('../lib/store.js');
saveConfig({ geminiKey: '假接口专用，不能调用真实模型' });
const { Hub } = await import('../lib/hub.js');
const { runAgent, sessionUsage, which } = await import('../lib/agents.js');
const { findGeminiSession } = await import('../lib/gemini.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('Gemini：实际假进程能完成首轮、保存会话，并在重新加载后续接同一记忆', { skip: process.platform === 'win32' }, async () => {
  assert.equal(which('gemini'), path.join(fake, 'gemini'));
  const store = new Store();
  const room = store.createRoom({ name: 'Gemini 测试', cwd: root, members: ['gemini'], permission: 'full' });
  const hub = new Hub(store);
  hub.postUserMessage(room.id, '第一轮，记住这条消息');
  // postUserMessage 已经启动任务，等实际子进程把结果交回 Hub。
  const wait = async (target) => {
    const end = Date.now() + 5000;
    while (target.runs.size) {
      assert.ok(Date.now() < end, '假 Gemini 必须及时结束');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await wait(hub);
  const sid = store.getState(room.id).sessions.gemini;
  assert.ok(sid);
  assert.match(store.getMessages(room.id).at(-1).text, /假的 Gemini/);
  assert.deepEqual(await sessionUsage('gemini', sid), { images: 0, used: 110, window: 0 });

  const restored = new Store();
  assert.equal(restored.getState(room.id).sessions.gemini, sid);
  const again = new Hub(restored);
  again.postUserMessage(room.id, '第二轮，继续');
  await wait(again);
  const resumedId = restored.getState(room.id).sessions.gemini;
  assert.ok(resumedId);
  const saved = findGeminiSession(resumedId);
  assert.ok(saved.raw.includes('第一轮，记住这条消息'));
  assert.ok(saved.raw.includes('第二轮，继续'));
});

test('Gemini：实际分身进程使用复制的记忆，本体会话文件保持原样', { skip: process.platform === 'win32' }, async () => {
  const room = { cwd: root, permission: 'full', models: {} };
  const main = await runAgent('gemini', { room, prompt: '本体记忆', onStep() {} }).done;
  assert.equal(main.ok, true);
  const before = findGeminiSession(main.session).raw;
  const side = await runAgent('gemini', { room, session: main.session, side: true, prompt: '只属于分身的私聊', onStep() {} }).done;
  assert.equal(side.ok, true);
  assert.notEqual(side.session, main.session);
  assert.equal(findGeminiSession(main.session).raw, before);
  assert.equal(findGeminiSession(side.session), null);
});

test('Gemini：停止真实的假进程后，首轮失败的会话不能进入房间状态', { skip: process.platform === 'win32' }, async () => {
  const savedDelay = process.env.FAKE_SECS;
  process.env.FAKE_SECS = '5';
  const store = new Store();
  const room = store.createRoom({ name: 'Gemini 停止测试', cwd: root, members: ['gemini'], permission: 'full' });
  let started;
  const activity = new Promise((resolve) => { started = resolve; });
  const hub = new Hub(store, { run: (id, opts) => runAgent(id, { ...opts, onActivity() { opts.onActivity?.(); started(); } }) });
  try {
    hub.postUserMessage(room.id, '这一轮要停止');
    await Promise.race([activity, new Promise((_, reject) => setTimeout(() => reject(new Error('假进程没有启动')), 3000).unref())]);
    hub.stop(room.id, 'gemini');
    const end = Date.now() + 3000;
    while (hub.runs.size) {
      assert.ok(Date.now() < end, '停止后子进程必须及时结束');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(!store.getState(room.id).sessions.gemini);
  } finally {
    hub.stop(room.id, 'gemini');
    process.env.FAKE_SECS = savedDelay;
  }
});
