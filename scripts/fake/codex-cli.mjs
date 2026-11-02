// 假 Codex 的跨平台入口，测试绝不调用机器上已登录的真实程序。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const send = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
// 版本号要不低于联合群文件夹档要求的 0.165.0（lib/joint-discussion.js 的 jointFolderVersionSupported），
// 要测「版本太旧」就设 FAKE_CODEX_VERSION
if (args[0] === '--version') console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION || '0.165.0'}-fake`);
else if (args[0] === 'login') {
  if (process.env.FAKE_CODEX_LOGGED_OUT) { console.error('Not logged in'); process.exitCode = 1; }
  else console.log('Logged in using ChatGPT (fake)');
} else if (args[0] === 'features' && args[1] === 'list') {
  // 联合群讨论档启动前，lib/agents.js 会用 features list 确认这个 Codex 认识全部禁用开关
  // （旧版会悄悄忽略未知 feature）。清单要和 lib/joint-discussion.js 的 JOINT_CODEX_CONFIG 保持同步。
  const feats = ['shell_tool', 'view_image', 'multi_agent', 'apps', 'plugins', 'remote_plugin', 'memories',
    'hooks', 'goals', 'browser_use', 'browser_use_external', 'computer_use', 'code_mode', 'code_mode_host',
    'code_mode_only', 'request_permissions_tool', 'skill_search',
    // 文件夹档另外要求的：受管网络代理
    'network_proxy'];
  const missing = new Set((process.env.FAKE_CODEX_MISSING_FEATURES || '').split(',').filter(Boolean));
  for (const f of feats.filter((f) => !missing.has(f))) console.log(`${f}  enabled`);
}
else if (args[0] === 'app-server') {
  if (process.env.FAKE_CODEX_RPC_SCENARIO === 'old-cli') { console.error("error: unrecognized subcommand 'app-server'"); process.exitCode = 2; }
  else if (args.includes('--help')) console.log('codex app-server: 后台协议服务（假的）');
  else await import('./codex-app-server.mjs');
}
else if (args[0] === 'exec') {
  fs.readFileSync(0, 'utf8'); // exec 保留给旧协议兼容测试，本体和分身都走 app-server。
  const at = args.indexOf('resume');
  const sid = at >= 0 ? args[at + 1] : `fake-codex-${crypto.randomUUID()}`;
  const file = path.join(process.env.CLAWCHAT_HOME || '/tmp', 'fake-replies', 'codex.txt');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '（假的 ChatGPT）做完了';
  fs.rmSync(file, { force: true });
  send({ type: 'thread.started', thread_id: sid });
  send({ type: 'item.started', item: { type: 'command_execution', command: 'echo 假的 ChatGPT 在干活' } });
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CODEX_SECS || process.env.FAKE_SECS || 6) * 1000));
  send({ type: 'item.completed', item: { type: 'agent_message', text } });
  send({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
} else { console.error('假 Codex：不支持这个命令'); process.exitCode = 1; }
