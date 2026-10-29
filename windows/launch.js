// Windows 版的启动器（桌面上的 ClawChat 快捷方式就是运行它）：
// 后台服务没在跑就先启动它，然后用 Edge 的「应用模式」打开一个独立窗口（没有地址栏，看起来就是一个软件）。
// 关掉窗口服务还在后台，两位可以接着干活；要彻底退出，在 设置 → 通用 里点「退出 ClawChat」。
// --restart：在线升级后用，等旧服务退出再起一个新的，不另开窗口（窗口里的页面会自己刷新）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.CLAWCHAT_HOME || path.join(os.homedir(), '.clawchat');
const PORT = Number(process.env.CLAWCHAT_PORT) || 7317;
const URL_BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive() {
  try {
    return (await fetch(`${URL_BASE}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function waitFor(want, seconds) {
  for (let i = 0; i < seconds * 4; i++) {
    if ((await alive()) === want) return true;
    await sleep(250);
  }
  return false;
}

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', log, log] }).unref();
}

// 优先用 Edge（Windows 10 自带），没有就用 Chrome；都没有就用默认浏览器打开
function findBrowser() {
  const env = process.env;
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
  const apps = [path.join('Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join('Google', 'Chrome', 'Application', 'chrome.exe')];
  for (const app of apps) {
    for (const root of roots) {
      const p = path.join(root, app);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function openWindow() {
  const browser = findBrowser();
  if (!browser) {
    spawn('explorer.exe', [URL_BASE], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  // 单独的浏览器资料夹：窗口大小、主题这些自己记着，也不会和平时上网的浏览器混在一起
  const profile = path.join(DATA_DIR, 'window');
  spawn(browser, [`--app=${URL_BASE}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1180,780'], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

// 服务没起来：写一个说明页打开，里面带着日志最后几行，方便发给帮忙的人看
function showError() {
  let tail = '';
  try {
    tail = fs.readFileSync(path.join(DATA_DIR, 'server.log'), 'utf8').slice(-4000);
  } catch {}
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const file = path.join(DATA_DIR, 'start-error.html');
  // 按系统语言选中文或英文：系统是中文就用中文，否则用英文
  let zh = true;
  try {
    zh = /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale || '');
  } catch {}
  const t = zh
    ? {
        title: 'ClawChat 没能启动',
        retry: '可以再双击一次桌面上的 ClawChat 试试。还是不行的话，重新运行一次 ClawChat 文件夹里的 <b>Install-Windows.cmd</b>，它会检查缺了什么。',
        help: '如果要找人帮忙，把下面这段发给对方：',
        noLog: '（没有日志）',
      }
    : {
        title: 'ClawChat couldn’t start',
        retry: 'Try double-clicking ClawChat on your desktop again. If that doesn’t work, run <b>Install-Windows.cmd</b> in the ClawChat folder again. It will check what’s missing.',
        help: 'If you’re asking someone for help, send them the text below:',
        noLog: '(No log)',
      };
  fs.writeFileSync(
    file,
    `<!doctype html><meta charset="utf-8"><title>${t.title}</title>
<body style="font:15px/1.7 'Microsoft YaHei UI','Segoe UI',sans-serif;max-width:760px;margin:40px auto;padding:0 20px">
<h2>${t.title}</h2>
<p>${t.retry}</p>
<p>${t.help}</p>
<pre style="background:#f4f4f5;padding:12px;border-radius:8px;white-space:pre-wrap;font:12px/1.5 Consolas,monospace">${esc(tail || t.noLog)}</pre>`,
  );
  const browser = findBrowser();
  spawn(browser || 'explorer.exe', [file], { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  if (process.argv.includes('--restart')) {
    await waitFor(false, 20);
    startServer();
    await waitFor(true, 30);
    return;
  }
  if (!(await alive())) {
    startServer();
    if (!(await waitFor(true, 30))) return showError();
  }
  openWindow();
}

main();
