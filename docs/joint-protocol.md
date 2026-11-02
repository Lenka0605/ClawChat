# 联合群（第一期）协议约定

老板 2026-11-02 定：做第一期，Mac 和 Windows 都要能用；界面按液态玻璃（草图 A）。
调研材料：`~/.clawchat/local-notes/联合群调研-2026-11-02/`（总设计、ChatGPT 的安全方案、DeepSeek 的草图）。
这份是**各分支之间的接口约定**，改动先在群里说，由 Claude 更新这里。

## 第一期做什么、不做什么

- 做：配对、联合群里一起聊天（两边各自的 AI 都能被叫醒回话）、逐文件批准的传文件、收件箱。
- **第一期所有 AI 在联合群里一律「讨论档」**：不管谁叫醒、不管哪边的 AI，都用联合群专用的受限配置跑——不能写文件、不能跑命令、不能调 MCP。
  第一期**也不给读文件的工具**（ChatGPT 的 worker 已按这个做：每家都是空工具清单，`room.jointDiscussion === true` 强制生效）。共享文件夹留到第二期。主持方跑自己的 AI 时同样要带 `jointDiscussion`。
- 不做（第二、三期）：对方叫醒后在本机动手；「和自己人一样」档。

## 角色和名词

- **主持方（host）**：建联合群的那台。公开聊天记录、轮到谁、自动接力上限都在主持方算。
- **加入方（guest）**：用邀请码加入的那台。它的 AI 在它自己电脑上跑，记忆、额度、Key 都不出本机。
- **节点（node）**：一台 ClawChat。`nodeId` 随机生成，存在 `~/.clawchat/joint/node.json`。
- **远程成员**：在主持方眼里，加入方的 AI。成员 key 写成 `<nodeId>_<agentId>`（Windows 文件名不能有冒号）。联合群里**两边所有 AI 的名字都带主人**：「Claude·Lenka」「Claude·小王」，两边老板和 AI 看到的是同一套名字；@ 时写全名。
- 只有主持方需要开 `tailscale serve`。加入方**主动**来主持方领任务、拉消息（加入方零暴露）。所以 Windows 当加入方不需要 Tailscale serve，只需要能连上主持方。

## 认证（三道，缺一不可）

1. **Tailscale 身份**：请求必须经 `tailscale serve` 进来，`Tailscale-User-Login` 等于配对时记下的登录名（`lib/remote.js` 的 `requestAccess` 新增返回值 `'peer'`）。
2. **设备令牌**：配对成功时主持方发给加入方一个 256 位随机令牌，请求头 `Authorization: Bearer <令牌>`。主持方只存哈希。撤销 = 删掉记录。
3. **群范围**：令牌只绑定一个联合群；访问别的群一律 404。

`'peer'` 只能访问 `/joint/v1/` 下列出的接口，其余（`/api/` 全部、静态上传、预览、打开文件等）一律 403。peer 接口不用 `X-ClawChat` 头（它不是浏览器），但必须有上面三道。

## 配对

1. 主持方老板在联合群里点「邀请」→ 生成邀请码（只在本机界面显示，不进群消息、不进 AI 上下文、不写日志）：
   `clawchat-join:` + base64url(JSON `{ v:1, host:"https://xxx.ts.net", room:"<roomId>", secret:"<256 位随机>", exp:<毫秒时间戳> }`)，10 分钟内有效、只能用一次。
2. 老板把邀请码通过微信等发给同事。同事在自己的 ClawChat 里点「加入联合群」粘贴。
3. 加入方 `POST /joint/v1/pair`：`{ secret, nodeId, nodeName, ownerName, agents:[{ id, name, engine }], protocol:1, appVersion }`
   → `202 { pairId, code }`（`code` 是 6 位核对码，两边界面都显示，老板们口头对一下）。
4. 主持方界面弹「xx（Tailscale 账号 a@b.com，设备 yy）想加入「群名」，核对码 123456」→ 老板点同意或拒绝。
5. 加入方轮询 `GET /joint/v1/pair/:pairId`，请求头 `Authorization: Bearer <邀请秘密>`（光有 pairId / 核对码领不到令牌），主持方同时核对发起配对的 Tailscale 登录名。
   没批准前 `202 { status:'waiting' }`；拒绝 `403`；过期 `410`；同意后 `200 { token, room:{ id, name, members } }`，令牌只发这一次。全部 `Cache-Control: no-store`，日志里不记秘密和令牌。

## 主持方提供的 peer 接口（`/joint/v1/rooms/:roomId/...`）

