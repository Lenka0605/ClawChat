import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processGuard } from '../lib/processes.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-process-guard-'));
const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };

// 引擎进程会 detached 出自己的进程组；它跑的子命令要么继承这个组，要么清了环境自己脱离。
// 清掉环境标记的（env -i、脚本里 unset）曾经三种锚点全丢：标记没了、父子链断了、组也换了，
// 清理却照样报成功。这里验证两条修复路径：同组的靠进程组找回，脱离组的靠孤儿识别找回。
test('清理：子命令清空了环境标记，但还在引擎的进程组里——照样能找到并结束', { skip: process.platform === 'win32' }, async () => {
  const guard = processGuard();
  // 引擎进程：spawn 一个清空环境的子进程（不 detached，和引擎跑命令一样继承进程组），然后退出
  const src = `const{spawn}=require('node:child_process');const fs=require('node:fs');
    const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',env:{}});
    fs.writeFileSync('${root}/group.pid',String(c.pid));setTimeout(()=>process.exit(1),100);`;
  const parent = spawn(process.execPath, ['-e', src], { detached: true, env: { PATH: process.env.PATH, ...guard.env }, stdio: 'ignore' });
  guard.attach(parent);
  await once(parent, 'close');
  const pid = Number(fs.readFileSync(path.join(root, 'group.pid'), 'utf8'));
  try {
    assert.equal(await guard.kill(), true, '清理要确认成功');
    assert.equal(alive(pid), false, '清了环境标记的组员也要被结束');
  } finally { try { process.kill(pid, 'SIGKILL'); } catch {} }
});

test('清理：子进程清了环境标记还 detached 出了进程组——靠孤儿识别找回，不能漏杀也不能谎报成功', { skip: process.platform === 'win32' }, async () => {
  const guard = processGuard();
  const src = `const{spawn}=require('node:child_process');const fs=require('node:fs');
    const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{}});
    c.unref();fs.writeFileSync('${root}/stray.pid',String(c.pid));setTimeout(()=>process.exit(1),100);`;
  const parent = spawn(process.execPath, ['-e', src], { detached: true, env: { PATH: process.env.PATH, ...guard.env }, stdio: 'ignore' });
  guard.attach(parent);
  await once(parent, 'close');
  const pid = Number(fs.readFileSync(path.join(root, 'stray.pid'), 'utf8'));
  try {
    assert.equal(await guard.kill(), true, '孤儿能被识别并结束，清理确认成功');
    assert.equal(alive(pid), false, '脱离了进程组的漏网孤儿也要被结束');
  } finally { try { process.kill(pid, 'SIGKILL'); } catch {} }
});

test('清理：别把别人家的守护进程当成漏网孤儿', { skip: process.platform === 'win32' }, async () => {
  // 引擎结束之前就存在的、和本轮无关的 detached 进程（ppid=1、自成组），不在清理窗口内出生，不能误杀
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  unrelated.unref();
  await new Promise((r) => setTimeout(r, 300));
  const guard = processGuard();
  const src = `setTimeout(()=>process.exit(1),100);`;
  const parent = spawn(process.execPath, ['-e', src], { detached: true, env: { PATH: process.env.PATH, ...guard.env }, stdio: 'ignore' });
  guard.attach(parent);
  await once(parent, 'close');
  try {
    await guard.kill();
    assert.equal(alive(unrelated.pid), true, '本轮之前就在跑的无关进程不能被误杀');
  } finally { try { process.kill(unrelated.pid, 'SIGKILL'); } catch {} }
});
