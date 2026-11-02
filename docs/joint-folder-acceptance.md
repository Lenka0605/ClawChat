# 联合群第二期：指定文件夹候选配置验收

验收时间：2026-11-02。原验收基点：`df28d51`（0.7.62）；接入时已合并 `claude/joint-p2` 的 `c1bbf90`。组长确认后，本分支已接入 Mac 的 folder 档，导出 `claude/deepseek/glm/api/codex`；其他系统导出空数组。发布仍需 API 初审、组长复查和最终联调。

## 建议开放范围

| 引擎 | Mac 上的结论 | Windows 上的结论 |
| --- | --- | --- |
| Claude、DeepSeek、GLM、API | 同用 Claude Code 2.1.316；严格候选配置的真实 CLI + 假 Anthropic 接口验收通过。建议仅 Mac 先开放，接入后还要逐入口验收 | 未验收，不开放文件夹档 |
| ChatGPT（Codex） | 0.165.0 的真实 app-server + 假 Responses 接口验收通过。必须用命名权限 profile 和受管网络代理，不能沿用 workspace-write | 未验收，不开放文件夹档 |
| Grok | 本轮查了真实 CLI 参数和现有配置，尚未完成同级别的真实工具反向验收，不开放；不是声称 CLI 做不到 | 未验收，不开放 |
| Cursor | 同上，只有 sandbox 开关不能代替读边界和网络白名单验收，不开放 | 未验收，不开放 |
| Gemini CLI / Antigravity CLI | 本轮没有完成真实 CLI + 假接口验收，不开放；不得用普通群现有参数代替证明 | 未验收，不开放 |

这里的“文件夹边界”指业务文件的路径边界。系统可执行文件、系统库、公开 CA 和每轮独立的运行临时目录是明确的运行例外，不承诺整个进程只打开项目中的文件。既有文件夹内的内容本身会提供给 AI，不能把此档当作对共享文件夹内秘密的保护。

## Claude 系候选配置

使用 `--restricted --setting-sources ''`，仅提供 `Read,Grep,Glob,Write,Edit,Bash`，显式禁 MCP、插件命令和 hooks。不能开放 Agent 或其他未验收工具。认证保留原入口；模型认证变量通过 `sandbox.credentials.envVars` 对子命令设为 deny，至少涵盖 ANTHROPIC_AUTH_TOKEN、ANTHROPIC_API_KEY、CLAUDE_CODE_OAUTH_TOKEN。

命令沙盒必须 enabled、failIfUnavailable，并且 allowUnsandboxedCommands=false、excludedCommands=[]。文件读取从根目录 deny，只重开真实项目路径、必要的系统运行路径和本轮独立临时目录；文件工具另用 restricted 和 blockReadsOutsideWorkingDirectories 收口。网络只放开发域名。不要把整个 `/System` 当运行白名单，以免纳入 Data 卷入口；本轮只重开 `/System/Library` 等必要路径。

实际踩到两个可用性问题并已验证解法：

- CLI 的命令 cwd 跟踪文件受临时路径长度限制，长目录会退回共享 `/tmp/claude-501`。用本轮随机、700 权限、短路径的 CLAUDE_CODE_TMPDIR，并只放行这一个临时目录；不能把共享临时目录整体放开。
- 严格读白名单下 curl 读默认 CA 失败。把系统公开 CA 复制到本轮目录，通过 CURL_CA_BUNDLE / SSL_CERT_FILE 指向副本；不是因此放开整个 `/etc`。

真实工具结果：项目内 Read/Write/Bash 成功；外部、软链接和 `..` 的 Read/Write/Bash 均拒绝；dangerouslyDisableSandbox 重试仍拒绝；Data 卷别名读取拒绝；查询假父进程的 ps 被拒；Bash 看不到假认证变量；registry.npmjs.org 请求成功，本机非白名单端口没有收到请求；预种的用户/项目 hooks 和 MCP 未运行。

