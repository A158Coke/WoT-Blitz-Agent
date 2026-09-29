//! wotb-replay-core：回放解析的纯核心库（架构契约第 4/5 节的 Rust Core 载体）。
//!
//! 边界约定：
//! - **零网络依赖**（无 reqwest/tokio/axum）：可编译原生与 wasm32 双目标，
//!   阶段 3 的浏览器通道（.wotbreplay → 浏览器文件接口 → WASM → 切面）由本库承载；
//! - 唯一事实源：回放解析（`replay`）、领域数据模型（`models`）、切面投影（`facets`）
//!   都在这里；服务端 crate（wotb-agent）经 `src/replay` 等垫片模块 re-export，
//!   存量调用点（`crate::replay::combat::…`）不改一行；
//! - 不绑定 IO/配置：`TankNames` trait 由服务端 `TankResolver` 实现（读 tank_cache.json），
//!   文件路径、CDN、缓存全部留在服务端 crate。

pub mod facets;
pub mod models;
pub mod replay;
pub mod wargaming;
