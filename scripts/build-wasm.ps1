# 构建 WASM 回放解析产物到 frontend/public/wasm/（vite build 会拷入 dist，rust-embed 随之伺服 /wasm/*）。
#
# 用法：powershell -File scripts/build-wasm.ps1
# 依赖：rustup target add wasm32-unknown-unknown；cargo install -f wasm-bindgen-cli --version <见下方 lock 值>
#
# 本文件必须保存为 UTF-8 **带 BOM**：PowerShell 5.1 会把无 BOM 的 .ps1 按系统 ANSI 码页读，
# 中文提示被截断，报"字符串缺少终止符"解析失败（历史故障）。

# 原生命令（cargo / wasm-bindgen）正常会向 stderr 写进度，Stop 偏好会把它们当作终止错误——
# 故此处用 Continue，并逐处检查 $LASTEXITCODE。
$ErrorActionPreference = 'Continue'

# wasm-bindgen CLI 版本必须与 Cargo.lock 锁定的依赖精确一致，否则产物与 JS 胶水不匹配。
# 版本改从 Cargo.lock 读：`cargo tree -i wasm-bindgen --depth 0` 在本工作区会向 stderr 输出
# "warning: nothing to print."，既取不到版本，又会在 Stop 偏好下中断脚本。
$lock = Get-Content "$PSScriptRoot\..\Cargo.lock" -Raw
if ($lock -notmatch '(?ms)name = "wasm-bindgen"\s*\r?\nversion = "([^"]+)"') {
    Write-Error 'Cargo.lock 中找不到 wasm-bindgen 版本'
    exit 1
}
$want = $Matches[1]
$have = (& wasm-bindgen --version) -replace '^wasm-bindgen\s+', ''
if ($LASTEXITCODE -ne 0) { Write-Error '未找到 wasm-bindgen CLI'; exit 1 }
Write-Host "wasm-bindgen: lock=$want cli=$have"
if ($have.Trim() -ne $want) {
    Write-Error "wasm-bindgen CLI 版本 ($have) 与 Cargo.lock ($want) 不一致；请 cargo install -f wasm-bindgen-cli --version $want"
    exit 1
}

cargo build -p wotb-replay-wasm --release --target wasm32-unknown-unknown
if ($LASTEXITCODE -ne 0) { exit 1 }

$OUT = "$PSScriptRoot\..\frontend\public\wasm"
New-Item -ItemType Directory -Force -Path $OUT | Out-Null
& wasm-bindgen "$PSScriptRoot\..\target\wasm32-unknown-unknown\release\wotb_replay_wasm.wasm" `
    --out-dir $OUT --target web --out-name wotb_replay_wasm
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host "产物已输出: $OUT (/wasm/wotb_replay_wasm.js)"
