//! 浏览器通道解析入口（架构契约第 6 节）：`.wotbreplay` 字节 → 核心库 → 三数据切面。
//!
//! 分层：纯逻辑 [`build_facets`] 不依赖任何平台 API，原生与 wasm32 同构、原生可测；
//! wasm-bindgen 绑定（`js` 模块）仅在 wasm32 编译，JS 侧调用
//! `parseReplayFacets(bytes)` 得到 `{"playback":{…},"ai":{…},"hof":{…}}` 信封。
//!
//! 客户端路径的已知取舍（与服务端路径的差异，均为数据可得性而非实现差异）：
//! - 无 tank_cache / models.pb：`tank_name` 空串、`gun_pitch` 走车体 pitch 兜底、
//!   无俯仰极限锚定（逐发质量标记如实透传）；前端可按 tank_id 自行映射展示名；
//! - 无地图显示名注册表：`map_name` 为解析器枚举名，前端以 `map_id` 键控底图与语义。

use std::collections::HashMap;
use std::io::Cursor;

use wotb_replay_core::replay::combat::GunPitchLimits;
use wotb_replay_core::replay::model::{ReplayModel, ScanInput};
use wotb_replay_core::replay::parser::ReplayParser;
use wotb_replay_core::replay::playback::{PlaybackInput, PlaybackPlayer};

/// 三切面产物（字段为已序列化的 JSON；[`ReplayFacets::envelope_json`] 组装单信封）。
pub struct ReplayFacets {
    /// 回放切面（PlaybackData：位姿网格/弹道/击杀/阶段/可见性）
    pub playback: String,
    /// 评审切面（花名册 + 类型化事件流 + 结算锚点）
    pub ai: String,
    /// 名人堂切面（结算精简行）
    pub hof: String,
}

impl ReplayFacets {
    /// 信封：`{"playback":{…},"ai":{…},"hof":{…}}`。各切面串由 serde 序列化产出、
    /// 自包含即合法 JSON 值，直接拼装即可——此前 from_str 回 parse 成 Value 再整体
    /// to_string，PlaybackData（MB 级位姿网格）多付一整轮解析+序列化。
    pub fn envelope_json(&self) -> anyhow::Result<String> {
        let mut out = String::with_capacity(
            self.playback.len() + self.ai.len() + self.hof.len() + 32);
        out.push_str("{\"playback\":");
        out.push_str(&self.playback);
        out.push_str(",\"ai\":");
        out.push_str(&self.ai);
        out.push_str(",\"hof\":");
        out.push_str(&self.hof);
        out.push('}');
        Ok(out)
    }
}

/// 字节 → 单次扫描 → 三切面。扫描一次共享给三个投影（与服务端 `/api/playback/data`
/// 同一构建语义，JS 侧可用同一套渲染代码无缝切换数据源）。
pub fn build_facets(bytes: &[u8]) -> anyhow::Result<ReplayFacets> {
    let mut replay = wotbreplay_parser::replay::Replay::open(Cursor::new(bytes))?;
    let summary = ReplayParser::new().parse_replay(&mut replay, "client.wotbreplay")?;
    let data = replay.read_data()?;
    let packets: Vec<(u32, f32, &[u8])> = data.packets.iter()
        .map(|pkt| {
            let t = match &pkt.payload {
                wotbreplay_parser::models::data::payload::Payload::EntityMethod(_) => 8,
                wotbreplay_parser::models::data::payload::Payload::BasePlayerCreate { .. } => 0,
                wotbreplay_parser::models::data::payload::Payload::Unknown { packet_type } => *packet_type,
            };
            (t, pkt.clock_secs, &pkt.raw_payload[..])
        })
        .collect();

    let roster: Vec<PlaybackPlayer> = summary.players.iter()
        .map(|p| PlaybackPlayer {
            account_id: p.account_id,
            nickname: p.nickname.clone(),
            team: p.team,
            tank_id: p.tank_id,
        })
        .collect();
    let limits = GunPitchLimits::new();
    let model = ReplayModel::scan(&ScanInput {
        packets: &packets,
        roster: &roster,
        author_account_id: summary.author_account_id,
        pitch_limits: &limits,
    })?;
    let input = PlaybackInput {
        packets: &packets,
        players: roster,
        author_account_id: summary.author_account_id,
        winner_team: summary.winner_team,
        map_id: summary.map_id,
        map_name: summary.map_name.clone(),
        pitch_limits: &limits,
        tank_names: HashMap::new(),
    };
    let playback = wotb_replay_core::replay::playback::from_model(&model, &input)?;
    let ai = wotb_replay_core::facets::AiReviewFacet::from_model(&model, &summary);
    let hof = wotb_replay_core::facets::HofFacet::from_settlement(&summary);

    Ok(ReplayFacets {
        playback: serde_json::to_string(&playback)?,
        ai: serde_json::to_string(&ai)?,
        hof: serde_json::to_string(&hof)?,
    })
}

#[cfg(target_arch = "wasm32")]
mod js {
    use wasm_bindgen::prelude::*;

    /// JS 入口：`parseReplayFacets(new Uint8Array(fileBuffer))` → 切面信封 JSON 字符串。
    /// 解析失败以字符串 Error 拒绝（含链式原因），不 panic 跨界。
    #[wasm_bindgen(js_name = parseReplayFacets)]
    pub fn parse_replay_facets(bytes: &[u8]) -> Result<String, JsValue> {
        super::build_facets(bytes)
            .and_then(|f| f.envelope_json())
            .map_err(|e| JsValue::from_str(&format!("replay parse failed: {e:#}")))
    }
}
