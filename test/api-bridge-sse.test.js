import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApiBridge, stopApiBridge, apiBridgeToken } from '../lib/api-bridge.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 转接器收 SSE 的三件小事：UTF-8 被拆包不能乱码、一条事件跨多行 data、用量帧晚到也要等到。
// 全程用本机假平台，不连任何真平台、不用真 Key。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-bridge-sse-test-'));
let script = null;
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => script(req, res, JSON.parse(raw || '{}')));
});
let base;
let bridge;
before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${upstream.address().port}/v1`;
  bridge = await startApiBridge(() => ({ base, key: 'real-upstream-key', model: () => ({ vision: false, maxOutput: 1000, thinking: true }) }), { dataDir });
});
after(() => { stopApiBridge(); upstream.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

async function call(body = {}) {
  const res = await fetch(`${bridge.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiBridgeToken('sse-room:api')}` },
    body: JSON.stringify({ model: 'm', max_tokens: 5000, stream: true, messages: [{ role: 'user', content: 'hi' }], ...body }),
  });
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((b) => b.includes('data:'))
    .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data:')).slice(5)));
  return { status: res.status, text, events };
}

const textOf = (events) =>
  events
    .filter((e) => e.delta?.type === 'text_delta')
    .map((e) => e.delta.text)
    .join('');

test('转接器 SSE：一个汉字的字节被拆在两个网络包里，收到的字不乱码', async () => {
  // 「你好啊」整帧拼好以后按 UTF-8 字节切：每个汉字的三字节都被从中间切开
  const frame = `data: ${JSON.stringify(delta({ content: '你好啊' }))}\n\n${'data: ' + JSON.stringify(delta({}, 'stop')) + '\n\n'}`;
  script = async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const all = Buffer.from(frame + 'data: [DONE]\n\n', 'utf8');
    // 找到每个汉字的中间位置切三刀；切点都在多字节字符内部，模拟最坏的拆包方式
    const cuts = [];
    for (const ch of ['你', '好', '啊']) {
      const at = all.indexOf(Buffer.from(ch, 'utf8'));
      cuts.push(at + 1); // 三字节 UTF-8 的第一字节之后
    }
    let from = 0;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const at of [...cuts, all.length]) {
      res.write(all.subarray(from, at));
      from = at;
      // 停一下：确保每个片段单独到达转接器，不会被本机网络栈合并成一个包
      await wait(15);
    }
    res.end();
  };
  const r = await call({});
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('�'), '不能出现乱码替换符');
  assert.equal(textOf(r.events), '你好啊');
  assert.equal(r.events.find((e) => e.type === 'message_delta').delta.stop_reason, 'end_turn');
});

test('转接器 SSE：一条事件分成好几行 data: 发过来，拼接后按一条解析', async () => {
  // SSE 规范：一个事件可以有多行 data:，事件结束时按行拼接（中间夹换行）。JSON 里的换行是合法空白，拼起来仍是合法 JSON
  script = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":\n');
    res.write('data:     "拼出来的字"}}]}\n\n');
    res.write(`data: ${JSON.stringify(delta({}, 'stop'))}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };
  const r = await call({});
  assert.equal(r.status, 200);
  assert.equal(textOf(r.events), '拼出来的字');
});

test('转接器 SSE：带 finish_reason 的帧先到、用量帧后到，最后的 usage 也要是对的', async () => {
  // 有的平台先发 finish 帧、隔一会儿才发 choices: [] 的用量帧，最后才是 [DONE]：
  // 转接器不能收到 finish_reason 就提前收尾，否则用量（计费依据）就丢了
  script = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(delta({ content: '好的' }))}\n\n`);
    res.write(`data: ${JSON.stringify(delta({}, 'stop'))}\n\n`);
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 80 } } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }, 400);
  };
  const r = await call({});
  assert.equal(r.status, 200);
  const md = r.events.find((e) => e.type === 'message_delta');
  assert.deepEqual(md.usage, { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 80 }, '命中缓存的部分不算进普通输入');
  assert.equal(r.events.find((e) => e.type === 'message_stop').type, 'message_stop');
});
