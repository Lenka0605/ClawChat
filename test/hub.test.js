import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAWCHAT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-test-'));
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-codex-')); // 别去翻本机真的 Codex 会话
const { Store } = await import('../lib/store.js');
const { Hub, parseMentions, isPass, buildTurn, buildIntro, splitReply } = await import('../lib/hub.js');
const { unwrapShell, cmdShimTarget, codexPicksWindowsSandbox, codexArgs } = await import('../lib/agents.js');

test('parseMentions 识别点名', () => {
  assert.deepEqual(parseMentions('@Claude 你来'), ['claude']);
  assert.deepEqual(parseMentions('@gpt 和 @claude'), ['gpt', 'claude']);
  assert.deepEqual(parseMentions('@所有人 看一下'), ['claude', 'gpt', 'deepseek', 'glm', 'gemini', 'grok']);
  assert.deepEqual(parseMentions('@DeepSeek 你来审一下'), ['deepseek']);
  assert.deepEqual(parseMentions('@深度求索 和 @gpt'), ['deepseek', 'gpt']);
  assert.deepEqual(parseMentions('@Codex 写页面'), ['gpt']);
  assert.deepEqual(parseMentions('@GLM 你来'), ['glm']);
  assert.deepEqual(parseMentions('@智谱 和 @glm 看一下'), ['glm']);
  assert.deepEqual(parseMentions('邮箱 me@gpt.com 不算'), []);
  assert.deepEqual(parseMentions('代码里的 `@claude` 不算'), []);
  assert.deepEqual(parseMentions('```\n@gpt\n```'), []);
});

test('isPass', () => {
  assert.ok(isPass('[PASS]'));
  assert.ok(isPass(' pass '));
  assert.ok(!isPass('PASS 了测试'));
});

test('unwrapShell 去掉 zsh -lc 外壳', () => {
  assert.equal(unwrapShell(`/bin/zsh -lc "sed -n '1p' a.txt"`), "sed -n '1p' a.txt");
  assert.equal(unwrapShell('/bin/zsh -lc \'echo "hi"\''), 'echo "hi"');
  assert.equal(unwrapShell('ls -la'), 'ls -la');
  // Windows 上 Codex 用 PowerShell 跑命令
  assert.equal(unwrapShell(['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-Command', 'Get-ChildItem src']), 'Get-ChildItem src');
  assert.equal(unwrapShell('powershell.exe -Command "npm test"'), 'npm test');
});

test('Windows：从 npm 的 .cmd 包装脚本里找出真正要跑的 JS', () => {
  const shim = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join('\r\n');
  assert.equal(cmdShimTarget(shim), 'node_modules\\@anthropic-ai\\claude-code\\cli.js');
  assert.equal(cmdShimTarget('"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*'), 'node_modules\\@openai\\codex\\bin\\codex.js');
  assert.equal(cmdShimTarget('@echo off\r\nclaude.exe %*'), null);
  assert.equal(cmdShimTarget('"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*'), 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
});

test('Windows：npm 10.9 的包装脚本开头先找 npm 目录里的 node.exe，不能把它当成要跑的程序', () => {
  // npm 10.9（cmd-shim 7）生成的 codex.cmd 原文：以前取到了第一个匹配的 %dp0%\node.exe，那个文件根本不存在，ChatGPT 一启动就 ENOENT
  const npm109 = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ].join('\r\n');
  assert.equal(cmdShimTarget(npm109), 'node_modules\\@openai\\codex\\bin\\codex.js');
  // 更早的 npm：IF EXIST 那一行直接写着 node.exe 和 JS
  const older = [
    '@IF EXIST "%~dp0\\node.exe" (',
    '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ') ELSE (',
    '  @SETLOCAL',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    '  node  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ')',
  ].join('\r\n');
  assert.equal(cmdShimTarget(older), 'node_modules\\@openai\\codex\\bin\\codex.js');
  // 只有 node.exe、没有别的：找不到，交给 cmd.exe 照原样跑
  assert.equal(cmdShimTarget('"%dp0%\\node.exe" %*'), null);
});

test('Codex 配置里自己选过 Windows 沙盒就不替它选', () => {
  assert.equal(codexPicksWindowsSandbox('model = "gpt-6"\n[windows]\nsandbox = "elevated"\n'), true);
  assert.equal(codexPicksWindowsSandbox('windows.sandbox = "elevated"\n'), true);
  assert.equal(codexPicksWindowsSandbox('model = "gpt-6"\n[sandbox_workspace_write]\nnetwork_access = true\n'), false);
  assert.equal(codexPicksWindowsSandbox('[features]\nsandbox = 1\n'), false);
});

test('buildTurn 标注发言人，图片按顺序编号', () => {
  const room = { name: 'r', members: ['claude', 'gpt'] };
  const { prompt: p, images } = buildTurn(room, 'gpt', [
    { from: 'user', text: '开工', ts: 0, images: [{ id: 'a.png', type: 'image/png' }] },
    { from: 'claude', text: '@GPT 写页面', ts: 0 },
    { from: 'gpt', text: '好', ts: 0 },
    { from: 'user', text: '', ts: 0, images: [{ id: 'b.jpg', type: 'image/jpeg' }] },
  ], false, '/up');
  assert.match(p, /老板\] 开工 〔图 #1〕/);
  assert.match(p, /Claude\] @GPT 写页面/);
  assert.match(p, /你（ChatGPT）\] 好/);
  assert.match(p, /老板\] 〔图 #2〕/);
  assert.match(p, /@Claude/);
  assert.deepEqual(images.map((i) => [i.n, i.path, i.type]), [[1, '/up/a.png', 'image/png'], [2, '/up/b.jpg', 'image/jpeg']]);
});

test('buildTurn：DeepSeek 用看不了图的模型时，图片只给文件路径', () => {
  const msgs = [{ from: 'user', text: '看看这张图', ts: 0, images: [{ id: 'a.png', type: 'image/png' }] }];
  const pro = buildTurn({ name: 'r', members: ['deepseek', 'claude'], models: { deepseek: 'deepseek-v4-pro' } }, 'deepseek', msgs, false, '/up');
  assert.equal(pro.images.length, 0);
  assert.match(pro.prompt, /〔图片：\/up\/a\.png〕/);
  assert.match(pro.prompt, /看不了图片/);
  const flash = buildTurn({ name: 'r', members: ['deepseek', 'claude'], models: { deepseek: '' } }, 'deepseek', msgs, false, '/up');
  assert.equal(flash.images.length, 1); // 默认的 deepseek-flash 能看图
  assert.doesNotMatch(flash.prompt, /看不了图片/);
});

test('splitReply 拆出私聊和群聊', () => {
  assert.deepEqual(splitReply('好的。<私聊老板>我觉得 Claude 的方案有问题</私聊老板>', false), { group: '好的。', dm: '我觉得 Claude 的方案有问题', pms: [] });
  assert.deepEqual(splitReply('<私聊老板>只跟你说', false), { group: '', dm: '只跟你说', pms: [] });
  assert.deepEqual(splitReply('收到老板。<群聊>@Claude 按你的方案来</群聊>', true), { group: '@Claude 按你的方案来', dm: '收到老板。', pms: [] });
  assert.deepEqual(splitReply('普通回复', false), { group: '普通回复', dm: '', pms: [] });
  // 私下找另一位 AI
  assert.deepEqual(splitReply('群里说一句。<私聊 DeepSeek>你那边的接口先别动</私聊>', false), { group: '群里说一句。', dm: '', pms: [{ to: 'deepseek', text: '你那边的接口先别动' }] });
  assert.deepEqual(splitReply('<私聊ChatGPT>只跟你说</私聊 ChatGPT>', false), { group: '', dm: '', pms: [{ to: 'gpt', text: '只跟你说' }] });
  // 新加的两位：私聊标签不能被当成群聊正文
  assert.deepEqual(splitReply('收到。<私聊 GLM>你的接口先别动</私聊>', false), { group: '收到。', dm: '', pms: [{ to: 'glm', text: '你的接口先别动' }] });
  assert.deepEqual(splitReply('<私聊Gemini>看一下这个</私聊 Gemini>', false), { group: '', dm: '', pms: [{ to: 'gemini', text: '看一下这个' }] });
  assert.deepEqual(splitReply('<私聊 智谱>一起看</私聊>', false), { group: '', dm: '', pms: [{ to: 'glm', text: '一起看' }] });
  // 被另一位私下找来的回合：默认私下回它，<群聊> 发群里，<私聊老板> 给老板
  assert.deepEqual(splitReply('好的，我改。<群聊>@ChatGPT 接口改好了</群聊><私聊老板>Claude 让我改接口</私聊老板>', false, 'claude'), {
    group: '@ChatGPT 接口改好了',
    dm: 'Claude 让我改接口',
    pms: [{ to: 'claude', text: '好的，我改。' }],
  });
});

// 假的 AI：按脚本回复，记录每次收到的消息
function fakeRunner(script) {
  const calls = [];
  const run = (agent, opts) => {
    calls.push({ agent, prompt: opts.prompt, session: opts.session, images: opts.images, room: opts.room });
    const reply = script(agent, opts.prompt, calls.length);
    return { done: new Promise((r) => setTimeout(() => r({ ok: true, text: reply, steps: [], session: `${agent}-session` }), 5)), kill() {} };
  };
  return { run, calls };
}

function settle(hub) {
  return new Promise((resolve) => {
    const check = () => (hub.runs.size === 0 ? setTimeout(() => (hub.runs.size === 0 ? resolve() : check()), 30) : setTimeout(check, 10));
    check();
  });
}

function newRoom(store, extra = {}) {
  return store.createRoom({ name: 't', cwd: os.tmpdir(), ...extra });
}

// 可控的假 AI：每次调用都挂起，测试里手动结束；被停止时返回失败
function heldRunner() {
  const calls = [];
  const run = (agent, opts) => {
    let resolve;
    const done = new Promise((r) => (resolve = r));
    const call = { agent, side: !!opts.side, session: opts.session, prompt: opts.prompt, finish: (text) => resolve({ ok: true, text, steps: [], session: `${agent}-s` }) };
    calls.push(call);
    return { done, kill: () => resolve({ ok: false, error: 'killed', steps: [], session: null }) };
  };
  return { run, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test('不 @ 时两位同时开工，并且知道对方也在干', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '你俩看看这个文件夹');
  await tick();
  assert.deepEqual(calls.map((c) => c.agent).sort(), ['claude', 'gpt']); // 两位都已经开始，谁也没等谁
  assert.match(calls.find((c) => c.agent === 'claude').prompt, /同时发给了你和 ChatGPT/);
  assert.match(calls.find((c) => c.agent === 'gpt').prompt, /同时发给了你和 Claude/);
  calls.forEach((c) => c.finish(`${c.agent} 看完了`));
  await settle(hub);
  assert.equal(store.getMessages(room.id).filter((m) => m.from !== 'user' && m.from !== 'system').length, 2);
});

test('三人群：不 @ 时三位同时开工，各自知道另外两位也在干；@DeepSeek 只叫它', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt', 'deepseek'] });
  hub.postUserMessage(room.id, '大家看看这个文件夹');
  await tick();
  assert.deepEqual(calls.map((c) => c.agent).sort(), ['claude', 'deepseek', 'gpt']);
  assert.match(calls.find((c) => c.agent === 'deepseek').prompt, /同时发给了你和 Claude、ChatGPT/);
  calls.forEach((c) => c.finish('[PASS]'));
  await settle(hub);
  hub.postUserMessage(room.id, '@DeepSeek 你来审一下');
  await tick();
  assert.deepEqual(calls.slice(3).map((c) => c.agent), ['deepseek']);
  calls[3].finish('好的');
  await settle(hub);
});

