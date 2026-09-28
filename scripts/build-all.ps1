# 一键构建：Vue 前端（frontend/ → dist/）+ Rust 后端。
# release 构建在编译期嵌入 frontend/dist（build.rs 有前置检查），因此 cargo build 前必须先构建前端。
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-all.ps1                # 前端 + release 后端
#   powershell -ExecutionPolicy Bypass -File scripts\build-all.ps1 -Debug         # 前端 + debug 后端
#   powershell -ExecutionPolicy Bypass -File scripts\build-all.ps1 -SkipFrontend  # 跳过前端（仅改了 Rust 代码）
#
# 日常开发（免重编译迭代）：后端 `cargo run -- web` + 前端 `cd frontend && npm run dev`（5173 端口，代理到 18999）。

param(
    [switch]$Debug,
    [switch]$SkipFrontend
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $SkipFrontend) {
    Push-Location frontend
    try {
        if (-not (Test-Path "node_modules")) {
            Write-Host "==> npm ci (frontend)"
            npm ci
            if ($LASTEXITCODE -ne 0) { throw "npm ci 失败" }
        }
        Write-Host "==> npm run build (frontend)"
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build 失败" }
    } finally { Pop-Location }
}

Write-Host "==> cargo build"
if ($Debug) { cargo build } else { cargo build --release }
if ($LASTEXITCODE -ne 0) { throw "cargo build 失败" }
Write-Host "构建完成。"
