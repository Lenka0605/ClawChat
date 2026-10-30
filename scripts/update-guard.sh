# 升级退回（restart-app.sh、restart-server.sh 共用，约定写在 lib/updater.js）：
# 在线升级拉了新代码以后会留一个 update-prev.json。重启后等新版本起来，90 秒内起不来就退回原来的版本
DATA="${CLAWCHAT_DATA:-${CLAWCHAT_HOME:-$HOME/.clawchat}}"
PORT="${CLAWCHAT_PORT:-7317}"
PREV="$DATA/update-prev.json"

field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$PREV" | head -1; }

# 等新版本起来：/api/health 报的 commit 是新的那个才算（旧服务可能还没退出）
wait_new_version() {
  local to
  to="$(field to)"
  [ -n "$to" ] || return 0
  for _ in $(seq 1 "${CLAWCHAT_UPDATE_WAIT:-90}"); do
    curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q "\"commit\":\"$to\"" && return 0
    sleep 1
  done
  return 1
}

# 退回原来的版本，并留下记录（服务启动时看到它，会告诉老板）
roll_back() {
  local from
  from="$(field from)"
  [ -n "$from" ] || return 1
  # 程序目录已经不是这次升级到的版本（比如有人手动动过）：不自动回退
  [ "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" = "$(field to)" ] || { echo "[$(date '+%F %T')] 程序目录不是这次升级到的版本，不自动退回"; return 1; }
  echo "[$(date '+%F %T')] 新版本 $(field to) 90 秒内没起来，退回 $from"
  git -C "$ROOT" reset --hard "$from" || return 1
  mv -f "$PREV" "$DATA/update-rollback.json"
}
