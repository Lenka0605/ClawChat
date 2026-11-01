import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// 本地转接器：让「API」这位成员借 Claude Code 干活，但背后用任意 OpenAI 兼容平台（填地址和 Key 就能接）。
// Claude Code 只会说 Anthropic Messages 协议；这里在本机起一个只听 127.0.0.1 的小服务，
// 把它的请求翻译成 OpenAI 的 /chat/completions 发给平台，再把平台的流式回答翻译回 Anthropic 的事件。
//
// 安全：
//   - 只监听 127.0.0.1 的随机端口，不挂在会被 Tailscale 转发的 ClawChat 主服务上；
//   - Claude Code 拿到的是每次启动随机生成的令牌，真正的平台 Key 只在这里，不给 Claude Code；
//   - 先核对令牌再读请求体；带 Origin 的（浏览器发来的）一律拒绝；平台地址和 Key 只从服务端配置读，请求里改不了；
//   - Claude Code 被停掉、连接断开时，同时中止发给平台的请求，免得模型接着生成、接着扣量。
// 协议上的取舍（ChatGPT 复核时提的）：
//   - 工具调用先收完整、确认参数是合法 JSON 才交给 Claude Code，截断的命令不会被执行；
//   - 平台的「思考过程」不伪装成 Anthropic 的 thinking 块，只在内存里记着，下一轮按工具调用编号原样带回去（DeepSeek 等要求）；
//   - 断流、出错、被截断都不当成正常结束。

const MAX_BODY = 64 * 1024 * 1024; // Claude Code 一次请求最多这么大（长对话、截图）
const PING_MS = 10000; // 模型想很久时，每 10 秒发一个 ping，Claude Code 不会以为断了
const IDLE_MS = 10 * 60 * 1000; // 平台 10 分钟一个字都不回：当成断了

// 思考内容：工具调用编号 → 那一轮的思考（DeepSeek 这类平台要求下一轮原样带回去）。
// 按「哪个群的哪位成员」分开记（scope），别的群返回同一个调用编号也不会串；分身单独一份，找不到时再看本体的。
// 存在磁盘上，ClawChat 重启后接着聊也带得回去
let reasoningDir = '';
const reasoning = new Map(); // scope → Map(调用编号 → 思考)
// 第几代：「忘掉记忆」时加一，之前发出、晚到的回答不再写回来。分两级：
//   群（整群清空、删群）和成员（只给某一位换新会话、删掉某一位：只影响它自己和它的分身，同群别的成员照常记）
const generation = new Map();
const memberOf = (scope) => scope.split('~')[0];
const genOf = (scope) => `${generation.get(roomOf(scope)) || 0}/${generation.get(memberOf(scope)) || 0}`;
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
const roomOf = (scope) => scope.split(':')[0];
// 磁盘上按群分文件夹：<群的哈希>/<范围的哈希>.json，内容带上范围本身，清理时认得出是谁的
const scopeFile = (scope) => path.join(reasoningDir, hash(roomOf(scope)), `${hash(scope)}.json`);
function scopeMap(scope) {
  if (!reasoning.has(scope)) {
    let entries = [];
    try { if (reasoningDir) entries = JSON.parse(fs.readFileSync(scopeFile(scope), 'utf8')).entries || []; } catch {}
    reasoning.set(scope, new Map(entries));
  }
  return reasoning.get(scope);
}
function rememberReasoning(scope, gen, ids, text) {
  if (!text || !ids.length) return;
  if (genOf(scope) !== gen) return; // 这一轮开始以后，这一群或这一位的记忆被清过了：不写回
  const m = scopeMap(scope);
  for (const id of ids) m.set(id, text);
  while (m.size > 300) m.delete(m.keys().next().value);
  if (!reasoningDir) return;
  try {
    fs.mkdirSync(path.dirname(scopeFile(scope)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(scopeFile(scope), JSON.stringify({ scope, entries: [...m] }), { mode: 0o600 });
  } catch {}
}
function recallReasoning(scope, id) {
  const own = scopeMap(scope).get(id);
  if (own) return own;
  const parent = scope.split('~')[0];
  return parent !== scope ? scopeMap(parent).get(id) : undefined;
}

// 换新会话、清空并忘掉记忆、删群、删成员时：这一群（或这一群的某一位，连同它的分身）记下的思考一起清掉
export function forgetApiReasoning(room, agent) {
  room = String(room);
  const key = agent ? `${room}:${agent}` : room;
  generation.set(key, (generation.get(key) || 0) + 1);
  const mine = (scope) => roomOf(scope) === room && (!agent || scope === `${room}:${agent}` || scope.startsWith(`${room}:${agent}~`));
  for (const scope of [...reasoning.keys()]) if (mine(scope)) reasoning.delete(scope);
  if (!reasoningDir) return;
  const dir = path.join(reasoningDir, hash(room));
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return; }
  for (const f of files) {
    const file = path.join(dir, f);
    try {
      if (!agent || mine(JSON.parse(fs.readFileSync(file, 'utf8')).scope)) fs.rmSync(file, { force: true });
    } catch { fs.rmSync(file, { force: true }); }
  }
}

let server = null;
let state = null; // { url, secret }

// 每位成员拿到的令牌：「范围.签名」，范围写着是哪个群的哪位（分身后面带 ~side-xxx），签名用转接器启动时的随机密钥算
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (secret, scope) => crypto.createHmac('sha256', secret).update(scope).digest('base64url');
export function apiBridgeToken(scope = 'default') {
  return state ? `${b64(scope)}.${sign(state.secret, scope)}` : '';
}
function scopeOf(token, secret) {
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  let scope;
  try { scope = Buffer.from(token.slice(0, i), 'base64url').toString('utf8'); } catch { return null; }
  const want = Buffer.from(sign(secret, scope));
  const got = Buffer.from(token.slice(i + 1));
  return got.length === want.length && crypto.timingSafeEqual(got, want) ? scope : null;
}

// getUpstream()：每次请求时取当前配置 { base, key, model(id) => 模型信息 }；dataDir：思考内容存哪
export function startApiBridge(getUpstream, { dataDir = '' } = {}) {
  if (state) return Promise.resolve(state);
  reasoningDir = dataDir;
  const secret = crypto.randomBytes(32);
  server = http.createServer((req, res) => handle(req, res, secret, getUpstream).catch((err) => {
    if (!res.headersSent) sendError(res, 500, 'api_error', String(err?.message || err));
    else res.end();
  }));
  server.keepAliveTimeout = 5000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      state = { url: `http://127.0.0.1:${server.address().port}`, secret };
      server.unref(); // 不因为它挡住进程退出
      resolve(state);
    });
  });
}

