#!/bin/bash
# 打安卓 App（ClawChat 的安卓外壳）：只用 Android SDK 自带的工具（aapt2、javac、d8、zipalign、apksigner），
# 不用 Gradle、不下载任何第三方库。打出来的 APK 放在 ~/.clawchat/android/ClawChat.apk。
# 签名证书第一次自动生成，放在 ~/.clawchat/signing/android.keystore（密码在旁边的 android.pass，只有自己能读），
# 不进代码仓库；以后每次都用同一张证书签，手机上升级不用卸载重装。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${CLAWCHAT_HOME:-$HOME/.clawchat}"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
OUT_DIR="$DATA/android"
SIGN_DIR="$DATA/signing"

fail() { echo "打包失败：$*" >&2; exit 1; }

[ -d "$SDK/build-tools" ] || fail "没找到 Android SDK（$SDK）。装好 Android Studio 或命令行工具后再试"
BT="$(ls -1d "$SDK"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
PLATFORM="$(ls -1d "$SDK"/platforms/android-*/ 2>/dev/null | sort -V | tail -1)"
[ -n "$BT" ] && [ -x "$BT/aapt2" ] && [ -x "$BT/d8" ] && [ -x "$BT/apksigner" ] || fail "Android SDK 里缺 build-tools（aapt2、d8、apksigner）"
[ -n "$PLATFORM" ] && [ -f "$PLATFORM/android.jar" ] || fail "Android SDK 里缺 platforms/android-xx"
ANDROID_JAR="$PLATFORM/android.jar"
command -v javac >/dev/null || fail "没找到 javac（要装 JDK 17 以上）"
command -v keytool >/dev/null || fail "没找到 keytool（要装 JDK 17 以上）"

# 版本号跟着 ClawChat 走：0.7.47 → versionName 0.7.47，versionCode 747（每次升级都会变大）
VERSION="$(node -p "require('$ROOT/package.json').version")"
IFS=. read -r MA MI PA <<<"$VERSION"
CODE=$((MA * 10000 + MI * 100 + PA))

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/res/drawable" "$WORK/classes" "$WORK/dex" "$OUT_DIR" "$SIGN_DIR"
cp -R "$ROOT/android/res/." "$WORK/res/" 2>/dev/null || true
cp "$ROOT/public/favicon.png" "$WORK/res/drawable/icon.png"

# 1. 资源和清单
"$BT/aapt2" compile --dir "$WORK/res" -o "$WORK/res.zip"
"$BT/aapt2" link -I "$ANDROID_JAR" --manifest "$ROOT/android/AndroidManifest.xml" \
  --version-code "$CODE" --version-name "$VERSION" --min-sdk-version 26 --target-sdk-version 34 \
  -o "$WORK/base.apk" "$WORK/res.zip" --java "$WORK/gen" --auto-add-overlay

# 2. 代码：javac → d8
find "$ROOT/android/src" "$WORK/gen" -name '*.java' > "$WORK/sources.txt"
javac -nowarn -encoding UTF-8 --release 11 -classpath "$ANDROID_JAR" -d "$WORK/classes" @"$WORK/sources.txt" 2> >(grep -v '^Note:' >&2)
"$BT/d8" --release --min-api 26 --lib "$ANDROID_JAR" --output "$WORK/dex" $(find "$WORK/classes" -name '*.class')
(cd "$WORK/dex" && zip -q -j "$WORK/base.apk" classes.dex)

# 3. 对齐、签名
"$BT/zipalign" -p -f 4 "$WORK/base.apk" "$WORK/aligned.apk"
KS="$SIGN_DIR/android.keystore"
PASS="$SIGN_DIR/android.pass"
if [ ! -f "$KS" ]; then
  umask 077
  head -c 32 /dev/urandom | base64 | tr -d '/+=\n' > "$PASS"
  keytool -genkeypair -keystore "$KS" -storetype PKCS12 -storepass:file "$PASS" -keypass:file "$PASS" \
    -alias clawchat -keyalg RSA -keysize 3072 -validity 36500 -dname "CN=ClawChat" >/dev/null 2>&1
  chmod 600 "$KS" "$PASS"
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass "file:$PASS" --ks-key-alias clawchat --out "$WORK/ClawChat.apk" "$WORK/aligned.apk"
"$BT/apksigner" verify "$WORK/ClawChat.apk"
mv -f "$WORK/ClawChat.apk" "$OUT_DIR/ClawChat.apk"
echo "$VERSION" > "$OUT_DIR/version.txt"
echo "$OUT_DIR/ClawChat.apk"
