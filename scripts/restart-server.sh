#!/bin/bash
# 用 npm start 跑的 ClawChat 重启（Mac、Linux）：等旧服务退出后起一个新的。
# 刚升级过的话，等新版本起来；起不来就退回原来的版本再起一次
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/update-guard.sh"
NODE="${CLAWCHAT_NODE:-node}"
cd "$ROOT" || exit 1
sleep 1
"$NODE" server.js &
PID=$!
if [ -f "$PREV" ]; then
  if wait_new_version; then
    rm -f "$PREV"
  elif roll_back; then
    kill "$PID" 2>/dev/null
    sleep 1
    "$NODE" server.js &
  fi
fi
