import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

// 父进程退出后 Unix 会把子进程交给系统，单查父子关系已经找不回来了。
// 每轮的随机标记随环境继承，独立进程组也能找回；不按程序名或项目目录杀进程。
export function processGuard({ platform = process.platform, exec = execFile, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const id = crypto.randomUUID();
  const since = now();
  const known = new Map();
  let child;
  let attachedAt;
  let endedAt;
  let killing;
  const invoke = (cmd, args) => new Promise((resolve) => {
    try {
      exec(cmd, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 64 << 20, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } }, (err, out) => resolve({ ok: !err, out: out || '' }));
    } catch { resolve({ ok: false, out: '' }); }
  });
  const snapshot = async () => {
    if (platform === 'win32') {
      // Windows 保留已退出父进程的编号；同时核对创建时间，避免杀到后来复用编号的程序。
      const { ok, out } = await invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process | ForEach-Object { @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; started = $_.CreationDate.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress"]);
      if (!ok) return null;
      try {
        const rows = JSON.parse(out);
        return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r, time: Date.parse(r.started) }));
      } catch { return null; }
    }
    // 输出只在内存里筛选，绝不记录命令或其他进程的环境（里面可能有密钥）。
    // pgid：引擎进程是独立进程组（detached），它跑的子命令会继承这个组——子命令清空了环境标记也丢不掉组关系。
    const { ok, out } = await invoke('ps', ['eww', '-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart=,command=']);
    if (!ok || !out.trim()) return null;
    const marker = new RegExp(`(?:^|\\s)CLAWCHAT_RUN_ID=${id}(?:\\s|$)`);
    const rows = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.*)$/);
      if (m && !m[4].startsWith('Z')) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), started: m[5], time: Date.parse(m[5]), marked: marker.test(m[6]) });
    }
    return rows;
  };
  const targets = (rows) => {
    const selected = new Set();
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const rootAlive = child?.exitCode === null && !endedAt;
    for (const r of rows) {
      if (r.pid === process.pid) continue;
      if (r.marked || known.get(r.pid)?.started === r.started || (rootAlive && r.pid === child?.pid && r.time >= since - 1000 && r.time <= attachedAt + 1)) selected.add(r.pid);
      // 引擎进程组里的：引擎 detached 出自己的组，组内全是这一轮的（子命令清了环境标记也在组里）。
      // 时间下限防编号复用；组号在组内还有成员时一直存在，父退出后照样能找到。
      if (child?.pid && r.pgid === child.pid && r.time >= since - 1000) selected.add(r.pid);
      // 引擎的直接子进程：父刚退出、系统还没把孤儿改挂到别处的那一小段里，父子关系还能看见。
      if (child?.pid && r.ppid === child.pid && r.time >= since - 1000 && (!endedAt || r.time <= endedAt)) selected.add(r.pid);
    }
    // Windows 的父进程记录不会被改成系统进程，因此父进程先退出也能从它的编号接着找。
    if (platform === 'win32') {
      // 已被杀掉的父节点仍可作为锚点，但其编号已复用时必须停止沿那条链查找。
      for (const [pid] of known) if (!byPid.has(pid)) selected.add(pid);
      const root = byPid.get(child?.pid);
      if (child?.pid && (!root || (root.time >= since - 1000 && root.time <= attachedAt + 1))) selected.add(child.pid);
    }
    let changed;
    do {
      changed = false;
      for (const r of rows) {
        if (r.pid === process.pid || selected.has(r.pid) || !selected.has(r.ppid)) continue;
        if (!Number.isFinite(r.time) || r.time < since - 1000) continue;
        if (r.ppid === child?.pid && endedAt && r.time > endedAt) continue;
        const parent = byPid.get(r.ppid) || known.get(r.ppid);
        if (parent && r.time < parent.time) continue;
        if (!byPid.has(r.ppid) && parent?.until && r.time > parent.until) continue;
        selected.add(r.pid);
        changed = true;
      }
    } while (changed);
    return rows.filter((r) => selected.has(r.pid) && r.pid !== process.pid && Number.isFinite(r.time) && r.time >= since - 1000);
  };
  // 找漏网孤儿：引擎活着期间（since ~ endedAt）出生、引擎死后被系统收养（ppid=1）、自己成了进程组长、
  // 也不带本轮标记——这正是「清了环境标记又 detached」的子进程的特征（普通组员的 pgid 是继承来的，
  // 不会等于自己的编号）。范围收得很窄：只在这几秒的清理窗口里认，避免误伤别的软件同期启动的守护进程。
  const strays = (rows) =>
    endedAt
      ? rows.filter((r) => !r.marked && !known.has(r.pid) && r.ppid === 1 && r.pgid === r.pid && r.time >= since - 1000 && r.time <= endedAt)
      : [];
  const signal = async (rows, force) => {
    for (const r of rows) known.set(r.pid, { started: r.started, time: r.time, until: now() });
    if (platform === 'win32') {
      // 每个编号都已经按创建时间复核；不加 /T，免得 Windows 把重用父编号的无关子树也杀掉。
      for (const r of rows.reverse()) {
        await invoke('taskkill', ['/PID', String(r.pid), '/F']);
        known.get(r.pid).until = now();
      }
    } else {
      for (const r of rows.reverse()) { try { process.kill(r.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {} }
    }
  };
  // 引擎活着的时候记下它的直接子进程（每 2 秒查一次，只查父子关系、不读环境，开销很小）。
  // 这样就算某个子进程既清了环境标记、又 detached 出了进程组，结束引擎后照样找得到它。
  let recorderStopped = false;
  const recordChildren = async () => {
    if (recorderStopped || !child?.pid || child.exitCode !== null || endedAt) return;
    const { ok, out } = await invoke('pgrep', ['-P', String(child.pid)]);
    if (ok && out.trim()) {
      for (const line of out.split('\n')) {
        const pid = Number(line.trim());
        if (!Number.isFinite(pid) || pid <= 1 || known.has(pid)) continue;
        // 补查一次启动时间：known 靠「编号 + 启动时间完全一致」认人，编号被复用的不会认错
        const one = await invoke('ps', ['-p', String(pid), '-o', 'lstart=']);
        if (one.ok && one.out.trim()) known.set(pid, { started: one.out.trim(), time: now(), until: now() });
      }
    }
  };
  const recorderLoop = async () => {
    while (!recorderStopped && child?.pid && child.exitCode === null && !endedAt) {
      await sleep(2000);
      await recordChildren();
    }
  };
  const startRecorder = () => {
    if (platform === 'win32') return; // Windows 按父子树杀（taskkill /T），不用另外记
    recorderLoop().catch(() => {});
  };
  const kill = () => killing ||= (async () => {
    if (!child?.pid) return true;
    let rows = targets((await snapshot()) || []);
    const fallback = !rows.length && child.exitCode === null && !endedAt;
    if (fallback) {
      // 系统查询失败也要至少停掉本体；正常情况下下面会收掉整棵树。
      if (platform === 'win32') await invoke('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
    }
    await signal(rows, false);
    // 本轮要清的目标 = 认得出来的（标记、组、父子链、recordChildren 记下的）+ 漏网孤儿
    const pick = (rows) => { const seen = new Set(); const out = []; for (const r of [...targets(rows), ...strays(rows)]) if (!seen.has(r.pid)) { seen.add(r.pid); out.push(r); } return out; };
    const deadline = now() + 3000;
    while ((rows.length || (fallback && child.exitCode === null && !endedAt)) && now() < deadline) {
      await sleep(100);
      const current = await snapshot();
      if (!current) continue;
      rows = pick(current);
      // 新出生的先停止（SIGTERM），漏网孤儿直接强杀：它连标记都不带，体面退出的指望也没有
      await signal(rows.filter((r) => !known.has(r.pid)), false);
    }
    if (rows.length) await signal(rows, true);
    if (fallback && child.exitCode === null && !endedAt) {
      if (platform === 'win32') await invoke('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }
    // taskkill 返回成功也不代表整棵树都退出；回退代码前必须拿到一次可信的空快照。
    const confirmBy = now() + 1000;
    do {
      const current = await snapshot();
      if (!current) return false;
      const rest = pick(current);
      if (!rest.length && (child.exitCode !== null || endedAt)) return true;
      if (rest.length) await signal(rest.filter((r) => !known.has(r.pid)), true);
      await sleep(100);
    } while (now() < confirmBy);
    return false;
  })().then((ok) => {
    recorderStopped = true;
    if (!ok) console.error('[clawchat] 这一轮的子进程没能确认全部结束，可能还有残留'); // 返回 false 的调用方会拦住重开（比如登录），日志里也留个痕
    return ok;
  }).catch((err) => { recorderStopped = true; console.error('[clawchat] 清理本轮子进程失败', err.message); return false; });
  return {
    env: { CLAWCHAT_RUN_ID: id },
    attach(proc) {
      child = proc;
      attachedAt = now();
      startRecorder();
      // close 可能还在等孤儿进程持有的输出管道；必须在 exit 时就开始清理。
      child.once('exit', (code, sig) => { endedAt = now(); recorderStopped = true; if (code !== 0 || sig) kill(); });
    },
    kill,
  };
}