export function apiBridge() {
  return state;
}

export function stopApiBridge() {
  if (server) server.close();
  server = null;
  state = null;
  reasoning.clear();
}

function sendError(res, status, type, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求太大'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res, secret, getUpstream) {
  // 先认人：令牌不对、浏览器发来的，都不读请求体
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || '');
  const scope = scopeOf(auth, secret);
  if (!scope) return sendError(res, 401, 'authentication_error', 'invalid token');
  if (req.headers.origin) return sendError(res, 403, 'permission_error', 'browser requests are not allowed');
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'POST' || !/\/v1\/messages(\/count_tokens)?$/.test(url.pathname)) return sendError(res, 404, 'not_found_error', 'not found');
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return sendError(res, err.status || 400, 'invalid_request_error', err.status ? err.message : 'bad json');
  }
  // 粗估 token 数：中文一个字大约一个 token，英文大约四个字母一个
  if (url.pathname.endsWith('/count_tokens')) {
    const text = JSON.stringify([body.system, body.messages, body.tools]);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ input_tokens: Math.ceil(text.length / 3) }));
  }
  const up = getUpstream();
  if (!up?.base || !up?.key) return sendError(res, 401, 'authentication_error', '还没填 API 的地址和 Key');
  const model = String(body.model || '').replace(/\[1m\]$/i, '');
  const gen = genOf(scope); // 记下这一轮开始时是第几代，清过记忆就不再写回
  const info = up.model(model) || {};
  let chat;
  try {
    chat = toChat(body, model, info, (id) => recallReasoning(scope, id));
  } catch (err) {
    return sendError(res, 400, 'invalid_request_error', err.message);
  }

  // Claude Code 断开（被停掉）时中止发给平台的请求。注意不能用 req 的 close：请求体读完它就会触发
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });

  let upstream = await callUpstream(up, chat, abort.signal);
  // 有的平台（比如千问）自己会加思考参数，再传 reasoning_effort 就冲突：去掉重试一次（还没往回发任何东西，可以重试）
  if (upstream.status === 400 && chat.reasoning_effort && /reasoning_effort|thinking/i.test(upstream.errorText || '')) {
    delete chat.reasoning_effort;
    upstream = await callUpstream(up, chat, abort.signal);
  }
  if (upstream.error) return sendError(res, upstream.status, upstream.type, upstream.error);
  return relay(upstream.response, res, body, model, abort, chat, scope, gen);
}

