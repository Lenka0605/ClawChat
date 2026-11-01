import path from 'node:path';
import { DATA_DIR, readConfig } from './store.js';
import { tr } from './i18n.js';
import { startApiBridge, apiBridge, apiBridgeToken } from './api-bridge.js';

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
  // 「API」：任意 OpenAI 兼容平台（填地址和 Key）。平台说的是 OpenAI 协议，Claude Code 只会 Anthropic 协议，
  // 所以中间隔一个本机转接器（lib/api-bridge.js）：Claude Code 连转接器、拿的是转接器的临时令牌，真正的 Key 只在转接器里
  api: {
    id: 'api',
    name: 'API',
    maker: '',
    bridge: true,
    get api() { return apiBaseUrl(); },
    get modelsApi() { const b = apiBaseUrl(); return b ? `${b}/models` : ''; },
    keyField: 'apiKey',
    keyEnv: 'CLAWCHAT_API_KEY',
    baseField: 'apiBase',
    homeDir: 'api',
    // 平台标了默认的就用它，没标就用列表第一个；子任务也用同一个（别家平台没有统一的「小模型」）
    get defaultModel() { const list = onlineModels.get('api') || []; return (list.find((m) => m.isDefault) || list[0])?.id || ''; },
    get smallModel() { return this.defaultModel; },
    autoCompact: '',
    fatal: {
      get 401() { return tr('API 的 Key 不对，请在「设置 → 程序与模型」里重新填一下'); },
      get 402() { return tr('API 平台说额度不够（或者这个模型没开通），换一个模型，或者找平台管理员'); },
    },
    fallback: [],
  },
};

export function providerKey(p) {
  if (!p) return '';
  return readConfig()[p.keyField] || process.env[p.keyEnv] || '';
}

// 「API」平台的地址（https://…/v1），去掉末尾的斜杠
export function apiBaseUrl() {
  return String(readConfig().apiBase || process.env.CLAWCHAT_API_BASE || '').trim().replace(/\/+$/, '');
}

// 地址只认 https（本机调试可以 http://127.0.0.1 / localhost），不能带账号密码、查询参数
export function validApiBase(value) {
  try {
    const u = new URL(String(value || '').trim());
    const local = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if ((u.protocol !== 'https:' && !local) || u.username || u.password || u.search || u.hash) return '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

// 本机转接器：ClawChat 启动时开一次；转接器每次请求时读当前的地址、Key 和模型信息
export function ensureApiBridge() {
  return startApiBridge(() => ({ base: apiBaseUrl(), key: providerKey(PROVIDERS.api), model: (id) => providerModel(PROVIDERS.api, id) }), { dataDir: path.join(DATA_DIR, 'api', 'reasoning') });
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
// scope：「API」用，写进转接器令牌里，分清是哪个群的哪位（分身单独一份），思考内容不会串
export function providerEnv(p, model, scope = 'default') {
  const info = providerModel(p, model);
  const bridge = p.bridge ? apiBridge() : null;
  return {
    ANTHROPIC_BASE_URL: p.bridge ? bridge?.url || '' : `${p.api}/anthropic`,
    ANTHROPIC_AUTH_TOKEN: p.bridge ? apiBridgeToken(scope) : providerKey(p),
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
// base：「API」保存前先拿新地址核对，核对通过才存（不传就用已经存好的地址）
export async function fetchProviderModels(p, key, base) {
  const url = p.bridge && base ? `${base}/models` : p.modelsApi;
  if (!url) return { models: [] };
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
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
  // 能不能看图：平台写了就按平台的（input_modalities 或 supports_vision），没写就是「不知道」（null），按看不了处理
  const vision = Array.isArray(m.input_modalities) ? m.input_modalities.includes('image') : typeof m.supports_vision === 'boolean' ? m.supports_vision : p.bridge ? null : false;
  const context = Number(m.context_window) || 0;
  const size = context >= 1000000 ? `${Math.round(context / 100000) / 10}M` : context ? `${Math.round(context / 1000)}K` : '';
  // 「API」平台：支持思考的模型给 low / high / max 三档（转接器换成平台的 reasoning_effort）
  const thinking = p.bridge && m.supports_thinking !== false ? ['low', 'high', 'max'] : null;
  return {
    id: m.id,
    name: m.display_name || m.name || m.id,
    description: [vision === true ? tr('能看图') : vision === false ? tr('不能看图') : '', size && tr('{size} 上下文', { size })].filter(Boolean).join(' · '),
    vision,
    context,
    ...(p.bridge ? { maxOutput: Number(m.max_tokens) || 0, isDefault: !!m.is_default, thinking: m.supports_thinking !== false } : {}),
    // 只留 Claude Code 的 --effort 认得的档位
    efforts: thinking || (m.effort?.supported_levels || []).filter((e) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(e)),
    defaultEffort: m.effort?.default_level || '',
  };
}
