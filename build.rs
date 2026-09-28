// Vue 前端构建产物前置检查：rust-embed 在 release 构建编译期需要 frontend/dist 存在。
// 标准构建入口是 scripts/build-all.ps1（npm build → cargo build）。
use std::path::Path;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let index = Path::new(&manifest).join("frontend/dist/index.html");
    if !index.exists() {
        panic!(
            "\n\nfrontend/dist/index.html 不存在 —— Vue 前端尚未构建。\n  \
             先运行: cd frontend && npm ci && npm run build\n  \
             或一键: powershell -ExecutionPolicy Bypass -File scripts\\build-all.ps1\n"
        );
    }
    println!("cargo:rerun-if-changed=build.rs");
}
