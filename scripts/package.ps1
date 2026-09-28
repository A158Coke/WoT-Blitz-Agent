# wotb-agent 打包分发脚本（Windows）
#
# 产出两种形态，均为压缩包（在仓库根目录运行）：
#   powershell -ExecutionPolicy Bypass -File scripts\package.ps1 -All         # 一键重新打包：轻量 zip + 全量 zip + 全量目录（改完代码用这个）
#   powershell -ExecutionPolicy Bypass -File scripts\package.ps1              # 仅轻量便携 zip（~18MB，模型联网懒下载）
#   powershell -ExecutionPolicy Bypass -File scripts\package.ps1 -Full        # 仅全量：zip（~1.9GB）+ 同名目录，完全离线
#   -SkipBuild   跳过构建，直接用现有 target/release/wotb-agent.exe（只改了数据/文档时用）
#
# 依赖：Node.js（Vue 前端构建，见 frontend/）；构建统一走 scripts\build-all.ps1。
#
# 产物（默认在 dist/）：
#   wotb-agent-portable-win64.zip          轻量便携包
#   wotb-agent-portable-win64-full.zip     全量离线包（-Full/-All）
#   wotb-agent-portable-win64\             全量便携目录（-Full/-All，zip 的解压版）
#
# 注意：绝不会打包真实 config.toml（含密钥），只带 config.toml.example 模板。

param(
    [switch]$Full,
    [switch]$All,
    [switch]$SkipBuild,
    [string]$OutDir = "dist"
)

# -All = 一键产出全部产物
if ($All) { $Full = $true }

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$exe = "target/release/wotb-agent.exe"

# ---- 1. 构建（前端 npm build → cargo build --release，release 编译期嵌入 frontend/dist）----
if (-not $SkipBuild) {
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "build-all.ps1")
    if ($LASTEXITCODE -ne 0) { throw "build-all.ps1 失败" }
}
if (-not (Test-Path $exe)) { throw "未找到 $exe，请先执行 scripts\build-all.ps1" }