test('DeepSeek 知道自己不是 Claude', () => {
  const intro = buildIntro({ name: 'r', members: ['claude', 'deepseek'], cwd: '/p' }, 'deepseek');
  assert.match(intro, /你自己——DeepSeek（/);
  assert.match(intro, /不是 Claude/);
  assert.match(intro, /@Claude/);
});

test('停止可以只停一位：停 Claude，GPT 照常干完', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '@所有人 开工');
  await tick();
  hub.stop(room.id, 'claude');
  await tick();
  assert.equal(hub.runs.size, 1);
  assert.ok(hub.runs.has(hub.key(room.id, 'gpt')));
  calls.find((c) => c.agent === 'gpt').finish('我干完了');
  await settle(hub);
  const texts = store.getMessages(room.id).map((m) => m.text);
  assert.ok(texts.includes('已停止 Claude'));
  assert.ok(texts.includes('我干完了'));
});

test('依次模式：停掉前一位，后一位照样开工；全部停止则都不再开工', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store, { defaultTarget: 'sequential' });
  hub.postUserMessage(room.id, '开工');
  await tick();
  assert.deepEqual(calls.map((c) => c.agent), ['claude']);
  hub.stop(room.id, 'claude');
  await tick();
  assert.deepEqual(calls.map((c) => c.agent), ['claude', 'gpt']);
  hub.stop(room.id); // 全部停止
  await settle(hub);
  hub.postUserMessage(room.id, '再来');
  await tick();
  assert.equal(calls.length, 3); // 只有新消息的第一位开工
  hub.stop(room.id);
  await settle(hub);
});

test('依次模式：两位依次回答，后答的能看到前一位的话', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent) => (agent === 'claude' ? '我来当组长' : '收到'));
  const hub = new Hub(store, { run });
  const room = newRoom(store, { defaultTarget: 'sequential' });
  hub.postUserMessage(room.id, '你们俩商量一下');
  await settle(hub);
  assert.deepEqual(calls.map((c) => c.agent), ['claude', 'gpt']);
  assert.match(calls[1].prompt, /Claude\] 我来当组长/);
  assert.deepEqual(store.getMessages(room.id).map((m) => m.from), ['user', 'claude', 'gpt']);
});

test('@ 谁就只叫谁；[PASS] 不显示', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner(() => '[PASS]');
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '@GPT 在吗');
  await settle(hub);
  assert.deepEqual(calls.map((c) => c.agent), ['gpt']);
  assert.deepEqual(store.getMessages(room.id).map((m) => m.from), ['user']);
});

test('互相 @ 接力，到上限自动暂停', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent) => (agent === 'claude' ? '@GPT 再改一版' : '@Claude 改好了'));
  const hub = new Hub(store, { run });
  const room = newRoom(store, { maxAutoTurns: 3 });
  hub.postUserMessage(room.id, '@Claude 开始');
  await settle(hub);
  assert.equal(calls.length, 4); // 老板叫 1 次 + 自动接力 3 次
  const last = store.getMessages(room.id).at(-1);
  assert.equal(last.from, 'system');
  assert.match(last.text, /先停一下/);
});

test('关闭协作后不会互相叫醒；会话 id 会续上', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner(() => '@GPT 你看看');
  const hub = new Hub(store, { run });
  const room = newRoom(store, { collab: false });
  hub.postUserMessage(room.id, '@Claude 第一句');
  await settle(hub);
  hub.postUserMessage(room.id, '@Claude 第二句');
  await settle(hub);
  assert.deepEqual(calls.map((c) => c.agent), ['claude', 'claude']);
  assert.equal(calls[0].session, null);
  assert.equal(calls[1].session, 'claude-session');
  assert.match(calls[1].prompt, /第二句/);
  assert.doesNotMatch(calls[1].prompt, /第一句/); // 续上会话后只发新消息
});

test('GPT 在群里私下找老板：私聊部分另一位看不到，也不会叫醒它', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent, prompt) => {
    if (agent === 'claude') return '@GPT 把整个页面重写成 jQuery';
    return '收到，我先看看。<私聊老板>老板，用 jQuery 重写没必要，现在的代码挺好，要不要拦一下？</私聊老板>';
  });
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '@Claude 你安排一下');
  await settle(hub);
  const msgs = store.getMessages(room.id);
  const dm = msgs.find((m) => m.dm === 'gpt');
  assert.equal(dm.from, 'gpt');
  assert.match(dm.text, /没必要/);
  assert.ok(msgs.some((m) => m.from === 'gpt' && !m.dm && m.text === '收到，我先看看。'));
  assert.equal(store.getRoom(room.id).dmLast.gpt.from, 'gpt');

  // 老板私聊回复 GPT：只叫醒 GPT，它这一轮是私聊模式；Claude 之后也看不到这段私聊
  hub.postUserMessage(room.id, '你说得对，按你的来', [], 'gpt');
  await settle(hub);
  const last = calls.at(-1);
  assert.equal(last.agent, 'gpt');
  assert.match(last.prompt, /老板（私聊你）\] 你说得对/);
  assert.match(last.prompt, /只有老板能看到/);
  assert.equal(store.getMessages(room.id).at(-1).dm, 'gpt'); // 回复也进私聊

  hub.postUserMessage(room.id, '@Claude 进度如何');
  await settle(hub);
  const claudeLast = calls.filter((c) => c.agent === 'claude').at(-1);
  assert.doesNotMatch(claudeLast.prompt, /没必要|你说得对/);
});

test('干活时退出：重新打开后提醒一次，下一轮把没做完的消息再交给它', async () => {
  const store = new Store();
  const calls = [];
  // 第一轮一直不结束，直到被结束进程
  const hangRun = (agent, opts) => {
    calls.push({ agent, prompt: opts.prompt });
    let resolve;
    const done = new Promise((r) => (resolve = r));
    return { done, kill: () => resolve({ ok: false, error: 'killed', steps: [], session: 's1' }) };
  };
  const hub = new Hub(store, { run: hangRun });
  const room = newRoom(store, { members: ['claude'] });
  hub.postUserMessage(room.id, '写个登录页');
  await new Promise((r) => setTimeout(r, 20));
  hub.shutdown();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getMessages(room.id).filter((m) => m.from === 'system' && /已停止/.test(m.text)).length, 0);

  // 模拟重新打开：新的 Store 从磁盘读
  const store2 = new Store();
  const { run, calls: calls2 } = fakeRunner(() => '登录页写好了');
  const hub2 = new Hub(store2, { run });
  hub2.noticeInterrupted();
  hub2.noticeInterrupted();
  assert.equal(store2.getMessages(room.id).filter((m) => /被打断/.test(m.text)).length, 1);
  hub2.postUserMessage(room.id, '继续');
  await settle(hub2);
  assert.match(calls2[0].prompt, /被打断/);
  assert.match(calls2[0].prompt, /写个登录页/);
  assert.match(calls2[0].prompt, /继续/);
  assert.equal(store2.getMessages(room.id).at(-1).text, '登录页写好了');
});

test('出错的一轮：不保存会话，下次叫到时把没处理的消息重新给它', async () => {
  const store = new Store();
  let fail = true;
  const calls = [];
  const run = (agent, opts) => {
    calls.push({ prompt: opts.prompt, session: opts.session });
    const res = fail ? { ok: false, error: 'model not supported', steps: [], session: 'bad' } : { ok: true, text: '在的', steps: [], session: 'good' };
    return { done: Promise.resolve(res), kill() {} };
  };
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['gpt'] });
  hub.postUserMessage(room.id, '在吗');
  await settle(hub);
  assert.match(store.getMessages(room.id).at(-1).text, /出错了.*模型/);
  assert.equal(store.getState(room.id).sessions.gpt, undefined);
  fail = false;
  hub.postUserMessage(room.id, '现在呢');
  await settle(hub);
  assert.equal(calls[1].session, null);
  assert.match(calls[1].prompt, /在吗/);
  assert.match(calls[1].prompt, /现在呢/);
  assert.equal(store.getState(room.id).sessions.gpt, 'good');
});

test('回复上记下这一轮实际用的模型（群聊和私聊两条都记）', async () => {
  const store = new Store();
  const run = (agent) => ({
    done: Promise.resolve({ ok: true, text: '群里说一句<私聊老板>私下说一句</私聊老板>', steps: [], session: 's', model: 'gpt-6-astra' }),
    kill() {},
  });
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '@GPT 你好');
  await settle(hub);
  const replies = store.getMessages(room.id).filter((m) => m.from === 'gpt');
  assert.equal(replies.length, 2);
  assert.ok(replies.every((m) => m.model === 'gpt-6-astra'));
});

test('回复 GPT 的消息：只有 GPT 回答，而且知道是在回它哪句话；回复时 @ 了别人就按 @ 的来', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent) => `${agent} 收到`);
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '你俩各说一句');
  await settle(hub);
  const gptMsg = store.getMessages(room.id).find((m) => m.from === 'gpt');
  const before = calls.length;
  hub.postUserMessage(room.id, '展开说说', [], null, { seq: gptMsg.seq, from: 'gpt', text: gptMsg.text });
  await settle(hub);
  assert.deepEqual(calls.slice(before).map((c) => c.agent), ['gpt']); // Claude 没被叫醒
  assert.match(calls.at(-1).prompt, /老板，回复你的「gpt 收到」\] 展开说说/);
  assert.equal(store.getMessages(room.id).find((m) => m.text === '展开说说').replyTo.from, 'gpt');

  const mid = calls.length;
  hub.postUserMessage(room.id, '@Claude 你怎么看', [], null, { seq: gptMsg.seq, from: 'gpt', text: gptMsg.text });
  await settle(hub);
  assert.deepEqual(calls.slice(mid).map((c) => c.agent), ['claude']);
  assert.match(calls.at(-1).prompt, /回复ChatGPT的「gpt 收到」/);
});

test('私聊里单独换的模型、强度只用在私聊那一轮，群里照旧', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent) => `${agent} 收到`);
  const hub = new Hub(store, { run });
  const room = newRoom(store, { models: { claude: 'opus', gpt: '' }, efforts: { claude: 'high', gpt: '' } });
  store.updateRoom(room.id, { dmSettings: { claude: { effort: 'low' } } });
  hub.postUserMessage(room.id, '私聊问一下', [], 'claude');
  await settle(hub);
  const dmCall = calls.at(-1);
  assert.equal(dmCall.agent, 'claude');
  assert.equal(dmCall.room.efforts.claude, 'low'); // 私聊用私聊的强度
  assert.equal(dmCall.room.models.claude, 'opus'); // 没单独换的模型跟着群里
  hub.postUserMessage(room.id, '@Claude 群里干活');
  await settle(hub);
  const groupCall = calls.at(-1);
  assert.equal(groupCall.agent, 'claude');
  assert.equal(groupCall.room.efforts.claude, 'high'); // 群里还是群里的
  assert.equal(store.getRoom(room.id).efforts.claude, 'high');
});

