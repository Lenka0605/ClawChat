import { tr } from './i18n.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { DATA_DIR } from './store.js';

export const isJointDiscussion = (room) => room?.jointDiscussion === true;
// 只开放做过真实 CLI 反向验收的 Mac；其他系统保持讨论档。
export const JOINT_FOLDER_ENGINES = process.platform === 'darwin' ? ['claude', 'deepseek', 'glm', 'api', 'codex'] : [];
export const isJointFolder = (room) => isJointDiscussion(room) && room.jointMode === 'folder' && process.platform === 'darwin';
export const JOINT_DEV_DOMAINS = [
  'registry.npmjs.org', '*.npmjs.org', 'registry.yarnpkg.com', 'registry.npmmirror.com', '*.npmmirror.com',
  'pypi.org', 'files.pythonhosted.org', 'pypi.tuna.tsinghua.edu.cn', 'mirrors.aliyun.com',
  'github.com', '*.github.com', '*.githubusercontent.com', 'crates.io', '*.crates.io',
  'proxy.golang.org', 'sum.golang.org', 'goproxy.cn', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
];
// 未验收文件工具的读边界，一律不提供；不能因为是「只读」就继承本机的任意读取能力。
export const JOINT_CODEX_CONFIG = {
  'features.shell_tool': false, 'features.view_image': false, 'features.multi_agent': false,
  'features.apps': false, 'features.plugins': false, 'features.remote_plugin': false,
  'features.memories': false, 'features.hooks': false, 'features.goals': false,
  'features.browser_use': false, 'features.browser_use_external': false, 'features.computer_use': false,
  'features.code_mode': false, 'features.code_mode_host': false, 'features.code_mode_only': false,
  'features.request_permissions_tool': false, 'features.skill_search': false,
  'web_search': 'disabled', 'project_doc_max_bytes': 0,
  'skills.bundled.enabled': false, 'skills.include_instructions': false,
};
// -c 接受 TOML 值；嵌套对象不能用 JSON 的冒号，否则 CLI 会把它当字符串而不是权限表。
export function codexConfigLiteral(value) {
  if (Array.isArray(value)) return `[${value.map(codexConfigLiteral).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}=${codexConfigLiteral(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function jointCodexConfig(room) {
  if (!isJointFolder(room)) return JOINT_CODEX_CONFIG;
  if (!room.jointProxyUrl || !room.jointScratch) throw new Error(tr('联合群文件夹沙盒未能准备，已停止'));
  const projects = {};
  for (let dir = room.cwd; ; dir = path.dirname(dir)) {
    projects[dir] = { trust_level: 'untrusted' };
    if (path.dirname(dir) === dir) break;
  }
  return {
    ...JOINT_CODEX_CONFIG, 'features.shell_tool': true, 'features.network_proxy': true,
    default_permissions: 'clawchat-joint-folder', approval_policy: 'never', mcp_servers: {}, projects, notify: [],
    'shell_environment_policy.exclude': ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    'permissions.clawchat-joint-folder.filesystem': {
      ':root': 'deny', ':minimal': 'read', '/tmp': 'deny', '/private/tmp': 'deny', '/private/var/folders': 'deny',
      // 固定绝对路径，不让 exec_command.workdir 或后续配置改变工作根；只额外开放本轮独立运行目录。
      [room.cwd]: 'write', [room.jointScratch]: 'write',
    },
    'permissions.clawchat-joint-folder.network': {
      enabled: true, proxy_url: room.jointProxyUrl, enable_socks5: false,
      allow_local_binding: false, allow_upstream_proxy: false, dangerously_allow_non_loopback_proxy: false,
      domains: Object.fromEntries(JOINT_DEV_DOMAINS.map((domain) => [domain, 'allow'])),
    },
  };
}

export function jointClaudeSettings(room) {
  if (!isJointFolder(room) || !room.jointScratch) throw new Error(tr('联合群文件夹沙盒未能准备，已停止'));
  return {
    disableAllHooks: true, permissions: { blockReadsOutsideWorkingDirectories: true },
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false, excludedCommands: [],
      credentials: { envVars: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].map((name) => ({ name, mode: 'deny' })) },
      filesystem: { denyRead: ['/'], allowRead: [
        room.cwd, room.jointScratch, '/bin', '/usr/bin', '/usr/lib', '/System/Library',
        '/dev/null', '/dev/random', '/dev/urandom', '/private/var/db/dyld',
        '/private/etc/ssl', '/etc/ssl', '/private/etc/ssl/cert.pem', '/etc/ssl/cert.pem',
        '/private/etc/hosts', '/private/etc/resolv.conf', '/private/etc/services', '/private/etc/protocols',
        '/Library/Keychains/SystemRootCertificates.keychain',
      ] },
      network: { allowedDomains: JOINT_DEV_DOMAINS },
    },
  };
}
// 不能交给联合群的文件夹（选文件夹时 joint-policy 的 checkFolder、每轮启动前 prepareJointRoom 共用这一份）：
// 根目录、整个用户目录（及其上级）、ClawChat 数据目录、装登录凭据和浏览器数据的目录，以及包含它们的上级目录。
// real 必须已经 realpath 过。返回不能用的原因，能用返回空串。
export function jointFolderProblem(real) {
  const under = (p, root) => p === root || p.startsWith(root + path.sep);
  const home = fs.realpathSync(os.homedir());
  if (real === path.parse(real).root || under(home, real)) return tr('不能把整个电脑或整个用户目录交出去，请选一个具体的项目文件夹');
  const forbidden = [DATA_DIR, '/Library/Keychains', '/private/var/db', '/private/etc',
    ...['.ssh', '.gnupg', '.aws', '.azure', '.config', '.docker', '.kube', '.claude', '.codex', '.grok', '.cursor', '.gemini', '.clawchat', 'Library'].map((p) => path.join(home, p))];
  if (forbidden.some((p) => {
    try { p = fs.realpathSync(p); } catch {}
    return under(real, p) || under(p, real);
  })) return tr('这个文件夹里有登录凭据或 ClawChat 自己的数据，不能交给联合群');
  return '';
}
function privateDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
export function jointSessionDirectory(room, agent) {
  const root = path.resolve(DATA_DIR, 'joint');
  const fallback = path.join(root, crypto.createHash('sha256').update(String(room.id)).digest('hex'), 'sessions', agent);
  const dir = path.resolve(room.jointSessionDir || fallback);
  const relative = path.relative(root, dir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(tr('联合群会话目录不在专用数据区'));
  return privateDir(dir);
}
export function prepareJointRoom(room, agent, engine = agent === 'gpt' ? 'codex' : agent) {
  const dir = jointSessionDirectory(room, agent);
  const folder = room.jointMode === 'folder' && JOINT_FOLDER_ENGINES.includes(engine);
  let cwd = privateDir(path.join(dir, 'workspace'));
  if (folder) {
    if (!path.isAbsolute(room.jointFolder || '')) throw new Error(tr('请选一个文件夹'));
    cwd = fs.realpathSync(room.jointFolder);
    // 已审批的是 canonical 路径；启动前若被换成软链接，不能扩大到另一个目录。
    if (cwd !== path.resolve(room.jointFolder) || !fs.statSync(cwd).isDirectory()) throw new Error(tr('请重新选择要共享的文件夹'));
    const bad = jointFolderProblem(cwd);
    if (bad) throw new Error(bad);
  }
  return { ...room, permission: folder ? 'project' : 'readonly', jointMode: folder ? 'folder' : 'discuss',
    cwd, jointSessionDir: dir, jointScope: folder ? `folder-${crypto.createHash('sha256').update(cwd).digest('hex')}` : 'discuss', fast: { gpt: false } };
}

// 短临时根避免 Claude 的 cwd 跟踪退回共享 /tmp/claude-uid；整个目录只属于这一轮。
// 代理端口由 OS 分配，释放后若被别的进程占用，CLI 必须启动失败，不能换成不受管网络。
export async function prepareJointFolderRuntime(room, engine) {
  const scratch = fs.mkdtempSync('/private/tmp/ccjf-');
  fs.chmodSync(scratch, 0o700);
  try {
    const next = { ...room, jointScratch: fs.realpathSync(scratch) };
    if (engine === 'codex') {
      next.jointProxyUrl = await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const port = server.address().port;
          server.close((err) => err ? reject(err) : resolve(`http://127.0.0.1:${port}`));
        });
      });
    } else fs.copyFileSync('/etc/ssl/cert.pem', path.join(scratch, 'cert.pem'));
    return next;
  } catch (err) { fs.rmSync(scratch, { recursive: true, force: true }); throw err; }
}

