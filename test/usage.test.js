import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'clawchat-usage-'));
process.env.CLAWCHAT_HOME = HOME;
const { getUsage, recordClaudeRateLimit, recordCodexRateLimits, recordGrokBilling, recordAgyUsage, seedCodexUsage, onUsageChange, _resetUsage } = await import('../lib/usage.js');
const sec = (h) => Math.floor(Date.now() / 1000) + h * 3600;

test('Claude 的额度：分窗口的按窗口存，小数换成百分数，秒换成毫秒；只报一个窗口时其余沿用上次', () => {
  _resetUsage();
  let seen = null;
  onUsageChange((u) => (seen = u));
  recordClaudeRateLimit({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: sec(2) }, seven_day: { utilization: 0.7, resetsAt: sec(48) } } });
  let c = getUsage().claude;
  assert.deepEqual(c.windows.map((w) => [w.key, w.usedPercent]), [['five_hour', 42], ['seven_day', 70]]);
  assert.ok(c.windows[0].resetsAt > Date.now(), '毫秒时间戳');
  assert.ok(seen?.claude, '变了会通知');
  recordClaudeRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9, resetsAt: sec(1) });
  c = getUsage().claude;
  assert.deepEqual(c.windows.map((w) => [w.key, w.usedPercent]), [['five_hour', 90], ['seven_day', 70]]);
  assert.equal(c.status, 'allowed_warning');
  // Claude 的 utilization 永远是比例：1.2 是超额用到 120%
  recordClaudeRateLimit({ unifiedWindows: { five_hour: { utilization: 1.2, resetsAt: sec(1) } } });
  assert.equal(getUsage().claude.windows.find((w) => w.key === 'five_hour').usedPercent, 120);
  recordClaudeRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9, resetsAt: sec(1) });
  // 存到了文件里，重启后还在
  _resetUsage();
  assert.equal(getUsage().claude.windows.length, 2);
});

test('Codex 的额度：按窗口长度取名，蛇形和驼峰写法都认，套餐和额外点数一起存；过了重置时间的归零', () => {
  _resetUsage();
  recordCodexRateLimits({ primary: { used_percent: 30, window_minutes: 300, resets_at: sec(3) }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: sec(-1) }, credits: { has_credits: true, unlimited: false, balance: '12.5' }, plan_type: 'pro' });
  const g = getUsage().codex;
  assert.deepEqual(g.windows.map((w) => [w.key, w.usedPercent]), [['five_hour', 30], ['seven_day', 0]]);
  assert.equal(g.plan, 'pro');
  assert.deepEqual(g.credits, { hasCredits: true, unlimited: false, balance: '12.5' });
  assert.equal(recordCodexRateLimits(null), null);
  // Codex 的 used_percent 永远是百分数：1 就是 1%，不是 100%
  recordCodexRateLimits({ primary: { used_percent: 1, window_minutes: 300, resets_at: sec(3) } });
  assert.equal(getUsage().codex.windows.find((w) => w.key === 'five_hour').usedPercent, 1);
  assert.equal(recordCodexRateLimits({}), null);
});

test('启动时从最近的 Codex 会话文件里读一次余量', () => {
  _resetUsage();
  fs.rmSync(path.join(HOME, 'usage.json'), { force: true });
  const codex = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const dir = path.join(codex, 'sessions', '2026', '11', '01');
  fs.mkdirSync(dir, { recursive: true });
  const line = (pct) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: pct, window_minutes: 10080, resets_at: sec(24) }, plan_type: 'pro' } } });
  fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), [line(10), '{"type":"other"}', line(55), '{"type":"other"}'].join('\n') + '\n');
  seedCodexUsage(codex);
  assert.equal(getUsage().codex.windows[0].usedPercent, 55, '取最后一次');
  assert.equal(seedCodexUsage(path.join(codex, '没有')), null, '目录不存在也不出错');
});

test('Grok 的账单用量：识别周期、百分数、套餐与预付余额，替换旧窗口', () => {
  _resetUsage();
  const futureIso = new Date(Date.now() + 3 * 86400000).toISOString();
  const got = recordGrokBilling({
    config: {
      creditUsagePercent: 16,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: futureIso },
      prepaidBalance: { val: 0 },
    },
    subscription_tier: 'SuperGrok',
  });
  assert.equal(got.plan, 'SuperGrok');
  assert.deepEqual(got.windows.map((w) => [w.key, w.usedPercent]), [['seven_day', 16]]);
  assert.ok(got.windows[0].resetsAt > Date.now());
  assert.equal(got.credits, undefined, '预付余额为 0 时不额外显示 credits');
  // 换到月周期、且有预付余额时：替换旧窗口而不保留残留
  const got2 = recordGrokBilling({
    config: {
      creditUsagePercent: 45.5,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: futureIso },
      prepaidBalance: { val: 500 },
    },
    subscription_tier: 'SuperGrok',
  });
  assert.deepEqual(got2.windows.map((w) => [w.key, w.usedPercent]), [['monthly', 45.5]]);
  assert.deepEqual(got2.credits, { hasCredits: true, unlimited: false, balance: null });
  assert.equal(recordGrokBilling(null), null);
  assert.equal(recordGrokBilling({ config: {} }), null);
});

test('Gemini (agy /usage) 的额度：解析三组窗口，remaining_fraction 转成已用百分比', () => {
  _resetUsage();
  const futureIso = new Date(Date.now() + 2 * 3600000).toISOString();
  const got = recordAgyUsage({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.892, reset_time: futureIso },
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.7824, reset_time: futureIso },
            ],
          },
          {
            name: 'Claude and GPT models',
            buckets: [
              { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: futureIso },
              { id: '3p-5h', window: '5h', remaining_fraction: 0.5, reset_time: futureIso },
            ],
          },
          {
            name: 'Gemini 4 Argon',
            buckets: [
              { id: 'gemini-argon-wtu-weekly', window: 'weekly', remaining_fraction: 0, reset_time: futureIso },
            ],
          },
        ],
      },
    },
  });
  assert.deepEqual(
    got.windows.map((w) => [w.key, w.usedPercent]),
    [['seven_day', 10.8], ['five_hour', 21.8], ['seven_day_3p', 0], ['five_hour_3p', 50], ['seven_day_argon', 100]],
  );
  assert.ok(got.windows[0].resetsAt > Date.now());
  assert.equal(recordAgyUsage({ status: 'ERROR' }), null);
  assert.equal(recordAgyUsage(null), null);
});