test('私聊里 @ 了别人却没发到群里：不自动转，提醒老板并能一键转到群里', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent) => (agent === 'claude' ? '@ChatGPT 进度如下：APK 已打好' : 'gpt 收到'));
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '你去群里发一下进度', [], 'claude');
  await settle(hub);
  assert.deepEqual(calls.map((c) => c.agent), ['claude']); // ChatGPT 没被叫起来：私聊里的话不自动公开
  const msgs = store.getMessages(room.id);
  const dmReply = msgs.find((m) => m.from === 'claude');
  assert.equal(dmReply.dm, 'claude');
  const tip = msgs.find((m) => m.action?.type === 'forward');
  assert.equal(tip.dm, 'claude');
  assert.equal(tip.action.seq, dmReply.seq);
  // 老板点「发到群里」
  assert.equal(hub.forwardToGroup(room.id, dmReply.seq), true);
  await settle(hub);
  assert.equal(calls.at(-1).agent, 'gpt');
  assert.match(calls.at(-1).prompt, /Claude（老板从私聊转到群里的）\] @ChatGPT 进度如下/);
  assert.equal(store.getMessages(room.id).filter((m) => m.forwardOf === dmReply.seq).length, 1);
  hub.forwardToGroup(room.id, dmReply.seq); // 再点一次不会重复发
  assert.equal(store.getMessages(room.id).filter((m) => m.forwardOf === dmReply.seq).length, 1);
});

test('本体忙时，分身在私聊里写的 <群聊> 会发到群里，并叫醒被 @ 的那位', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '@Claude 打包');
  await tick();
  calls[0].finish('好的');
  await settle(hub);
  hub.postUserMessage(room.id, '@Claude 继续打包');
  await tick();
  const main = calls.at(-1);
  hub.postUserMessage(room.id, '你去群里同步一下进度', [], 'claude');
  await tick();
  const side = calls.at(-1);
  assert.equal(side.side, true);
  assert.match(side.prompt, /写在 <群聊>…<\/群聊> 里，会发到群里/);
  side.finish('<群聊>@ChatGPT 安卓包进度：APK 已打好</群聊>老板，已经在群里同步了');
  await tick();
  const msgs = store.getMessages(room.id);
  const inGroup = msgs.find((m) => m.from === 'claude' && m.side && !m.dm);
  assert.equal(inGroup.text, '@ChatGPT 安卓包进度：APK 已打好');
  assert.ok(msgs.some((m) => m.from === 'claude' && m.side && m.dm === 'claude' && m.text === '老板，已经在群里同步了'));
  assert.equal(calls.at(-1).agent, 'gpt'); // ChatGPT 被叫起来了
  assert.match(calls.at(-1).prompt, /@ChatGPT 安卓包进度/);
  main.finish('打完了');
  // 本体干完会再起一轮看分身替它聊了什么：把还没结束的轮次都结束掉
  for (let i = 0; i < 20 && (hub.runs.size || hub.sideRuns.size); i++) {
    calls.forEach((c) => c.finish('[PASS]'));
    await tick();
  }
});

test('AI 私下找另一位 AI：对方被叫醒、默认私下回；第三位看不到；整段对话只放在被找的那一位的私聊里', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent, prompt, n) => {
    if (agent === 'claude' && n === 1) return '大家好。<私聊 DeepSeek>你那边的接口先别动，等我改完</私聊>';
    if (agent === 'claude' && /好的，等你/.test(prompt)) return '行，我改完叫你。';
    if (agent === 'deepseek' && !/改完叫你/.test(prompt)) return '好的，等你。';
    return '[PASS]';
  });
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt', 'deepseek'] });
  hub.postUserMessage(room.id, '@Claude 开工');
  await settle(hub);
  const msgs = store.getMessages(room.id);
  const pms = msgs.filter((m) => m.pm);
  assert.deepEqual(
    pms.map((m) => [m.from, m.pm, m.pmIn, m.text]),
    [
      ['claude', 'deepseek', 'deepseek', '你那边的接口先别动，等我改完'], // Claude 找 DeepSeek：放在 DeepSeek 的私聊里
      ['deepseek', 'claude', 'deepseek', '好的，等你。'], // DeepSeek 回 Claude：还是那段对话，也在 DeepSeek 的私聊里
      ['claude', 'deepseek', 'deepseek', '行，我改完叫你。'], // Claude 接着说：同上
    ],
  );
  // DeepSeek 被叫醒，知道是 Claude 私下找它，回复默认私下回 Claude
  const dsCall = calls.find((c) => c.agent === 'deepseek');
  assert.match(dsCall.prompt, /Claude（私下发给你，别人看不到）\] 你那边的接口先别动/);
  assert.match(dsCall.prompt, /Claude 私下找你/);
  // ChatGPT 看不到这几条
  hub.postUserMessage(room.id, '@ChatGPT 你看看进度');
  await settle(hub);
  const gptCall = calls.filter((c) => c.agent === 'gpt').at(-1);
  assert.doesNotMatch(gptCall.prompt, /接口先别动|好的，等你|改完叫你/);
  // 侧栏：只有 DeepSeek 的私聊有这段对话，Claude 的私聊里没有
  assert.equal(store.getRoom(room.id).dmLast.claude, undefined);
  assert.equal(store.getRoom(room.id).dmLast.deepseek.text, '行，我改完叫你。');
  // 之后 DeepSeek 主动找 Claude，是另一段对话：放在 Claude 的私聊里
  hub.deliver(room.id, 'deepseek', '<私聊 Claude>接口我这边也有个问题想问你</私聊>', false, {});
  assert.equal(store.getMessages(room.id).filter((m) => m.pm).at(-1).pmIn, 'claude');
  await settle(hub);
});

test('被别的 AI 私下找来的这一轮，「正在干活」只显示在那段对话所在的私聊里', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt', 'deepseek'] });
  hub.deliver(room.id, 'deepseek', '<私聊 Claude>问你几个问题</私聊>', false, {});
  await tick();
  assert.deepEqual(hub.status().map((r) => [r.agent, r.peer, r.pmIn]), [['claude', 'deepseek', 'claude']]);
  calls.at(-1).finish('好，你问。');
  await tick();
  // Claude 的回复把 DeepSeek 叫醒：DeepSeek 这一轮也显示在 Claude 的私聊里
  assert.deepEqual(hub.status().map((r) => [r.agent, r.peer, r.pmIn]), [['deepseek', 'claude', 'claude']]);
  calls.at(-1).finish('[PASS]');
  await settle(hub);
});

test('0.6.1 以前的 AI 私聊：按「谁找谁」补上放在谁的私聊里，侧栏的最后一条也重算', async () => {
  const store = new Store();
  const room = newRoom(store, { members: ['claude', 'gpt', 'deepseek'] });
  store.appendMessage(room.id, { from: 'deepseek', pm: 'claude', text: '问你个事' });
  store.appendMessage(room.id, { from: 'claude', pm: 'deepseek', text: '你说' });
  store.appendMessage(room.id, { from: 'deepseek', pm: 'claude', text: '签名在谁手里' });
  store.appendMessage(room.id, { from: 'user', dm: 'deepseek', text: '你好' });
  // 以前的侧栏记录：两位的私聊都记了 AI 私聊
  store.getRoom(room.id).dmLast = { deepseek: { from: 'deepseek', text: '签名在谁手里', pm: 'claude' }, claude: { from: 'deepseek', text: '签名在谁手里', pm: 'claude' } };
  store.saveRooms();
  const again = new Store();
  assert.deepEqual(again.getMessages(room.id).filter((m) => m.pm).map((m) => m.pmIn), ['claude', 'claude', 'claude']);
  assert.equal(again.getRoom(room.id).dmLast.claude.text, '签名在谁手里');
  assert.equal(again.getRoom(room.id).dmLast.deepseek.text, '你好');
});

test('老板编辑了自己的消息：作为新消息发出，大家看得到改的是哪条、以新的为准', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent) => `${agent} 收到`);
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '@Claude 把海报改成蓝色');
  await settle(hub);
  const orig = store.getMessages(room.id).find((m) => m.text === '@Claude 把海报改成蓝色');
  hub.postUserMessage(room.id, '@Claude 把海报改成绿色', [], null, null, { seq: orig.seq, text: orig.text });
  await settle(hub);
  assert.equal(calls.at(-1).agent, 'claude');
  assert.match(calls.at(-1).prompt, /老板，修改了自己之前那条「@Claude 把海报改成蓝色」，以这条为准\] @Claude 把海报改成绿色/);
  assert.equal(store.getMessages(room.id).at(-2).editOf.seq, orig.seq);
});

test('空闲时私聊它，它还没看过群里别人的新消息：照样按私聊回，回复留在私聊里，群里的话只当背景', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt', 'deepseek'] });
  hub.postUserMessage(room.id, '@DeepSeek 你好');
  await tick();
  calls[0].finish('老板好');
  await settle(hub);
  // Claude 和 ChatGPT 在群里聊（提到 DeepSeek 但没 @ 它），DeepSeek 没被叫醒
  store.appendMessage(room.id, { from: 'claude', text: 'DeepSeek 刚才在手机上测过了，我建议合进 main。' });
  store.appendMessage(room.id, { from: 'gpt', text: '复核通过，等老板说合再合。' });
  hub.postUserMessage(room.id, '看下你还有多少余额？帮我打开充值页面', [], 'deepseek');
  await tick();
  const call = calls.at(-1);
  assert.equal(call.agent, 'deepseek');
  assert.match(call.prompt, /我建议合进 main/); // 群里的新消息也给它看
  assert.match(call.prompt, /只是让你知道群里的进展/);
  assert.match(call.prompt, /老板在私聊你/);
  assert.deepEqual(hub.status().map((r) => [r.agent, r.dm]), [['deepseek', true]]); // 「正在干活」显示在私聊里
  call.finish('充值页面已经打开了');
  await settle(hub);
  const reply = store.getMessages(room.id).at(-1);
  assert.equal(reply.from, 'deepseek');
  assert.equal(reply.dm, 'deepseek');
});

test('群里 @ 了它、老板又私聊了它：按群聊回合跑，私聊里也显示它在干活；没 @ 它的老板消息不算叫它', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt', 'deepseek'], defaultTarget: 'claude', collab: true });
  hub.postUserMessage(room.id, '@DeepSeek 你好');
  await tick();
  calls[0].finish('老板好');
  await settle(hub);
  // 老板在群里没 @ 人（默认只找 Claude），不算叫 DeepSeek
  store.appendMessage(room.id, { from: 'user', text: '大家辛苦了' });
  hub.postUserMessage(room.id, '你那边怎么样', [], 'deepseek');
  await tick();
  assert.deepEqual(hub.status().map((r) => [r.agent, r.dm, r.withDm]), [['deepseek', true, false]]);
  calls.at(-1).finish('都好');
  await settle(hub);
  // Claude 在群里 @ 了它（它当时没被叫醒，比如接力到了上限），老板又私聊它：群聊回合，私聊里也有「正在干活」
  store.appendMessage(room.id, { from: 'claude', text: '@DeepSeek 帮我核一下包' });
  hub.postUserMessage(room.id, '顺便看下余额', [], 'deepseek');
  await tick();
  assert.deepEqual(hub.status().map((r) => [r.agent, r.dm, r.withDm]), [['deepseek', false, true]]);
  assert.match(calls.at(-1).prompt, /<私聊老板>/);
});

