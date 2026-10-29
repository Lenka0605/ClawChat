#!/bin/bash
# 给 ClawChat.app 签名。用法：bash scripts/sign-app.sh <ClawChat.app 的路径>
# macOS 按签名认应用：临时签名（ad-hoc）每次打包都不一样，系统会当成一个新应用，升级后又要重新授权一次。
# 所以第一次打包时在本机生成一张固定的自签名证书，以后每次都用它签，授权一次就一直有效。
# 证书放在单独的钥匙串文件里（~/.clawchat/signing），不碰登录钥匙串；出了任何问题就退回临时签名，不影响打包。
set -uo pipefail
APP="$1"
DIR="${CLAWCHAT_HOME:-$HOME/.clawchat}/signing"
KC="$DIR/ClawChat.keychain-db"
NAME="ClawChat Local Signing"

adhoc() { codesign --force --sign - "$APP" >/dev/null 2>&1 || true; }

make_identity() {
  rm -rf "$DIR" && mkdir -p "$DIR" && chmod 700 "$DIR" || return 1
  local tmp ok
  tmp="$(mktemp -d)" || return 1
  PW="$(/usr/bin/openssl rand -hex 24)" || return 1
  export PW
  (umask 077 && printf '%s' "$PW" > "$DIR/password")
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -days 36500 -subj "/CN=$NAME" \
      -addext "extendedKeyUsage=critical,codeSigning" -addext "keyUsage=critical,digitalSignature" \
      -addext "basicConstraints=critical,CA:false" >/dev/null 2>&1 \
    && /usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$NAME" -out "$tmp/id.p12" -passout env:PW \
    && security create-keychain -p "$PW" "$KC" \
    && security set-keychain-settings "$KC" \
    && security import "$tmp/id.p12" -k "$KC" -P "$PW" -T /usr/bin/codesign >/dev/null \
    && security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PW" "$KC" >/dev/null
  ok=$?
  rm -rf "$tmp"
  return $ok
}

if [ ! -f "$KC" ] || [ ! -f "$DIR/password" ]; then
  echo "  第一次打包：在本机生成签名证书（只做这一次）"
  make_identity || { echo "  证书没生成成功，这次先用临时签名"; adhoc; exit 0; }
fi
if security unlock-keychain -p "$(cat "$DIR/password")" "$KC" 2>/dev/null \
  && codesign --force --keychain "$KC" --sign "$NAME" "$APP" >/dev/null 2>&1; then
  echo "  已用本机证书签名"
else
  echo "  用本机证书签名失败，这次先用临时签名"
  adhoc
fi