证据：`/tmp/clawchat-joint-folder-evidence/claude-folder-v7.mjs`、`claude-v7.log`、`claude/folder-candidate-v7/stdout.jsonl`。本节记录原候选配置，实际产品入口的补验证据见后文。

## Codex 候选配置

使用独立 CODEX_HOME，只导入必要认证。命名 profile 的文件系统从 `:root=deny` 开始，用 `:minimal=read` 提供系统运行文件，仅把固定项目绝对路径和本轮独立运行目录设为 write。**还要显式拒绝 `/tmp`、`/private/tmp`、`/private/var/folders`**：本轮证明，仅 root deny + minimal 会留下默认临时目录例外，外面的假文件仍可读写。

app-server 的 thread/start、turn/start 都传 `permissions:'joint-folder'`；不能同时传旧 sandbox/sandboxPolicy，也不能让启动参数里的 sandbox_mode 覆盖命名 profile。shell_tool 开启，其余讨论档已有的插件、MCP、hooks、记忆、浏览器、电脑控制、代码模式、提权工具等继续关闭。实测暴露的是 exec_command、write_stdin 和 request_user_input，没有额外文件工具。

网络开启时必须同时启用 features.network_proxy，profile 仅允许开发域名，禁止本机服务、Unix socket 和上游代理绕行。代理使用本轮独立端口；API 请求流量由 CLI 主进程发出，不受 Bash 的网络 allowlist 代替控制。审批策略固定 never，禁止命令请求提权后换无沙盒执行。

真实 app-server 结果：内读/内写成功；外读/外写、软链接、`..`、外部临时文件、CLI 配置目录和 Data 卷别名全部拒绝；把 exec_command.workdir 改成外部目录也不能读写；require_escalated 被拒；registry.npmjs.org 成功、example.com 被代理拒绝，忽略代理后的直接 IP 连接和本机模型接口连接也被拒绝。

证据：`/tmp/clawchat-joint-folder-evidence/codex-native-v3.mjs`、`codex/native-v3.log`、`codex/native-results.json`、`codex/explicit-tmp-deny.json`。本机 schema 明确支持 thread/start 与 turn/start 的 permissions 字段；接入时必须检查版本和能力，不能在旧 CLI 上忽略配置后放行。

## 普通群 Claude 系“项目内”修补

本分支修了 Mac/Linux 分支继承预授权 Write 绕过项目写边界的问题：加入 restricted、空配置来源、工具白名单，关闭 MCP/hooks/插件命令；沙盒不可用时直接失败，禁止无沙盒重试。Windows 原生分支原先就没有强制命令沙盒，本轮未将它标为安全、未开放 Windows 联合群 folder 档；Linux 也没有本轮的真机验收。

保留原认证位置、resume 会话、图片输入，以及附件和完整聊天记录的 add-dir。后两者同时加文件工具拒写规则和命令沙盒 denyWrite，避免“为了读附件”额外扩大写范围。隔离会跳过项目配置和自动记忆，所以提示先手动读项目须知和可读记忆，不重新放开配置。

用实际 claudeArgs + 真实 CLI 验证：项目内写文件、执行命令、编辑 notebook 正常；项目外写入拒绝；附件能读，Write/Edit/NotebookEdit/Bash 都不能改；恶意 hooks/MCP 没有运行。另起进程用原 session id resume 成功，假接口确实收到了上一轮内容和回复，会话编号不变。证据为 `claude-product.log`、`claude-notebook-v2.log`、`claude-resume.json` 及对应脚本。原始 E2 反例在 `/tmp/clawchat-joint-security-evidence/claude-project-boundary.json`。

普通群补丁首次回归：完整 `npm test` 297 项通过，见证据目录 `npm-test.log`；文件夹最终接入回归为 **315 项全过**，见 `folder-final-full.log`。未使用真 Key、未请求真实模型、未碰 7317、没有启动浏览器。

## 实际接入后的补验

两家均从真实 `runAgent` 入口调用真实 CLI，模型端仍只连接本机假接口。Claude 用隔离配置及假认证；Codex 用测试启动包装器只替换模型后端为本机假 Responses，权限、配置检查与回合协议仍走产品代码。证据为 `claude-product-folder.log`、`codex/product-results.json` 和对应 `.mjs` 脚本。

