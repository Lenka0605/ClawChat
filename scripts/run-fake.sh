#!/bin/bash
# 用假的 claude / codex / gemini 起一个测试实例，不叫起任何真 AI、不耗你的额度。
# 用法：bash scripts/run-fake.sh [端口，默认 7399]
# 数据放在 /tmp/clawchat-fake（不碰 ~/.clawchat）；FAKE_SECS 控制假 AI 每轮「干活」多少秒；
# touch /tmp/clawchat-fake/compact.on 可以让假 Claude 每轮模拟一次自动压缩记忆。
# 局限：假 codex 除了查版本一律报错，只能测 ChatGPT 出错的流程；DeepSeek 接口指向连不上的本地地址，也只能测出错。
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAKE="$ROOT/scripts/fake"
HOME_DIR="${CLAWCHAT_FAKE_HOME:-/tmp/clawchat-fake}"
mkdir -p "$HOME_DIR"
cd "$ROOT"
# setupPath 会把登录 shell 的 PATH 排在最前，所以 SHELL 也要换成假的，假程序才会被找到
export PATH="$FAKE:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin" SHELL="$FAKE/fakeshell" \
  CLAWCHAT_PORT="${1:-7399}" CLAWCHAT_HOME="$HOME_DIR" GEMINI_CLI_HOME="$HOME_DIR/gemini-cli" FAKE_COMPACT="$HOME_DIR/compact.on" FAKE_SECS="${FAKE_SECS:-6}"
# 不让 DeepSeek、GLM 碰真接口、真 Key（CLAWCHAT_FAKE_DEEPSEEK_API 可以换成自己起的假接口）
unset DEEPSEEK_API_KEY GLM_API_KEY GEMINI_API_KEY GOOGLE_API_KEY ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
export CLAWCHAT_DEEPSEEK_API="${CLAWCHAT_FAKE_DEEPSEEK_API:-http://127.0.0.1:9}"
export CLAWCHAT_GLM_API="${CLAWCHAT_FAKE_GLM_API:-http://127.0.0.1:9}"
exec node server.js
