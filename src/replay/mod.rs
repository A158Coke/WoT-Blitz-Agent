// 回放解析层已上移至核心库 `wotb-replay-core`（crates/replay-core，架构契约第 4 节的
// Rust Core 载体：零网络依赖，可编译原生与 wasm32 双目标）。本模块是兼容垫片：
// 存量调用点（`crate::replay::combat::…`）零改动；新代码建议直接引 `wotb_replay_core`。
pub use wotb_replay_core::replay::{combat, filter, model, packets, parser, playback, scanner};

// 玩家开局配置与弹种映射（loadout）：依赖服务端 BlitzKit 坦克表静态缓存（crate::data IO），
// 属服务端增值标注而非解析核心，留在本 crate。
pub mod loadout;
