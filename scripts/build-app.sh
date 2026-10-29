#!/bin/bash
# 生成 ClawChat.app，放进「应用程序」。项目文件夹移动后要重新运行一次。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "找不到 node，请先安装 Node.js 22 或更新的版本" >&2
  exit 1
fi

if [ -w /Applications ]; then DEST=/Applications; else DEST="$HOME/Applications"; mkdir -p "$DEST"; fi
APP="$DEST/ClawChat.app"

mkdir -p "$BUILD"
echo "→ 编译原生外壳"
swiftc -O -swift-version 5 -o "$BUILD/ClawChat" "$ROOT/mac/main.swift" -framework Cocoa -framework WebKit

echo "→ 取 Claude / ChatGPT 官方图标（来自本机装的官方应用，不放进仓库）"
swift "$ROOT/mac/extract-icons.swift" "$ROOT/public/icons" || echo "  没取到官方图标，界面会用内置的简笔头像"
if [ ! -f "$ROOT/public/icons/deepseek.png" ]; then
  echo "→ 下载 DeepSeek 官方头像（来自 DeepSeek 的官方 GitHub 账号）"
  curl -fsSL --max-time 20 -o "$ROOT/public/icons/deepseek.png" "https://avatars.githubusercontent.com/u/148330874?s=256" \
    || { rm -f "$ROOT/public/icons/deepseek.png"; echo "  没下载到，界面会用内置的简笔头像"; }
fi

echo "→ 生成图标"
rm -rf "$BUILD/ClawChat.iconset"
swift "$ROOT/mac/make-icon.swift" "$BUILD/ClawChat.iconset"
iconutil -c icns -o "$BUILD/ClawChat.icns" "$BUILD/ClawChat.iconset"
cp "$BUILD/ClawChat.iconset/icon_256x256.png" "$ROOT/public/app-icon.png" # 设置 →「关于」里用

echo "→ 打包到 $APP"
if pgrep -f "$APP/Contents/MacOS/ClawChat" >/dev/null; then
  osascript -e 'tell application id "local.clawchat.app" to quit' || true
  sleep 1
fi
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/ClawChat" "$APP/Contents/MacOS/ClawChat"
cp "$BUILD/ClawChat.icns" "$APP/Contents/Resources/ClawChat.icns"
VERSION="$(node -p "require('$ROOT/package.json').version")"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ClawChat</string>
  <key>CFBundleDisplayName</key><string>ClawChat</string>
  <key>CFBundleIdentifier</key><string>local.clawchat.app</string>
  <key>CFBundleExecutable</key><string>ClawChat</string>
  <key>CFBundleIconFile</key><string>ClawChat</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>ClawChatNode</key><string>$NODE</string>
  <key>ClawChatRoot</key><string>$ROOT</string>
</dict>
</plist>
PLIST
echo "→ 签名（用本机固定的证书，升级后系统还认得是同一个应用，不用重新授权）"
bash "$ROOT/scripts/sign-app.sh" "$APP"
touch "$APP"
echo "✓ 已生成 $APP"
