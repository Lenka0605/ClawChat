import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentEnv } from '../lib/agent-env.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-agent-security-'));
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
process.env.CLAWCHAT_HOME = path.join(root, 'data');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
process.env.CODEX_HOME = path.join(root, 'codex');
process.env.GEMINI_CLI_HOME = path.join(root, 'gemini');
process.env.GROK_HOME = path.join(root, 'grok');
fs.mkdirSync(process.env.GROK_HOME);
fs.writeFileSync(path.join(process.env.GROK_HOME, 'auth.json'), JSON.stringify({
  'https://auth.x.ai::fake': { key: 'fake-oauth', auth_mode: 'oidc' },
}));
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
process.env.FAKE_SECS = process.env.FAKE_CODEX_SECS = '0.01';
const secretKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'DEEPSEEK_API_KEY', 'GLM_API_KEY', 'CLAWCHAT_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'CURSOR_API_KEY', 'UNKNOWN_COMPANY_TOKEN'];
for (const key of secretKeys) process.env[key] = `fake-${key}`;
process.env.CLAWCHAT_API_BASE = 'https://fake.invalid/v1';
const log = path.join(root, 'capture.jsonl');
for (const file of ['codex-cli.mjs', 'codex-app-server.mjs']) {
  fs.copyFileSync(new URL(`../scripts/fake/${file}`, import.meta.url), path.join(bin, file));
}
for (const name of ['claude', 'codex', 'grok', 'cursor-agent', 'gemini', 'agy']) {
  const capture = `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({name:${JSON.stringify(name)}, args:process.argv.slice(2), env:Object.fromEntries(${JSON.stringify(secretKeys)}.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))})+'\\n');`;
  const body = name === 'claude'
    ? `process.stdin.once('data',()=>{console.log(JSON.stringify({type:'result',subtype:'success',result:'假的完成',session_id:'fake-session'}));process.stdin.resume();});`
    : name === 'codex' ? `await import('./codex-cli.mjs');`
      : fs.readFileSync(new URL(`../scripts/fake/${name}`, import.meta.url), 'utf8').replace(/^#!.*\n/, '').replace("import fs from 'node:fs';", '');
  fs.writeFileSync(path.join(bin, `${name}.mjs`), `${capture}\n${body}`);
  fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(path.join(bin, `${name}.mjs`)).href)};\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${name}.mjs" %*\r\n`);
}
const { runAgent, claudeArgs, loginEngine, probeModel } = await import('../lib/agents.js');
const { ensureApiBridge } = await import('../lib/providers.js');
const { stopApiBridge } = await import('../lib/api-bridge.js');
const { grokEnv } = await import('../lib/grok.js');
const { cursorEnv } = await import('../lib/cursor.js');
const { agyState } = await import('../lib/antigravity.js');
const { saveConfig } = await import('../lib/store.js');
after(() => { stopApiBridge(); fs.rmSync(root, { recursive: true, force: true }); });
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
const own = { claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  gpt: ['OPENAI_API_KEY', 'CODEX_API_KEY'], gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], cursor: ['CURSOR_API_KEY'] };
function checkEnv(agent, env) {
  for (const key of secretKeys) {
    if ((own[agent] || []).includes(key)) assert.equal(env[key], `fake-${key}`, `${agent} 保留自己的 ${key}`);
    else assert.notEqual(env[key], `fake-${key}`, `${agent} 不得收到 ${key}`);
  }
}

test('AI 环境：未知凭据、注入入口和别家的令牌默认不继承，保留跨平台运行环境', () => {
  const source = { Path: '/bin', SystemRoot: 'C:\\Windows', HOME: '/home/test', NODE_OPTIONS: '--require bad',
    CLAWCHAT_API_KEY: 'fake', UNKNOWN_COMPANY_TOKEN: 'fake', FAKE_UNKNOWN_KEY: 'fake', CLAUDE_CODE_OAUTH_TOKEN: 'fake' };
  for (const engine of ['claude', 'codex', 'gemini', 'agy', 'grok', 'cursor', 'deepseek', 'glm', 'api']) {
    const env = agentEnv(engine, source);
    assert.equal(env.Path, '/bin');
    assert.equal(env.SystemRoot, 'C:\\Windows');
    for (const key of ['NODE_OPTIONS', 'CLAWCHAT_API_KEY', 'UNKNOWN_COMPANY_TOKEN', 'FAKE_UNKNOWN_KEY']) assert.equal(env[key], undefined);
    if (engine !== 'claude') assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  }
  checkEnv('grok', grokEnv(path.join(root, 'isolated-grok')));
  checkEnv('cursor', cursorEnv(path.join(root, 'isolated-cursor')));
});

