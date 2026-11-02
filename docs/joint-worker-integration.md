# 联合群加入方：本机接入与验收记录

这份是 `chatgpt/joint-worker` 的交接说明，基于 `3d21c43`，不替代组长维护的 `joint-protocol.md`。第一期只讨论，不开放任何本机文件工具。主持方和本机界面路由由 Claude 接入，以下没有自行改 `server.js`、`lib/hub.js` 或协议文档。

## 本机服务如何接入

`lib/joint-worker.js` 导出：

- `parseJointInvitation(code)`：验证协议版本、有效期、群编号和 HTTPS Tailscale 地址。不允许任意 URL、用户名密码、非 443 端口或额外路径。
- `beginJointPair(code, { nodeId, nodeName, ownerName, agents, appVersion })`：提交加入申请，返回含 pairId/核对码的本机 pending 记录。pending 含邀请秘密，不得进入 `/api/state`、群消息、AI 输入或日志。
- `finishJointPair(pending)`：轮询同一主持方；尚未批准时返回 null，批准后返回 connection。只在本机可信界面保存/使用。
- `new JointWorker({ connection, agents, runAgent, room, ownerName, onEvents, onStatus })`：agents 是**本机老板允许**的成员编号数组；room 只用于本机模型/思考选择，不能拿远端 room 对象填它。runAgent 传 `lib/agents.js` 的正式入口。
- `.start()` 启动独立事件/领任务/在线心跳循环；`.close()` 中断请求并停止本机任务，服务退出/撤销连接时必须调用。
- `.sendMessage(...)`、`.stop(本机成员编号数组)`、`.leave()` 供本机界面路由调用。不能暴露为 peer 可直接调用的老板授权接口。
- `storedJointConnections()` 供本机服务重启恢复连接，**含设备令牌**，不能原样返回前端。

镜像由 `onEvents(events)` 写入本机联合群记录；回调持久化成功后才推进游标，按 seq 去重。不要把镜像作为普通本地 room 调原 hub 再次调度 AI，否则会重复开工。worker 的结果已交主持方，由主持方形成公开消息。

数据目录使用 `joint/<sha256(host, roomId, nodeId)>/`，这个哈希是本地 jointId，避免不同主持方同名群、不同本机节点串会话。其下 `connection.json` / `worker.json` / `sessions/<agentId>/session.json` 存连接、游标、任务日志和会话编号；CLI 可隔离的 home 放同一 sessions 目录。目录 700、文件 600；Windows 使用 Node 跨平台文件操作及用户数据目录继承的 ACL，尚未做 Windows 实机验收，不能把 chmod 当作 Windows ACL 实测。

worker 不信任任务里的 cwd、env、systemPrompt、session 或 uploadsDir，只读取公开消息的 id/from/text。当前不会把图片引用解析成本机路径，也不会读收件箱给模型；图片在镜像中显示由事件接入方处理，向模型提供明确批准的公开图片附件需等文件/图片协议对齐，不能自行取任意 URL。

## 三项线协议细节（组长已采纳于 ea3ec1e）

当前分支与以下协议约定对齐，尚不能算主持方联调通过：

1. `GET /joint/v1/pair/:pairId` 用 `Authorization: Bearer <邀请秘密>` 证明持有邀请，不能仅凭 pairId/六位核对码领取设备令牌。主持方还须验证发起配对的 Tailscale login；pending/批准回应都应 no-store，不记录秘密。
2. 事件响应 `{ events:[{seq,type,...}] }`；取消事件 `{seq,type:'job.cancelled',jobId}`。领任务响应可为 `{job:{jobId,agentId,lease,context}}`，也支持协议原文的顶层 job；lease 当前按不可猜测字符串处理。心跳/结果正文带同一个 lease；续租回应 `{cancelled:true}` 可终止任务。
3. 结果提交按 jobId 去重，同一结果重交应成功返回。已过期/已关闭的任务可返回 409/410，worker 丢弃陈旧结果并继续后续任务，**不重跑 AI**。401/403/群级 404 会停止连接并结束本机任务。不要把正常的“暂无事件/暂无任务”写成 404，应返回空集合或 204。

事件公开 DTO 应由主持方按白名单构造。任务 context.messages 只含公开消息；不要为了“方便”带入普通 room/state、工具输出、文件路径或私聊。审批、文件字节和设备令牌永远不进入这个对象。

## 讨论档

本机执行入口通过 `room.jointDiscussion === true` 强制只读讨论，**即使原 room.permission 写着 full 也不能放开**。主持方调用本机 AI 时也必须使用该标记；不能只在加入方启用。

`prepareJointRoom` 给它一个专用空 workspace；`runAgent` 拒绝未记录在该联合群专用 session.json 里的旧 session，成功后记录新编号。正常群/私聊不带这个标记，保持原行为。

