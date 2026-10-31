# ClawChat 开发须知（给在这个仓库里干活的 AI 看）

ClawChat 是本地 AI 群聊：用户 + Claude（Claude Code）+ ChatGPT（Codex）+ DeepSeek、GLM（都借 Claude Code 跑）+ Gemini（订阅走 Antigravity CLI，API 走 Gemini CLI）+ Grok（Grok Build，只走账号登录）。
这个仓库常常是在 ClawChat 里由群里的 AI 自己开发的：**改坏了会把正在用的群聊弄坏**，所以下面的规矩要守。

> 本机如果有本地须知文件 `AGENTS.local.md`（不进仓库），先读它，它优先。

## 协作

- **每人在自己的工作副本里干活**：`git worktree add .worktrees/<名字> -b <名字>/<事> origin/main`，干完推上去就删掉。别直接在主目录里改：大家共用一个目录时，谁的改动没提交、谁停在旧版本都看不出来，测试工具也可能是旧的。
- 动手前在群里认领要改的文件，别同时改同一个文件。`test/hub.test.js`、`README.md`、`package.json` 是公共文件，改之前先认领。
- 一个功能要跨到别人负责的文件时，先在群里说「我要动 xx 的哪一块」，对方同意再改。
- 改完一位做、另一位看（review），再提交。
- 推到 main 就等于发新版（应用内的在线升级拉的就是 origin/main），推之前要用户点头。
- **main 由一个人统一推**：一个任务分工做时，各自只推自己的分支（`<名字>/<事>`），不改版本号、不推 main；都做完、测完、review 过以后，由负责发版的那位合到一起，在最新 main 上跑一遍 `npm test`，一次推上去、只升一个版本号。不要一人推一个。

## 测试

- 单元测试：`npm test`（Node 自带的 test runner，假 AI 在 `test/hub.test.js` 里的 fakeRunner）。提交前必须全过。
- **要看界面或走完整流程，用假 AI 实例**：`bash scripts/run-fake.sh [端口]`（默认 7399，数据在 `/tmp/clawchat-fake`，可以用 `CLAWCHAT_FAKE_HOME` 换）。它把 `scripts/fake/` 里假的 `claude`、`codex` 放在 PATH 最前面，不连任何真 AI。启动后先看 `/api/state` 里 `engines.claude.path` 和 `engines.codex.path` 是不是都指向 `scripts/fake/`。
  - 假 Claude、假 ChatGPT 都能正常回话（默认回「（假的 xx）做完了」）。要它回指定的内容（比如测 AI 之间私聊、接力），把内容写进 `$CLAWCHAT_FAKE_HOME/fake-replies/claude.txt` 或 `codex.txt`，用一次就删。`FAKE_SECS` 设每轮干多久，`FAKE_CODEX_SECS` 单独设 ChatGPT 的。
  - 局限：DeepSeek / GLM 的接口固定指向连不上的本地地址、真 Key 被清掉，只能测出错；Gemini 用 `scripts/fake/gemini`。
- **普通测试实例（`CLAWCHAT_PORT=7318 CLAWCHAT_HOME=/tmp/xxx node server.js`）用的是本机真实的 Claude / Codex 登录**，在里面发消息会叫起真 AI、花用户的额度。以前犯过两次：测输入框时按了 Enter，把消息发了出去。在这种实例里只测界面，不要真的发送；自动化脚本里不要在 `#input` 上按 Enter。万一发出去了，马上调 `/api/rooms/<id>/stop`，然后如实告诉用户。
- 新数据目录里没有 `config.json`，DeepSeek 会显示没填 Key。要测 DeepSeek 的话，用 `CLAWCHAT_DEEPSEEK_API` 指向本地的假接口，不要拿真 Key。
- 自己写脚本调接口时：**所有写接口（POST 等）都要带请求头 `X-ClawChat: 1`**，否则一律 403。
- 起测试实例前先在群里报端口和数据目录，别用同一个端口，免得关掉别人的实例。
- 生效方式：改 `public/` 刷新页面就行（静态文件是 `no-store`）；改 `lib/`、`server.js` 要重启服务；改 `mac/` 或者挪了目录要重新 `npm run app`。

## 发版

- 推之前先 `git pull --rebase origin main`。**只有功能和界面改动才升版本号**（改 `package.json` 的 `version`），纯文档、测试脚本不升；一个任务（几个分支合在一起）只升一位。**这一版改了什么写在提交说明里**：中文、大白话，结尾括号里写版本号（参考 `git log`）。
- README 没有更新日志，但它是给用户和同事看的使用说明，功能的用法变了，要跟着改「怎么用」那几段。
- 仓库是公开的，同事（包括 Windows 用户）直接从 GitHub 下载和在线升级。

## 产品规矩

- **记忆保留是核心功能**：退出再打开，聊天记录和 AI 的记忆（会话）都要在。会话 id 存在 `~/.clawchat/rooms/<id>/state.json`；出错、重启这类不是老板本意被打断的那一轮要退回读取进度；第一轮就失败的会话不能保存。改动不能破坏这一条。
- **老板按「停止」和 Claude Code 里按 Esc 一样**（老板定的）：停掉的那一轮不重做、读取进度不退回；但下次轮到它时要告诉它刚才在做什么（连同干活中途插进来的消息）、被老板停了，别自动接着做，等老板发话。
- 界面、提示词、代码注释都用中文。
- 界面风格：克制、有质感，控件像 macOS 原生的。界面元素沿用 `style.css` 里的 `--glass*` 玻璃变量，不要用实色块。提示框（toast）放在顶栏下方，分割线用半像素、两头淡出的细线。
- 界面上统一叫「ChatGPT」，不要只写「GPT」（成员 id 还是 `gpt`）。
- ChatGPT 切到快速档（更耗订阅额度）之前必须二次确认。
- 不要改用户自己的 `~/.codex/config.toml`、`~/.claude` 的全局设置。

