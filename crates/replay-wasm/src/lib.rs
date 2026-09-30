//! 浏览器通道解析入口（架构契约第 6 节）：`.wotbreplay` 字节 → 核心库 → 独立能力 JSON。
//!
//! 能力边界（契约 v2）：Agent Rust Core 只暴露**结果解释**与**时序解释**两个维度，
//! 消费方（WotBTools）按需取用——只要结果时不得被迫物化全场时序（~10MB 级），
//! 时序消费也不依赖结果通道。名人堂（HoF）是消费方产品域：由消费方从结果能力
//! 自行投影，Agent 公开面不感知（此前 giant envelope `{playback,ai,hof}` 已拆除，
//! breaking，不做双 API 兼容）。
//!
//! JS 入口（wasm32，`js` 模块）：
//! - `parseResult(bytes)`    → 结算 JSON（BattleSummary：花名册/胜负/地图/全员统计）；
//!   只读 meta + battle_results，**不读包流、不建时序模型**，单文件毫秒级；
//! - `parsePlayback(bytes)`  → PlaybackData JSON（位姿网格/弹道/击杀/阶段/可见性）；
//! - `parseShotReplays(bytes)` → 全员射击链 JSON 数组（弹道/命中判定/质量标记/渲染锚点）。
//!
//! 客户端路径的已知取舍（与服务端路径的差异，均为数据可得性而非实现差异）：
//! - 无 tank_cache / models.pb：`tank_name` 空串、`gun_pitch` 走车体 pitch 兜底、
//!   无俯仰极限锚定（逐发质量标记如实透传）；前端可按 tank_id 自行映射展示名。
//!   俯仰锚定与弹种反解均可由消费方经可选参数注入（`limits_json` / `shells_json`，
//!   数据源 = 静态资产面 / `dump-shell-kinds` 产物），注入后与服务端路径同级；
//! - 无地图显示名注册表：`map_name` 为解析器枚举名，前端以 `map_id` 键控底图与语义。
//!
//! 纯逻辑不依赖平台 API，原生与 wasm32 同构、原生可测（tests/facets_smoke.rs）。

use std::collections::HashMap;
use std::io::Cursor;

use wotb_replay_core::replay::combat::GunPitchLimits;
use wotb_replay_core::replay::model::{ReplayModel, ScanInput};
use wotb_replay_core::replay::parser::ReplayParser;
use wotb_replay_core::replay::playback::{PlaybackInput, PlaybackPlayer};

/// 包流解码（三能力共用的类型映射步）：payload → (type, clock, raw)。
fn decode_packets<R: std::io::Read + std::io::Seek>(
    replay: &mut wotbreplay_parser::replay::Replay<R>,
) -> anyhow::Result<Vec<(u32, f32, Vec<u8>)>> {
    let data = replay.read_data()?;
    Ok(data.packets.iter()
        .map(|pkt| {
            let t = match &pkt.payload {
                wotbreplay_parser::models::data::payload::Payload::EntityMethod(_) => 8,
                wotbreplay_parser::models::data::payload::Payload::BasePlayerCreate { .. } => 0,
                wotbreplay_parser::models::data::payload::Payload::Unknown { packet_type } => *packet_type,
            };
            (t, pkt.clock_secs, pkt.raw_payload.to_vec())
        })
        .collect())
}

fn roster_of(summary: &wotb_replay_core::models::battle::BattleSummary) -> Vec<PlaybackPlayer> {
    summary.players.iter()
        .map(|p| PlaybackPlayer {
            account_id: p.account_id,
            nickname: p.nickname.clone(),
            team: p.team,
            tank_id: p.tank_id,
        })
        .collect()
}

/// 结果能力（Result interpretation）：字节 → BattleSummary JSON。
/// 只解析 meta + battle_results——**不读包流、不建时序模型**，单文件毫秒级，
/// 供批量扫描与消费方 HoF 投影（HoF 不是 Agent 公开能力，见契约 v2）。
pub fn result_json(bytes: &[u8]) -> anyhow::Result<String> {
    let mut replay = wotbreplay_parser::replay::Replay::open(Cursor::new(bytes))?;
    let summary = ReplayParser::new().parse_replay(&mut replay, "client.wotbreplay")?;
    Ok(serde_json::to_string(&summary)?)
}

