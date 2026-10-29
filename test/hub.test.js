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
  assert.deepEqual(parseMentions('@所有人 看一下'), ['claude', 'gpt', 'deepseek']);
  assert.deepEqual(parseMentions('@DeepSeek 你来审一下'), ['deepseek']);
  assert.deepEqual(parseMentions('@深度求索 和 @gpt'), ['deepseek', 'gpt']);
  assert.deepEqual(parseMentions('@Codex 写页面'), ['gpt']);
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

test('AI 私下找另一位 AI：对方被叫醒、默认私下回；第三位看不到；老板在两位的私聊里都能看到', async () => {
  const store = new Store();
  const { run, calls } = fakeRunner((agent, prompt, n) => {
    if (agent === 'claude' && n === 1) return '大家好。<私聊 DeepSeek>你那边的接口先别动，等我改完</私聊>';
    if (agent === 'deepseek') return '好的，等你。';
    return '[PASS]';
  });
  const hub = new Hub(store, { run });
  const room = newRoom(store, { members: ['claude', 'gpt', 'deepseek'] });
  hub.postUserMessage(room.id, '@Claude 开工');
  await settle(hub);
  const msgs = store.getMessages(room.id);
  const pm = msgs.find((m) => m.pm === 'deepseek');
  assert.equal(pm.from, 'claude');
  assert.equal(pm.text, '你那边的接口先别动，等我改完');
  // DeepSeek 被叫醒，知道是 Claude 私下找它，回复默认私下回 Claude
  const dsCall = calls.find((c) => c.agent === 'deepseek');
  assert.match(dsCall.prompt, /Claude（私下发给你，别人看不到）\] 你那边的接口先别动/);
  assert.match(dsCall.prompt, /Claude 私下找你/);
  const reply = msgs.find((m) => m.from === 'deepseek');
  assert.equal(reply.pm, 'claude');
  assert.equal(reply.text, '好的，等你。');
  // ChatGPT 看不到这两条
  hub.postUserMessage(room.id, '@ChatGPT 你看看进度');
  await settle(hub);
  const gptCall = calls.filter((c) => c.agent === 'gpt').at(-1);
  assert.doesNotMatch(gptCall.prompt, /接口先别动|好的，等你/);
  // 侧栏：两位各自的私聊里都有最新一条
  assert.equal(store.getRoom(room.id).dmLast.claude.pm, 'claude');
  assert.equal(store.getRoom(room.id).dmLast.deepseek.text, '好的，等你。');
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
