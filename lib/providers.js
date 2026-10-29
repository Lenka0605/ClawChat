import path from 'node:path';
import { DATA_DIR, readConfig } from './store.js';
import { tr } from './i18n.js';

// 借 Claude Code 干活的外部模型：DeepSeek、GLM（智谱）都提供 Anthropic 兼容接口，
// 接法完全一样，只有接口地址、Key、模型目录、出错提示不同。以后再加别家，在这里加一项就行。
//
//   api        —— 兼容接口的根地址，真正请求的是 `${api}/anthropic`
//   modelsApi  —— 能列出模型目录的地址；没有（或读不出来）就用 fallback
//   fallback   —— 先用的模型清单，在线读到以后以接口为准
//   keyField   —— 存在 ~/.clawchat/config.json 里的字段名
//   keyEnv     —— 也可以从环境变量给（测试时用）
//   homeDir    —— 这一位的 Claude Code 配置目录（会话、凭据和 Claude 的分开放）
//   autoCompact—— 上下文窗口很大时的自动压缩阈值（各家文档推荐的数值不一样）
// 界面上显示的文字（出错提示、模型说明）写成 getter：模块加载时还不知道界面语言，用到时再翻译
// 测试时可以指向本地的假接口（run-fake.sh 就是这么做的），免得碰到真接口、真 Key
const DEEPSEEK_API = process.env.CLAWCHAT_DEEPSEEK_API || 'https://api.deepseek.com';
const GLM_API = process.env.CLAWCHAT_GLM_API || 'https://open.bigmodel.cn/api';

export const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    maker: '深度求索',
    api: DEEPSEEK_API,
    modelsApi: `${DEEPSEEK_API}/models`,
    keyField: 'deepseekKey',
    keyEnv: 'DEEPSEEK_API_KEY',
    homeDir: 'deepseek',
    defaultModel: 'deepseek-flash',
    smallModel: 'deepseek-flash', // 子任务、总结网页这类小活用快的
    autoCompact: '786432',
    fatal: {
      get 401() { return tr('DeepSeek 的 API Key 不对，请在「设置 → 程序与模型」里重新填一下'); },
      get 402() { return tr('DeepSeek 账户余额不足，去 platform.deepseek.com 充值后再叫它'); },
    },
    // 连不上时先用这份（2026 年 10 月官方文档里的两个模型）
    fallback: [
      { id: 'deepseek-flash', name: 'DeepSeek Flash', get description() { return tr('快、便宜，能看图 · 1M 上下文'); }, vision: true, context: 1000000, efforts: [], defaultEffort: '' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', get description() { return tr('更强，不能看图 · 1M 上下文'); }, vision: false, context: 1000000, efforts: [], defaultEffort: '' },
    ],
  },
  glm: {
    id: 'glm',
    name: 'GLM',
    maker: '智谱',
    api: GLM_API,
    modelsApi: '', // 官方文档没有列模型目录的接口，先用 fallback
    keyField: 'glmKey',
    keyEnv: 'GLM_API_KEY',
    homeDir: 'glm',
    defaultModel: 'glm-5.3',
    smallModel: 'glm-5.3',
    autoCompact: '',
    fatal: {
      get 401() { return tr('GLM 的 API Key 不对，请在「设置 → 程序与模型」里重新填一下'); },
      get 402() { return tr('GLM 账户余额不足，去 bigmodel.cn 充值后再叫它'); },
    },
    // 2026 年 10 月官方文档里出现的两个模型；没有模型目录接口，出了新模型要手动补
    fallback: [
      { id: 'glm-5.3', name: 'GLM-5.3', get description() { return tr('智谱最新'); }, vision: false, context: 0, efforts: [], defaultEffort: '' },
      { id: 'glm-5.2', name: 'GLM-5.2', description: '', vision: false, context: 0, efforts: [], defaultEffort: '' },
    ],
  },
};

export function providerKey(p) {
  if (!p) return '';
  return readConfig()[p.keyField] || process.env[p.keyEnv] || '';
}

// 在线读到的模型目录；读不到就用 fallback
const onlineModels = new Map();

export function setProviderModels(id, models) {
  if (models?.length) onlineModels.set(id, models);
}

export function providerModels(p) {
  const online = onlineModels.get(p.id);
  return online?.length ? online : p.fallback;
}

export function providerModel(p, model) {
  return providerModels(p).find((m) => m.id === model) || null;
}

// 跑这一位时给 Claude Code 的环境：接口和 Key 换成它的，配置目录单独放，
// 不沿用 Claude 的模型、思考强度、插件这些设置，会话也分开放，也碰不到 Claude 账号的登录
export function providerEnv(p, model) {
  const info = providerModel(p, model);
  return {
    ANTHROPIC_BASE_URL: `${p.api}/anthropic`,
    ANTHROPIC_AUTH_TOKEN: providerKey(p),
    ANTHROPIC_API_KEY: undefined, // 别把 Anthropic 的 Key 一起发出去
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CONFIG_DIR: path.join(DATA_DIR, p.homeDir, 'claude-home'),
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: p.smallModel,
    CLAUDE_CODE_SUBAGENT_MODEL: p.smallModel,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(p.autoCompact && (info?.context || 0) >= 1000000 ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: p.autoCompact } : {}),
  };
}

// 1M 上下文的模型要加 [1m]，Claude Code 才知道窗口有多大（发给接口时会去掉）
export function providerModelArg(p, model) {
  return (providerModel(p, model)?.context || 0) >= 1000000 ? `${model}[1m]` : model;
}

// 在线读模型目录；读不出来就返回空，调用方继续用 fallback
export async function fetchProviderModels(p, key) {
  if (!p.modelsApi) return { models: [] };
  try {
    const res = await fetch(p.modelsApi, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401) return { models: [], badKey: true, error: tr('API Key 不对') };
    if (!res.ok) return { models: [], error: tr('{name} 返回了 {status}', { name: p.name, status: res.status }) };
    const models = ((await res.json()).data || []).filter((m) => m.id);
    const list = models.map((m) => normalizeModel(p, m));
    setProviderModels(p.id, list);
    return { models: list };
  } catch {
    return { models: [], error: tr('连不上 {name}', { name: p.name }) };
  }
}

function normalizeModel(p, m) {
  const vision = (m.input_modalities || []).includes('image');
  const context = Number(m.context_window) || 0;
  const size = context >= 1000000 ? `${Math.round(context / 100000) / 10}M` : context ? `${Math.round(context / 1000)}K` : '';
  return {
    id: m.id,
    name: m.name || m.id,
    description: [vision ? tr('能看图') : tr('不能看图'), size && tr('{size} 上下文', { size })].filter(Boolean).join(' · '),
    vision,
    context,
    // 只留 Claude Code 的 --effort 认得的档位
    efforts: (m.effort?.supported_levels || []).filter((e) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(e)),
    defaultEffort: m.effort?.default_level || '',
  };
}
