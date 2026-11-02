import path from 'node:path';

// 只继承运行命令行所需的系统环境。不能用「删掉已知 Key」的办法：新提供方和新令牌名会漏网。
const COMMON = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  // 假引擎的控制参数逐个列出；不能放行 FAKE_* 或 CLAWCHAT_* 的任意字段。
  'CLAWCHAT_HOME', 'FAKE_SECS',
  'FAKE_CLAUDE_LOGGED_OUT', 'FAKE_COMPACT', 'FAKE_COMPACT_SECS',
  'FAKE_USAGE_LOG', 'FAKE_USAGE_RESULT', 'FAKE_USAGE_KEY_SOURCE',
  'FAKE_CODEX_LOGGED_OUT', 'FAKE_CODEX_RPC_SCENARIO', 'FAKE_CODEX_RPC_LOG', 'FAKE_CODEX_SECS',
  'FAKE_CURSOR_LOGGED_OUT', 'FAKE_CURSOR_SCENARIO', 'FAKE_CURSOR_LOG', 'FAKE_CURSOR_SECS',
  'FAKE_GROK_LOGGED_OUT', 'FAKE_GROK_SCENARIO', 'FAKE_GROK_LOG', 'FAKE_GROK_SECS', 'FAKE_GROK_CHILD',
];
const OWN = {
  claude: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'],
  // 借 Claude Code 的成员由 providerEnv 显式注入自己的凭据，不继承 Claude 的认证信息。
  deepseek: [], glm: [], api: [],
  codex: ['CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
  gemini: ['GEMINI_CLI_HOME', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  agy: [],
  grok: ['GROK_HOME', 'GROK_AUTH_PATH'],
  cursor: ['CURSOR_API_KEY'],
};

export function engineName(cmd) {
  const name = path.basename(cmd).replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();
  return name === 'cursor-agent' ? 'cursor' : name;
}

export function agentEnv(engine, source = process.env) {
  const allowed = new Set([...COMMON, ...(OWN[engine] || [])].map((k) => k.toLowerCase()));
  // Windows 的环境变量名不区分大小写；保留原名，避免 Path/PATH 等重复。
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && allowed.has(key.toLowerCase())));
}
