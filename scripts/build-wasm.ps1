# 构建 WASM 回放解析产物到 frontend/public/wasm/（vite build 会拷入 dist，rust-embed 随之伺服 /wasm/*）。
# 用法：powershell -File scripts/build-wasm.ps1   （需 rustup target wasm32-unknown-unknown + wasm-bindgen-cli，版本与 Cargo.lock 一致）
$ErrorActionPreference = 'Stop'

$VERSION = (cargo metadata --format-version 1 --no-deps | ConvertFrom-Json).packages |
    Where-Object { $_.name -eq 'wasm-bindgen' } | Select-Object -First 0
# wasm-bindgen CLI 版本必须与依赖 crate 精确一致（Cargo.lock 锁定）
$BINDGEN_VERSION = (cargo tree -i wasm-bindgen --depth 0 2>$null | Select-String 'wasm-bindgen v').ToString() -replace '.*v', ''
Write-Host "wasm-bindgen: $BINDGEN_VERSION"

cargo build -p wotb-replay-wasm --release --target wasm32-unknown-unknown
if ($LASTEXITCODE -ne 0) { exit 1 }

$OUT = "$PSScriptRoot\..\frontend\public\wasm"
New-Item -ItemType Directory -Force -Path $OUT | Out-Null
wasm-bindgen --version | Out-Null
& wasm-bindgen "$PSScriptRoot\..\target\wasm32-unknown-unknown\release\wotb_replay_wasm.wasm" `
    --out-dir $OUT --target web --out-name wotb_replay_wasm
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host "产物已输出: $OUT（/wasm/wotb_replay_wasm.js）"
