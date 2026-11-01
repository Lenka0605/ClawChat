import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApiBridge, stopApiBridge, toChat, apiBridgeToken, forgetApiReasoning } from '../lib/api-bridge.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-bridge-test-'));

// 假的 OpenAI 兼容平台：按每个测试设定的剧本回流式数据，不连任何真平台、不用真 Key
let script = null;
let lastBody = null;
const requests = [];
let aborted = 0;
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    lastBody = JSON.parse(raw || '{}');
    requests.push({ auth: req.headers.authorization, body: lastBody });
    res.on('close', () => { if (!res.writableFinished) aborted += 1; });
    await script(req, res, lastBody);
  });
});
let base;
let bridge;
const vision = new Set(['vision-model']);
before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${upstream.address().port}/v1`;
  bridge = await startApiBridge(() => ({ base, key: 'real-upstream-key', model: (id) => ({ vision: vision.has(id), maxOutput: 1000, thinking: true }) }), { dataDir });
});
after(() => { stopApiBridge(); upstream.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const sse = (res, chunks, { done = true } = {}) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
  if (done) res.write('data: [DONE]\n\n');
  res.end();
};
const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

async function call(body, { token = apiBridgeToken('room-a:api'), headers = {} } = {}) {
  const res = await fetch(`${bridge.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ model: 'm', max_tokens: 5000, stream: true, messages: [{ role: 'user', content: 'hi' }], ...body }) });
  const text = await res.text();
  const events = text.split('\n\n').filter((b) => b.includes('data:')).map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data:')).slice(5)));
  return { status: res.status, text, events };
}

test('转接器：没有令牌、令牌不对、浏览器发来的请求都拒绝，而且不会碰平台', async () => {
  const before = requests.length;
  assert.equal((await call({}, { token: 'wrong' })).status, 401);
  const forged = `${Buffer.from('room-b:api').toString('base64url')}.${apiBridgeToken('room-a:api').split('.')[1]}`;
  assert.equal((await call({}, { token: forged })).status, 401, '换了范围、签名对不上');
  assert.equal((await call({}, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal(requests.length, before);
});

test('转接器：文字流式回答翻译成 Anthropic 事件，顺序正确；用平台的真 Key、不用令牌', async () => {
  script = (req, res) => sse(res, [delta({ role: 'assistant' }), delta({ content: '你' }), delta({ content: '好' }), delta({}, 'stop'), { choices: [], usage: { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 80 } } }]);
  const r = await call({ system: [{ type: 'text', text: '群规' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.events.map((e) => e.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(r.events.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join(''), '你好');
  const md = r.events.find((e) => e.type === 'message_delta');
  assert.equal(md.delta.stop_reason, 'end_turn');
  assert.deepEqual(md.usage, { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 80 }, '命中缓存的部分不算进普通输入');
  assert.equal(requests.at(-1).auth, 'Bearer real-upstream-key');
  assert.equal(lastBody.messages[0].role, 'system');
  assert.equal(lastBody.max_tokens, 1000, '按模型的输出上限截断');
});

test('转接器：两个工具调用交错着发过来，各自拼完整、校验成合法 JSON 后才交出去', async () => {
  script = (req, res) => sse(res, [
    delta({ content: '我来看看' }),
    delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Bash', arguments: '{"comm' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'Read', arguments: '{"file_' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] }),
    delta({ tool_calls: [{ index: 1, function: { arguments: 'path":"/a"}' } }] }),
    delta({}, 'tool_calls'),
  ]);
  const tools = [{ name: 'Bash', input_schema: { type: 'object' } }, { name: 'Read', input_schema: { type: 'object' } }];
  const r = await call({ tools });
  const starts = r.events.filter((e) => e.type === 'content_block_start').map((e) => e.content_block);
  assert.deepEqual(starts.map((b) => b.type), ['text', 'tool_use', 'tool_use']);
  assert.deepEqual(starts.slice(1).map((b) => [b.id, b.name]), [['call_a', 'Bash'], ['call_b', 'Read']]);
  const json = r.events.filter((e) => e.delta?.type === 'input_json_delta').map((e) => JSON.parse(e.delta.partial_json));
  assert.deepEqual(json, [{ command: 'ls' }, { file_path: '/a' }]);
  assert.equal(r.events.find((e) => e.type === 'message_delta').delta.stop_reason, 'tool_use');
  assert.equal(lastBody.tools[0].function.name, 'Bash');
});

test('转接器：工具参数被截断、参数不是合法 JSON、调了没给过的工具：都报错，不交出去执行', async () => {
  const tools = [{ name: 'Bash', input_schema: { type: 'object' } }];
  script = (req, res) => sse(res, [delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'Bash', arguments: '{"command":"rm -rf /tmp/x' } }] }), delta({}, 'length')]);
  let r = await call({ tools });
  assert.ok(r.events.some((e) => e.type === 'error'));
  assert.ok(!r.events.some((e) => e.content_block?.type === 'tool_use'));
  assert.ok(!r.events.some((e) => e.type === 'message_stop'), '出错时不能再发正常结束');
  script = (req, res) => sse(res, [delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'Bash', arguments: '{"command":' } }] }), delta({}, 'tool_calls')]);
  r = await call({ tools });
  assert.ok(r.events.some((e) => e.type === 'error'));
  script = (req, res) => sse(res, [delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'Evil', arguments: '{}' } }] }), delta({}, 'tool_calls')]);
  r = await call({ tools });
  assert.ok(r.events.some((e) => e.type === 'error'));
});

