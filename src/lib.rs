//! wotb-agent 库形态入口：桌面 CLI（`main.rs`）与移动端 Tauri 壳
//! （`mobile/src-tauri`，路径依赖本 crate）共用全部业务模块。
//!
//! 移动端启动时先 `data::set_base_dir(应用私有目录)` 再触碰任何文件访问，
//! 之后 data/、glb_cache/、tank_images/、web/vendor 等相对路径全部落在私有目录。

pub mod agent;
pub mod data;
#[cfg(feature = "bundle")]
pub mod bundle;
pub mod models;
pub mod replay;
pub mod wargaming;
pub mod web;