## 多语言

- 界面支持中文和英文，默认跟随系统。**代码里写中文原文，用 `tr('中文原文', { 变量 })` 包起来**（前端是 `public/i18n.js` 提供的全局 `tr`，服务端是 `lib/i18n.js` 导出的 `tr`），变量用 `{name}` 占位，不要用模板字符串拼进去。
- 英文译文放在 `public/locales/en/` 下（`app.json` 前端、`html.json` 静态页面、`server.json` 服务端；新功能可以自己加一份，比如 `gemini.json`，加载时会合并）。`index.html` 里写死的文字不用改代码，只要把原文加进 `html.json`，页面加载时会自动换掉。
- `npm test` 会检查每句 `tr()` 都有英文译文、占位符对得上；漏了会直接报出来是哪一句。
- **发给 AI 的提示词不翻**（AI 看中文没问题），只有「用什么语言回复」那一句按界面语言换。匹配用的标记（`<私聊老板>`、`<群聊>`、`[PASS]`、@ 识别词）也不翻。
- Mac 外壳（`mac/main.swift`）用 `L("中文", "English")`，语言由网页通过 `native({ type: 'lang' })` 告诉它。

## 踩过的坑（改相关代码前先看）

- **停止任务要结束整棵进程树**：Codex 会把命令放进单独的进程组。
- **ChatGPT「卡住」**：通常是会话里存了太多图片（base64），之后每轮请求都发不出去，换模型也没用。判断要不要换会话，看最后一次压缩（compacted）之后还剩多少图片数据，不看文件大小。用户说「卡住」时，先看 `~/.codex/sessions` 里那个会话文件最后一条事件是什么时候。
- **换新会话**：会弹窗让用户选谁来交代情况（群里另一位 AI / 不用交代 / 用户自己来），接口是 `hub.resetAgent(room, agent, by)`。
- **ChatGPT 的群规**走 Codex 的 `developer_instructions`，只在新会话时传；续上的会话不会更新群规。
- **签名**：`scripts/sign-app.sh` 用 `~/.clawchat/signing` 里的自签名证书，这样每次升级后不用重新授权。不要把 `build-app.sh` 改回 `codesign --sign -`。
- **ChatGPT 速度档**：`codexArgs` 每次都明确传参（标准档 `-c features.fast_mode=false`），因为用户的 config.toml 里可能写了别的档位。
- **私聊**：`dm` 字段只表示用户和某位 AI 的私聊；AI 之间的私聊用 `pm`，`pmIn` 记这条放在谁的私聊里（整段对话只显示在被找的那一位的私聊里）。可见范围看 hub 的 `visibleTo`。用户说「私聊没回」时，先查那条私聊之后它的回复带不带 `dm`。
- **中途插话**：AI 正在干活时，老板或同事在同一个场合（群里 / 老板的私聊）又给它发消息，直接塞进它这一轮（Claude Code 写进 stream-json 的 stdin，ChatGPT 用 app-server 的 `turn/steer`），不用等它干完。AI 之间私下找它、场合对不上的，照旧开分身或排队。插话要等回执的，收到了才推进读取进度。
- **不 @ 时默认接着上一位**（`room.defaultTarget = 'last'`）。以前默认大家同时开工，经常刚发出去就得停掉不该开工的那几位。
- **重启**：用户点更新或重启时打断的活，下次启动自动接着做；有人在干活时可以等干完再重启（server 的 `pendingRestart`）。
- **DeepSeek**：用 `claude -p` 跑，`ANTHROPIC_BASE_URL` 换成 DeepSeek 的 Anthropic 兼容接口，`CLAUDE_CONFIG_DIR` 单独指向 `~/.clawchat/deepseek/claude-home`。Key 不对（401）或余额不足（402）时 Claude Code 会重试很久，所以看到 `api_retry` 就直接结束这一轮。
- **Grok**：用 `grok -p --output-format streaming-messages-json`（格式和 Claude Code 的 stream-json 一样），`-r` 续会话、`--fork-session` 开分身。**只走账号登录，不能变成按 API 计费**：每个群用 `~/.clawchat/grok/homes/` 下单独的 `GROK_HOME`（关掉 Claude/Codex/Cursor 的技能插件兼容，不然一句话就 4 万 token），登录文件用 `GROK_AUTH_PATH` 和老板终端共用一份（refresh_token 用一次就作废，复制多份会把人登出），去掉 `XAI_API_KEY` 等环境变量并禁用 API Key 登录。记忆就在那个目录里，删群、清空并忘掉记忆时由 `removeGrokHome` 清掉。暂不支持中途插话。
- **Windows**：Edge `--app` 模式开窗口；`ClawChat.vbs` 要 UTF-16 编码、`install.ps1` 要带 BOM 的 UTF-8；npm 装的 `.cmd` 不能直接 spawn。**Windows 代码没在真机上跑过**，同事出问题时先要 `~/.clawchat/start-error.html` 或 `server.log`。