- Claude 系：`--restricted`、空 setting-sources、`--tools ''`、dontAsk、空 MCP、关闭 hooks/slash commands；不会再提示先用 Read 读项目须知，也不附加 uploads/transcripts。
- Codex：只读 sandbox，显式关 shell、view_image、子代理、插件、apps、hooks、记忆、浏览器、电脑控制和 code mode 等；禁自动项目须知与 bundled skills。启动前检查 `features list` 是否真的认识全部禁用开关，旧版本不能忽略参数后继续跑。
- Grok：空 tools、关闭自动批准、显式拒绝 Bash/Edit/Read/Grep/MCPTool/WebFetch/WebSearch、关闭 web search/memory/plan；独立 home，认证仍遵守原先单一 GROK_AUTH_PATH 的规则。
- Cursor：拒绝 Read/Write/Shell/MCP/WebFetch，ask + sandbox；独立 home，长消息超出启动参数限制时报错，不再写文件后要求模型 Read。
- Gemini API：管理员层 deny-all，不开放只读工具例外；独立 CLI 用户目录，不附加项目目录。
- Antigravity：拒绝 read/write/command/MCP/unsandboxed/URL 工具，不开放 allow 例外或项目附加目录。

Claude 系保留原认证目录：Mac 的 Claude Code 登录绑定配置目录对应的钥匙串条目，换空目录会显示未登录。由 restricted、空 setting-sources、空 tools、禁 hooks/MCP 负责隔离，cwd 和 session 编号仍由联合群专用记录管理。Codex 的新 home 只导入认证文件，不复制配置、插件、会话和自动记忆。认证刷新、重新登录/登出以及 Antigravity 全局 hooks/插件自动发现仍待原生验收，未判为全面通过。

## 已验证与待验证

专项单元测试覆盖：非法邀请码/URL、配对领取秘密、禁止重定向和响应上限、远端字段过滤、任务归属、结果回执丢失/重启不重做、停止/提前取消、续租失败、镜像落盘失败不推进游标、旧结果不堵后续任务、各引擎讨论参数、拒绝本地私聊 session、旧 Codex 能力检测。

真实 CLI + 假上游证据位于 `/tmp/clawchat-joint-worker-probe/`：
- Codex 0.165.0，实际调用本分支 `runCodexServer`：模型工具清单只余 request_user_input；假模型强行发 exec_command 时收到 `unsupported call: exec_command`，标记文件没有创建，正常完成文字回复。
- Claude Code 2.1.316：隔离用户/项目设置预先允许 Write；模型工具清单为空，假模型仍请求 Write 时被拒，目标假文件没有创建。
- 均未使用真实模型/Key，假接口 7472/7473 已关闭。

还需 API 与组长联调：完整配对/镜像/领任务/取消/重启恢复；更新假 Codex 支持 `features list` 的能力清单；其他四种 CLI 的恶意工具请求和启动配置负向测试；Windows 实机路径/.cmd/登录/停止；公开图片附件的显式模型输入。单元测试和 Mac 的两项 CLI 实验不能替代这些验收。

所有分支的安全复核是后续工作：主持方、文件传输、WebAuthn、界面提交固定版本后再逐项复核；本分支通过不表示联合群已经可以发版。

## 2026-11-02 19:25 对齐

线上完整成员 key 改为 `<nodeId>_<agentId>`，本机 agentId 保持不变；停止请求已同步。双方公开名字均带主人称呼，worker 的群规使用 `agentNames`（本机成员名映射）和 ownerName 形成 `ChatGPT·小王` 等名字。UI 发消息的 mentions 应直接传完整 key，主持方按结构化 mentions 调度，不依赖正文解析。

Claude Code 2.1.316 原认证入口对照：`auth status --json` 在默认目录为已登录、空配置目录为未登录、默认目录 + restricted + 空 setting-sources 仍已登录。只收集 loggedIn/authMethod/退出码，未输出或保存账号、组织和凭据；未发模型请求。脱敏证据 `/tmp/clawchat-joint-auth-probe/status-results.json`。

本机 2.1.316 脱敏结果：

| 条件 | loggedIn | authMethod | 退出码 |
| --- | --- | --- | --- |
| 原认证目录 | true | claude.ai | 0 |
| 新的空配置目录 | false | none | 1 |
| 原目录 + restricted + 空 setting-sources | true | claude.ai | 0 |

另外用完全隔离的假认证目录保留旧 settings：预先允许 Write，设置 SessionStart hook，提供项目 MCP 配置、用户/项目 CLAUDE.md 和已写出项目目录里的 memory/MEMORY.md。真实 CLI + 本地假上游结果：tools=[]，Write 返回错误，假目标文件未创建，hook/MCP 标记均未创建，项目须知和自动记忆标记未进入请求。这个实验使用假 token，不借真实账号发送模型请求。证据 `/tmp/clawchat-joint-auth-probe/restricted-results.json`。

官方资料也说明不同 CLAUDE_CONFIG_DIR 对应独立登录：https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts 。`auth status` 的语义见 https://code.claude.com/docs/en/cli-reference 。

## worker 私聊出站与离线退出修复

发送前使用 `splitJointReply` 拆分私聊标签，私聊保存于 `joint/<本地jointId>/private-replies/<jobId>.json`（600），不放在 workspace，也不放进公开结果队列。可用本机回调 `onPrivateReply({jobId,agentId,text})` 通知老板界面；回调只能接本机存储/显示，不能转成公开事件。只有私聊时公开结果为 [PASS]。升级前已排队的旧结果也会在重交前清理；未闭合、嵌套或长名字的私聊块均保守留在本机。

leave 先删除 connection.json、关闭 worker，再尝试通知主持方；finally 再保证 close/删除。网络失败不保留本机执行权或自动恢复资格。退出通知可能报网络错误，但本机停止不依赖它成功。
