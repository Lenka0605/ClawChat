import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR } from './store.js';

// 订阅额度还剩多少（Claude、ChatGPT 这种按账号订阅的；DeepSeek、GLM 按 API 计费，不管）。
// 数据都是官方工具自己带出来的，不另外去问：
// - Claude Code 干活时会推一条 rate_limit_event（5 小时、本周、本周 Opus 各用了多少、什么时候重置）
// - Codex 每一轮的 token_count 里带着 rate_limits（5 小时、本周；还有套餐和额外点数余额），app-server 也能随时读
// 所以显示的是「最近一次跑的时候」的数，存在 ~/.clawchat/usage.json，重启后还在。
//
// 存的样子：{ claude: { windows: [{ key, usedPercent, resetsAt, windowMinutes }], plan, credits, status, updatedAt }, codex: {…} }
//   key：five_hour | seven_day | seven_day_opus | seven_day_sonnet | …（认不出来的按窗口长度取名）
//   usedPercent：0–100；resetsAt：毫秒时间戳（没有就是 null）

const FILE = () => path.join(DATA_DIR, 'usage.json');
let cache = null;
const listeners = new Set();

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE(), 'utf8')) || {};
  } catch {
    cache = {};
  }
  return cache;
}

export function getUsage() {
  return load();
}

export function onUsageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 时间戳统一成毫秒：有的给秒、有的给毫秒、有的给 ISO 字符串
function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
}

// 用了百分之多少（0–100，超额的可以超过 100）。两家的单位是固定的，不能靠大小猜（ChatGPT 核实过）：
// Claude Code 的 utilization 永远是比例（0.42 = 42%，1.2 = 120%）；Codex 的 used_percent 永远是百分数（1 = 1%）
function toPercent(v, ratio) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round((ratio ? n * 100 : n) * 10) / 10;
}

const keyOfMinutes = (m) => (m === 300 ? 'five_hour' : m === 10080 ? 'seven_day' : m ? `${m}m` : 'other');

function save(engine, entry) {
  const all = load();
  const prev = all[engine] || {};
  // 这次只带了一部分窗口（比如 Claude 有时只报触发的那一个）：其余窗口沿用上次的
  const windows = new Map((prev.windows || []).map((w) => [w.key, w]));
  for (const w of entry.windows || []) windows.set(w.key, w);
  const next = { ...prev, ...entry, windows: [...windows.values()], updatedAt: Date.now() };
  // 已经过了重置时间的窗口：用量归零（不然会一直显示「已用 100%」）
  for (const w of next.windows) if (w.resetsAt && w.resetsAt < Date.now()) Object.assign(w, { usedPercent: 0, resetsAt: null, stale: true });
  all[engine] = next;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(all, null, 2));
  } catch (err) {
    console.error('[clawchat] 用量写不进去', err.message);
  }
  for (const fn of listeners) {
    try {
      fn(all);
    } catch {}
  }
  return next;
}

// Claude Code 的 rate_limit_event.rate_limit_info：{ status, rateLimitType, utilization, resetsAt, unifiedWindows: { five_hour: { utilization, resetsAt, status }, … } }
export function recordClaudeRateLimit(info) {
  if (!info || typeof info !== 'object') return null;
  const windows = [];
  for (const [key, w] of Object.entries(info.unifiedWindows || {})) {
    const usedPercent = toPercent(w?.utilization, true);
    if (usedPercent === null) continue;
    windows.push({ key, usedPercent, resetsAt: toMs(w.resetsAt), status: w.status || null });
  }
  // 没有分窗口的老格式：只有触发的那一个
  if (!windows.length && info.rateLimitType && toPercent(info.utilization, true) !== null) {
    windows.push({ key: info.rateLimitType, usedPercent: toPercent(info.utilization, true), resetsAt: toMs(info.resetsAt), status: info.status || null });
  }
  if (!windows.length && !info.status) return null;
  return save('claude', { windows, status: info.status || null });
}

// Codex 的 rate_limits（token_count 事件、app-server 的 account/rateLimits/*）：
// { primary: { used_percent, window_minutes, resets_at }, secondary: {…}, credits: { has_credits, unlimited, balance }, plan_type }
// app-server 用的是驼峰写法（usedPercent、windowDurationMins、resetsAt），两种都认
export function recordCodexRateLimits(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const windows = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (!w) continue;
    const minutes = Number(w.window_minutes ?? w.windowDurationMins ?? w.windowMinutes) || null;
    const usedPercent = toPercent(w.used_percent ?? w.usedPercent, false);
    if (usedPercent === null) continue;
    windows.push({ key: keyOfMinutes(minutes), usedPercent, resetsAt: toMs(w.resets_at ?? w.resetsAt), windowMinutes: minutes });
  }
  const c = rl.credits;
  const credits = c ? { hasCredits: !!(c.has_credits ?? c.hasCredits), unlimited: !!c.unlimited, balance: c.balance ?? null } : undefined;
  const plan = rl.plan_type ?? rl.planType;
  if (!windows.length && !credits) return null;
  return save('codex', { windows, ...(credits ? { credits } : {}), ...(plan ? { plan } : {}) });
}

// 启动时：从最近的 Codex 会话文件里找最后一次的 rate_limits，先有个数（不用等 ChatGPT 跑一轮）。只读，不碰会话
export function seedCodexUsage(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  try {
    const latest = (dir, depth) => {
      // sessions/年/月/日/xxx.jsonl：每层取名字最大的那个（就是最新的）
      const names = fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort().reverse();
      if (!depth) return names.filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n));
      for (const n of names) {
        const files = latest(path.join(dir, n), depth - 1);
        if (files.length) return files;
      }
      return [];
    };
    const files = latest(path.join(codexHome, 'sessions'), 3)
      .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 5);
    for (const { f, t } of files) {
      const fd = fs.openSync(f, 'r');
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 512 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n').reverse();
      for (const line of lines) {
        if (!line.includes('"rate_limits"')) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const rl = ev?.payload?.rate_limits || ev?.rate_limits;
        if (!rl) continue;
        const prev = load().codex?.updatedAt || 0;
        if (prev >= t) return null; // 已经有更新的数了
        const next = recordCodexRateLimits(rl);
        if (next) next.updatedAt = t;
        return next;
      }
    }
  } catch {}
  return null;
}

// 测试用：换数据目录后清掉缓存
export function _resetUsage() {
  cache = null;
  listeners.clear();
}