| 接口 | 作用 |
| --- | --- |
| `GET events?after=<seq>&wait=25` | 长轮询拉公开事件（消息、成员在线状态、文件请求状态）。只含这个联合群的公开内容，没有私聊、配置、过程细节 |
| `POST messages` `{ clientId, text, mentions:[成员 key], replyTo? }` | 加入方老板发言。`clientId` 去重 |
| `GET jobs?wait=25` | 长轮询领本节点 AI 的任务。返回 `{ jobId, agentId, lease, context }` |
| `POST jobs/:jobId/heartbeat` | 续租（30 秒一次，租约 90 秒）。可带一句进度 |
| `POST jobs/:jobId/result` `{ ok, text, error? }` | 交结果。主持方把回复记成该远程成员的消息，照常按 @ 接力 |
| `POST stop` `{ agents:[成员 key] }` | 请求停止（各自只能停自己节点的 AI；主持方老板停远程成员 = 取消任务，加入方收到取消就结束那一轮） |
| `POST presence` | 心跳：在线、各 AI 是否就绪 |
| `POST leave` | 加入方退出联合群 |
| 文件相关 | 见下面「传文件」 |

任务 `context` 里只放：这位成员上次之后的公开消息（含图片引用）、群规模板需要的字段（ownerName、本机老板名、自动接力剩余次数）。**不放**任何一方的私聊、其他群、本机路径。

线上格式（和 ChatGPT 的 worker 对齐）：
- 事件：`{ events:[{ seq, type, ... }] }`，没有新事件时返回空数组（不要 404）。取消：`{ seq, type:'job.cancelled', jobId }`。
- 领任务：`{ job:{ jobId, agentId, lease, context } }`，没有任务返回 `{ job:null }`。`lease` 是不可猜的字符串，心跳和交结果的正文都带上它；心跳回 `{ cancelled:true }` 表示取消。
- 交结果按 `jobId` 去重：同样的结果重交照样返回成功；任务已过期 / 已关闭返回 `409` / `410`，worker 丢掉结果、不重跑。`401/403/404`（群级）表示连接失效，worker 停止。
- 租约过期没续上的，主持方标成「对方没回应」，不自动重发（防止重复执行）。

## 加入方本地

- 本地有一个「联合群镜像」：界面照常显示，消息来自主持方的事件流。加入方老板在镜像里发言 = 调 `POST messages`。
- worker 领到任务 → 用联合群专用会话（`~/.clawchat/joint/<jointId>/sessions`，按 agent 分开，绝不接本地群/私聊的会话）、讨论档配置跑本机 AI → 交结果。
- 停止：加入方老板按停止 → 本地结束那一轮 + 告诉主持方。

## 传文件（API 的 `lib/joint-files.js`，路由由 API 写在 `lib/joint-files-routes.js`，Claude 在 joint-server 里挂上）

原则照 ChatGPT 安全方案第 4 节：授权永远在**发送方本机**生成（快照 → 危险判定 → 确认框 → 私钥类再输一遍文件名 → 一次性授权 → transferId）；主持方只做中转存储（存的是发送方老板确认过的那份快照，24 小时过期清理）；接收方拉回后落自己的收件箱（700/600、随机存储名），默认不给 AI、不自动打开。文件字节不进 AI 对话、不进日志、不进事件流（事件里只有文件名、大小、用途、谁提的）。

**peer 接口**（`/joint/v1/rooms/:id/files/...`，三道认证；读正文/分块之后、动手之前必须再核对一次授权 `host.still(room, peer)`）：

| 接口 | 谁调 | 说明 |
|---|---|---|
| `POST files/request` `{ name, size, purpose }` | 加入方 | 想要一个文件：主持方界面出确认框 |
| `POST files/uploads` `{ transferId, hash, size, name, toNode, risk }` | 加入方（它是发送方时） | 发送方本机已经确认过；之后 `PUT files/:transferId/chunks`（按序）+ `POST files/:transferId/finish`（校验哈希进待取区） |
| `GET files/:transferId/manifest` | 接收方 | 元数据（名称、大小、哈希、来源、风险级） |
| `GET files/:transferId/content` | 接收方 | 文件字节；transferId 绑定接收节点，别的节点 404；`no-store` |

**本机界面接口**（`/api/joint/files/...`，浏览器调，带 `X-ClawChat`）：

| 接口 | 说明 |
|---|---|
| `POST snapshot` `{ path, roomId }` | 本机快照 + 危险判定 → `{ hash, size, name, risk, reason? }`；路径只在本机 |
| `POST approve` `{ hash, size, name, toNode, confirmName? }` → `{ transferId }` | 确认发送；私钥类必须来自本机电脑窗口、`confirmName` 和文件名一致 |
| `POST :transferId/chunks` / `POST :transferId/finish` | 主持方老板自己发送时推进待取区 |
| `GET inbox` / `POST inbox/reveal` `{ transferId }` | 收件箱 / 在访达里显示 |

**第一期私钥类文件只能在电脑上确认，还要再输一遍文件名**（老板 2026-11-02 定）：请求必须来自本机电脑窗口（`host` 是 `127.0.0.1` / `localhost`、不带任何 `x-forwarded-*` 头），`confirmName` 和快照的文件名一致；手机上碰到私钥类提示「请到电脑上确认」。这一步防误点、发错文件；电脑上有完全权限的 AI 本来就能直接读文件，拦不住它（普通群一直就有的风险）。原生 Touch ID / Windows Hello 放第二期；WebAuthn 代码留在库里、不接路由。授权在内存里：主持方重启就失效，要重新走确认框。