async function callUpstream(up, chat, signal) {
  let response;
  try {
    response = await fetch(`${up.base.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${up.key}`, accept: 'text/event-stream' },
      body: JSON.stringify(chat),
      redirect: 'error', // 不跟着跳转，免得 Key 被带到别处
      signal,
    });
  } catch (err) {
    return { status: 502, type: 'api_error', error: signal.aborted ? '已停止' : `连不上平台：${err.message}` };
  }
  if (response.ok) return { response };
  const text = await response.text().catch(() => '');
  let message = text;
  try { message = JSON.parse(text).error?.message || text; } catch {}
  message = String(message).slice(0, 500);
  // 状态码原样带回去：Claude Code 和 ClawChat 按 401（Key 不对）、402（余额不足）、429（限流）给出明确提示
  const type = { 400: 'invalid_request_error', 401: 'authentication_error', 402: 'billing_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error' }[response.status] || 'api_error';
  // 平台把「额度不够」报成 400 的也有：归到 402，免得 Claude Code 一直重试
  const status = /credit|balance|余额|额度|subscription/i.test(message) ? 402 : response.status;
  return { status, type: status === 402 ? 'billing_error' : type, error: message, errorText: text };
}

// ---------------- Anthropic 请求 → OpenAI 请求 ----------------

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function imagePart(block, vision) {
  const src = block.source || {};
  if (!vision) return { type: 'text', text: '[这里有一张图片，但现在用的模型看不了图]' };
  if (src.type === 'base64') return { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } };
  if (src.type === 'url') return { type: 'image_url', image_url: { url: src.url } };
  return { type: 'text', text: '[图片格式不支持]' };
}

// 工具结果里可能有文字和图片：文字放进 tool 消息；图片 tool 消息放不下，另起一条用户消息附上
function toolResultParts(block, vision) {
  const items = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : block.content || [];
  const text = items.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const images = items.filter((b) => b.type === 'image').map((b) => imagePart(b, vision));
  return { text: (block.is_error ? '[工具出错]\n' : '') + (text || (images.length ? '[结果是图片，见下一条]' : '')), images };
}

export function toChat(body, model, info = {}, recall = () => undefined) {
  const vision = info.vision === true;
  const messages = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const m of body.messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) {
        msg.tool_calls = calls;
        const thought = calls.map((c) => recall(c.id)).find(Boolean);
        if (thought) msg.reasoning_content = thought;
      }
      messages.push(msg);
      continue;
    }
    // 用户消息：先放所有工具结果（各成一条 tool 消息），再放剩下的文字和图片
    const later = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const r = toolResultParts(b, vision);
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: r.text });
        if (r.images.length) later.push(...r.images);
      } else if (b.type === 'text') later.push({ type: 'text', text: b.text });
      else if (b.type === 'image') later.push(imagePart(b, vision));
      else if (b.type === 'document') later.push({ type: 'text', text: '[附了一个文档，这个接口不支持直接读文档，请用读文件工具]' });
    }
    if (later.length) {
      const onlyText = later.every((p) => p.type === 'text');
      messages.push({ role: 'user', content: onlyText ? later.map((p) => p.text).join('\n') : later });
    }
  }
  const chat = { model, messages, stream: true, stream_options: { include_usage: true }, n: 1 };
  const tools = (body.tools || []).filter((t) => t.input_schema && (!t.type || t.type === 'custom'));
  if (tools.length) {
    chat.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema } }));
    const tc = body.tool_choice;
    if (tc?.type === 'any') chat.tool_choice = 'required';
    else if (tc?.type === 'tool') chat.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc?.type === 'none') chat.tool_choice = 'none';
    if (tc?.disable_parallel_tool_use) chat.parallel_tool_calls = false;
  }
  const cap = Number(info.maxOutput) || 0;
  const want = Number(body.max_tokens) || 0;
  if (want) chat.max_tokens = cap ? Math.min(want, cap) : want;
  if (typeof body.temperature === 'number') chat.temperature = body.temperature;
  if (typeof body.top_p === 'number') chat.top_p = body.top_p;
  if (body.stop_sequences?.length) chat.stop = body.stop_sequences.slice(0, 4);
  // 思考强度：Claude Code 的 --effort 档位换成平台的 reasoning_effort（平台只认 low / high / max）
  const effort = body.output_config?.effort || body.effort;
  if (info.thinking !== false && effort) chat.reasoning_effort = { low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' }[effort] || undefined;
  if (!chat.reasoning_effort) delete chat.reasoning_effort;
  return chat;
}

// ---------------- OpenAI 流式回答 → Anthropic 事件 ----------------

async function* sseEvents(stream, signal) {
  const decoder = new StringDecoder('utf8'); // 一个汉字被拆在两个网络包里也不会乱码
  let buf = '';
  let data = [];
  const reader = stream.getReader();
  let timer;
  const idle = () => new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('平台太久没有回应')), IDLE_MS); });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), idle()]).finally(() => clearTimeout(timer));
      if (done) break;
      buf += decoder.write(Buffer.from(value));
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    buf += decoder.end();
    if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, ''));
    if (data.length) yield data.join('\n');
  } finally {
    if (signal.aborted) reader.cancel().catch(() => {});
    else reader.releaseLock?.();
  }
}

