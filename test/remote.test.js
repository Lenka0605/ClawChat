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
  assert.match(fs.readFileSync(path.join(HOME, 'fake-tailscale.log'), 'utf8'), /"serve","--bg","--yes","--https=443","http:\/\/127\.0\.0\.1:7317"/);
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
  assert.match(fs.readFileSync(path.join(HOME, 'fake-tailscale.log'), 'utf8'), /"serve","--yes","--https=443","off"/);
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