/// 时序能力（Temporal interpretation）：字节 → PlaybackData JSON。
/// 单次扫描构建全场时序（与服务端 `/api/playback/data` 同一构建语义）。
pub fn playback_json(bytes: &[u8]) -> anyhow::Result<String> {
    let mut replay = wotbreplay_parser::replay::Replay::open(Cursor::new(bytes))?;
    let summary = ReplayParser::new().parse_replay(&mut replay, "client.wotbreplay")?;
    let packets = decode_packets(&mut replay)?;
    let packets: Vec<(u32, f32, &[u8])> = packets.iter()
        .map(|(t, c, raw)| (*t, *c, raw.as_slice()))
        .collect();

    let limits = GunPitchLimits::new();
    let model = ReplayModel::scan(&ScanInput {
        packets: &packets,
        roster: &roster_of(&summary),
        author_account_id: summary.author_account_id,
        pitch_limits: &limits,
    })?;
    let input = PlaybackInput {
        packets: &packets,
        players: roster_of(&summary),
        author_account_id: summary.author_account_id,
        winner_team: summary.winner_team,
        map_id: summary.map_id,
        map_name: summary.map_name.clone(),
        pitch_limits: &limits,
        tank_names: HashMap::new(),
    };
    let playback = wotb_replay_core::replay::playback::from_model(&model, &input)?;
    Ok(serde_json::to_string(&playback)?)
}

/// 射击复现通道：字节 → 全员射击链（作者严格路径 + 他人宽松路径合并，含弹道/
/// 命中判定/逐发质量标记/双方渲染锚点）。形状与上游 Web `/api/replay/shots` 的
/// shots 数组同构，供 WotBTools 射击复现视图直接消费（three.js 渲染在消费方）。
/// 注意：两路合并后 index 为局部值，消费方须按 time_s 全局重编号（契约 §shots）。
///
/// `limits_json`：可选的俯仰锚定表（{昵称: {dep, ele, front?, back?, transition?}}，
/// GunPitchRange serde 形状——消费方由资产面 tank/{id}.json 的 pitch_limits 换算
/// dep=max、ele=−min）。服务端路径由 TankResolver 注入同名锚定；客户端路径
/// 缺省为空表——空表下 prop2 frac 无法按车型极限解码，逐发俯仰降级标记会
/// 如实透传（质量边界，非错误）。
///
/// `shells_json`：可选的全局弹种反解表（`wotb-agent dump-shell-kinds` 产物，
/// {全局弹种 id: {type, penetration, damage, module_damage, explosion_radius}}）。
/// 注入后每发输出补齐 `shell_kind`（与上游 annotate 同源）与 `shell`（完整弹
/// 数据，徽标/判定直接消费）——消费方渲染侧不再需要自带弹种表或槽位兜底；
/// 缺省时 shell_kind 保持空串、无 shell 字段（数据可得性边界，非错误）。
pub fn shot_replays_json(bytes: &[u8], limits_json: Option<&str>, shells_json: Option<&str>) -> anyhow::Result<String> {
    let mut replay = wotbreplay_parser::replay::Replay::open(Cursor::new(bytes))?;
    let summary = ReplayParser::new().parse_replay(&mut replay, "client.wotbreplay")?;
    let packets = decode_packets(&mut replay)?;
    let packets: Vec<(u32, f32, &[u8])> = packets.iter()
        .map(|(t, c, raw)| (*t, *c, raw.as_slice()))
        .collect();

    let author_nick = summary.players.iter()
        .find(|p| p.account_id == summary.author_account_id)
        .map(|p| p.nickname.clone())
        .unwrap_or_default();
    let author_eid = wotb_replay_core::replay::combat::resolve_author_player_eid_by_nick(&packets, &author_nick);
    let limits: GunPitchLimits = match limits_json {
        Some(s) if !s.is_empty() => serde_json::from_str(s).unwrap_or_default(),
        _ => GunPitchLimits::new(),
    };

    // 作者严格路径 + 他人宽松路径合并（与 playback::collect_all_shots 同构；
    // 严格路径失败降级宽松全路径——全场回放不应因单路径失败不可用）
    let mut shots = wotb_replay_core::replay::combat::extract_shot_replays_auto_with_limits(
        &packets, &author_nick, &limits).unwrap_or_default();
    shots.extend(wotb_replay_core::replay::combat::extract_other_shot_replays_with_limits(
        &packets, author_eid, &limits).shots);
    shots.sort_by(|a, b| a.fire_time.partial_cmp(&b.fire_time).unwrap());

    // 弹种反解注入（服务端 annotate + shell 字段注入的客户端等价）：表缺失时
    // 原样输出（消费方按缺数据处理）
    let mut out = serde_json::to_value(&shots)?;
    if let Some(table) = shells_json.filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(s).ok())
    {
        if let Some(arr) = out.as_array_mut() {
            for v in arr.iter_mut() {
                let shell_id = v.get("shell_id").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                if shell_id == 0 { continue; }
                let Some(entry) = table.get(&shell_id.to_string()) else { continue };
                if v.get("shell_kind").and_then(|x| x.as_str()).map(str::is_empty).unwrap_or(true) {
                    if let Some(t) = entry.get("type").and_then(|x| x.as_str()) {
                        v["shell_kind"] = serde_json::Value::String(t.to_string());
                    }
                }
                v["shell"] = entry.clone();
            }
        }
    }
    Ok(serde_json::to_string(&out)?)
}