产品入口补验抓出 `mcp_servers={}` 会与旧 MCP 表合并的问题。接入后会清理联合群专用 Codex home 里的 config.toml（不动用户原配置和会话），把项目及其上级路径的配置标为不受信任，关闭 notify，并在 thread/start 前用 config/read 检查实际生效的 MCP 表；发现仍有启用项时拒绝。专门预埋的 home MCP、项目 MCP、notify 均未运行。MCP 拦截也有“不能先建会话再拒绝”的回归。配置来源规则见 [Codex 官方项目配置说明](https://learn.chatgpt.com/docs/config-file/config-advanced#project-config-files-codexconfigtoml)。

Codex 使用 strict-config，所有 `-c` 对象序列化成 TOML 内联表；不能将 JSON 对象冒充 TOML。两个认证环境变量仍给模型主进程使用，但从命令环境排除；真实工具输出只看到了 FAKE_TOKEN_HIDDEN。Claude 子命令的三种认证变量同样显式禁用。

讨论档和每个目录分开记原生会话，在 native-sessions.json 中保留映射；切回原档/原目录会续接原会话。第一期无 scope 的记录只能迁到讨论档。失败不登记；成功后的辅助索引写失败仅向本机告警，不能把已完成的工具动作判失败而自动重做。

worker 带 jointContext 和固定 jointRemoteTask；后者不能信主持方自报的 from/node。协调器需在审批及真正启动前复查最新授权。运行器**要求** jointBeforeStart 同步回调，在版本预检后与 Codex 建会话/开回合前再次调用，只有明确返回 true 才启动；缺少回调、返回 Promise 或返回 false 全部拒绝。旧协调器尚未接这道检查时保持关闭动手。文件夹回合不接收跳过重新审批的 steer。

## Touch ID 的公开安全限度（组长接受）

本期采用首次登记后固定公钥，协议不验证公钥的硬件来源；把外壳登记提前、显示登记事件，可以提高可见性，不能证明首次公钥一定来自 Secure Enclave。已经拥有本机完全文件权限的程序可以直接访问文件或篡改程序/登记状态，不在这层保护范围。Touch ID 主要用于阻止手机或借用入口直接发送敏感文件，以及防止误点；真正限制 AI 的是各家引擎的沙盒和工具权限。首次登记、记录异常和不能使用指纹时的行为必须与这个边界一致，不能宣传成能抵御本机完全权限的恶意程序。

## 接入前必须保持的条件

1. 只对已验收的平台和 CLI 能力开放；未知版本/不支持配置/沙盒启动失败一律回讨论或明确报错，不能宽松降级。
2. 配对、权限或文件夹改变后，不能沿用旧文件夹的会话和运行权限；续会话也必须每轮覆盖 profile、cwd 和网络策略。
3. 按协议给 worker 传 jointContext，folder 提示覆盖“只能讨论”，批准只对指定任务生效；撤权、停止、过期在真正启动前再核对。
4. 模型主进程可以认证；工具和命令不能读登录文件或继承认证变量。路径和系统临时目录的例外要逐条固定，不能重开用户目录或整个系统 Data 卷。
5. 接入完成后再跑假 worker/host 的成功与拒绝路径，不能仅凭本报告导出开放列表就发版。

## 一手依据

- [Claude Code 沙盒](https://code.claude.com/docs/en/sandboxing)：Bash 沙盒与文件工具是不同边界。
- [Claude Code 设置参考](https://code.claude.com/docs/en/settings-reference)、[权限](https://code.claude.com/docs/en/permissions)：配置隔离、路径权限、沙盒和凭据规则。
- [Codex 权限](https://learn.chatgpt.com/docs/permissions)：命名 profile、网络代理、运行目录例外与平台范围；以本机 0.165.0 的 schema 和真实工具测试补证，未把跨平台文档当成 Windows 实测。