export const jointFolderPrompt = (room) => isJointFolder(room)
  ? `这一轮权限已由本机老板批准：可以在 ${room.cwd} 文件夹里读写并运行沙盒命令；文件夹外的业务文件不能读写，不能绕过沙盒、提权或改用其他工具。命令只允许访问开发网站白名单，MCP、插件和 hooks 均关闭。之前「只能讨论」的说明在这一轮由本条覆盖。开始前先用 Read 或沙盒命令读本目录中存在的 AGENTS.md、AGENTS.local.md、CLAUDE.md、CLAUDE.local.md 和相关项目须知；配置和自动记忆不会自动加载。`
  : '';

// 权限档或目录切换时不能把旧目录读到的内容带进新范围。各范围分别保留会话，切回来仍能接上。
// session.json 继续给 hub/worker 记录最近一次；完整映射单独存，避免 worker 的旧格式写回覆盖映射。
export function selectJointSession(room, requested) {
  const file = path.join(room.jointSessionDir, 'native-sessions.json');
  const latest = path.join(room.jointSessionDir, 'session.json');
  const read = (p, fallback) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
  };
  const records = read(file, { v: 1, sessions: {} });
  if (records?.v !== 1 || !records.sessions || typeof records.sessions !== 'object' || Array.isArray(records.sessions)
      || Object.values(records.sessions).some((s) => s !== null && typeof s !== 'string')) throw new Error(tr('联合群本地记录损坏，请核对后重新连接'));
  const saved = read(latest, {});
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)
      || (saved.session !== undefined && saved.session !== null && typeof saved.session !== 'string')) throw new Error(tr('联合群本地记录损坏，请核对后重新连接'));
  if (requested && ![...Object.values(records.sessions), saved.session].includes(requested)) throw new Error(tr('联合群不能接入本地群或私聊的会话'));
  const scope = room.jointScope;
  // 第一期没有 scope 的会话只能迁到讨论档，绝不能当作已批准的文件夹会话。
  const session = records.sessions[scope] || ((saved.scope === scope || (!saved.scope && scope === 'discuss')) ? saved.session : null) || null;
  const write = (p, value) => {
    const tmp = `${p}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, p); }
    finally { fs.rmSync(tmp, { force: true }); }
  };
  return { session, save(result) {
    if (result.ok) {
      const current = read(file, { v: 1, sessions: {} });
      write(file, { v: 1, sessions: { ...current.sessions, [scope]: result.session || null } });
      write(latest, { session: result.session || null, scope });
    }
    return { ...result, jointScope: scope };
  } };
}

export function jointFolderVersionSupported(engine, text) {
  const m = String(text).match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!m) return false;
  const want = engine === 'codex' ? [0, 165, 0] : [2, 1, 316];
  const got = m.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (got[i] !== want[i]) return got[i] > want[i];
  return true;
}
export function jointEngineHome(room, engine) {
  const home = privateDir(path.join(room.jointSessionDir, 'cli', engine));
  const root = fs.realpathSync(path.join(DATA_DIR, 'joint'));
  const real = fs.realpathSync(home);
  if (!real.startsWith(root + path.sep)) throw new Error(tr('联合群会话目录不在专用数据区'));
  return home;
}
// Claude 的配置目录同时决定 macOS 钥匙串条目，改目录会丢失订阅登录。
// 讨论档保留原认证入口，配置/工具隔离由 restricted、空 setting-sources 和空 tools 强制执行。
// Codex 仍使用独立 home，只导入认证文件，不复制配置、插件或会话。
export function jointAuthEnv(room, engine, env) {
  if (isJointFolder(room)) env = { ...env, TMPDIR: room.jointScratch, TMP: room.jointScratch, TEMP: room.jointScratch,
    ...(engine === 'claude' ? { CLAUDE_CODE_TMPDIR: room.jointScratch, CLAUDE_TMPDIR: room.jointScratch,
      CURL_CA_BUNDLE: path.join(room.jointScratch, 'cert.pem'), SSL_CERT_FILE: path.join(room.jointScratch, 'cert.pem') } : {}) };
  if (!isJointDiscussion(room) || engine === 'claude') return env;
  const home = jointEngineHome(room, engine);
  // MCP 表的空对象覆盖会与旧表合并，不能靠 mcp_servers={} 删除原条目。
  // 独立 home 只保留认证与会话，不加载它里面任何残留配置；从不修改老板原来的 CODEX_HOME。
  fs.rmSync(path.join(home, 'config.toml'), { force: true });
  const source = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  const target = path.join(home, 'auth.json');
  if (!fs.existsSync(target) && fs.existsSync(source)) {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
  }
  return { ...env, CODEX_HOME: home };
}

export function codexDiscussionFeaturesSupported(output, folder = false) {
  const known = new Set(String(output).split('\n').map((line) => line.trim().split(/\s+/)[0]));
  return Object.keys({ ...JOINT_CODEX_CONFIG, ...(folder ? { 'features.network_proxy': true } : {}) }).filter((key) => key.startsWith('features.')).every((key) => known.has(key.slice(9)));
}