test('转接器：中途断流、200 里夹着错误：都不当成正常说完', async () => {
  script = (req, res) => sse(res, [delta({ content: '说到一半' })], { done: false });
  let r = await call({});
  assert.ok(r.events.some((e) => e.type === 'error'));
  assert.ok(!r.events.some((e) => e.type === 'message_stop'));
  script = (req, res) => sse(res, [delta({ content: 'a' }), { error: { message: 'upstream exploded' } }]);
  r = await call({});
  assert.match(r.events.find((e) => e.type === 'error').error.message, /upstream exploded/);
});

test('转接器：平台报 401、余额不足（哪怕报成 400）时把状态码明确带回去', async () => {
  script = (req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad key"}}'); };
  assert.equal((await call({})).status, 401);
  script = (req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"You don\'t have enough Credits"}}'); };
  const r = await call({});
  assert.equal(r.status, 402);
  assert.equal(JSON.parse(r.text).error.type, 'billing_error');
});

test('转接器：平台不接受 reasoning_effort（比如千问）时去掉重试一次', async () => {
  let n = 0;
  script = (req, res, body) => {
    n += 1;
    if (body.reasoning_effort) { res.writeHead(400); return res.end('{"error":{"message":"\'reasoning_effort\' and \'thinking_budget\' cannot be set simultaneously"}}'); }
    sse(res, [delta({ content: 'ok' }), delta({}, 'stop')]);
  };
  const r = await call({ output_config: { effort: 'high' } });
  assert.equal(r.status, 200);
  assert.equal(n, 2);
  assert.equal(lastBody.reasoning_effort, undefined);
});

test('转接器：Claude Code 断开（被停掉）时，同时中止发给平台的请求', async () => {
  script = (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify(delta({ content: '慢慢说' }))}\n\n`); };
  const ctrl = new AbortController();
  const before = aborted;
  const res = await fetch(`${bridge.url}/v1/messages`, { method: 'POST', signal: ctrl.signal, headers: { authorization: `Bearer ${apiBridgeToken('room-a:api')}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }] }) });
  const reader = res.body.getReader();
  await reader.read();
  ctrl.abort();
  for (let i = 0; i < 50 && aborted === before; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(aborted, before + 1);
});

