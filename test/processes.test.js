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
  // 引擎进程：spawn 一个清空环境的子进程（不 detached，和引擎跑命令一样继承进程组）。活 1.5 秒，让清点至少跑过一拍
  const src = `const{spawn}=require('node:child_process');const fs=require('node:fs');
    const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',env:{}});
    fs.writeFileSync('${root}/group.pid',String(c.pid));setTimeout(()=>process.exit(1),1500);`;
  const parent = spawn(process.execPath, ['-e', src], { detached: true, env: { PATH: process.env.PATH, ...guard.env }, stdio: 'ignore' });
  guard.attach(parent);
  await once(parent, 'close');
  const pid = Number(fs.readFileSync(path.join(root, 'group.pid'), 'utf8'));
  try {
    assert.equal(await guard.kill(), true, '清理要确认成功');
    assert.equal(alive(pid), false, '清了环境标记的组员也要被结束');
  } finally { try { process.kill(pid, 'SIGKILL'); } catch {} }
});

test('清理：引擎活得太短、没清点过子进程就退出了，脱组的孤儿找不到——要如实报告失败，不能谎报成功', { skip: process.platform === 'win32' }, async () => {
  const guard = processGuard();
  // 100 毫秒就退出：清点（300 毫秒一拍）一次都没跑过。这种树里有没有「清了标记又脱离组」的孤儿无从知道
  const src = `const{spawn}=require('node:child_process');const fs=require('node:fs');
    const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{}});
    c.unref();fs.writeFileSync('${root}/stray.pid',String(c.pid));setTimeout(()=>process.exit(1),100);`;
  const parent = spawn(process.execPath, ['-e', src], { detached: true, env: { PATH: process.env.PATH, ...guard.env }, stdio: 'ignore' });
  guard.attach(parent);
  await once(parent, 'close');
  const pid = Number(fs.readFileSync(path.join(root, 'stray.pid'), 'utf8'));
  try {
    assert.equal(await guard.kill(), false, '确认不了就报失败，不谎报清理干净');
  } finally { try { process.kill(pid, 'SIGKILL'); } catch {} }
});

test('清理：同一时间窗里别人起的 detached 孤儿不能被误杀', { skip: process.platform === 'win32' }, async () => {
  // 引擎活着，另一棵进程树同期 spawn 一个 detached 孤儿（父马上退出、被系统收养、自成组）：
  // 它不带标记、ppid=1、自成组，跟漏网孤儿长得一样，但不是这一轮的——绝不能杀
  const otherSrc = `const{spawn}=require('node:child_process');const fs=require('node:fs');
    const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    c.unref();fs.writeFileSync('${root}/unrelated-orphan.pid',String(c.pid));process.exit(0);`;
  const otherParent = spawn(process.execPath, ['-e', otherSrc], { detached: true, stdio: 'ignore' });
  otherParent.unref();
  await new Promise((r) => setTimeout(r, 400)); // 等孤儿落地、被收养
  const guard = processGuard();
  const parent = spawn(process.execPath, ['-e', 'setTimeout(()=>{},2500)'], { detached: true, env: { PATH: process.env.PATH, ...guard.env }, stdio: 'ignore' });
  guard.attach(parent);
  await new Promise((r) => setTimeout(r, 1200)); // 让清点至少跑过几拍
  try {
    assert.equal(await guard.kill(), true, '本轮没有子进程，清理确认成功');
    const orphan = Number(fs.readFileSync(path.join(root, 'unrelated-orphan.pid'), 'utf8'));
    assert.equal(alive(orphan), true, '同窗的无关孤儿不能被误杀');
    try { process.kill(orphan, 'SIGKILL'); } catch {}
  } finally { try { process.kill(parent.pid, 'SIGKILL'); } catch {} }
});

test('清理：本轮之前就在跑的无关 detached 进程不能被误杀', { skip: process.platform === 'win32' }, async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  unrelated.unref();
  await new Promise((r) => setTimeout(r, 300));
  const guard = processGuard();
  const parent = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(1),1500)'], { detached: true, env: { PATH: process.env.PATH, ...guard.env }, stdio: 'ignore' });
  guard.attach(parent);
  await once(parent, 'close');
  try {
    await guard.kill();
    assert.equal(alive(unrelated.pid), true, '本轮之前就在跑的无关进程不能被误杀');
  } finally { try { process.kill(unrelated.pid, 'SIGKILL'); } catch {} }
});
