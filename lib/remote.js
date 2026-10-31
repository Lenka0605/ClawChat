import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { readConfig, saveConfig } from './store.js';
import { tr } from './i18n.js';

// 手机远程访问：走 Tailscale Serve（只在老板自己 Tailscale 账号的设备之间通，不公开到互联网）。
// 打开时让 Tailscale 把 https://<这台电脑>.<tailnet>.ts.net 转到本机的 ClawChat；
// 每个请求都核对 Tailscale 写进来的账号（Tailscale-User-Login，它会先删掉请求里原有的同名头，伪造不了），
// 必须是打开开关时这台电脑登录的那个账号。从公开网络（Funnel）进来的一律拒绝。默认关着。

const IS_WIN = process.platform === 'win32';
const KNOWN = IS_WIN
  ? ['C:\\Program Files\\Tailscale\\tailscale.exe']
  : ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

let state = null; // 开关的设置：{ enabled, host, login }，启动时从 config.json 读一次，改的时候一起写回
let awake = null; // 开着时让电脑别自己睡着（macOS 的 caffeinate）

function current() {
  if (!state) state = { ...readConfig().remote };
  return state;
}

function findBin() {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const file = path.join(dir, IS_WIN ? 'tailscale.exe' : 'tailscale');
    if (dir && fs.existsSync(file)) return file;
  }
  return KNOWN.find((f) => fs.existsSync(f)) || null;
}

function run(bin, args, timeout = 20000) {
  return new Promise((resolve) =>
    execFile(bin, args, { timeout, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err?.code, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() }),
    ),
  );
}

