// 数据模型层：battle / replay_dataset 已上移核心库（垫片 re-export，调用点零改动）；
// report（聚合报告）与 config（全局配置与 Token 统计）是服务端视角，留在本 crate。
pub use wotb_replay_core::models::{battle, replay_dataset};
pub mod config;
pub mod report;
