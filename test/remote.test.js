import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 用 scripts/fake 里假的 tailscale，不碰真的 Tailscale
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-remote-'));
process.env.CLAWCHAT_HOME = HOME;
process.env.PATH = `${path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'fake')}${path.delimiter}${process.env.PATH}`;
const { decodeLogin, requestAccess, setRemote, remoteInfo, _resetRemoteState } = await import('../lib/remote.js');
const mode = (m) => fs.writeFileSync(path.join(HOME, 'fake-tailscale'), m);
const SERVE = path.join(HOME, 'fake-tailscale-serve.json');
const served = () => (fs.existsSync(SERVE) ? JSON.parse(fs.readFileSync(SERVE, 'utf8')) : {});
const req = (host, headers = {}) => ({ headers: { host, ...headers } });
const PORT = 7317;
const REMOTE = 'fake-mac.tail-fake.ts.net';

test('Tailscale 带过来的账号名：英文原样，中文按 Q 编码解开', () => {
  assert.equal(decodeLogin('boss@example.com'), 'boss@example.com');
  assert.equal(decodeLogin('=?utf-8?q?=E8=80=81=E6=9D=BF_A?='), '老板 A');
  assert.equal(decodeLogin(undefined), '');
});

test('手机访问默认关着：只有本机地址能进来', async () => {
  _resetRemoteState();
  mode('running');
  assert.equal(requestAccess(req(`127.0.0.1:${PORT}`), PORT), 'local');
  assert.equal(requestAccess(req(`localhost:${PORT}`), PORT), 'local');
  assert.equal(requestAccess(req(REMOTE, { 'tailscale-user-login': 'boss@example.com' }), PORT), null);
  assert.equal(requestAccess(req('evil.com'), PORT), null);
  assert.equal((await remoteInfo()).enabled, false);
});

test('打开以后：只认这台电脑登录的那个 Tailscale 账号；别的账号、公开网络（Funnel）、别的地址一律拒绝', async () => {
  _resetRemoteState();
  mode('running');
  const on = await setRemote(true, PORT);
  assert.equal(on.enabled, true);
  assert.equal(on.url, `https://${REMOTE}`);
  assert.equal(on.login, 'boss@example.com');
  assert.equal(on.tailscale, 'ready');
  assert.equal(served()['/'], 'http://127.0.0.1:7317');
  assert.equal(requestAccess(req(REMOTE, { 'tailscale-user-login': 'boss@example.com' }), PORT), 'remote');
  assert.equal(requestAccess(req(`${REMOTE}:443`, { 'tailscale-user-login': 'boss@example.com' }), PORT), 'remote');
  assert.equal(requestAccess(req(REMOTE, { 'tailscale-user-login': 'someone@else.com' }), PORT), null, '别的账号');
  assert.equal(requestAccess(req(REMOTE), PORT), null, '没带账号');
  assert.equal(requestAccess(req(REMOTE, { 'tailscale-user-login': 'boss@example.com', 'tailscale-funnel-request': '?1' }), PORT), null, '公开网络');
  assert.equal(requestAccess(req('other.ts.net', { 'tailscale-user-login': 'boss@example.com' }), PORT), null, '别的地址');
  // 重启以后还记得
  _resetRemoteState();
  assert.equal(requestAccess(req(REMOTE, { 'tailscale-user-login': 'boss@example.com' }), PORT), 'remote');
  const off = await setRemote(false, PORT);
  assert.equal(off.enabled, false);
  assert.equal(served()['/'], undefined);
  assert.equal(requestAccess(req(REMOTE, { 'tailscale-user-login': 'boss@example.com' }), PORT), null);
});

test('Tailscale 没装、没打开、没登录、开启失败：开关打不开，说清楚原因', async () => {
  _resetRemoteState();
  mode('missing');
  let r = await setRemote(true, PORT);
  assert.equal(r.tailscale, 'missing');
  assert.equal(r.enabled, false);
  mode('stopped');
  r = await setRemote(true, PORT);
  assert.equal(r.tailscale, 'stopped');
  assert.match(r.error, /打开 Tailscale/);
  mode('needslogin');
  r = await setRemote(true, PORT);
  assert.match(r.error, /还没登录/);
  mode('serve-error');
  r = await setRemote(true, PORT);
  assert.equal(r.enabled, false);
  assert.match(r.error, /login\.tailscale\.com/, '第一次要开通 HTTPS 时，把 Tailscale 给的链接原样告诉老板');
});

test('经 Tailscale 转进来的请求把主机名写成本机地址冒充本机：一律按手机来的核对，开关关着时拒绝', async () => {
  _resetRemoteState();
  mode('running');
  fs.rmSync(SERVE, { force: true });
  const fake = (extra) => req(`127.0.0.1:${PORT}`, { 'x-forwarded-for': '100.64.0.9', 'x-forwarded-host': `127.0.0.1:${PORT}`, ...extra });
  assert.equal(requestAccess(fake({}), PORT), null, '开关关着');
  assert.equal(requestAccess(fake({ 'tailscale-user-login': 'boss@example.com' }), PORT), null, '开关关着，账号对也不行');
  await setRemote(true, PORT);
  assert.equal(requestAccess(fake({ 'tailscale-user-login': 'someone@else.com' }), PORT), null, '别的账号');
  assert.equal(requestAccess(fake({ 'tailscale-funnel-request': '?1' }), PORT), null, '公开网络');
  assert.equal(requestAccess(fake({ 'tailscale-user-login': 'boss@example.com' }), PORT), null, '地址不是这台电脑的 .ts.net');
  assert.equal(requestAccess(req(REMOTE, { 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': 'boss@example.com' }), PORT), 'remote');
  await setRemote(false, PORT);
});

test('Tailscale Serve：根路径被老板别的服务占着时不覆盖；关掉时只撤 ClawChat 自己那一条', async () => {
  _resetRemoteState();
  mode('running');
  fs.writeFileSync(SERVE, JSON.stringify({ '/': 'http://127.0.0.1:3000' }));
  const r = await setRemote(true, PORT);
  assert.equal(r.enabled, false);
  assert.match(r.error, /别的服务/);
  assert.equal(served()['/'], 'http://127.0.0.1:3000', '别的服务还在');
  // 别的路径上挂着别的服务：打开、关掉都不影响它
  fs.writeFileSync(SERVE, JSON.stringify({ '/grafana': 'http://127.0.0.1:3000' }));
  assert.equal((await setRemote(true, PORT)).enabled, true);
  assert.equal((await setRemote(false, PORT)).enabled, false);
  assert.deepEqual(served(), { '/grafana': 'http://127.0.0.1:3000' });
  // 关的时候根路径已经被换成别的了：不去撤
  await setRemote(true, PORT);
  fs.writeFileSync(SERVE, JSON.stringify({ '/': 'http://127.0.0.1:4000' }));
  await setRemote(false, PORT);
  assert.equal(served()['/'], 'http://127.0.0.1:4000');
  fs.rmSync(SERVE, { force: true });
});