test('转接器：思考过程不混进正文；有工具调用时记下来，下一轮按调用编号原样带回去', async () => {
  const tools = [{ name: 'Bash', input_schema: { type: 'object' } }];
  script = (req, res) => sse(res, [delta({ reasoning_content: '先列目录' }), delta({ tool_calls: [{ index: 0, id: 'call_r', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }), delta({}, 'tool_calls')]);
  const r = await call({ tools });
  assert.ok(!r.text.includes('先列目录'));
  script = (req, res) => sse(res, [delta({ content: '2' }), delta({}, 'stop')]);
  await call({ tools, messages: [
    { role: 'user', content: '几个文件' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_r', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_r', content: 'a\nb' }, { type: 'text', text: '快点' }] },
  ] });
  const msgs = lastBody.messages;
  assert.equal(msgs[1].reasoning_content, '先列目录');
  assert.equal(msgs[1].tool_calls[0].id, 'call_r');
  assert.deepEqual([msgs[2].role, msgs[2].tool_call_id, msgs[2].content], ['tool', 'call_r', 'a\nb']);
  assert.deepEqual([msgs[3].role, msgs[3].content], ['user', '快点']);
});

test('转接器：能看图的模型才发图，看不了的换成一句说明；工具结果里的图另起一条', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const body = { messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, img] }] };
  assert.equal(toChat(body, 'vision-model', { vision: true }).messages[0].content[1].image_url.url, 'data:image/png;base64,AAAA');
  assert.match(toChat(body, 'text-model', { vision: false }).messages[0].content, /看不了图/);
  assert.match(toChat(body, 'unknown', {}).messages[0].content, /看不了图/, '不知道能不能看图的，按看不了处理');
  const tr = toChat({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: '截图如下' }, img] }] }] }, 'v', { vision: true }).messages;
  assert.equal(tr[0].role, 'tool');
  assert.equal(tr[1].role, 'user');
  assert.equal(tr[1].content[0].type, 'image_url');
});

test('转接器：非流式请求也能用', async () => {
  script = (req, res) => sse(res, [delta({ content: '好的' }), delta({}, 'stop')]);
  const res = await fetch(`${bridge.url}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${apiBridgeToken('room-a:api')}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: 'x' }] }) });
  const json = await res.json();
  assert.equal(json.content[0].text, '好的');
  assert.equal(json.stop_reason, 'end_turn');
});

test('转接器：思考内容按群、按成员分开记；别的群返回同一个调用编号也不会串；分身找不到时用本体的', async () => {
  const tools = [{ name: 'Bash', input_schema: { type: 'object' } }];
  const think = (text) => (req, res) => sse(res, [delta({ reasoning_content: text }), delta({ tool_calls: [{ index: 0, id: 'same_id', function: { name: 'Bash', arguments: '{}' } }] }), delta({}, 'tool_calls')]);
  script = think('A 群的思考');
  await call({ tools }, { token: apiBridgeToken('room-a:api') });
  script = think('B 群的思考');
  await call({ tools }, { token: apiBridgeToken('room-b:api') });
  script = (req, res) => sse(res, [delta({ content: 'ok' }), delta({}, 'stop')]);
  const history = { tools, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'same_id', name: 'Bash', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'same_id', content: 'r' }] }] };
  await call(history, { token: apiBridgeToken('room-a:api') });
  assert.equal(lastBody.messages[1].reasoning_content, 'A 群的思考');
  await call(history, { token: apiBridgeToken('room-a:api~side-1') });
  assert.equal(lastBody.messages[1].reasoning_content, 'A 群的思考', '分身复制了本体的记忆，用本体的思考');
});

test('转接器：流里报错提前结束时，也中止发给平台的请求', async () => {
  const before = aborted;
  script = (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify(delta({ content: 'a' }))}\n\n`); res.write('data: {"error":{"message":"boom"}}\n\n'); };
  const r = await call({});
  assert.ok(r.events.some((e) => e.type === 'error'));
  for (let i = 0; i < 50 && aborted === before; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(aborted, before + 1);
});

