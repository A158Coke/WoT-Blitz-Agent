// Vue 前端构建产物前置检查：rust-embed 在 release 构建编译期需要 frontend/dist 存在。
// 标准构建入口是 scripts/build-all.ps1（npm build → cargo build）。
//
// 仅对真正消费产物的构建（release 嵌入 / bundle 特性）硬性要求；debug 测试构建
// （cargo test，rust-embed 运行时读盘）不要求——否则 CI 的纯 Rust 作业必须先装
// Node 工具链才能跑测试，本机未构建前端也会卡住新克隆者。
use std::path::Path;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let index = Path::new(&manifest).join("frontend/dist/index.html");
    if !index.exists() {
        let is_release = std::env::var("PROFILE").map(|p| p == "release").unwrap_or(false);
        let bundling = std::env::var("CARGO_FEATURE_BUNDLE").is_ok();
        if is_release || bundling {
            panic!(
                "\n\nfrontend/dist/index.html 不存在 —— Vue 前端尚未构建。\n  \
                 先运行: cd frontend && npm ci && npm run build\n  \
                 或一键: powershell -ExecutionPolicy Bypass -File scripts\\build-all.ps1\n"
            );
        }
        // debug 测试构建：rust-embed 宏在编译期硬性要求目录存在——生成占位 dist
        // （frontend/dist 已 gitignore；占位页仅在被未构建前端的 debug 服务命中时可见）
        let dir = index.parent().expect("dist 路径必有父目录");
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(
            &index,
            "<!doctype html><meta charset=\"utf-8\"><title>WotB Agent</title>\
             <p>前端尚未构建：cd frontend && npm ci && npm run build</p>\n",
        );
        println!("cargo:warning=frontend/dist 不存在——已生成占位（debug 测试构建）；release/bundle 构建前先 cd frontend && npm run build");
    }
    println!("cargo:rerun-if-changed=build.rs");
}