test('Claude 只读和分身：硬工具白名单、配置隔离、禁用 hooks 和 MCP，续会话目录不变', () => {
  for (const [permission, side] of [['readonly', false], ['full', true], ['project', true]]) {
    const args = claudeArgs({ permission }, 'original-session', '群规', null, side, 'fake-model');
    const value = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(value('--tools'), 'Read,Grep,Glob,WebSearch,WebFetch');
    assert.equal(value('--setting-sources'), '');
    assert.ok(args.includes('--restricted'));
    assert.ok(args.includes('--disable-slash-commands'));
    assert.equal(value('--disallowedTools'), 'mcp__*');
    assert.deepEqual(JSON.parse(value('--mcp-config')), { mcpServers: {} });
    assert.equal(JSON.parse(value('--settings')).disableAllHooks, true);
    assert.equal(value('--resume'), 'original-session');
    assert.equal(args.includes('--no-session-persistence'), side);
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  }
  assert.ok(claudeArgs({ permission: 'full' }, null, '', null, false, 'fake').includes('--dangerously-skip-permissions'));
});

test('Claude 项目内：不继承旧写权限，附件和完整历史保留读取但不能变成额外写目录', { skip: process.platform === 'win32' }, () => {
  const uploads = path.join(root, 'room', 'uploads');
  const transcripts = path.join(root, 'room', 'transcripts');
  for (const dir of [uploads, transcripts]) fs.mkdirSync(dir, { recursive: true });
  const args = claudeArgs({ cwd: root, permission: 'project' }, 'kept-session', '原群规', uploads, false, 'fake-model');
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.ok(args.includes('--restricted'));
  assert.equal(value('--setting-sources'), '');
  assert.equal(value('--permission-mode'), 'acceptEdits');
  assert.equal(value('--resume'), 'kept-session');
  assert.match(value('--append-system-prompt'), /原群规/);
  assert.match(value('--append-system-prompt'), /AGENTS\.md/);
  assert.match(value('--append-system-prompt'), /MEMORY\.md/);
  assert.ok(value('--tools').split(',').includes('Bash'));
  assert.ok(value('--tools').split(',').includes('Write'));
  assert.ok(!value('--tools').split(',').includes('Agent'));
  assert.equal(value('--disallowedTools'), 'mcp__*');
  assert.deepEqual(JSON.parse(value('--mcp-config')), { mcpServers: {} });
  assert.ok(args.includes('--disable-slash-commands'));
  const settings = JSON.parse(value('--settings'));
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox.excludedCommands, []);
  assert.ok(settings.sandbox.network.allowedDomains.includes('registry.npmjs.org'));
  for (const dir of [uploads, transcripts]) {
    assert.ok(args.some((s, i) => s === '--add-dir' && args[i + 1] === dir));
    for (const canonical of [path.resolve(dir), fs.realpathSync(dir)]) {
      assert.ok(settings.sandbox.filesystem.denyWrite.includes(canonical));
      for (const tool of ['Write', 'Edit', 'NotebookEdit']) assert.ok(settings.permissions.deny.includes(`${tool}(/${canonical}/**)`));
    }
  }
});

test('AI 环境：经过真实启动入口，八位成员和订阅 Gemini 均收不到别家的假凭据', async () => {
  await ensureApiBridge();
  for (const agent of ['claude', 'deepseek', 'glm', 'api', 'gpt', 'grok', 'cursor', 'gemini']) {
    const result = await runAgent(agent, { room: { id: 'fake-security', cwd: root, permission: 'readonly', models: {} }, prompt: '假测试', systemPrompt: '假群规', onStep() {} }).done;
    assert.ok(result.ok, `${agent}: ${result.error}`);
    checkEnv(agent, calls().at(-1).env);
  }
  // 订阅入口不可继承 Google API Key，避免误走付费 API。
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  saveConfig({ geminiKey: '' });
  agyState.version = '1.4.10';
  const result = await runAgent('gemini', { room: { cwd: root, permission: 'readonly', models: {} }, prompt: '假测试' }).done;
  assert.ok(result.ok, result.error);
  assert.equal(calls().at(-1).name, 'agy');
  checkEnv('agy', calls().at(-1).env);
});

test('AI 环境：登录和模型探测也不重新继承整份环境', async () => {
  // 假登录脚本快速打印网址退出；不能调用真实的账号登录。
  fs.writeFileSync(path.join(bin, 'cursor-agent.mjs'), `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({env:Object.fromEntries(${JSON.stringify(secretKeys)}.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))})+'\\n');console.log('https://cursor.com/login/fake');`);
  assert.equal((await loginEngine('cursor')).ok, true);
  checkEnv('cursor', calls().at(-1).env);
  const result = await probeModel('deepseek', 'fake-model');
  assert.ok(result.ok, result.error);
  checkEnv('deepseek', calls().at(-1).env);
});
