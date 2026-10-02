//! wotb-agent 库形态入口：桌面 CLI（`main.rs`）复用全部业务模块。
//!
//! `data::set_base_dir()` 可把 data/（静态库/缓存/会话）等相对路径整体重定向到
//! 应用私有目录——2026-10 移除移动端（Tauri）壳后，本机无人再调用它；保留该
//! 能力供任何"需要私有数据目录"的宿主复用。

pub mod agent;
pub mod data;
pub mod facets;
#[cfg(feature = "bundle")]
pub mod bundle;
pub mod models;
pub mod replay;
pub mod wargaming;
pub mod web;
