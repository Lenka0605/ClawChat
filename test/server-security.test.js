// 服务端的几道安全门：真起一个 server.js（临时数据目录、随机端口），从外面发请求看拦没拦住
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let home, child, base;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-sec-'));
  fs.chmodSync(home, 0o755); // 模拟老版本留下的 755 目录，看启动时会不会收紧
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, CLAWCHAT_PORT: String(port), CLAWCHAT_HOME: home },
    stdio: 'ignore',
  });
  // 等它起来：防卡死的兜底等 30 秒，正常一两秒就好
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    try { if ((await fetch(`${base}/api/state`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('测试用的服务没起来');
});

after(() => {
  child?.kill();
  fs.rmSync(home, { recursive: true, force: true });
});

const get = (site) => fetch(`${base}/api/state`, site ? { headers: { 'Sec-Fetch-Site': site } } : {});

test('读的接口：别的网站借浏览器发来的请求一律 403（含 same-site：本机别的端口也算 same-site）', async () => {
  assert.equal((await get('cross-site')).status, 403);
  assert.equal((await get('same-site')).status, 403);
});

test('读的接口：自己页面发的、地址栏直接打开的、没有这个头的（安卓 App、命令行）照常放行', async () => {
  assert.equal((await get('same-origin')).status, 200);
  assert.equal((await get('none')).status, 200);
  assert.equal((await get()).status, 200);
});

test('写的接口：不带 X-ClawChat 头一律 403', async () => {
  const res = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('数据目录启动后只有自己能读写（700）', { skip: process.platform === 'win32' }, () => {
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
});