// Tailscale 带过来的账号名：非英文的会按 MIME 的 Q 编码（=?utf-8?q?...?=），英文邮箱原样
export function decodeLogin(v) {
  const m = String(v || '').match(/^=\?utf-8\?q\?(.*)\?=$/i);
  if (!m) return String(v || '');
  const bytes = [];
  for (let i = 0; i < m[1].length; i++) {
    const c = m[1][i];
    if (c === '_') bytes.push(0x20);
    else if (c === '=' && /^[0-9a-f]{2}$/i.test(m[1].slice(i + 1, i + 3))) {
      bytes.push(parseInt(m[1].slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(c.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

// Tailscale 现在怎么样：missing 没装；stopped 没打开或没登录；ready 能用（host 是这台电脑的 .ts.net 地址，login 是登录的账号）
export async function tailscaleStatus() {
  const bin = findBin();
  if (!bin) return { tailscale: 'missing', error: tr('这台电脑上没装 Tailscale') };
  const r = await run(bin, ['status', '--json']);
  if (r.code === 'ENOENT' || r.code === 127) return { tailscale: 'missing', error: tr('这台电脑上没装 Tailscale') };
  let d;
  try {
    d = JSON.parse(r.out);
  } catch {
    return { tailscale: 'stopped', error: tr('Tailscale 没有打开，先在电脑上打开 Tailscale 并登录') };
  }
  const host = String(d.Self?.DNSName || '').replace(/\.$/, '');
  const login = d.User?.[d.Self?.UserID]?.LoginName || '';
  if (d.BackendState === 'NeedsLogin') return { tailscale: 'stopped', error: tr('Tailscale 还没登录，先在电脑上打开 Tailscale 并登录') };
  if (d.BackendState !== 'Running' || !host || !login) return { tailscale: 'stopped', error: tr('Tailscale 没有打开，先在电脑上打开 Tailscale 并登录') };
  return { tailscale: 'ready', host, login, bin };
}

// 设置里显示的状态
export async function remoteInfo() {
  const st = await tailscaleStatus();
  const cfg = current();
  return {
    enabled: !!cfg.enabled,
    url: cfg.enabled && cfg.host ? `https://${cfg.host}` : '',
    login: cfg.enabled ? cfg.login || '' : st.login || '',
    tailscale: st.tailscale,
    error: st.tailscale === 'ready' ? '' : st.error || '',
  };
}

function keepAwake(on) {
  if (process.platform !== 'darwin') return;
  if (on && !awake) {
    // -i：电脑闲着也别睡（屏幕照常可以关）；-w：ClawChat 退出时它自己跟着结束
    try {
      awake = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      awake.unref(); // 别因为它拖着 ClawChat 退不出去
      awake.on('exit', () => (awake = null));
      awake.on('error', () => (awake = null));
    } catch {
      awake = null;
    }
  } else if (!on && awake) {
    awake.kill();
    awake = null;
  }
}

// 这台电脑 Tailscale Serve 在 443 端口根路径「/」上现在挂着什么：{ handler }（null 是空着），读不出来就是 { error }。
// 没有任何 Serve 设置时官方输出 null；命令失败、空输出、内容不对都算读不出来，这时不去改 Serve
async function rootHandler(bin, host) {
  const r = await run(bin, ['serve', 'status', '--json']);
  const fail = { error: tr('读不出 Tailscale 现在的 Serve 设置，没有去改它：{error}', { error: (r.err || r.out || tr('没有输出')).split('\n').slice(-2).join(' ') }) };
  if (!r.ok || !r.out) return fail;
  let sc;
  try {
    sc = JSON.parse(r.out);
  } catch {
    return fail;
  }
  if (sc === null) return { handler: null };
  if (typeof sc !== 'object' || Array.isArray(sc)) return fail;
  // 443 整个端口被直接转发（不是网页服务）：也算被占着
  const tcp = sc.TCP?.['443'];
  if (tcp && (tcp.TCPForward || tcp.TerminateTLS)) return { handler: { TCPForward: tcp.TCPForward || tcp.TerminateTLS } };
  return { handler: sc.Web?.[`${host}:443`]?.Handlers?.['/'] || null };
}

// 根路径上挂的是不是 ClawChat 自己：只有一项 Proxy，并且正好转到这里（静态目录 Path、固定文本 Text、跳转等都不是）
function isOurs(handler, target) {
  if (!handler) return false;
  const others = Object.entries(handler).filter(([k, v]) => k !== 'Proxy' && v !== undefined && v !== null && v !== '' && v !== false);
  return !others.length && String(handler.Proxy || '').replace(/\/$/, '') === target;
}

// 打开 / 关上手机访问。打开要 Tailscale 已经在电脑上登录好
export async function setRemote(enabled, port) {
  const st = await tailscaleStatus();
  const target = `http://127.0.0.1:${port}`;
  if (enabled) {
    if (st.tailscale !== 'ready') return { ...(await remoteInfo()), error: st.error };
    // 读不出现在的设置，或者老板自己在 443 的根路径上挂了别的东西：都不去动它
    const root = await rootHandler(st.bin, st.host);
    if (root.error) return { ...(await remoteInfo()), error: root.error };
    if (root.handler && !isOurs(root.handler, target)) {
      const what = root.handler.Proxy || root.handler.Path || root.handler.TCPForward || (root.handler.Text !== undefined ? tr('一段固定文字') : tr('别的设置'));
      return { ...(await remoteInfo()), error: tr('这台电脑的 Tailscale 已经把这个地址给了别的服务（{target}），ClawChat 不去覆盖它', { target: what }) };
    }
    const r = await run(st.bin, ['serve', '--bg', '--yes', '--https=443', '--set-path=/', target], 60000);
    if (!r.ok) {
      // 第一次用时 Tailscale 可能要先在网页上开通 HTTPS 证书，它的提示里带着链接，原样给老板看
      return { ...(await remoteInfo()), error: tr('Tailscale 没能开启访问地址：{error}', { error: (r.err || r.out).split('\n').slice(-3).join(' ') }) };
    }
    state = { enabled: true, host: st.host, login: st.login };
    saveConfig({ remote: state });
    keepAwake(true);
  } else {
    // 只撤掉 ClawChat 自己的那一条（443 根路径、并且确实转到这里的），不动别的 Serve 设置
    if (st.tailscale === 'ready' && isOurs((await rootHandler(st.bin, st.host)).handler, target)) {
      await run(st.bin, ['serve', '--yes', '--https=443', '--set-path=/', 'off']);
    }
    state = {};
    saveConfig({ remote: null });
    keepAwake(false);
  }
  return remoteInfo();
}

// 启动时：开着的话让电脑别睡；Tailscale 的 Serve 设置它自己会记着
export function initRemote() {
  if (current().enabled) keepAwake(true);
}

// 经过代理转进来的（Tailscale Serve 一定会写上 X-Forwarded-Host / X-Forwarded-For，客户端带的会被覆盖）。
// 浏览器里的网页没法给本机地址带这些头（要先过跨域预检，ClawChat 不答应），所以本机直接打开的请求不会有
const PROXY_HEADERS = ['x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto', 'forwarded', 'tailscale-user-login', 'tailscale-funnel-request', 'tailscale-headers-info'];

// 这个请求能不能进来：local 本机；remote 老板自己的手机（经 Tailscale）；null 拒绝。
// 先看是不是转进来的：转进来的 Host 是客户端自己写的，可以冒充本机地址，所以一律按手机来的核对账号
export function requestAccess(req, port) {
  const host = String(req.headers.host || '');
  const proxied = PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
  if (!proxied) return host === `127.0.0.1:${port}` || host === `localhost:${port}` ? 'local' : null;
  const cfg = current();
  if (!cfg.enabled || !cfg.host || !cfg.login) return null;
  if (host.replace(/:443$/, '') !== cfg.host) return null;
  if (req.headers['tailscale-funnel-request']) return null; // 从公开网络进来的
  return decodeLogin(req.headers['tailscale-user-login']) === cfg.login ? 'remote' : null;
}

// 测试用：重新从 config.json 读开关
export function _resetRemoteState() {
  state = null;
}
