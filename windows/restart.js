import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { tr } from '../lib/i18n.js';

// 启动器和测试共用的重启流程。git 的工作目录始终是程序目录，不是聊天里的项目目录。
export async function restartServer({ root, dataDir, alive, isStopped = async () => !(await alive()), startServer, showError, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, exitTimeout = 20000, healthTimeout = 90000, git = runGit }) {
  const pendingFile = path.join(dataDir, 'update-prev.json');
  const rollbackFile = path.join(dataDir, 'update-rollback.json');
  const checkGit = (args) => git(root, args);
  const wait = async (want, timeout, attempt) => {
    const end = now() + timeout;
    while (now() < end) {
      if (attempt?.failed) return false;
      if (want ? await alive(Math.min(1500, Math.max(1, end - now()))) : await isStopped()) return true;
      await sleep(Math.min(250, Math.max(1, end - now())));
    }
    return false;
  };
  const report = (reason) => { showError(reason); return { ok: false, error: reason }; };
  const launch = async () => {
    try {
      const attempt = startServer();
      if (await wait(true, healthTimeout, attempt)) return { ok: true, attempt };
      // 覆盖程序文件之前，必须确认失败的新进程已经停下。
      const stopped = await attempt.stop();
      return { ok: false, stopped, error: attempt.error || tr('等待 ClawChat 启动超过了 90 秒') };
    } catch (err) { return { ok: false, stopped: false, error: String(err.message || err) }; }
  };
  if (!(await wait(false, exitTimeout))) return report(tr('旧的 ClawChat 服务还没退出，请稍后再试，或查看 server.log'));
  const next = await launch();
  if (next.ok) {
    try { fs.rmSync(pendingFile, { force: true }); } catch {}
    return { ok: true };
  }
  if (!next.stopped || !(await isStopped())) return report(tr('新服务没能启动，且无法确认它已经退出，未自动覆盖程序文件：{error}', { error: next.error }));
  let prev;
  try { prev = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { return report(next.error); }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(prev.from || '') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(prev.to || '') || prev.from === prev.to) return report(tr('升级回退记录不完整，未自动修改程序文件'));
  const [head, status, commit, ancestry] = await Promise.all([
    checkGit(['rev-parse', 'HEAD']), checkGit(['status', '--porcelain', '--untracked-files=all']),
    checkGit(['cat-file', '-e', `${prev.from}^{commit}`]), checkGit(['merge-base', '--is-ancestor', prev.from, prev.to]),
  ]);
  if (!head.ok || head.out !== prev.to || !status.ok || status.out || !commit.ok || !ancestry.ok) return report(tr('程序目录有改动，或已不是这次升级的版本，未自动回退，请保留日志后处理'));
  const reset = await checkGit(['reset', '--hard', prev.from]);
  if (!reset.ok) return report(tr('自动退回旧版本失败：{error}', { error: reset.err }));
  try {
    const tmp = `${rollbackFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ from: prev.from, to: prev.to, reason: next.error }), { mode: 0o600 });
    fs.renameSync(tmp, rollbackFile);
    fs.rmSync(pendingFile, { force: true });
  } catch (err) {
    // 代码已退回，仍尝试启动；日志留下通知没能保存的原因。
    console.error('[clawchat] 升级回退提示没能保存', err.message);
  }
  const old = await launch();
  if (!old.ok) return report(tr('已经退回旧版本，但仍然无法启动：{error}', { error: old.error }));
  return { ok: true, rolledBack: true };
}

function runGit(root, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, out, stderr) =>
      resolve({ ok: !err, out: (out || '').trim(), err: (stderr || err?.message || '').trim() }));
  });
}