test('本体在群里忙时私聊它：分身马上回；本体干完后看到分身聊了什么', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  // 先让 Claude 有一个会话
  hub.postUserMessage(room.id, '@Claude 你好');
  await tick();
  calls[0].finish('你好老板');
  await settle(hub);
  // Claude 在群里干一件很久的活
  hub.postUserMessage(room.id, '@Claude 去重构整个项目');
  await tick();
  const mainCall = calls.at(-1);
  assert.equal(mainCall.side, false);
  // 这时私聊它：不用等，分身马上开工，带着本体的会话（分叉）
  hub.postUserMessage(room.id, '进度怎么样了？', [], 'claude');
  await tick();
  const sideCall = calls.at(-1);
  assert.equal(sideCall.side, true);
  assert.equal(sideCall.session, 'claude-s');
  assert.match(sideCall.prompt, /你是本体的分身/);
  assert.match(sideCall.prompt, /进度怎么样了/);
  assert.equal(hub.runs.size, 1); // 本体还在干
  sideCall.finish('在改第三个模块了，大概还要十分钟');
  await tick();
  const sideReply = store.getMessages(room.id).at(-1);
  assert.equal(sideReply.side, true);
  assert.equal(sideReply.dm, 'claude');
  assert.equal(calls.length, 3); // 本体还没干完，不会多开回合
  // 本体干完：接着看一眼分身替它聊了什么（私聊模式）
  mainCall.finish('重构完了');
  await tick();
  const syncCall = calls.at(-1);
  assert.equal(syncCall.side, false);
  assert.match(syncCall.prompt, /你的分身（私聊老板）\] 在改第三个模块了/);
  assert.match(syncCall.prompt, /老板（私聊你）\] 进度怎么样了/);
  syncCall.finish('[PASS]');
  await settle(hub);
  assert.equal(store.getMessages(room.id).filter((m) => m.from === 'claude' && m.dm).length, 1); // 没有重复回私聊
});

test('本体在群里忙时同事私下找它：分身马上私下回同事；本体干完后看到分身聊了什么', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt'] });
  // Claude 先有一个会话，然后在群里干一件很久的活
  hub.postUserMessage(room.id, '@Claude 你好');
  await tick();
  calls[0].finish('你好老板');
  await settle(hub);
  hub.postUserMessage(room.id, '@Claude 去重构整个项目');
  await tick();
  const mainCall = calls.at(-1);
  assert.equal(mainCall.agent, 'claude');
  // 老板让 ChatGPT 去问问；ChatGPT 私下找 Claude
  hub.postUserMessage(room.id, '@ChatGPT 问问 Claude 做到哪了');
  await tick();
  const gptCall = calls.at(-1);
  assert.equal(gptCall.agent, 'gpt');
  gptCall.finish('<私聊 Claude>你那边重构做到哪了？</私聊>');
  await tick();
  // 不用等 Claude 干完：分身马上开工，知道是 ChatGPT 私下找它
  const sideCall = calls.at(-1);
  assert.equal(sideCall.agent, 'claude');
  assert.equal(sideCall.side, true);
  assert.equal(sideCall.session, 'claude-s');
  assert.match(sideCall.prompt, /你是本体的分身，专门先回 ChatGPT 私下找你的话/);
  assert.match(sideCall.prompt, /你那边重构做到哪了/);
  assert.ok(hub.runs.has(hub.key(room.id, 'claude')));
  // 分身的状态显示在 ChatGPT 找 Claude 的那段私聊里
  const st = hub.status().find((r) => r.side);
  assert.equal(st.peer, 'gpt');
  assert.equal(st.pmIn, 'claude');
  sideCall.finish('在改第三个模块了，大概还要十分钟');
  await tick();
  const reply = store.getMessages(room.id).find((m) => m.from === 'claude' && m.side);
  assert.equal(reply.pm, 'gpt'); // 默认私下回 ChatGPT，不发到群里、也不进老板的私聊
  assert.equal(reply.pmIn, 'claude');
  assert.equal(reply.dm, undefined);
  // ChatGPT 被叫醒，看到回复
  const gptAgain = calls.at(-1);
  assert.equal(gptAgain.agent, 'gpt');
  assert.match(gptAgain.prompt, /在改第三个模块了/);
  gptAgain.finish('老板，Claude 说在改第三个模块，大概还要十分钟');
  await tick();
  // 本体干完：接着看一眼分身替它聊了什么，不会把 ChatGPT 的私聊再回一遍
  mainCall.finish('重构完了');
  await tick();
  const syncCall = calls.at(-1);
  assert.equal(syncCall.agent, 'claude');
  assert.equal(syncCall.side, false);
  assert.match(syncCall.prompt, /你的分身（私下发给 ChatGPT）\] 在改第三个模块了/);
  syncCall.finish('[PASS]');
  await settle(hub);
  assert.equal(store.getMessages(room.id).filter((m) => m.from === 'claude' && m.pm === 'gpt').length, 1);
});

test('做完了但会话要重置（resetSession）、带提醒（warning）：不算失败、不重跑，只提示；下一轮开新会话带上聊天记录', async () => {
  const store = new Store();
  let n = 0;
  const calls = [];
  const run = (agent, opts) => {
    calls.push({ agent, session: opts.session, prompt: opts.prompt });
    n++;
    const res = n === 1 ? { ok: true, text: '第一轮', steps: [], session: 'gem-1' }
      : n === 2 ? { ok: true, text: '改好了', steps: [], session: 'gem-2', resetSession: true, warning: '这一轮做完了，但记忆没存上' }
      : { ok: true, text: '接着做', steps: [], session: 'gem-3' };
    return { done: Promise.resolve(res), kill() {} };
  };
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude'] });
  hub.postUserMessage(room.id, '你好');
  await settle(hub);
  hub.postUserMessage(room.id, '改一下文件');
  await settle(hub);
  assert.equal(calls.length, 2); // 没有因为记忆没存上把这一轮重跑
  assert.equal(store.getState(room.id).sessions.claude, null);
  const msgs = store.getMessages(room.id);
  assert.ok(msgs.some((m) => m.from === 'claude' && m.text === '改好了'));
  assert.ok(msgs.some((m) => m.from === 'system' && /记忆没存上/.test(m.text)));
  hub.postUserMessage(room.id, '继续');
  await settle(hub);
  assert.equal(calls[2].session, null); // 新会话
  assert.match(calls[2].prompt, /改一下文件/); // 带上了最近的聊天记录
  assert.equal(store.getState(room.id).sessions.claude, 'gem-3');
});

test('同事私下找时开的分身出错了：提示留在那段私聊里，不发到群里', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt'] });
  hub.postUserMessage(room.id, '@Claude 去重构整个项目');
  await tick();
  const mainCall = calls.at(-1);
  hub.postUserMessage(room.id, '@ChatGPT 问问 Claude');
  await tick();
  calls.at(-1).finish('<私聊 Claude>做到哪了？</私聊>');
  await tick();
  const sideCall = calls.at(-1);
  assert.equal(sideCall.side, true);
  hub.stop(room.id, 'claude', 'side'); // 只停分身
  await tick();
  const note = store.getMessages(room.id).find((m) => m.from === 'system' && /分身/.test(m.text));
  assert.ok(note);
  assert.equal(note.pm, 'gpt');
  assert.equal(note.pmIn, 'claude');
  assert.equal(note.dm, undefined);
  mainCall.finish('重构完了');
  for (let i = 0; i < 20 && (hub.runs.size || hub.sideRuns.size); i++) {
    await tick();
    for (const c of calls) c.finish('[PASS]');
  }
});

test('上下文满了：自动换新会话重来，完整记录里没有另一位的私聊；换了还超就提示分几次发', async () => {
  const store = new Store();
  let overflow = 0; // 还要报几次「上下文满了」
  const calls = [];
  const run = (agent, opts) => {
    calls.push({ agent, session: opts.session, prompt: opts.prompt });
    const full = agent === 'gpt' && overflow > 0;
    if (full) overflow--;
    const res = full
      ? { ok: false, error: "Codex ran out of room in the model's context window.", steps: [], session: null }
      : { ok: true, text: `${agent} 好的`, steps: [], session: `${agent}-s` };
    return { done: Promise.resolve(res), kill() {} };
  };
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '@GPT 先记住项目叫火星计划');
  await settle(hub);
  hub.postUserMessage(room.id, '只跟你说的秘密', [], 'claude');
  await settle(hub);

  overflow = 1;
  hub.postUserMessage(room.id, '@GPT 接着干');
  await settle(hub);
  const [failed, retried] = calls.slice(-2);
  assert.equal(failed.session, 'gpt-s');
  assert.equal(retried.session, null); // 换成了新会话
  assert.match(retried.prompt, /上下文满了/);
  assert.match(retried.prompt, /接着干/);
  const file = retried.prompt.match(/完整记录在 (\S+?)，/)[1];
  const transcript = fs.readFileSync(file, 'utf8');
  assert.match(transcript, /火星计划/);
  assert.doesNotMatch(transcript, /只跟你说的秘密/); // 另一位和老板的私聊不在里面
  assert.ok(store.getMessages(room.id).some((m) => m.from === 'system' && /上下文满了，已经自动换成新会话/.test(m.text)));
  assert.equal(store.getMessages(room.id).at(-1).text, 'gpt 好的');

  overflow = 2; // 换了新会话还是超
  hub.postUserMessage(room.id, '@GPT 这是一大堆内容');
  await settle(hub);
  assert.match(store.getMessages(room.id).at(-1).text, /内容太大了.*分几次发/);
});

test('单聊：没有 @ 规则，消息只发给这一位', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner(() => '好的');
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude'] });
  hub.postUserMessage(room.id, '@GPT 在吗', [{ id: 'x.png', type: 'image/png' }]);
  await settle(hub);
  assert.deepEqual(calls.map((c) => c.agent), ['claude']);
  assert.equal(calls[0].images.length, 1);
  assert.doesNotMatch(calls[0].prompt, /私聊老板/);
});

test('分身卡住时，群里的新消息照样马上开工；分身正在回的私聊会标出来，不会回两遍', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  // 老板现场：GPT 在群里干活 → 私聊问它卡了没（分身开工）→ 停掉本体 → 换模型后在群里再叫它
  hub.postUserMessage(room.id, '@GPT 根据Claude的要求继续做');
  await tick();
  hub.postUserMessage(room.id, '你卡了吗？', [], 'gpt');
  await tick();
  const sideCall = calls.at(-1);
  assert.equal(sideCall.side, true);
  hub.stop(room.id, 'gpt', 'main');
  await tick();
  hub.postUserMessage(room.id, '@GPT 根据Claude的要求继续做');
  await tick();
  const mainCall = calls.at(-1);
  assert.equal(mainCall.side, false); // 不用等卡住的分身，本体已经开工
  assert.match(mainCall.prompt, /老板（私聊你，你的分身正在回）\] 你卡了吗/);
  assert.match(mainCall.prompt, /这一轮不用回/);
  assert.doesNotMatch(mainCall.prompt, /回应那部分请写在 <私聊老板>/);
  mainCall.finish('好的，继续做');
  sideCall.finish('没卡，在等图片生成');
  await settle(hub);
  const gptMsgs = store.getMessages(room.id).filter((m) => m.from === 'gpt');
  assert.deepEqual(gptMsgs.map((m) => [m.text, !!m.dm]), [['好的，继续做', false], ['没卡，在等图片生成', true]]);
  hub.stop(room.id);
  await settle(hub);
});