## 版本

`protocol:1`。两边不一致时，界面提示「对方的 ClawChat 版本不同，请双方都升级到最新版」。

## 本机界面 ↔ 本机服务（浏览器调自己的 ClawChat，照常要 `X-ClawChat: 1`）

联合群**单独新建**，不能把普通群变成联合群（普通群里的 AI 带着本地项目的记忆，不能拿去和对方聊）。入口在「新建聊天」弹窗：「新建联合群」「加入联合群」。普通群的群设置里不出现联合群相关内容。

| 接口 | 作用 |
| --- | --- |
| `POST /api/joint/rooms` `{ name, members:[agentId] }` | 新建联合群（主持方） |
| `POST /api/rooms/:id/joint/invite` → `{ code, expiresAt }` | 生成邀请码（只在本机显示） |
| `POST /api/joint/join` `{ code, ownerName, members:[agentId] }` → `{ pairId, check }` | 加入方提交邀请码；`check` 是 6 位核对码 |
| `GET /api/joint/join/:pairId` → `{ status:'waiting'|'approved'|'rejected'|'expired', roomId? }` | 加入方轮询 |
| `POST /api/joint/pair/:pairId/approve` / `reject` | 主持方老板同意 / 拒绝（待确认的配对通过事件推给界面：`{ type:'joint-pair', pairId, login, nodeName, ownerName, check, agents }`） |
| `POST /api/rooms/:id/joint/leave` | 退出（加入方）/ 解散（主持方） |
| 收件箱、文件确认、WebAuthn | API 在 `api/joint-files` 定好后补进来 |

## 数据形状（界面用）

- `room.joint = { role:'host'|'guest', selfNode, peerNode, peerName, peerLogin, peerOnline, permission:'discuss', protocol:1 }`
- `room.members` 发给界面时只有自己这边的简单 id（勾成员、配模型用）。显示和 @ 用 `room.jointMembers = [{ key:'<nodeId>_<agentId>', agentId, name:'Claude', owner:'小王', node, engine, mine:true|false }]`。
  所有成员都显示「名字·主人」；「我的 / 远程」靠角标和小标签区分。
- 消息：自己这边 AI 发的 `from` 是简单 id，对方 AI 发的是完整 key（镜像群的消息还带 `fromName`）；老板发的 `from:'user'` 加 `node`：`node === selfNode` 显示「你」，否则显示对方老板称呼。
- @：可以 @ 两边任何一位，写全名 `@Claude·小王`、`@Claude·Lenka`。发送时 `mentions` 传完整成员 key（加入方的发言，主持方以 `mentions` 为准）。
- 测试模式：`CLAWCHAT_JOINT_TEST=1` + `CLAWCHAT_JOINT_TEST_LOGIN=<假账号>`，邀请码写本机 http 地址、本机请求带 `x-clawchat-test-login` 当 Tailscale 账号。不开就一律不认。
- 第一期不支持：和对方 AI 私聊、改对方 AI 的模型/思考档（模型菜单只列自己这边的）、联合群里的分身。

## 第二期：权限档和动手前的审批（Claude，`lib/joint-policy.js`）

- 每位老板只给**自己这边**的 AI 定档，存在本机群设置 `room.joint.policy[agentId] = { level:'discuss'|'folder', folder, confirm }`，不发给对方。
- `folder` 档只对验收过的引擎开放：`lib/joint-discussion.js` 导出 `JOINT_FOLDER_ENGINES`（引擎名数组，ChatGPT 验收后填），没有就一家都不开放。文件夹不能是根目录、整个用户目录、凭据目录（.ssh/.aws/.claude/.codex/钥匙串）、ClawChat 数据目录。
- 本机 AI 在联合群里每一轮都过 `policy.guard(runAgent, room, agentId, opts, messages)`：给 `opts.room` 加上 `jointDiscussion: true` 和 `jointMode: 'discuss'|'folder'`（folder 时再加 `jointFolder`）。**真正的限制由 runAgent 按 `jointMode`/`jointFolder` 落实**（ChatGPT）。
- 要不要先问老板：这一轮看到的消息里只要有不是本机老板自己发的（对方老板、对方 AI、接力），且 `confirm` 开着，就先弹审批：事件 `{ type:'joint-approval', approvalId, roomId, agentId, name, folder, from, text }`；老板 `POST /api/joint/approvals/:id { approve }`；`GET /api/joint/approvals` 补查。同意 → folder 档；不同意、10 分钟没点、等的时候被停 → 只讨论。结束时推 `{ type:'joint-approval-done', approvalId, approved }`。
- 加入方：worker 调 runAgent 时请带上 `jointContext: job.context`（用里面的公开消息判断要不要问；没带就一律当成要问）。
- 本机接口：`GET/PUT /api/rooms/:id/joint/policy`，PUT 正文 `{ agents: { claude: { level:'folder', folder:'/abs', confirm:true } } }`，返回 `{ engines, agents:{ id:{ level, folder, confirm, available } } }`。
