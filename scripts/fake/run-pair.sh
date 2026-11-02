#!/bin/bash
# 在一台电脑上模拟两位老板：起两个互相独立的假 AI 实例（联合群 / 远程成员功能联调用）。
# 用法：
#   bash scripts/fake/run-pair.sh start   起 A(7451) 和 B(7452) 两个实例，数据目录分开
#   bash scripts/fake/run-pair.sh stop    停掉两个实例
#   bash scripts/fake/run-pair.sh status  看两个实例在不在、能不能互相访问
# 数据目录：/tmp/clawchat-pair-a 和 /tmp/clawchat-pair-b（可以用 CLAWCHAT_PAIR_A_HOME / CLAWCHAT_PAIR_B_HOME 换）。
# 和 run-fake.sh 一样用的是假 AI，不碰真 AI、真 Key；假回复也写在各自数据目录的 fake-replies/ 里。
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAKE="$ROOT/scripts/fake"
A_PORT="${CLAWCHAT_PAIR_A_PORT:-7451}"
B_PORT="${CLAWCHAT_PAIR_B_PORT:-7452}"
A_HOME="${CLAWCHAT_PAIR_A_HOME:-/tmp/clawchat-pair-a}"
B_HOME="${CLAWCHAT_PAIR_B_HOME:-/tmp/clawchat-pair-b}"
A_PID="/tmp/clawchat-pair-a.pid"
B_PID="/tmp/clawchat-pair-b.pid"

start_one() { # $1=端口 $2=数据目录 $3=pid 文件 $4=名字 $5=测试登录名（联调时冒充的 Tailscale 账号）
  if [ -f "$3" ] && kill -0 "$(cat "$3")" 2>/dev/null; then
    echo "$4 已在跑（端口 $1，pid $(cat "$3")）"
    return
  fi
  mkdir -p "$2"
  # setupPath 会把登录 shell 的 PATH 排在最前，所以 SHELL 也要换成假的，假程序才会被找到
  env PATH="$FAKE:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin" SHELL="$FAKE/fakeshell" \
    CLAWCHAT_PORT="$1" CLAWCHAT_HOME="$2" GEMINI_CLI_HOME="$2/gemini-cli" \
    FAKE_COMPACT="$2/compact.on" FAKE_SECS="${FAKE_SECS:-6}" CLAWCHAT_JOINT_TEST=1 CLAWCHAT_JOINT_TEST_LOGIN="${5:-$4@pair.test}" \
    CODEX_HOME="$2/codex" \
    CLAWCHAT_DEEPSEEK_API="${CLAWCHAT_FAKE_DEEPSEEK_API:-http://127.0.0.1:9}" \
    CLAWCHAT_GLM_API="${CLAWCHAT_FAKE_GLM_API:-http://127.0.0.1:9}" \
    CLAWCHAT_RUNPAIR_ROOT="$ROOT" bash -c 'mkdir -p "$CODEX_HOME"; exec node "$CLAWCHAT_RUNPAIR_ROOT/server.js"' >>"$2/server.log" 2>&1 &
  echo $! >"$3"
  echo "$4 起在 http://127.0.0.1:$1（数据 $2，pid $!）"
}

stop_one() { # $1=pid 文件 $2=名字
  if [ -f "$1" ]; then
    local pid
    pid="$(cat "$1")"
    if kill -0 "$pid" 2>/dev/null; then
      # 只按自己记下的 pid 关，不按端口、不按程序名，免得碰到别人的实例
      kill "$pid" 2>/dev/null || true
      echo "$2 已停（pid $pid）"
    fi
    rm -f "$1"
  fi
}

case "${1:-start}" in
  start)
    start_one "$A_PORT" "$A_HOME" "$A_PID" "老板A" "${CLAWCHAT_PAIR_A_LOGIN:-a@pair.test}"
    start_one "$B_PORT" "$B_HOME" "$B_PID" "老板B" "${CLAWCHAT_PAIR_B_LOGIN:-b@pair.test}"
    sleep 2
    ;;
  stop)
    stop_one "$A_PID" "老板A"
    stop_one "$B_PID" "老板B"
    exit 0
    ;;
  status) ;;
  *) echo "用法：bash scripts/fake/run-pair.sh [start|stop|status]"; exit 1 ;;
esac

# 两个实例互通检查：假 AI 的世界里没有网络，互相访问就是 HTTP 打得通
ok=1
for item in "A:$A_PORT" "B:$B_PORT"; do
  name="${item%%:*}"; port="${item##*:}"
  if curl -sf -o /dev/null "http://127.0.0.1:$port/api/health"; then
    echo "老板$name（:$port）健康检查通过"
  else
    echo "老板$name（:$port）没起来，看 $([ $name = A ] && echo "$A_HOME" || echo "$B_HOME")/server.log"
    ok=0
  fi
done
[ "$ok" = 1 ] && echo "两个实例都在，可以开始联调（双方互访地址就是上面两个）"
exit $((1 - ok)) # ok=1 表示都在，退出码要是 0