test('分身在回私聊、本体空着时，只有新私聊不会叫醒本体，等分身回完再一起处理', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '@GPT 干活');
  await tick();
  hub.postUserMessage(room.id, '进度？', [], 'gpt');
  await tick();
  const [mainCall, sideCall] = calls;
  mainCall.finish('干完了');
  await tick();
  assert.equal(calls.length, 2); // 分身还在回「进度？」，本体没有别的活，不开新回合
  hub.postUserMessage(room.id, '还有一件事', [], 'gpt');
  await tick();
  assert.equal(calls.length, 2);
  sideCall.finish('快好了');
  await tick();
  const sync = calls.at(-1);
  assert.equal(sync.side, false);
  assert.match(sync.prompt, /你的分身（私聊老板）\] 快好了/);
  assert.match(sync.prompt, /老板（私聊你）\] 还有一件事/);
  sync.finish('[PASS]');
  await settle(hub);
});

test('卡住时「换新会话重来」：丢掉旧会话，带上最近记录把这一轮重来', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '@GPT 先记住项目叫火星计划');
  await tick();
  calls[0].finish('记住了');
  await settle(hub);
  hub.postUserMessage(room.id, '@GPT 出一张海报');
  await tick();
  assert.equal(calls[1].session, 'gpt-s');
  assert.ok(hub.restartFresh(room.id, 'gpt'));
  await tick();
  const retried = calls[2];
  assert.equal(retried.session, null);
  assert.match(retried.prompt, /会话太重了/);
  assert.match(retried.prompt, /出一张海报/);
  assert.match(retried.prompt, /火星计划/);
  assert.ok(store.getMessages(room.id).some((m) => m.from === 'system' && /换成了新会话/.test(m.text)));
  assert.ok(!store.getMessages(room.id).some((m) => /已停止/.test(m.text)));
  retried.finish('海报做好了');
  await settle(hub);
  assert.equal(store.getState(room.id).sessions.gpt, 'gpt-s');
  assert.equal(hub.restartFresh(room.id, 'gpt'), false); // 没在干活时没什么可重来的
});

test('GPT 知道看图前先缩小，免得会话越来越重', () => {
  assert.match(buildIntro({ name: 'r', members: ['claude', 'gpt'], cwd: '/p' }, 'gpt'), /先缩小/);
  assert.match(buildIntro({ name: 'r', members: ['gpt'], cwd: '/p' }, 'gpt'), /先缩小/);
  assert.doesNotMatch(buildIntro({ name: 'r', members: ['claude', 'gpt'], cwd: '/p' }, 'claude'), /先缩小/);
});

test('GPT 换新会话后，上一个给它派活的 Claude 先把情况重新交代一遍，GPT 再接着干', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  hub.postUserMessage(room.id, '@Claude 安排一下海报');
  await tick();
  calls[0].finish('@GPT 按 prompts.md 出中英两张海报，放 output/');
  await tick();
  const gpt = calls.at(-1);
  assert.equal(gpt.agent, 'gpt');
  // GPT 卡住，老板点「换新会话」
  assert.equal(hub.resetAgent(room.id, 'gpt'), 'restarted');
  await tick();
  const brief = calls.at(-1);
  assert.equal(brief.agent, 'claude'); // 先叫派活的 Claude
  assert.match(brief.prompt, /老板给 ChatGPT 换了一个新会话/);
  assert.match(brief.prompt, /@ChatGPT/);
  assert.equal(hub.runs.has(hub.key(room.id, 'gpt')), false); // GPT 等交代完再干
  assert.ok(store.getMessages(room.id).some((m) => m.from === 'system' && /先请 Claude 把前面的情况/.test(m.text)));
  brief.finish('@GPT 情况是：海报要中英两张，提示词在 prompts.md，Logo 用官方 SVG，做完放 output/');
  await tick();
  const fresh = calls.at(-1);
  assert.equal(fresh.agent, 'gpt');
  assert.equal(fresh.session, null);
  assert.match(fresh.prompt, /会话太重了/);
  assert.match(fresh.prompt, /Claude\] @GPT 情况是：海报要中英两张/);
  fresh.finish('收到，接着做');
  await settle(hub);
  assert.equal(calls.filter((c) => c.agent === 'gpt').length, 2); // 不会多跑一轮
});

test('空闲时手动换新会话：有派活的 AI 就请它交代；没有就下次叫它时带上记录；本来没会话就什么都不做', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent, prompt) => (agent === 'claude' && /重新交代/.test(prompt) ? '@GPT 接着把第二版做完' : '好的'));
  const hub = new Hub(store, { run });
  const room = newRoom(store);
  assert.equal(hub.resetAgent(room.id, 'gpt'), 'none');
  hub.postUserMessage(room.id, '@GPT 先做第一版');
  await settle(hub);
  assert.equal(hub.resetAgent(room.id, 'gpt'), 'reset'); // 是老板自己派的活，没有 AI 要交代
  hub.postUserMessage(room.id, '@GPT 继续');
  await settle(hub);
  assert.equal(calls.at(-1).session, null);
  assert.match(calls.at(-1).prompt, /会话太重了/);
  // Claude 派过活之后再换：请 Claude 交代
  hub.postUserMessage(room.id, '@Claude 让 GPT 做第二版');
  await settle(hub);
  const before = calls.length;
  hub.postUserMessage(room.id, '@Claude 你看着办');
  await settle(hub);
  store.appendMessage(room.id, { from: 'claude', text: '@GPT 第二版要加上时间' });
  assert.equal(hub.resetAgent(room.id, 'gpt'), 'briefing');
  await settle(hub);
  const after = calls.slice(before + 1).map((c) => c.agent);
  assert.deepEqual(after, ['claude', 'gpt']);
});

test('换新会话时老板选谁来交代：选了别的 AI 就请它；选「不用交代」就谁也不叫；选「我自己来」就停下等老板', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt', 'deepseek'] });
  hub.postUserMessage(room.id, '@Claude 安排一下海报');
  await tick();
  calls[0].finish('@GPT 按 prompts.md 出两张海报');
  await tick();
  calls.at(-1).finish('第一张好了');
  await settle(hub);
  assert.equal(hub.suggestBriefer(room.id, 'gpt'), 'claude'); // 弹窗里默认选上一次派活的
  // 空着时选 DeepSeek 来交代：叫的是 DeepSeek，不是派活的 Claude
  assert.equal(hub.resetAgent(room.id, 'gpt', 'deepseek'), 'briefing');
  await tick();
  const brief = calls.at(-1);
  assert.equal(brief.agent, 'deepseek');
  assert.match(brief.prompt, /老板给 ChatGPT 换了一个新会话/);
  assert.ok(store.getMessages(room.id).some((m) => m.from === 'system' && /先请 DeepSeek 把前面的情况/.test(m.text)));
  brief.finish('@GPT 情况是：两张海报，第一张已经好了');
  await tick();
  assert.equal(calls.at(-1).agent, 'gpt');
  assert.equal(calls.at(-1).session, null);
  calls.at(-1).finish('收到');
  await settle(hub);
  // 选「不用交代」：派活的 Claude 也不叫，下次叫它时自己看记录
  const n = calls.length;
  assert.equal(hub.resetAgent(room.id, 'gpt', 'self'), 'reset');
  await settle(hub);
  assert.equal(calls.length, n);
  hub.postUserMessage(room.id, '@GPT 做第二张');
  await tick();
  assert.equal(calls.at(-1).session, null);
  assert.match(calls.at(-1).prompt, /做第二张/);
  // 干活时选「我自己来」：这一轮停下，不重来、不叫别人；老板一说话它就带着没做完的消息开新会话
  const busy = calls.length;
  assert.equal(hub.resetAgent(room.id, 'gpt', 'boss'), 'restarted');
  await settle(hub);
  assert.equal(calls.length, busy);
  assert.ok(store.getMessages(room.id).some((m) => m.from === 'system' && /等你把情况交代给它/.test(m.text)));
  assert.equal(store.getState(room.id).sessions.gpt, null);
  hub.postUserMessage(room.id, '@GPT 第二张要竖版，字放大');
  await tick();
  const resumed = calls.at(-1);
  assert.equal(resumed.agent, 'gpt');
  assert.equal(resumed.session, null);
  assert.match(resumed.prompt, /会话太重了/);
  assert.match(resumed.prompt, /做第二张[\s\S]*竖版/);
  // 干活时选 DeepSeek 来交代：停下这一轮，先叫 DeepSeek，交代完 GPT 接着干
  assert.equal(hub.resetAgent(room.id, 'gpt', 'deepseek'), 'restarted');
  await tick();
  assert.equal(calls.at(-1).agent, 'deepseek');
  assert.match(calls.at(-1).prompt, /老板给 ChatGPT 换了一个新会话/);
  calls.at(-1).finish('@GPT 竖版、字放大，其它照旧');
  await tick();
  assert.equal(calls.at(-1).agent, 'gpt');
  assert.equal(calls.at(-1).session, null);
  calls.at(-1).finish('好');
  await settle(hub);
});

test('GPT 会话里的图片太多时提醒换新会话，带按钮；同一级别只提醒一次', async () => {
  const store = new Store();
  let images = 9 * 1024 * 1024;
  const { run } = fakeRunner(() => '做好了');
  const hub = new Hub(store, { run, imageBytes: async () => images });
  const room = newRoom(store);
  const warnings = () => store.getMessages(room.id).filter((m) => m.action?.type === 'fresh');
  hub.postUserMessage(room.id, '@GPT 做海报');
  await settle(hub);
  await tick();
  assert.equal(warnings().length, 1);
  assert.match(warnings()[0].text, /约 9MB 的图片/);
  assert.equal(warnings()[0].action.agent, 'gpt');
  hub.postUserMessage(room.id, '@GPT 再改改');
  await settle(hub);
  await tick();
  assert.equal(warnings().length, 1); // 同一级别不重复提醒
  images = 14 * 1024 * 1024;
  hub.postUserMessage(room.id, '@GPT 再改改');
  await settle(hub);
  await tick();
  assert.equal(warnings().length, 2);
  assert.match(warnings()[1].text, /马上|现在就/);
});

test('GPT 的速度每次都明确指定，不跟着老板 Codex 配置里的 service_tier 走', () => {
  const room = { cwd: os.tmpdir(), permission: 'project', models: {}, efforts: {} };
  const std = codexArgs({ ...room, fast: { gpt: false } }, null, []);
  assert.ok(std.includes('features.fast_mode=false'));
  assert.ok(!std.some((a) => a.startsWith('service_tier')));
  assert.ok(codexArgs(room, null, []).includes('features.fast_mode=false')); // 老的群没有这个字段，也按标准
  const fast = codexArgs({ ...room, fast: { gpt: true } }, null, []);
  assert.ok(fast.includes('service_tier="fast"') && fast.includes('features.fast_mode=true'));
  assert.ok(!fast.includes('features.fast_mode=false'));
});

test('ChatGPT 的新会话：群聊说明作为开发者指令传进去；续上的会话不再传', () => {
  const room = { cwd: os.tmpdir(), permission: 'project', models: {}, efforts: {} };
  const intro = '你现在在一个叫「t」的群聊里。\n5. 私聊：有些话想私下跟老板说，写在 <私聊老板>…</私聊老板> 里，"引号"也没事';
  const fresh = codexArgs(room, null, [], false, intro);
  const arg = fresh.find((a) => a.startsWith('developer_instructions='));
  assert.ok(arg);
  assert.equal(JSON.parse(arg.slice('developer_instructions='.length)), intro); // 原样传过去，换行、引号都不丢
  assert.ok(!codexArgs(room, 'gpt-session', [], false, intro).some((a) => a.startsWith('developer_instructions=')));
});

