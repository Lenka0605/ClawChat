# ClawChat 的 Windows 安装脚本（由 ClawChat 文件夹里的 Install-Windows.cmd 启动，可以重复运行，相当于「修复」）：
# 1. 检查并安装需要的程序：Node.js、Git、Claude Code（Claude 和 DeepSeek 都借它干活），可选 Codex（群里的 ChatGPT）
# 2. 接上 GitHub，以后可以在 设置 → 软件更新 里一键升级
# 3. 在桌面和开始菜单放一个 ClawChat 快捷方式，然后打开 ClawChat
# 这个文件要存成带 BOM 的 UTF-8，Windows PowerShell 才能认出中文。
$ErrorActionPreference = 'Continue'
# 老一些的 Windows 10 默认还用 TLS 1.0，连不上现在的网站：打开 TLS 1.2
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root
try { $Host.UI.RawUI.WindowTitle = 'ClawChat 安装' } catch {}

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   √ $text" -ForegroundColor Green }
function Warn($text) { Write-Host "   ! $text" -ForegroundColor Yellow }
function Done($code) { Write-Host ''; Read-Host '按回车键关闭这个窗口' | Out-Null; exit $code }
function Has($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Ask($question, $default) {
  $hint = if ($default) { '[Y/n]' } else { '[y/N]' }
  $answer = Read-Host "   $question $hint"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer.Trim().ToLower() -match '^(y|是|要|好|对|嗯|装|ok)'
}
# 刚装好的程序要重新读一遍 PATH 才找得到
function RefreshPath {
  $parts = @(
    [Environment]::GetEnvironmentVariable('Path', 'Machine'),
    [Environment]::GetEnvironmentVariable('Path', 'User'),
    "$env:USERPROFILE\.local\bin",
    "$env:APPDATA\npm"
  )
  $env:Path = ($parts | Where-Object { $_ }) -join ';'
}
$HasWinget = Has 'winget'
function WingetInstall($id, $name) {
  if (-not $HasWinget) { return $false }
  Say "   正在安装 $name（用 winget，要等几分钟；如果弹出管理员授权，点「是」）…"
  winget install -e --id $id --accept-package-agreements --accept-source-agreements --silent | Out-Host
  $ok = $LASTEXITCODE -eq 0
  RefreshPath
  return $ok
}
function NodeMajor {
  if (-not (Has 'node')) { return 0 }
  try { return [int]((node -v) -replace '^v(\d+).*$', '$1') } catch { return 0 }
}

Say ''
Say '  ClawChat 安装（Windows）' 'White'
Say "  文件夹：$Root"
Say '  以后别挪动这个文件夹；挪了的话，在新位置再运行一次 Install-Windows.cmd 就行。'

# 从网上下载解压的文件带着「来自网络」的标记，会一直弹安全提示：去掉
Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

$build = [Environment]::OSVersion.Version.Build
if ($build -lt 17763) { Warn "这台电脑的 Windows 10 版本太旧（需要 1809 或更新），有些功能可能用不了，建议先在「设置 → 更新」里更新系统。" }

RefreshPath

# ---------- Node.js ----------
Step '检查 Node.js（ClawChat 本身靠它运行）'
$major = NodeMajor
if ($major -lt 22) {
  if ($major -gt 0) { Warn "现在的 Node.js 是 $major 版，太旧了，需要 22 或更新" } else { Warn '没有找到 Node.js' }
  WingetInstall 'OpenJS.NodeJS.LTS' 'Node.js' | Out-Null
  $major = NodeMajor
}
if ($major -lt 22) {
  Warn '没能自动装好 Node.js。请打开 https://nodejs.org 下载「LTS」版本安装，装好后再双击一次 Install-Windows.cmd。'
  Start-Process 'https://nodejs.org/zh-cn/download'
  Done 1
}
$NodePath = (Get-Command node).Source
Ok "Node.js $(node -v)"

# ---------- Git ----------
Step '检查 Git（在线升级要用；Claude Code 跑命令也会用到）'
if (-not (Has 'git')) { WingetInstall 'Git.Git' 'Git' | Out-Null }
if (Has 'git') { Ok (git --version) } else { Warn '没装上 Git：不能在线升级，Claude / DeepSeek 跑命令也会改用 PowerShell。建议去 https://git-scm.com 下载安装后，再运行一次这个安装程序。' }

# ---------- Claude Code ----------
Step '检查 Claude Code（Claude 和 DeepSeek 都借它干活）'
if (-not (Has 'claude')) {
  Say '   没有找到 Claude Code。要用 Claude 得有 Claude 账号；只用 DeepSeek 也要装它，但不用登录。'
  if (Ask '现在安装 Claude Code 吗？' $true) {
    powershell -NoProfile -ExecutionPolicy Bypass -Command '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://claude.ai/install.ps1 | iex'
    RefreshPath
  }
}
$localBin = Join-Path $env:USERPROFILE '.local\bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ((Test-Path -LiteralPath (Join-Path $localBin 'claude.exe')) -and -not (($userPath -split ';') -contains $localBin)) {
  [Environment]::SetEnvironmentVariable('Path', ((@($userPath, $localBin) | Where-Object { $_ }) -join ';'), 'User')
  RefreshPath
}
if (Has 'claude') { Ok (claude --version) } else { Warn '没有 Claude Code：Claude 和 DeepSeek 暂时用不了。再运行一次这个安装程序就能补装。' }

