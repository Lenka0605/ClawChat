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

// 打开 / 关上手机访问。打开要 Tailscale 已经在电脑上登录好
export async function setRemote(enabled, port) {
  const st = await tailscaleStatus();
  if (enabled) {
    if (st.tailscale !== 'ready') return { ...(await remoteInfo()), error: st.error };
    const r = await run(st.bin, ['serve', '--bg', '--yes', '--https=443', `http://127.0.0.1:${port}`], 60000);
    if (!r.ok) {
      // 第一次用时 Tailscale 可能要先在网页上开通 HTTPS 证书，它的提示里带着链接，原样给老板看
      return { ...(await remoteInfo()), error: tr('Tailscale 没能开启访问地址：{error}', { error: (r.err || r.out).split('\n').slice(-3).join(' ') }) };
    }
    state = { enabled: true, host: st.host, login: st.login };
    saveConfig({ remote: state });
    keepAwake(true);
  } else {
    if (st.bin) await run(st.bin, ['serve', '--yes', '--https=443', 'off']); // 只撤掉这一条，不动别的 Serve 设置
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

// 这个请求能不能进来：local 本机；remote 老板自己的手机（经 Tailscale）；null 拒绝
export function requestAccess(req, port) {
  const host = String(req.headers.host || '');
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return 'local';
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