test('群设置里显示每位记了多少：从会话记录里读出上下文用量和上限', async () => {
  const { sessionUsage } = await import('../lib/agents.js');
  const J = (o) => JSON.stringify(o);
  // Claude：只算主线回复的用量，子任务和合成的消息不算；上限还没报过时是 0（界面上只显示用了多少）
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-claude-'));
  process.env.CLAUDE_CONFIG_DIR = home;
  fs.mkdirSync(path.join(home, 'projects', '-p'), { recursive: true });
  const lines = [
    { type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 300000, output_tokens: 90 } } },
    { type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5', usage: { input_tokens: 5, output_tokens: 5 } } },
    { type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } },
  ];
  fs.writeFileSync(path.join(home, 'projects', '-p', 'c1.jsonl'), lines.map(J).join('\n') + '\n');
  assert.deepEqual(await sessionUsage('claude', 'c1'), { images: 0, used: 300100, window: 0 });
  // Codex：最后一条带数据的 token_count（只带额度信息的跳过）
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '30');
  fs.mkdirSync(dir, { recursive: true });
  const events = [
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 50000 }, model_context_window: 400000 } } },
    { type: 'event_msg', payload: { type: 'token_count', info: null } },
  ];
  fs.writeFileSync(path.join(dir, 'rollout-2026-10-30T01-00-00-g1.jsonl'), events.map(J).join('\n') + '\n');
  assert.deepEqual(await sessionUsage('gpt', 'g1'), { images: 0, used: 50000, window: 400000 });
  assert.equal(await sessionUsage('gpt', null), null);
});

test('不 @ 人时默认接着上一位：发给群里最后说话的那位 AI；还没人说过话就大家一起；回复、@ 照旧优先', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent) => (agent === 'gpt' ? '审完了，可以合' : '[PASS]'));
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt', 'deepseek'] });
  assert.equal(room.defaultTarget, 'last');
  // 还没人说过话：大家一起
  hub.postUserMessage(room.id, '大家好');
  await settle(hub);
  assert.deepEqual(calls.map((c) => c.agent).sort(), ['claude', 'deepseek', 'gpt']);
  // ChatGPT 刚在群里说完话：「合了发」只发给它
  calls.length = 0;
  hub.postUserMessage(room.id, '合了发');
  await settle(hub);
  assert.deepEqual(calls.map((c) => c.agent), ['gpt']);
  assert.deepEqual(store.getMessages(room.id).find((m) => m.text === '合了发').to, ['gpt']);
  // @ 了别人就按 @ 的来
  calls.length = 0;
  hub.postUserMessage(room.id, '@DeepSeek 你也看看');
  await settle(hub);
  assert.deepEqual(calls.map((c) => c.agent), ['deepseek']);
  // 私聊和 AI 之间的私聊不算「上一位」
  store.appendMessage(room.id, { from: 'claude', dm: 'claude', text: '私下说一句' });
  calls.length = 0;
  hub.postUserMessage(room.id, '继续');
  await settle(hub);
  assert.deepEqual(calls.map((c) => c.agent), ['gpt']);
});

test('以前默认「大家同时开工」的群换成「接着上一位」，只换一次；自己选过别的不动', async () => {
  const store = new Store();
  const a = newRoom(store);
  const b = newRoom(store);
  // 模拟以前的数据：没有 targetV
  for (const [r, t] of [[a, 'all'], [b, 'claude']]) {
    const room = store.getRoom(r.id);
    room.defaultTarget = t;
    delete room.targetV;
  }
  store.saveRooms();
  const again = new Store();
  assert.equal(again.getRoom(a.id).defaultTarget, 'last');
  assert.equal(again.getRoom(b.id).defaultTarget, 'claude');
  // 换过以后老板又选回「大家同时开工」：下次打开不再改
  again.getRoom(a.id).defaultTarget = 'all';
  again.saveRooms();
  assert.equal(new Store().getRoom(a.id).defaultTarget, 'all');
});

test('更新重启打断的活：重新打开后自动接着做；退出应用打断的：提醒里带「让它接着做」按钮', async () => {
  const hang = () => {
    const calls = [];
    const run = (agent, opts) => {
      calls.push({ agent, prompt: opts.prompt });
      let resolve;
      const done = new Promise((r) => (resolve = r));
      return { done, kill: () => resolve({ ok: false, error: 'killed', steps: [], session: 's1' }) };
    };
    return { run, calls };
  };
  // 更新重启
  const store = new Store();
  const hub = new Hub(store, hang());
  const room = newRoom(store, { members: ['claude'] });
  hub.postUserMessage(room.id, '把黑夜模式的图换上');
  await tick();
  hub.restarting = true;
  hub.shutdown();
  await tick();
  const store2 = new Store();
  const { run, calls } = fakeRunner(() => '换好了');
  const hub2 = new Hub(store2, { run });
  hub2.noticeInterrupted();
  await settle(hub2);
  assert.match(store2.getMessages(room.id).find((m) => m.from === 'system').text, /重启前 Claude 正在干活，已经让它接着做/);
  assert.match(calls[0].prompt, /被打断/);
  assert.match(calls[0].prompt, /把黑夜模式的图换上/);
  assert.equal(store2.getMessages(room.id).at(-1).text, '换好了');

  // 退出应用（不是重启）：不自动开工，提醒里带按钮
  const store3 = new Store();
  const hub3 = new Hub(store3, hang());
  const room3 = newRoom(store3, { members: ['claude', 'gpt'] });
  hub3.postUserMessage(room3.id, '@Claude 写个登录页');
  await tick();
  hub3.shutdown();
  await tick();
  const store4 = new Store();
  const r4 = fakeRunner(() => '写好了');
  const hub4 = new Hub(store4, { run: r4.run });
  hub4.noticeInterrupted();
  await tick();
  assert.equal(r4.calls.length, 0);
  const notice = store4.getMessages(room3.id).find((m) => m.from === 'system');
  assert.deepEqual(notice.action, { type: 'resume', agents: ['claude'] });
  // 点了按钮（服务端就是叫醒它）：接着做
  hub4.wake(room3.id, 'claude');
  await settle(hub4);
  assert.match(r4.calls[0].prompt, /写个登录页/);
});

test('中途插话：Claude 正在干活时老板又发一条，直接塞进这一轮；不能插话的（或者场合对不上的）照旧干完再来一轮', async () => {
  const store = new Store();
  const calls = [];
  // 假 AI：claude 能中途插话，gpt 不能
  const run = (agent, opts) => {
    let resolve;
    const done = new Promise((r) => (resolve = r));
    const call = { agent, prompt: opts.prompt, steered: [], done: false, finish: (text) => ((call.done = true), resolve({ ok: true, text, steps: [], session: `${agent}-s` })) };
    calls.push(call);
    const handle = { done, kill: () => resolve({ ok: false, error: 'killed', steps: [], session: null }) };
    if (agent === 'claude') handle.steer = (prompt) => (call.steered.push(prompt), true);
    return handle;
  };
  const hub = new Hub(store, { run });
  // 把还挂着的都结束掉（分身回完私聊，本体还会再看一眼），直到没人在干活
  const drain = async () => {
    for (let i = 0; i < 20 && (hub.runs.size || hub.sideRuns.size || calls.some((c) => !c.done)); i++) {
      calls.filter((c) => !c.done).forEach((c) => c.finish('[PASS]'));
      await tick();
    }
  };
  const room = newRoom(store, { members: ['claude', 'gpt'] });
  hub.postUserMessage(room.id, '@Claude 先把首页改一下');
  await tick();
  assert.equal(calls.length, 1);
  hub.postUserMessage(room.id, '@Claude 顺便把按钮改成蓝色');
  await tick();
  assert.equal(calls.length, 1, '插进去了，没有另开一轮');
  assert.equal(calls[0].steered.length, 1);
  assert.match(calls[0].steered[0], /你正在干活时，老板又发来了新消息/);
  assert.match(calls[0].steered[0], /按钮改成蓝色/);
  assert.equal(hub.runs.get(hub.key(room.id, 'claude')).steps.at(-1).text, '收到老板的新消息，接着一起干');
  calls[0].finish('首页改好了，按钮也换成蓝色了');
  await tick();
  assert.equal(calls.length, 1, '插进去的消息已经看过了，做完不会再来一轮');

  // 私聊里的话场合对不上（这一轮在群里干）：不往群里这一轮塞，走原来的路（开分身回私聊）
  hub.postUserMessage(room.id, '@Claude 再看看页脚');
  await tick();
  hub.postUserMessage(room.id, '私下问一句：今天能做完吗', [], 'claude');
  await tick();
  assert.equal(calls[1].steered.length, 0);
  await drain();

  // ChatGPT 不能插话：干完再来一轮（和以前一样）
  hub.postUserMessage(room.id, '@ChatGPT 看下测试');
  await tick();
  const gptCount = calls.filter((c) => c.agent === 'gpt').length;
  hub.postUserMessage(room.id, '@ChatGPT 还有日志也看看');
  await tick();
  assert.equal(calls.filter((c) => c.agent === 'gpt').length, gptCount);
  calls.filter((c) => c.agent === 'gpt').at(-1).finish('测试看完了');
  await tick();
  await tick();
  await tick();
  assert.equal(calls.filter((c) => c.agent === 'gpt').length, gptCount + 1, '干完以后再来一轮看新消息');
  assert.match(calls.filter((c) => c.agent === 'gpt').at(-1).prompt, /日志也看看/);
  await drain();

  // 同事 @ 它也算：Claude 在干活时，ChatGPT 干完回了一句 @Claude，直接塞进 Claude 这一轮
  hub.postUserMessage(room.id, '@所有人 一起查下这个 bug');
  await tick();
  const claudeRun = calls.filter((c) => c.agent === 'claude').at(-1);
  calls.filter((c) => c.agent === 'gpt').at(-1).finish('@Claude 我查到是缓存的问题，你那边顺便看下 cache.js');
  await tick();
  await tick();
  assert.equal(claudeRun.steered.length, 1, '同事 @ 它的话也插进了这一轮');
  assert.match(claudeRun.steered[0], /ChatGPT又发来了新消息/);
  assert.match(claudeRun.steered[0], /cache\.js/);
  assert.equal(hub.runs.get(hub.key(room.id, 'claude')).steps.at(-1).text, '收到ChatGPT的新消息，接着一起干');
  const before = calls.filter((c) => c.agent === 'claude').length;
  claudeRun.finish('缓存那边也改好了');
  await tick();
  await tick();
  assert.equal(calls.filter((c) => c.agent === 'claude').length, before, '做完不会为这句再来一轮');
  await drain();
});

