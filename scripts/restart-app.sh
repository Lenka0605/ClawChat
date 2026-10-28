#!/bin/bash
# 在线升级的最后一步：退出 ClawChat、重新打包、再打开。由服务在升级后启动，独立于应用进程运行。
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "[$(date '+%F %T')] 开始重启升级"
sleep 1
osascript -e 'tell application id "local.clawchat.app" to quit' >/dev/null 2>&1
for i in $(seq 1 60); do
  pgrep -f "ClawChat.app/Contents/MacOS/ClawChat" >/dev/null || break
  sleep 0.5
done
if bash "$ROOT/scripts/build-app.sh"; then
  echo "[$(date '+%F %T')] 打包完成"
else
  echo "[$(date '+%F %T')] 打包失败，用原来的应用重新打开"
fi
APP=/Applications/ClawChat.app
[ -d "$APP" ] || APP="$HOME/Applications/ClawChat.app"
open "$APP"