# ---- 2. 组装便携目录 ----
$stage = Join-Path $OutDir "wotb-agent-portable-win64"
if (Test-Path $stage) {
    try {
        Remove-Item -Recurse -Force $stage -ErrorAction Stop
    } catch {
        throw "无法清空 $stage —— 目录很可能正在运行（如双击过 start-web.bat）。请先关闭 wotb-agent.exe 再打包。"
    }
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# robocopy 返回码 0-7 均为成功
function Copy-Tree($src, $dst, $excludeDirs = @()) {
    if (-not (Test-Path $src)) { throw "缺少目录: $src" }
    $rcArgs = @($src, $dst, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
    foreach ($d in $excludeDirs) { $rcArgs += @("/XD", $d) }
    & robocopy @rcArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 复制 $src 失败（exit=$LASTEXITCODE）" }
}

Copy-Item $exe (Join-Path $stage "wotb-agent.exe")
Copy-Item config.toml.example $stage/
Copy-Item README.md $stage/
Copy-Tree "data"          (Join-Path $stage "data")          @("sessions", "cache")   # sessions 为运行时会话；cache 为运行时缓存（GLB/底图/封面/地形），仅全量包内置
Copy-Tree "data/replay_samples" (Join-Path $stage "data/replay_samples")

# 启动器：cmd 用纯 ASCII，避免编码问题
@"
@echo off
cd /d "%~dp0"
wotb-agent.exe web
pause
"@ | Set-Content -Path (Join-Path $stage "start-web.bat") -Encoding Ascii

# 使用说明：UTF-8 BOM，老版记事本也能正常显示中文
$readme = @"
WoTB Blitz Tactics Agent - 便携版使用说明
==========================================

一、启动
  双击 start-web.bat（或命令行运行: wotb-agent.exe web）
  启动后会自动打开浏览器访问 http://127.0.0.1:18999

二、首次配置
  1. 把 config.toml.example 复制一份，重命名为 config.toml
     （首次运行会自动生成，可直接改）
  2. WG API 的 application_id 已自带可用的公开 key，无需修改
  3. LLM 的 api_key 需要填入你自己的 key（也可启动后在
     网页 Settings - Model Config 里在线填写并保存）

三、3D 模型说明
  轻量包：首次查看某坦克的 3D 装甲/真实车模时会自动联网下载到
  data/cache/models/ 目录，之后离线可用。
  全量包：已内置全部模型，无需联网。

四、常用命令（命令行运行 wotb-agent.exe <命令>）
  web            Web 图形界面（推荐）
  scan <目录>    批量扫描回放目录生成报告
  single <文件>  解析单个回放
  playback <文件> 全场实时回放
  update-data    游戏版本更新后一键刷新数据
  fetch-models   全量预下载坦克模型（轻量包转离线）
  --help         查看全部命令

五、数据与目录
  全部数据/缓存均在解压目录内（data/，其中 data/cache/ 为模型/底图/封面/
  地形缓存），整个文件夹可随意移动。data/ 是必需的运行数据，请勿删除；
  如需重置数据，重新解压安装包即可。
"@
[System.IO.File]::WriteAllText((Join-Path $stage "使用说明.txt"), $readme, (New-Object System.Text.UTF8Encoding($true)))

# ---- 3. 压缩轻量 zip（必须在附加大体积缓存之前压，保证 zip 始终轻量） ----
$zipPath = Join-Path $OutDir "wotb-agent-portable-win64.zip"
$needZip = (-not $Full) -or $All
if ($needZip) {
    if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
    Write-Host "压缩 $stage -> $zipPath ..."
    Compress-Archive -Path "$stage/*" -DestinationPath $zipPath -CompressionLevel Optimal
}

# ---- 4. 全量附加（完全离线；robocopy 增量复制，缓存没变时很快） ----
if ($Full) {
    if (Test-Path "data/cache") {
        Write-Host "复制 data/cache/（约 2GB，增量复制，请稍候）..."
        Copy-Tree "data/cache" (Join-Path $stage "data/cache")
    } else {
        Write-Warning "未找到 data/cache/，跳过。可先运行: wotb-agent.exe fetch-models"
    }
}

# ---- 5. 压缩全量 zip ----
# 用 scripts/zipdir.py（python zipfile）：ZIP64 无 2GB 上限、GLB/图片直接存储不二次压缩、
# 中文文件名按 UTF-8 标记写入。无 python 时回退 Compress-Archive（慢，且超 2GB 会失败）。
if ($Full) {
    $fullZip = Join-Path $OutDir "wotb-agent-portable-win64-full.zip"
    if (Test-Path $fullZip) { Remove-Item -Force $fullZip }
    Write-Host "压缩 $stage -> $fullZip ..."
    if (Get-Command python -ErrorAction SilentlyContinue) {
        python (Join-Path $PSScriptRoot "zipdir.py") $stage $fullZip
        if ($LASTEXITCODE -ne 0) { throw "zipdir.py 压缩失败" }
    } else {
        Write-Warning "未找到 python，回退 Compress-Archive（较慢；目录总大小超 2GB 时会失败）"
        Compress-Archive -Path "$stage/*" -DestinationPath $fullZip -CompressionLevel Fastest
    }
}

# ---- 6. 汇总 ----
function Size-Of($path) {
    if (Test-Path $path -PathType Container) {
        "{0:N1} MB" -f ((Get-ChildItem $path -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
    } else {
        "{0:N1} MB" -f ((Get-Item $path).Length / 1MB)
    }
}
Write-Host ""
Write-Host "===== 打包完成 ====="
Write-Host ("  便携目录     {0}  ({1})" -f $stage, (Size-Of $stage))
if ($needZip) { Write-Host ("  轻量 zip     {0}  ({1})" -f $zipPath, (Size-Of $zipPath)) }
if ($Full) {
    Write-Host "  全量目录     $stage（含 data/cache 完全离线）"
    Write-Host ("  全量 zip     {0}  ({1})" -f (Join-Path $OutDir "wotb-agent-portable-win64-full.zip"), (Size-Of (Join-Path $OutDir "wotb-agent-portable-win64-full.zip")))
}