test('中途插话要等回执的（ChatGPT）：收到了才推进读取进度；被拒就排到下一轮；等回执时被停止，什么都不写回', async () => {
  const store = new Store();
  const calls = [];
  let answer = null; // 测试里决定这次插话的回执：true 收到、false 被拒
  const run = (agent, opts) => {
    let resolve;
    const done = new Promise((r) => (resolve = r));
    const call = { agent, prompt: opts.prompt, steered: [], done: false, finish: (text) => ((call.done = true), resolve({ ok: true, text, steps: [], session: `${agent}-s` })) };
    calls.push(call);
    return {
      done,
      kill: () => ((call.done = true), resolve({ ok: false, error: 'killed', steps: [], session: null })),
      steer: (prompt) => new Promise((r) => (call.steered.push(prompt), (answer = r))),
    };
  };
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt'] });
  const cursor = () => store.getState(room.id).cursors.gpt;

  // 收到回执才推进
  hub.postUserMessage(room.id, '@ChatGPT 先跑一下测试');
  await tick();
  const first = calls.at(-1);
  const before = cursor();
  hub.postUserMessage(room.id, '@ChatGPT 顺便看下日志');
  await tick();
  assert.equal(first.steered.length, 1);
  assert.equal(cursor(), before, '还没回执，读取进度不动');
  answer(true);
  await tick();
  assert.equal(cursor(), store.getMessages(room.id).length - 1, '收到了才推进');
  first.finish('测试和日志都看了');
  await tick();
  assert.equal(calls.length, 1, '已经插进去的，做完不再来一轮');

  // 被拒：这一轮做完以后再来一轮，带上被拒的那条
  hub.postUserMessage(room.id, '@ChatGPT 再跑一遍');
  await tick();
  const second = calls.at(-1);
  hub.postUserMessage(room.id, '@ChatGPT 记得截图');
  await tick();
  answer(false);
  await tick();
  hub.postUserMessage(room.id, '@ChatGPT 还有一件事');
  await tick();
  assert.equal(second.steered.length, 1, '被拒以后这一轮不再往里塞');
  second.finish('跑完了');
  await tick();
  await tick();
  const third = calls.at(-1);
  assert.notEqual(third, second, '做完以后另开一轮');
  assert.match(third.prompt, /记得截图/);
  assert.match(third.prompt, /还有一件事/);
  third.finish('都处理了');
  await tick();

  // 等回执时被停止：读取进度不往前推
  hub.postUserMessage(room.id, '@ChatGPT 最后看一眼');
  await tick();
  const fourth = calls.at(-1);
  hub.postUserMessage(room.id, '@ChatGPT 算了不用看了');
  await tick();
  const at = cursor();
  hub.stop(room.id, 'gpt');
  answer(true);
  await tick();
  await tick();
  assert.ok(fourth.done);
  assert.ok(cursor() <= at, '停止以后晚到的回执不推进读取进度');
});

test('中途插话的两个边界：前一批被拒、后一批还在排队时，后一批也不送；私聊里干活时老板再私聊它，只插话不开分身', async () => {
  const store = new Store();
  const calls = [];
  const answers = [];
  const run = (agent, opts) => {
    let resolve;
    const done = new Promise((r) => (resolve = r));
    const call = { agent, side: !!opts.side, prompt: opts.prompt, steered: [], done: false, finish: (text) => ((call.done = true), resolve({ ok: true, text, steps: [], session: `${agent}-s` })) };
    calls.push(call);
    const handle = { done, kill: () => ((call.done = true), resolve({ ok: false, error: 'killed', steps: [], session: null })) };
    if (!opts.side) handle.steer = (prompt) => new Promise((r) => (call.steered.push(prompt), answers.push(r)));
    return handle;
  };
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt'] });

  // 第一批等回执时第二批排队；第一批被拒 → 第二批不送，两条都留到下一轮
  hub.postUserMessage(room.id, '@ChatGPT 开始');
  await tick();
  const first = calls.at(-1);
  hub.postUserMessage(room.id, '@ChatGPT 第一批');
  await tick();
  hub.postUserMessage(room.id, '@ChatGPT 第二批');
  await tick();
  assert.equal(first.steered.length, 1, '第二批在排队，还没送');
  answers.shift()(false);
  await tick();
  await tick();
  assert.equal(first.steered.length, 1, '第一批被拒，排队的第二批也不送');
  first.finish('开始的做完了');
  await tick();
  await tick();
  const next = calls.at(-1);
  assert.notEqual(next, first);
  assert.match(next.prompt, /第一批/);
  assert.match(next.prompt, /第二批/);
  next.finish('两批都做了');
  await tick();

  // 私聊里干活时老板再私聊它：只插话，不开分身
  hub.postUserMessage(room.id, '私下帮我查个东西', [], 'claude');
  await tick();
  const dmRun = calls.at(-1);
  assert.equal(dmRun.agent, 'claude');
  hub.postUserMessage(room.id, '顺便把结果整理成表格', [], 'claude');
  await tick();
  assert.equal(calls.filter((c) => c.side).length, 0, '没有开分身');
  assert.equal(dmRun.steered.length, 1);
  answers.shift()(true);
  dmRun.finish('查好了，表格也整理了');
  await tick();
  await tick();
  assert.equal(store.getMessages(room.id).filter((m) => m.from === 'claude').length, 1, '只回了一条');
});

test('按停止和 Claude Code 里按 Esc 一样：这一轮不重做，但下次轮到它时告诉它刚才在做什么（连同中途插进来的），别自动接着做', async () => {
  const store = new Store();
  const calls = [];
  const run = (agent, opts) => {
    let resolve;
    const done = new Promise((r) => (resolve = r));
    const call = { agent, prompt: opts.prompt, steered: [], done: false, finish: (text) => ((call.done = true), resolve({ ok: true, text, steps: [], session: `${agent}-s` })) };
    calls.push(call);
    return { done, kill: () => ((call.done = true), resolve({ ok: false, error: 'killed', steps: [], session: null })), steer: (prompt) => (call.steered.push(prompt), true) };
  };
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt'] });
  // 先完整做完一轮，存下会话（不然下一轮是新会话，本来就会带上最近的聊天记录）
  hub.postUserMessage(room.id, '@Claude 你好');
  await tick();
  calls.at(-1).finish('你好');
  await tick();
  hub.postUserMessage(room.id, '@Claude 第一件事');
  await tick();
  const first = calls.at(-1);
  hub.postUserMessage(room.id, '@Claude 第二件事');
  await tick();
  assert.equal(first.steered.length, 1);
  const at = store.getState(room.id).cursors.claude;
  hub.stop(room.id, 'claude');
  await tick();
  await tick();
  assert.equal(store.getState(room.id).cursors.claude, at, '读取进度不退回：停掉的不重做');
  hub.postUserMessage(room.id, '@Claude 第三件事');
  await tick();
  const next = calls.at(-1);
  assert.notEqual(next, first);
  assert.match(next.prompt, /做到一半被老板按了「停止」/);
  assert.match(next.prompt, /第一件事/, '告诉它刚才在做的事');
  assert.match(next.prompt, /第二件事/, '中途插进来的也在里面');
  assert.match(next.prompt, /先别自动接着做/);
  assert.match(next.prompt, /第三件事/);
  next.finish('好的，先做第三件');
  await tick();
  // 只提一次
  hub.postUserMessage(room.id, '@Claude 第四件事');
  await tick();
  assert.doesNotMatch(calls.at(-1).prompt, /被老板按了「停止」/);
  calls.at(-1).finish('[PASS]');
  await tick();
});

test('清空聊天记录：消息清掉、读取进度从头算；默认留着 AI 的记忆，选忘掉就清会话；正在干活的晚到结果不写回', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt'] });
  hub.postUserMessage(room.id, '@Claude 你好');
  await tick();
  calls.at(-1).finish('你好');
  await settle(hub);
  assert.equal(store.getState(room.id).sessions.claude, 'claude-s');
  hub.postUserMessage(room.id, '@Claude 帮我做件事');
  await tick();
  const busy = calls.at(-1);
  hub.clearRoom(room.id);
  busy.finish('做完了'); // 清空之后才回来的结果
  await tick();
  await tick();
  const msgs = store.getMessages(room.id);
  assert.equal(msgs.length, 1, '只剩一条「已清空」的提示');
  assert.equal(msgs[0].from, 'system');
  assert.match(msgs[0].text, /大家还记得/);
  assert.equal(store.getState(room.id).sessions.claude, 'claude-s', '默认留着记忆');
  assert.deepEqual(store.getState(room.id).cursors, {});
  assert.equal(store.getRoom(room.id).last, null);
  // 清空以后照常能用：新消息交给它
  hub.postUserMessage(room.id, '@Claude 新的一件事');
  await tick();
  assert.match(calls.at(-1).prompt, /新的一件事/);
  assert.doesNotMatch(calls.at(-1).prompt, /帮我做件事/);
  calls.at(-1).finish('好');
  await settle(hub);
  // 清空后第一句不 @ 人：交给清空前的上一位，不会把全群叫醒
  hub.clearRoom(room.id);
  hub.postUserMessage(room.id, '不 @ 人的第一句');
  await tick();
  assert.equal(calls.at(-1).agent, 'claude');
  assert.equal(hub.runs.size, 1, '只叫了上一位');
  calls.at(-1).finish('好');
  await settle(hub);
  // 选「让 AI 也忘掉」：会话清掉
  hub.clearRoom(room.id, true);
  assert.deepEqual(store.getState(room.id).sessions, {});
  assert.match(store.getMessages(room.id)[0].text, /记忆也清掉了/);
});

test('清空聊天记录的两个时序：清空后马上发消息，新消息马上开工；清空后马上退出，旧的读取进度不写回', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt'] });
  hub.postUserMessage(room.id, '@Claude 做件事');
  await tick();
  const old = calls.at(-1);
  hub.clearRoom(room.id);
  assert.equal(hub.runs.size, 0, '旧任务马上从表里拿掉');
  hub.postUserMessage(room.id, '@Claude 清空后的新消息');
  await tick();
  const fresh = calls.at(-1);
  assert.notEqual(fresh, old, '新消息马上开工，不用等旧任务');
  assert.match(fresh.prompt, /清空后的新消息/);
  old.finish('旧任务晚到的结果');
  await tick();
  assert.ok(!store.getMessages(room.id).some((m) => m.text === '旧任务晚到的结果'), '旧结果不写回');
  fresh.finish('好');
  await settle(hub);

  // 清空后马上退出：退出时只处理还在表里的任务，旧任务的读取进度不会写回
  hub.postUserMessage(room.id, '@Claude 再做一件');
  await tick();
  hub.clearRoom(room.id);
  hub.shutdown();
  const state = store.getState(room.id);
  assert.deepEqual(state.cursors, {});
  assert.deepEqual(state.interrupted, {});
});

test('崩溃、断电这种来不及正常退出的：下次启动把读取进度退回开工前，按被打断提醒（带「让它接着做」）', async () => {
  const store = new Store();
  const { run } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt'] });
  hub.postUserMessage(room.id, '@Claude 改一下首页');
  await tick();
  const before = store.getState(room.id);
  assert.equal(before.running.claude, -1, '开工时记下开工前读到哪');
  // 不调 shutdown，直接换一个新的存储：相当于进程被强制结束了
  const store2 = new Store();
  const r2 = fakeRunner(() => '改好了');
  const hub2 = new Hub(store2, { run: r2.run });
  hub2.noticeInterrupted();
  await tick();
  const state = store2.getState(room.id);
  assert.equal(state.cursors.claude, -1, '读取进度退回开工前');
  assert.deepEqual(state.running, {});
  assert.equal(r2.calls.length, 0, '不是老板点的重启：不自动开工');
  const notice = store2.getMessages(room.id).find((m) => m.action?.type === 'resume');
  assert.deepEqual(notice.action.agents, ['claude']);
  hub2.wake(room.id, 'claude');
  await settle(hub2);
  assert.match(r2.calls[0].prompt, /改一下首页/);
  assert.deepEqual(store2.getState(room.id).running, {}, '正常做完，记号去掉');
});

