// 假 Codex 的跨平台入口，测试绝不调用机器上已登录的真实程序。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const send = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
if (args[0] === '--version') console.log('codex-cli 0.0.0-fake');
else if (args[0] === 'login') {
  if (process.env.FAKE_CODEX_LOGGED_OUT) { console.error('Not logged in'); process.exitCode = 1; }
  else console.log('Logged in using ChatGPT (fake)');
} else if (args[0] === 'app-server') await import('./codex-app-server.mjs');
else if (args[0] === 'exec') {
  fs.readFileSync(0, 'utf8'); // exec 只收一次输入；分身继续测这条旧路径。
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
