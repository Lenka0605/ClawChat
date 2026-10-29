import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 别读到老板本机真的 config.json
process.env.CLAWCHAT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-providers-'));
process.env.GLM_API_KEY = 'test-glm-key';
const { saveConfig } = await import('../lib/store.js');
const { PROVIDERS, providerKey, providerEnv, providerModel, providerModelArg, providerModels } = await import('../lib/providers.js');

const ds = PROVIDERS.deepseek;
const glm = PROVIDERS.glm;

test('DeepSeek 走 DeepSeek 的 Anthropic 兼容接口，配置目录单独放', () => {
  saveConfig({ deepseekKey: 'test-ds-key' });
  const env = providerEnv(ds, 'deepseek-flash');
  assert.equal(env.ANTHROPIC_BASE_URL, `${ds.api}/anthropic`);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'test-ds-key');
  assert.equal(env.ANTHROPIC_API_KEY, undefined); // 别把 Anthropic 的 Key 一起发出去
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.ok(env.CLAUDE_CONFIG_DIR.endsWith('deepseek/claude-home'));
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-flash');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-flash');
});

test('GLM 走智谱的 Anthropic 兼容接口，和 DeepSeek 是同一套接法', () => {
  const env = providerEnv(glm, 'glm-5.3');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://open.bigmodel.cn/api/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'test-glm-key'); // 环境变量也能给 Key
  assert.ok(env.CLAUDE_CONFIG_DIR.endsWith('glm/claude-home'));
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.3');
  // 两家的配置目录不能是同一个，会话和凭据要分开
  assert.notEqual(providerEnv(ds, 'deepseek-flash').CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR);
});

test('Key 先看设置里填的，再看环境变量', () => {
  saveConfig({ glmKey: 'from-config' });
  assert.equal(providerKey(glm), 'from-config');
  saveConfig({ glmKey: '' });
  assert.equal(providerKey(glm), 'test-glm-key');
  delete process.env.GLM_API_KEY;
  assert.equal(providerKey(glm), '');
});

test('1M 上下文的模型要加 [1m]，小窗口的不加', () => {
  assert.equal(providerModelArg(ds, 'deepseek-flash'), 'deepseek-flash[1m]');
  assert.equal(providerModelArg(ds, 'deepseek-v4-pro'), 'deepseek-v4-pro[1m]');
  assert.equal(providerModelArg(glm, 'glm-5.3'), 'glm-5.3');
  // 1M 的模型才设自动压缩阈值
  assert.equal(providerEnv(ds, 'deepseek-flash').CLAUDE_CODE_AUTO_COMPACT_WINDOW, '786432');
  assert.equal(providerEnv(glm, 'glm-5.3').CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
});

test('模型目录：在线读不到时用内置清单', () => {
  assert.deepEqual(providerModels(ds).map((m) => m.id), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual(providerModels(glm).map((m) => m.id), ['glm-5.3', 'glm-5.2']);
  assert.equal(providerModel(glm, 'glm-5.3').name, 'GLM-5.3');
  assert.equal(providerModel(glm, '不存在的模型'), null);
});