async function relay(response, res, body, model, abort, chat, scope, gen) {
  const streaming = body.stream !== false;
  const msgId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const toolNames = new Set((chat.tools || []).map((t) => t.function.name));
  let started = false;
  let index = 0;
  let textOpen = false;
  let text = '';
  let thought = '';
  const calls = new Map(); // 工具调用按序号收齐
  let finish = null;
  let usage = null;
  let gotDone = false;
  const events = [];
  const send = (event, data) => {
    if (streaming) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    else events.push(data);
  };
  const start = () => {
    if (started) return;
    started = true;
    if (streaming) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    send('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  };
  const ping = streaming ? setInterval(() => { start(); res.write('event: ping\ndata: {"type": "ping"}\n\n'); }, PING_MS) : null;
  // 出错提前结束：一定连带中止平台那边的请求，免得它接着生成、接着扣量
  const fail = (message) => {
    clearInterval(ping);
    abort.abort();
    if (streaming && started) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`);
      res.end();
    } else if (!res.headersSent) sendError(res, 502, 'api_error', message);
    else res.end();
  };
  try {
    for await (const data of sseEvents(response.body, abort.signal)) {
      if (data.trim() === '[DONE]') { gotDone = true; break; }
      let chunk;
      try { chunk = JSON.parse(data); } catch { return fail('平台返回的数据坏了'); }
      if (chunk.error) return fail(String(chunk.error.message || JSON.stringify(chunk.error)).slice(0, 500));
      if (chunk.usage) usage = chunk.usage;
      const choice = (chunk.choices || []).find((c) => (c.index ?? 0) === 0);
      if (!choice) continue;
      const d = choice.delta || choice.message || {};
      if (d.reasoning_content) thought += d.reasoning_content;
      if (typeof d.content === 'string' && d.content) {
        start();
        if (!textOpen) {
          send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
          textOpen = true;
        }
        text += d.content;
        send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: d.content } });
      }
      for (const tc of d.tool_calls || []) {
        const k = tc.index ?? 0;
        const c = calls.get(k) || { id: '', name: '', args: '' };
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name = tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
        calls.set(k, c);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  } catch (err) {
    if (abort.signal.aborted) return res.end();
    return fail(String(err.message || err));
  } finally {
    clearInterval(ping);
  }
  if (abort.signal.aborted) return res.end();
  // 没有结束标志：平台中途断了，不能当成正常说完
  if (!finish && !gotDone) return fail('平台的回答中途断了');
  if (!finish) return fail('平台的回答没有正常结束');
  start();
  if (textOpen) {
    send('content_block_stop', { type: 'content_block_stop', index });
    index += 1;
  }
  // 工具调用：正常结束（tool_calls / stop）、收齐了、参数是完整的 JSON 对象、名字是这一轮给过的工具，才交出去。
  // 被截断、被平台拦下（content_filter）或者不认识的结束方式，一律不执行
  const toolBlocks = [];
  if (calls.size) {
    if (finish === 'length') return fail('输出到上限被截断了，工具调用不完整，没有执行');
    if (!['tool_calls', 'stop', 'function_call'].includes(finish)) return fail(`平台以「${finish}」结束了这一轮，里面的工具调用没有执行`);
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let input;
      try { input = c.args.trim() ? JSON.parse(c.args) : {}; } catch { return fail(`工具 ${c.name || '?'} 的参数不完整，没有执行`); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(`工具 ${c.name || '?'} 的参数不对，没有执行`);
      if (!toolNames.has(c.name)) return fail(`模型调用了不存在的工具 ${c.name || '?'}`);
      const id = c.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
      toolBlocks.push({ id, name: c.name, input });
    }
    rememberReasoning(scope, gen, toolBlocks.map((t) => t.id), thought);
    for (const t of toolBlocks) {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input) } });
      send('content_block_stop', { type: 'content_block_stop', index });
      index += 1;
    }
  }
  const stopReason = toolBlocks.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end_turn';
  // OpenAI 的 prompt_tokens 里包含了命中缓存的部分；Anthropic 的 input_tokens 不含缓存，要减掉
  const cached = Number(usage?.prompt_tokens_details?.cached_tokens) || 0;
  const outUsage = {
    input_tokens: Math.max(0, (Number(usage?.prompt_tokens) || 0) - cached),
    output_tokens: Number(usage?.completion_tokens) || 0,
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  };
  if (!streaming) {
    const content = [...(text ? [{ type: 'text', text }] : []), ...toolBlocks.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input }))];
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: msgId, type: 'message', role: 'assistant', model, content, stop_reason: stopReason, stop_sequence: null, usage: outUsage }));
  }
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: outUsage });
  send('message_stop', { type: 'message_stop' });
  res.end();
}
