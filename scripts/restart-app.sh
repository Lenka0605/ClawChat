#!/bin/bash
# 在线升级的最后一步：退出 ClawChat、重新打包、再打开。由服务在升级后启动，独立于应用进程运行。
# 刚升级过的话，等新版本起来；起不来就退回原来的版本，再打包打开一次
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/update-guard.sh"
APP=/Applications/ClawChat.app
[ -d "$APP" ] || APP="$HOME/Applications/ClawChat.app"

relaunch() {
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
  open "$APP"
}

echo "[$(date '+%F %T')] 开始重启升级"
sleep 1
relaunch
if [ -f "$PREV" ]; then
  if wait_new_version; then
    rm -f "$PREV"
    echo "[$(date '+%F %T')] 新版本已经起来了"
  elif roll_back; then
    relaunch
  fi
fi