test('转接器：平台以 content_filter 或不认识的方式结束时，里面的工具调用不执行', async () => {
  const tools = [{ name: 'Bash', input_schema: { type: 'object' } }];
  for (const finish of ['content_filter', 'weird']) {
    script = (req, res) => sse(res, [delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }), delta({}, finish)]);
    const r = await call({ tools });
    assert.ok(r.events.some((e) => e.type === 'error'), finish);
    assert.ok(!r.events.some((e) => e.content_block?.type === 'tool_use'), finish);
  }
});

test('转接器：忘掉记忆后，之前记下的思考（内存和磁盘）都清掉；清之前发出、清之后才回来的也不写回', async () => {
  const tools = [{ name: 'Bash', input_schema: { type: 'object' } }];
  const history = { tools, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'fid', name: 'Bash', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fid', content: 'r' }] }] };
  const think = (req, res) => sse(res, [delta({ reasoning_content: '私密思考' }), delta({ tool_calls: [{ index: 0, id: 'fid', function: { name: 'Bash', arguments: '{}' } }] }), delta({}, 'tool_calls')]);
  const files = () => fs.readdirSync(dataDir, { recursive: true }).filter((f) => String(f).endsWith('.json')).length;
  const base0 = files();
  script = think;
  await call({ tools }, { token: apiBridgeToken('room-f:api') });
  script = think;
  await call({ tools }, { token: apiBridgeToken('room-g:api') });
  assert.equal(files(), base0 + 2);
  forgetApiReasoning('room-f');
  assert.equal(files(), base0 + 1, '只清这一群的');
  script = (req, res) => sse(res, [delta({ content: 'ok' }), delta({}, 'stop')]);
  await call(history, { token: apiBridgeToken('room-f:api') });
  assert.equal(lastBody.messages[1].reasoning_content, undefined, '清掉以后不再带回去');
  await call(history, { token: apiBridgeToken('room-g:api') });
  assert.equal(lastBody.messages[1].reasoning_content, '私密思考', '别的群不受影响');
  // 晚到：请求发出后清记忆，回答才回来
  let release;
  script = (req, res) => new Promise((r) => { release = () => { think(req, res); r(); }; });
  const pending = call({ tools }, { token: apiBridgeToken('room-f:api') });
  while (!release) await new Promise((r) => setTimeout(r, 10));
  forgetApiReasoning('room-f', 'api');
  release();
  await pending;
  script = (req, res) => sse(res, [delta({ content: 'ok' }), delta({}, 'stop')]);
  await call(history, { token: apiBridgeToken('room-f:api') });
  assert.equal(lastBody.messages[1].reasoning_content, undefined, '清之后才回来的思考不写回');
});

test('转接器：只清某一位时，同群另一位 API 成员正在等的回答照常记下思考', async () => {
  const tools = [{ name: 'Bash', input_schema: { type: 'object' } }];
  let release;
  script = (req, res) => new Promise((r) => { release = () => { sse(res, [delta({ reasoning_content: 'API2 的思考' }), delta({ tool_calls: [{ index: 0, id: 'k2', function: { name: 'Bash', arguments: '{}' } }] }), delta({}, 'tool_calls')]); r(); }; });
  const pending = call({ tools }, { token: apiBridgeToken('room-h:api2') });
  while (!release) await new Promise((r) => setTimeout(r, 10));
  forgetApiReasoning('room-h', 'api'); // 只清 API（1 号）
  release();
  await pending;
  script = (req, res) => sse(res, [delta({ content: 'ok' }), delta({}, 'stop')]);
  await call({ tools, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'k2', name: 'Bash', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'k2', content: 'r' }] }] }, { token: apiBridgeToken('room-h:api2') });
  assert.equal(lastBody.messages[1].reasoning_content, 'API2 的思考');
});