# ---------- Codex（可选） ----------
Step '检查 Codex（群里的 ChatGPT，要有 ChatGPT 账号，可以不装）'
if (-not (Has 'codex')) {
  if (Ask '要装 Codex 吗？只用 DeepSeek / Claude 的话不用装' $false) {
    & npm.cmd install -g @openai/codex
    RefreshPath
    if ((Has 'codex') -and (Ask '现在登录 ChatGPT 账号吗？会打开浏览器' $true)) { codex login }
  }
}
if (Has 'codex') { Ok (codex --version) } else { Say '   没装 Codex，群里就先不拉 ChatGPT。以后想用，再运行一次这个安装程序。' }

# ---------- 接上 GitHub（在线升级） ----------
Step '接上 GitHub（以后在 设置 → 软件更新 里一键升级）'
$pkg = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $Root 'package.json') | ConvertFrom-Json
$repo = $pkg.repository
if ($repo -and -not ($repo -is [string])) { $repo = $repo.url }
$gitDir = Join-Path $Root '.git'
$linked = $false
if ((Test-Path -LiteralPath $gitDir) -and (Has 'git')) {
  git -C $Root rev-parse --abbrev-ref '@{u}' 2>$null | Out-Null
  $linked = $LASTEXITCODE -eq 0
  if (-not $linked) {
    # 上次停在最后一步（代码已经下好，只差关联分支）：补上
    git -C $Root branch -q --set-upstream-to=origin/main 2>$null | Out-Null
    git -C $Root rev-parse --abbrev-ref '@{u}' 2>$null | Out-Null
    $linked = $LASTEXITCODE -eq 0
  }
  # 上次接到一半就断了（比如登录窗口被关掉）：清掉重来。用 git clone 下载的不会走到这里
  if (-not $linked -and -not (git -C $Root rev-parse --verify -q HEAD 2>$null)) {
    Remove-Item -LiteralPath $gitDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
if ($linked) {
  Ok '已经接上了'
} elseif (Test-Path -LiteralPath $gitDir) {
  Warn '这个文件夹有自己的 git 记录，但没关联 GitHub 上的分支，先跳过（在线升级要用 git pull）'
} elseif (-not (Has 'git')) {
  Warn '没有 Git，先跳过'
} elseif (-not $repo) {
  Warn '不知道仓库地址，先跳过'
} else {
  Say "   正在连接 $repo（如果弹出 GitHub 登录窗口，请用能看到这个仓库的账号登录）…"
  git -C $Root init -q
  git -C $Root remote add origin "$repo.git"
  git -C $Root fetch -q origin main
  $ok = $LASTEXITCODE -eq 0
  if ($ok) {
    git -C $Root checkout -q -B main origin/main -f
    $ok = $LASTEXITCODE -eq 0
  }
  if ($ok) {
    git -C $Root branch -q --set-upstream-to=origin/main main
    $ok = $LASTEXITCODE -eq 0
  }
  if ($ok) {
    Ok '接上了，已经是最新版。以后有新版本，ClawChat 的「设置」上会亮一个小红点'
  } else {
    Remove-Item -LiteralPath (Join-Path $Root '.git') -Recurse -Force -ErrorAction SilentlyContinue
    Warn '连不上 GitHub（可能是网络问题，或者仓库是私有的、这个账号没有权限）。ClawChat 照样能用，只是不能在线升级。'
  }
}

# DeepSeek 的官方头像：从 DeepSeek 官方 GitHub 账号下载一份（不放进代码仓库）；下载不到就用内置的简笔头像
$dsIcon = Join-Path $Root 'public\icons\deepseek.png'
if (-not (Test-Path -LiteralPath $dsIcon)) {
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dsIcon) | Out-Null
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri 'https://avatars.githubusercontent.com/u/148330874?s=256' -OutFile $dsIcon
  } catch { Remove-Item -LiteralPath $dsIcon -ErrorAction SilentlyContinue }
}

# 记下 node.exe 的位置，桌面快捷方式用它启动（存成 UTF-16，路径里有中文也不怕）
Set-Content -LiteralPath (Join-Path $PSScriptRoot 'node-path.txt') -Value $NodePath -Encoding Unicode

# ---------- 快捷方式 ----------
Step '创建快捷方式'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$vbs = Join-Path $PSScriptRoot 'ClawChat.vbs'
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  if (-not $dir) { continue }
  $lnk = $shell.CreateShortcut((Join-Path $dir 'ClawChat.lnk'))
  $lnk.TargetPath = $wscript
  $lnk.Arguments = '"' + $vbs + '"'
  $lnk.WorkingDirectory = $Root
  $lnk.IconLocation = (Join-Path $PSScriptRoot 'ClawChat.ico') + ',0'
  $lnk.Description = 'ClawChat：本地 AI 群聊'
  $lnk.Save()
}
Ok '桌面和开始菜单里都有 ClawChat 了'

# ---------- 打开 ----------
Step '打开 ClawChat'
# 已经在后台运行的（比如重新安装、刚升级过代码）先关掉，再用新代码打开
try {
  Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:7317/api/app/quit' -Headers @{ 'x-clawchat' = '1' } -TimeoutSec 3 | Out-Null
  Start-Sleep -Seconds 2
} catch {}
Start-Process $wscript -ArgumentList ('"' + $vbs + '"')

Say ''
Say '装好了！' 'Green'
Say '  · 用 DeepSeek：在 ClawChat 左下角点「设置」→「程序与模型」，填上 DeepSeek 的 API Key'
Say '    （在 https://platform.deepseek.com/api_keys 创建，需要先充值一点余额）。'
Say '  · 用 Claude：在开始菜单打开「命令提示符」，运行一次 claude，按提示登录 Claude 账号。'
Say '  · 以后双击桌面上的 ClawChat 就能打开。关掉窗口它会在后台接着干活；'
Say '    要彻底退出，在「设置 → 通用」里点「退出 ClawChat」。'
Done 0
