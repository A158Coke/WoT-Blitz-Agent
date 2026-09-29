//! 消费方数据切面（架构契约第 5 节）：Rust 内部模型 ≠ 对外 DTO。
//!
//! 三个切面都是纯投影，依赖方向恒为 切面 → 模型（`replay::model`）：
//! - **回放切面** = 全场时序（位姿网格/炮线/击杀/阶段/可见性），序列化形态即
//!   `replay::playback::PlaybackData`（含 visibility；前端 `/api/playback/data` 已在线）；
//! - **智能体评审切面** = 花名册 + 归一化事件流 + 结算锚点（→ Java → 大语言模型）；
//! - **名人堂切面** = 结算精简行（→ Java → PostgreSQL）。
//!
//! 原则：unknown ≠ 0 ≠ false——缺失一律 null/Option；分发机制（npm 包/构建产物/
//! 传输接口）不在本层定义，serde JSON 即契约本体。

pub mod ai_review;
pub mod hof;

pub use ai_review::AiReviewFacet;
pub use hof::HofFacet;
pub use crate::replay::playback::PlaybackData as PlaybackFacet;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::models::battle::BattleSummary;
use crate::replay::combat::feedback_code;
use crate::replay::model::ReplayModel;

/// 一条结算互验项（0x0c 过程计数 vs 结算总量，作者口径）。
#[derive(Debug)]
pub struct CrossCheck {
    pub label: &'static str,
    /// 结算总量（None = 结算补充字段缺失，无从对账）
    pub settlement: Option<u32>,
    /// 计数流最终 count
    pub counter_count: u32,
    /// 计数流最终 value
    pub counter_value: u32,
}

impl CrossCheck {
    /// None = 结算缺失无法判定；对不上返回 false——导出方应停下人工判读，禁止改语义硬凑。
    pub fn ok(&self) -> Option<bool> {
        let s = self.settlement?;
        Some(s == self.counter_count || s == self.counter_value)
    }
}

/// 作者反馈计数 × 结算互验：击杀（code 3）与点亮（code 2）。
/// count/value 哪个是"次数"口径未逐项复核——两者任一对上即判 OK。
pub fn cross_check_author_counters(model: &ReplayModel, summary: &BattleSummary) -> Vec<CrossCheck> {
    let author = summary.players.iter()
        .find(|p| p.account_id == summary.author_account_id);
    let mut max_by_code: HashMap<u16, (u32, u32)> = Default::default();
    for e in &model.timeline.counters {
        let slot = max_by_code.entry(e.event_code).or_insert((0, 0));
        slot.0 = slot.0.max(e.count as u32);
        slot.1 = slot.1.max(e.value as u32);
    }
    let mk = |label: &'static str, code: u16, settlement: Option<u32>| {
        let (count, value) = max_by_code.get(&code).copied().unwrap_or((0, 0));
        CrossCheck { label, settlement, counter_count: count, counter_value: value }
    };
    vec![
        mk("击杀 code=KILL vs n_enemies_destroyed", feedback_code::KILL,
            author.map(|a| a.n_enemies_destroyed)),
        mk("点亮 code=SPOTTED vs n_enemies_spotted", feedback_code::SPOTTED,
            author.and_then(|a| a.n_enemies_spotted)),
    ]
}

