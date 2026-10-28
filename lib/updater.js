import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 在线升级：ClawChat 直接从这个代码目录运行，升级就是从 GitHub 拉最新代码、重新打包、重启。
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args, timeout = 60000) {
  return new Promise((resolve) =>
    execFile('git', args, { cwd: ROOT, encoding: 'utf8', timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || err?.message || '').trim() }),
    ),
  );
}

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '';
  }
}

// 本地改过还没提交的文件（升级前要求是干净的，免得把你的改动冲掉）
async function dirtyFiles() {
  const { out } = await git(['status', '--porcelain', '--untracked-files=no']);
  return out ? out.split('\n').map((l) => l.slice(3)) : [];
}

export async function appInfo() {
  const [commit, branch, remote, dirty] = await Promise.all([
    git(['rev-parse', '--short', 'HEAD']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['remote', 'get-url', 'origin']),
    dirtyFiles(),
  ]);
  const url = remote.ok ? remote.out.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '') : '';
  return {
    version: version(),
    commit: commit.ok ? commit.out : '',
    branch: branch.ok ? branch.out : '',
    repo: url,
    dirty: dirty.length > 0,
    inApp: process.env.CLAWCHAT_APP === '1',
  };
}

export async function checkUpdate() {
  const upstream = await git(['rev-parse', '--abbrev-ref', '@{u}']);
  if (!upstream.ok) return { ok: false, error: '这份代码还没有关联 GitHub 仓库，没法检查更新' };
  const fetched = await git(['fetch', '--quiet', 'origin'], 90000);
  if (!fetched.ok) return { ok: false, error: `连不上 GitHub：${fetched.err.split('\n').pop()}` };
  const behind = Number((await git(['rev-list', '--count', 'HEAD..@{u}'])).out || 0);
  const log = await git(['log', '--format=%h%x09%s%x09%cr', '-20', 'HEAD..@{u}']);
  const changes = log.out ? log.out.split('\n').map((l) => {
    const [hash, subject, when] = l.split('\t');
    return { hash, subject, when };
  }) : [];
  let latest = version();
  const pkg = await git(['show', '@{u}:package.json']);
  try {
    latest = JSON.parse(pkg.out).version || latest;
  } catch {}
  return { ok: true, current: version(), latest, behind, changes, dirty: (await dirtyFiles()).length > 0 };
}

// 拉最新代码；成功后由调用方安排重启
export async function pullUpdate() {
  const dirty = await dirtyFiles();
  if (dirty.length) return { ok: false, error: `本地有没提交的改动，先处理掉再升级：${dirty.slice(0, 5).join('、')}` };
  const before = (await git(['rev-parse', 'HEAD'])).out;
  const pulled = await git(['pull', '--ff-only', '--quiet'], 180000);
  if (!pulled.ok) return { ok: false, error: `拉取失败：${pulled.err.split('\n').pop()}` };
  const after = (await git(['rev-parse', 'HEAD'])).out;
  return { ok: true, updated: before !== after, version: version() };
}

// 重启：在 ClawChat.app 里运行时，交给一个独立的脚本去退出应用、重新打包、再打开；
// 用 npm start 跑的，就自己重新起一个服务进程
export function scheduleRestart() {
  const log = fs.openSync(path.join(process.env.HOME || '', '.clawchat', 'update.log'), 'a');
  if (process.env.CLAWCHAT_APP === '1') {
    spawn('bash', [path.join(ROOT, 'scripts', 'restart-app.sh')], { cwd: ROOT, detached: true, stdio: ['ignore', log, log] }).unref();
  } else {
    spawn('sh', ['-c', `sleep 1; exec "${process.execPath}" server.js`], { cwd: ROOT, detached: true, stdio: ['ignore', log, log] }).unref();
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300);
  }
}