test('一轮里出了意外的错误：只算这一轮出错（读取进度退回、提示出错），服务不挂，后面的照常', async () => {
  const store = new Store();
  let boom = true;
  const calls = [];
  const run = (agent, opts) => {
    calls.push(agent);
    if (boom) throw new Error('磁盘满了');
    return { done: Promise.resolve({ ok: true, text: '好了', steps: [], session: 's' }), kill() {} };
  };
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt'] });
  hub.postUserMessage(room.id, '@Claude 看看');
  await tick();
  assert.equal(hub.runs.size, 0);
  assert.ok(store.getMessages(room.id).some((m) => m.from === 'system' && /Claude 出错了：磁盘满了/.test(m.text)));
  assert.equal(store.getState(room.id).cursors.claude, -1, '这一轮不算看过');
  assert.deepEqual(store.getState(room.id).running, {});
  boom = false;
  hub.postUserMessage(room.id, '@Claude 再看看');
  await settle(hub);
  assert.equal(store.getMessages(room.id).at(-1).text, '好了');
});

test('按了停止、这一轮还没完全停下时老板又发来的：停下后马上开工，不用等下次有人叫它', async () => {
  const store = new Store();
  const calls = [];
  const run = (agent, opts) => {
    let resolve;
    const done = new Promise((r) => (resolve = r));
    const call = { agent, prompt: opts.prompt, finish: (text) => resolve({ ok: true, text, steps: [], session: `${agent}-s` }), kill: () => resolve({ ok: false, error: 'killed', steps: [], session: null }) };
    calls.push(call);
    return { done, kill: () => setTimeout(call.kill, 30) }; // 停下要一小会儿
  };
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt'] });
  hub.postUserMessage(room.id, '@Claude 做 A');
  await tick();
  hub.stop(room.id, 'claude');
  hub.postUserMessage(room.id, '@Claude 别做 A 了，做 B');
  await tick();
  await tick();
  await tick();
  assert.equal(calls.length, 2, '停下后马上接着做新消息');
  assert.match(calls[1].prompt, /做 B/);
  calls[1].finish('好，做 B');
  await settle(hub);
});

test('插话的过程提示只写真正叫它的人：一起塞进去、只是让它知道的（老板对别人说的）不算', async () => {
  const store = new Store();
  const calls = [];
  const run = (agent, opts) => {
    let resolve;
    const done = new Promise((r) => (resolve = r));
    const call = { agent, steered: [], finish: (text) => resolve({ ok: true, text, steps: [], session: `${agent}-s` }) };
    calls.push(call);
    return { done, kill: () => resolve({ ok: false, error: 'killed', steps: [] }), steer: (p) => (call.steered.push(p), true) };
  };
  const hub = new Hub(store, { run });
  const steps = [];
  hub.on('event', (ev) => ev.type === 'step' && ev.agent === 'gpt' && steps.push(ev.step.text));
  const room = newRoom(store, { members: ['claude', 'gpt', 'deepseek'] });
  hub.postUserMessage(room.id, '@ChatGPT 审查一下');
  await tick();
  const gpt = calls.find((c) => c.agent === 'gpt');
  hub.postUserMessage(room.id, '@Claude 你也去做事'); // 对 Claude 说的
  await tick();
  calls.find((c) => c.agent === 'claude').finish('@ChatGPT 我这部分好了');
  await tick();
  await tick();
  assert.equal(gpt.steered.length, 1);
  assert.match(gpt.steered[0], /你也去做事/, '老板对别人说的也让它知道');
  assert.deepEqual(steps, ['收到Claude的新消息，接着一起干']);
  gpt.finish('[PASS]');
  await settle(hub);
});

test('做完了却一个字都没回：提示一声，不然看起来像没回', async () => {
  const store = new Store();
  const { run } = fakeRunner(() => '   ');
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt'] });
  hub.postUserMessage(room.id, '@Claude 看看');
  await settle(hub);
  assert.ok(store.getMessages(room.id).some((m) => m.from === 'system' && /Claude 这一轮做完了，但没有回复内容/.test(m.text)));
  const { run: run2 } = fakeRunner(() => '[PASS]');
  const hub2 = new Hub(store, { run: run2 });
  const n = store.getMessages(room.id).length;
  hub2.postUserMessage(room.id, '@Claude 再看看');
  await settle(hub2);
  assert.equal(store.getMessages(room.id).length, n + 1, '[PASS] 照旧不提示');
});

test('聊天记录最后一行写到一半（断电）：下一条另起一行，坏掉的那行能救的救回来，救不回的占位，后面的编号不错位', () => {
  const store = new Store();
  const room = newRoom(store, { members: ['claude'] });
  const file = path.join(store.roomDir(room.id), 'messages.jsonl');
  const line = (seq, text) => JSON.stringify({ seq, ts: 1, from: 'user', text });
  // 第 1 条坏了救不回；第 2 条写到一半时断电，第 3 条又接在了后面
  fs.writeFileSync(file, `${line(0, '一')}\n{"seq":1,"ts":1,"fr\n${line(2, '二').slice(0, 20)}${line(3, '三')}\n${line(4, '四').slice(0, 25)}`);
  const store2 = new Store();
  const list = store2.getMessages(room.id);
  assert.deepEqual(list.map((m) => m.seq), [0, 1, 2, 3]);
  assert.ok(list[1].lost && list[2].lost);
  assert.equal(list[3].text, '三', '接在半行后面的那条救回来了');
  const m = store2.appendMessage(room.id, { from: 'user', text: '五' });
  assert.equal(m.seq, 4);
  const store3 = new Store();
  assert.equal(store3.getMessages(room.id)[4].text, '五', '新的一条另起一行，读得出来');
});

test('群列表、记忆文件读不出来时用上一版的备份，不会被当成空的覆盖掉', () => {
  const store = new Store();
  const room = newRoom(store, { name: '备份测试' });
  store.getState(room.id).sessions.claude = 'sess-1';
  store.saveState(room.id);
  store.saveState(room.id); // 第二次保存时，上一版留成 .bak
  store.updateRoom(room.id, { collab: false });
  const rooms = path.join(process.env.CLAWCHAT_HOME, 'rooms.json');
  const state = path.join(store.roomDir(room.id), 'state.json');
  fs.writeFileSync(rooms, '[{"id":');
  fs.writeFileSync(state, '{"sess');
  const store2 = new Store();
  assert.ok(store2.getRoom(room.id), '群还在');
  assert.equal(store2.getState(room.id).sessions.claude, 'sess-1', '记忆还在');
  store2.saveRooms(); // 写回好的，别影响后面的测试
  store2.saveState(room.id);
});

test('收纳组头像的图片存成单独的文件，列表里只带版本号；留着、换掉、去掉都对', () => {
  const store = new Store();
  const folder = store.createFolder('图');
  const png = `data:image/png;base64,${Buffer.from('fake-png-1').toString('base64')}`;
  store.setFolderAvatar(folder.id, { color: 2 }, png);
  const v1 = store.getFolder(folder.id).avatar.imageV;
  assert.ok(v1 && !store.getFolder(folder.id).avatar.image, '列表里不带图片本身');
  assert.ok(store.folderAvatarFile(folder.id, v1));
  store.setFolderAvatar(folder.id, { color: 3, text: 'A' }, 'keep');
  assert.deepEqual(store.getFolder(folder.id).avatar, { color: 3, text: 'A', imageV: v1 });
  store.setFolderAvatar(folder.id, { color: 3 }, `data:image/png;base64,${Buffer.from('fake-png-2').toString('base64')}`);
  const v2 = store.getFolder(folder.id).avatar.imageV;
  assert.notEqual(v2, v1);
  assert.equal(store.folderAvatarFile(folder.id, v1), null, '旧图删掉');
  store.setFolderAvatar(folder.id, { color: 3 }, null);
  assert.equal(store.folderAvatarFile(folder.id, v2), null);
  assert.deepEqual(store.getFolder(folder.id).avatar, { color: 3 });
  // 旧版本把图片直接存在 folders.json 里：启动时搬出去
  store.getFolder(folder.id).avatar = { color: 1, image: png };
  store.saveFolders();
  const store2 = new Store();
  const a = store2.getFolder(folder.id).avatar;
  assert.ok(a.imageV && !a.image && store2.folderAvatarFile(folder.id, a.imageV));
  store2.deleteFolder(folder.id);
  assert.equal(store2.folderAvatarFile(folder.id, a.imageV), null, '解散时图片一起删');
});

test('没发出去的图片：放了一天以上、没有消息用到的清掉，用到的和刚传的留着', () => {
  const store = new Store();
  const room = newRoom(store, { members: ['claude'] });
  const dir = store.uploadsDir(room.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['aaaaaaaaaaaaaaaa.png', 'bbbbbbbbbbbbbbbb.png', 'cccccccccccccccc.png']) fs.writeFileSync(path.join(dir, f), 'x');
  const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  fs.utimesSync(path.join(dir, 'aaaaaaaaaaaaaaaa.png'), old, old);
  fs.utimesSync(path.join(dir, 'bbbbbbbbbbbbbbbb.png'), old, old);
  store.appendMessage(room.id, { from: 'user', text: '', images: [{ id: 'bbbbbbbbbbbbbbbb.png', type: 'image/png' }] });
  store.pruneUploads();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['bbbbbbbbbbbbbbbb.png', 'cccccccccccccccc.png']);
});

test('Grok 的记忆目录：删群、清空并忘掉记忆时一起清掉，只清空记录时留着', async () => {
  const { removeGrokHome } = await import('../lib/grok.js');
  const root = path.join(process.env.CLAWCHAT_HOME, 'grok', 'homes');
  const store = new Store();
  const { run } = fakeRunner(() => '好');
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'grok'] });
  const crypto = await import('node:crypto'); // 目录名的算法和 grok.js 里一样
  const dir = path.join(root, crypto.createHash('sha256').update(room.id).digest('hex').slice(0, 24) + '-grok');
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  hub.clearRoom(room.id);
  await tick();
  assert.ok(fs.existsSync(dir), '只清空记录：Grok 还记得');
  hub.clearRoom(room.id, true);
  await tick();
  assert.ok(!fs.existsSync(dir), '清空并忘掉：目录清掉');
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  await removeGrokHome(room);
  assert.ok(!fs.existsSync(dir), '删群时调用的清理');
});

test('干活时的状态里带着这一轮用的模型和思考强度（私聊里单独设置的按私聊的）', async () => {
  const store = new Store();
  const { run, calls } = heldRunner();
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt'], models: { claude: 'sonnet' }, efforts: { claude: 'low' }, dmSettings: { gpt: { model: 'gpt-x', effort: 'high' } } });
  hub.postUserMessage(room.id, '@Claude 看看');
  hub.postUserMessage(room.id, '私聊一句', [], 'gpt');
  await tick();
  const st = Object.fromEntries(hub.status().map((r) => [r.agent, r]));
  assert.equal(st.claude.model, 'sonnet');
  assert.equal(st.claude.effort, 'low');
  assert.equal(st.gpt.model, 'gpt-x');
  assert.equal(st.gpt.effort, 'high');
  calls.forEach((c) => c.finish('[PASS]'));
  await settle(hub);
});