/// CLI 导出（`wotb-agent facets <file>`）：模型扫描 → 三个切面 JSON 落盘 + 结算互验报告。
///
/// 注意：CLI 路径不做俯仰极限锚定（空锚定表，炮管俯仰走车体 pitch 兜底）与 GLB 变体
/// 标注——那两步是 viewer/在线链路的增值，不影响切面数据本身的正确性。
pub fn export_cli(
    file: &Path,
    parts: &str,
    out_dir: Option<&Path>,
    tank_cache: Option<&Path>,
) -> Result<()> {
    use crate::replay::model::ScanInput;
    use crate::replay::playback::{PlaybackInput, PlaybackPlayer};
    use crate::wargaming::tank_resolver::TankResolver;

    let want: Vec<String> = parts.split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    anyhow::ensure!(!want.is_empty(), "parts 为空（可选 playback/ai/hof）");
    for p in &want {
        anyhow::ensure!(matches!(p.as_str(), "playback" | "ai" | "hof"), "未知切面 `{p}`（可选 playback/ai/hof）");
    }

    // 结算（带可选坦克名解析）
    let resolver = tank_cache.filter(|p| p.exists())
        .and_then(|p| TankResolver::load_from_json_file(&p).ok());
    let summary = match &resolver {
        Some(r) => crate::replay::parser::ReplayParser::with_resolver(r).parse_file(file)?,
        None => crate::replay::parser::ReplayParser::new().parse_file(file)?,
    };
    // 地图显示名以客户端注册表为准（parser 兜底是解析器枚举名）
    let map_name = crate::wargaming::map_assets::display_name(summary.map_id)
        .map(|s| s.to_string())
        .unwrap_or_else(|| summary.map_name.clone());

    // 包流（与 playback_probe 同款类型映射）
    let f = std::fs::File::open(file)?;
    let mut replay = wotbreplay_parser::replay::Replay::open(f)?;
    let data = replay.read_data()?;
    let packets: Vec<(u32, f32, &[u8])> = data.packets.iter().map(|pkt| {
        let t = match &pkt.payload {
            wotbreplay_parser::models::data::payload::Payload::BasePlayerCreate { .. } => 0,
            wotbreplay_parser::models::data::payload::Payload::EntityMethod(_) => 8,
            wotbreplay_parser::models::data::payload::Payload::Unknown { packet_type } => *packet_type,
        };
        (t, pkt.clock_secs, &pkt.raw_payload[..])
    }).collect();

    let roster: Vec<PlaybackPlayer> = summary.players.iter().map(|p| PlaybackPlayer {
        account_id: p.account_id,
        nickname: p.nickname.clone(),
        team: p.team,
        tank_id: p.tank_id,
    }).collect();
    let limits = crate::replay::combat::GunPitchLimits::new();
    let model = ReplayModel::scan(&ScanInput {
        packets: &packets,
        roster: &roster,
        author_account_id: summary.author_account_id,
        pitch_limits: &limits,
    })?;

    let dir: PathBuf = out_dir.map(|p| p.to_path_buf())
        .unwrap_or_else(|| file.parent().map(|p| p.to_path_buf()).unwrap_or_default());
    std::fs::create_dir_all(&dir)?;
    let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("replay").to_string();

    println!(
        "切面导出：{}（{} / {} 人 / 胜方 {}）",
        file.display(), map_name, summary.players.len(), summary.winner_team
    );

    for part in &want {
        match part.as_str() {
            "hof" => {
                let facet = HofFacet::from_settlement(&summary);
                let path = write_json(&dir, &format!("{stem}.facet.hof.json"), &facet)?;
                println!("  名人堂切面 → {}（{} 行）", path.display(), facet.entries.len());
            }
            "ai" => {
                let facet = AiReviewFacet::from_model(&model, &summary);
                let path = write_json(&dir, &format!("{stem}.facet.ai.json"), &facet)?;
                println!(
                    "  评审切面   → {}（{} 事件 / {} 实体）",
                    path.display(), facet.events.len(), facet.rosters.len()
                );
            }
            "playback" => {
                let tank_names: HashMap<u32, String> = summary.players.iter()
                    .map(|p| (p.tank_id, p.tank_name.clone()))
                    .filter(|(_, n)| !n.is_empty())
                    .collect();
                let input = PlaybackInput {
                    packets: &packets,
                    players: roster.clone(),
                    author_account_id: summary.author_account_id,
                    winner_team: summary.winner_team,
                    map_id: summary.map_id,
                    map_name: map_name.clone(),
                    pitch_limits: &limits,
                    tank_names,
                };
                let facet = crate::replay::playback::from_model(&model, &input)?;
                println!(
                    "  回放切面   → {}/{}.facet.playback.json（{} 车 / {} 发 / 可见窗口 {}）",
                    dir.display(), stem, facet.vehicles.len(), facet.shots.len(), facet.visibility.len()
                );
            }
            _ => unreachable!(),
        }
    }

    println!("结算互验（0x0c 过程计数 vs 结算总量，作者口径）：");
    for c in cross_check_author_counters(&model, &summary) {
        let verdict = match c.ok() {
            Some(true) => "OK",
            Some(false) => "MISMATCH（需人工判读）",
            None => "N/A（结算缺失）",
        };
        println!(
            "  {:<42} 结算 {:>5}  count {:>5}  value {:>5}  [{verdict}]",
            c.label, c.settlement.unwrap_or(0), c.counter_count, c.counter_value
        );
    }
    Ok(())
}

fn write_json<T: serde::Serialize>(dir: &Path, name: &str, value: &T) -> Result<PathBuf> {
    let path = dir.join(name);
    let w = std::io::BufWriter::new(std::fs::File::create(&path)?);
    serde_json::to_writer_pretty(w, value)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 互验判定：任一口径对上即 OK；结算缺失 = None；全对不上 = false。
    #[test]
    fn cross_check_verdicts() {
        let mut model = ReplayModel::default();
        model.timeline.counters.push(crate::replay::combat::FeedbackCounterEvent {
            clock: 1.0, avatar_eid: 1, event_code: feedback_code::KILL, count: 2, value: 2,
        });
        let mut summary = BattleSummary::from_naive(0);
        let mut p = crate::models::battle::PlayerSummary::for_test(7, "a");
        p.n_enemies_destroyed = 2;
        summary.author_account_id = 7;
        summary.players.push(p);

        let checks = cross_check_author_counters(&model, &summary);
        assert_eq!(checks.len(), 2);
        assert_eq!(checks[0].ok(), Some(true), "击杀 count=2 == 结算 2");
        assert_eq!(checks[1].ok(), None, "点亮结算缺失 → 无法判定");

        // 全对不上
        summary.players[0].n_enemies_destroyed = 5;
        let checks = cross_check_author_counters(&model, &summary);
        assert_eq!(checks[0].ok(), Some(false));
    }
}