#[cfg(target_arch = "wasm32")]
mod js {
    use wasm_bindgen::prelude::*;

    /// JS 入口（结果能力）：`parseResult(new Uint8Array(fileBuffer))` → BattleSummary
    /// JSON 字符串。只读 meta + battle_results（毫秒级），不物化全场时序。
    /// 解析失败以字符串 Error 拒绝（含链式原因），不 panic 跨界。
    #[wasm_bindgen(js_name = parseResult)]
    pub fn parse_result(bytes: &[u8]) -> Result<String, JsValue> {
        super::result_json(bytes)
            .map_err(|e| JsValue::from_str(&format!("result parse failed: {e:#}")))
    }

    /// JS 入口（时序能力）：`parsePlayback(new Uint8Array(fileBuffer))` → PlaybackData
    /// JSON 字符串（位姿网格/弹道/击杀/阶段/可见性）。
    #[wasm_bindgen(js_name = parsePlayback)]
    pub fn parse_playback(bytes: &[u8]) -> Result<String, JsValue> {
        super::playback_json(bytes)
            .map_err(|e| JsValue::from_str(&format!("playback parse failed: {e:#}")))
    }

    /// JS 入口（射击复现用）：`parseShotReplays(new Uint8Array(fileBuffer), limitsJson?, shellsJson?)`
    /// → 全员射击链 JSON 数组字符串（弹道/命中判定/质量标记/渲染锚点）。
    /// `limitsJson` 可选：俯仰锚定表 JSON（{昵称: GunPitchRange}，消费方由资产面
    /// tank/{id}.json 的 pitch_limits 组装 dep=max、ele=−min）——注入后 prop2 俯仰
    /// 按车型极限解码（与服务端路径同级）；缺省空表时俯仰降级标记如实透传。
    /// `shellsJson` 可选：全局弹种反解表 JSON（`wotb-agent dump-shell-kinds` 产物，
    /// {全局弹种 id: {type, penetration, damage, module_damage, explosion_radius}}）——
    /// 注入后每发补齐 `shell_kind` 与 `shell`（完整弹数据）；缺省时无弹种反解。
    #[wasm_bindgen(js_name = parseShotReplays)]
    pub fn parse_shot_replays(bytes: &[u8], limits: Option<String>, shells: Option<String>) -> Result<String, JsValue> {
        super::shot_replays_json(bytes, limits.as_deref(), shells.as_deref())
            .map_err(|e| JsValue::from_str(&format!("shot replay parse failed: {e:#}")))
    }
}
