//! 智能体评审切面（架构契约第 5/7 节）：花名册 + 归一化事件流 + 结算锚点
//! → JSON → WotBTools Java → 大语言模型。
//!
//! 与回放切面共享同一 Rust 核心但 DTO 不同：评审切面按事件语义组织（带类型标签），
//! 不含渲染网格；喂给模型的粒度（降采样/摘要）由下游编排决定，本层保持权威全量。
//! 已知边界如实透出：队友点亮的事件级归属不在回放中（仅结算总量），可见性窗口
//! 是本队视角（AoI 生命周期）。

use std::collections::HashMap;

use serde::Serialize;

use crate::models::battle::BattleSummary;
use crate::models::replay_dataset::{PlayerSettlementRow, ReplayDataset};
use crate::replay::combat::ArenaPeriod;
use crate::replay::model::{EntityRecord, ReplayModel};

/// 智能体评审切面（单场）
#[derive(Debug, Clone, Serialize)]
pub struct AiReviewFacet {
    /// 契约版本（当前 1；不兼容变更递增）
    pub version: u32,
    pub battle: AiBattleHeader,
    pub rosters: Vec<AiRosterEntry>,
    /// 按回放时钟升序的归一化事件流
    pub events: Vec<AiEvent>,
    /// 结算锚点（模型结论与过程互验用；行结构见 ReplayDataset 阶段 1 契约）
    pub settlements: Vec<PlayerSettlementRow>,
}

/// 战斗头
#[derive(Debug, Clone, Serialize)]
pub struct AiBattleHeader {
    /// 战斗开始 Unix 秒
    pub start_time: i64,
    pub map_id: u32,
    pub map_name: String,
    pub room_type: String,
    pub winner: u8,
    /// 结算口径整秒时长（root5 尚未解码 → null；绝不以 meta 口径冒充——unknown ≠ 0）
    pub duration_secs: Option<u32>,
    /// 元数据口径时长（meta.json battleDuration；缺失/0 → None）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta_duration_secs: Option<f64>,
    /// 战局阶段（准备/倒计时/战斗）
    pub periods: Vec<ArenaPeriod>,
}

/// 花名册行（实体 ↔ 结算联表结果）
#[derive(Debug, Clone, Serialize)]
pub struct AiRosterEntry {
    /// 回放实体 id（0 = 该实体未在包流出现）
    pub eid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tank_id: Option<u32>,
    pub tank_name: String,
    pub is_author: bool,
}

/// 归一化事件（serde 内部标签；t = 回放时钟秒）
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiEvent {
    /// 满血锚点（血量链起点）
    Spawn { t: f32, eid: u32, max_hp: u16 },
    /// 开火 + 结果（全玩家；结果字段语义与回放切面弹道一致）
    Shot {
        t: f32,
        shooter_eid: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_eid: Option<u32>,
        hit: bool,
        ricochet: bool,
        /// 游戏命中结果枚举（0=无 1=未击穿 2=间隙止 3=有伤害 4=履带/模块 255=未获取）
        game_hit_result: u8,
        damage: u32,
        is_kill: bool,
        is_author: bool,
        #[serde(skip_serializing_if = "String::is_empty")]
        shell_kind: String,
    },
    /// 血量变化事件（method1；hp = 事件后绝对血量，overkill 钳 0）
    Damage { t: f32, victim_eid: u32, hp: u16, source_eid: u32, cause: u8 },
    /// 击毁（击杀播报归属增强：击杀者/死因/≥50% 助攻）
    Kill {
        t: f32,
        killer_eid: u32,
        victim_eid: u32,
        cause: u8,
        #[serde(skip_serializing_if = "Option::is_none")]
        assister_eid: Option<u32>,
    },
    /// 可见性窗口（AoI 生命周期，本队视角；t_out = None 表示战斗结束仍在场）
    Visibility { t_in: f32, eid: u32, #[serde(skip_serializing_if = "Option::is_none")] t_out: Option<f32> },
    /// 作者战斗反馈计数（0x0c；code 语义见 combat::feedback_code）
    Counter { t: f32, code: u8, count: u16, value: u16 },
    /// 累计伤害进度（prop10；相邻差 = 区段内伤害）
    DamageTick { t: f32, eid: u32, cumulative: u32 },
}

impl AiEvent {
    fn t(&self) -> f32 {
        match self {
            AiEvent::Spawn { t, .. }
            | AiEvent::Shot { t, .. }
            | AiEvent::Damage { t, .. }
            | AiEvent::Kill { t, .. }
            | AiEvent::Counter { t, .. }
            | AiEvent::DamageTick { t, .. } => *t,
            AiEvent::Visibility { t_in, .. } => *t_in,
        }
    }
}

impl AiReviewFacet {
    /// 从内部模型 + 结算联表投影。
    pub fn from_model(model: &ReplayModel, summary: &BattleSummary) -> Self {
        // 实体名 → eid（弹道目标归属；全名表——评审切面不做车辆候选过滤）
        let name_to_eid: HashMap<&str, u32> = model.timeline.entity_names.iter()
            .map(|(eid, n)| (n.as_str(), *eid))
            .collect();

        let mut events: Vec<AiEvent> = Vec::new();

        // 花名册先行：可见性事件只保留可联表到花名册的车辆实体——原始 AoI 流含
        // 未证明实体类型的 EID（投影物/特效物化等），不得作为裸 EID 泄漏进评审切面
        //（playback 切面保留完整 AoI 粒度，不受此约束）。
        // 花名册只收有身份的实体（昵称/结算联表命中）。
        let tank_name_of = |e: &EntityRecord| -> String {
            e.account_id.and_then(|aid| {
                summary.players.iter().find(|p| p.account_id == aid)
            }).map(|p| p.tank_name.clone()).unwrap_or_default()
        };
        let rosters: Vec<AiRosterEntry> = model.entities.iter()
            .filter(|e| e.nickname.is_some() || e.account_id.is_some())
            .map(|e| AiRosterEntry {
                eid: e.eid,
                account_id: e.account_id,
                nickname: e.nickname.clone(),
                team: e.team,
                tank_id: e.tank_id,
                tank_name: tank_name_of(e),
                is_author: e.is_author,
            }).collect();
        let roster_eids: std::collections::HashSet<u32> =
            rosters.iter().map(|r| r.eid).collect();

        for (eid, (t, hp)) in &model.timeline.initial_hp {
            events.push(AiEvent::Spawn { t: *t, eid: *eid, max_hp: *hp });
        }
        for e in &model.timeline.hp_events {
            // overkill 负值钳 0（与回放切面同式）
            let hp_v = if e.hp > 32767 { 0 } else { e.hp };
            events.push(AiEvent::Damage {
                t: e.clock,
                victim_eid: e.victim,
                hp: hp_v,
                source_eid: e.source,
                cause: e.cause,
            });
        }
        for k in model.kill_events() {
            events.push(AiEvent::Kill {
                t: k.t,
                killer_eid: k.killer_eid,
                victim_eid: k.victim_eid,
                cause: k.cause,
                assister_eid: k.assister_eid,
            });
        }
        for p in &model.timeline.presence {
            if roster_eids.contains(&p.eid) {
                events.push(AiEvent::Visibility { t_in: p.t_in, eid: p.eid, t_out: p.t_out });
            }
        }
        for c in &model.timeline.counters {
            events.push(AiEvent::Counter { t: c.clock, code: c.event_code, count: c.count, value: c.value });
        }
        for (eid, series) in &model.timeline.damage_progress {
            for (t, cum) in series {
                events.push(AiEvent::DamageTick { t: *t, eid: *eid, cumulative: *cum });
            }
        }
        for s in &model.timeline.shots {
            let target_eid = if s.target_name.is_empty() {
                None
            } else {
                name_to_eid.get(s.target_name.as_str()).copied()
            };
            events.push(AiEvent::Shot {
                t: s.fire_time,
                shooter_eid: s.shooter_eid,
                target_eid,
                hit: target_eid.is_some(),
                ricochet: s.hit_flags & 0x0008 != 0,
                game_hit_result: s.game_hit_result,
                damage: s.damage,
                is_kill: s.is_kill,
                is_author: s.is_author,
                shell_kind: s.shell_kind.clone(),
            });
        }
        events.sort_by(|a, b| a.t().partial_cmp(&b.t()).unwrap());

        let settlements = ReplayDataset::from_summary(summary).settlement.players;

        Self {
            version: 1,
            battle: AiBattleHeader {
                start_time: summary.timestamp,
                map_id: summary.map_id,
                map_name: summary.map_name.clone(),
                room_type: summary.room_type.clone(),
                winner: summary.winner_team,
                duration_secs: None, // 结算口径 root5 未解码；未知 → null
                meta_duration_secs: (summary.battle_duration_secs > 0.0)
                    .then_some(summary.battle_duration_secs),
                periods: model.timeline.periods.clone(),
            },
            rosters,
            events,
            settlements,
        }
    }
}

/// 评审切面用的语义标签再导出（编排层映射 code → 中文标签时用，避免魔法数字散落）
pub use crate::replay::combat::feedback_code as counter_codes;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::combat::feedback_code;

    /// 事件排序与来源映射：Counters/可见性/伤害进入统一事件流且按 t 升序；
    /// 可见性事件必须可联表到花名册（无名实体不出现在评审切面）。
    #[test]
    fn events_sorted_and_typed() {
        let summary = BattleSummary::from_naive(1);
        let limits = crate::replay::combat::GunPitchLimits::new();
        // 最小包流：一条 0x0c 点亮计数 + 一条 AoI 进场（Type33→Type5 物化，带合法昵称 "abc"）
        let mut p33 = vec![0u8; 4];
        p33[0..4].copy_from_slice(&0x33u32.to_le_bytes());
        let mut p5 = vec![0u8; 64];
        p5[0..4].copy_from_slice(&0x33u32.to_le_bytes());
        p5[57] = 3; // 昵称长度前缀
        p5[58..61].copy_from_slice(b"abc");
        let mut c = vec![0u8; 12 + 6];
        c[0..4].copy_from_slice(&0x99u32.to_le_bytes());
        c[4..8].copy_from_slice(&0x0Cu32.to_le_bytes());
        c[8..12].copy_from_slice(&6u32.to_le_bytes());
        c[12..].copy_from_slice(&[2, 0, 1, 0, 1, 0]);
        let packets: Vec<(u32, f32, &[u8])> = vec![
            (8, 5.0, &c),
            (33, 6.0, &p33),
            (5, 6.4, &p5),
        ];
        let roster: Vec<crate::replay::playback::PlaybackPlayer> = Vec::new();
        let model = ReplayModel::scan(&crate::replay::model::ScanInput {
            packets: &packets,
            roster: &roster,
            author_account_id: 0,
            pitch_limits: &limits,
        })
        .unwrap();
        let facet = AiReviewFacet::from_model(&model, &summary);

        // 核心不变量：每条 visibility 的 eid 都必须可联表到花名册（裸 EID 不泄漏）。
        // 0x33 带 type=5 昵称 → 有身份 → 进花名册，其可见性窗口保留且可联表。
        let roster_ids: std::collections::HashSet<u32> = facet.rosters.iter().map(|r| r.eid).collect();
        assert!(facet.events.iter().all(|e| match e {
            AiEvent::Visibility { eid, .. } => roster_ids.contains(eid),
            _ => true,
        }));
        assert!(facet.rosters.iter().any(|r| r.eid == 0x33 && r.nickname.as_deref() == Some("abc")));
        assert!(facet.events.iter().any(|e| matches!(e,
            AiEvent::Visibility { eid: 0x33, t_in, .. } if (*t_in - 6.4).abs() < 1e-5)));

        // 花名册联表（结算花名册含该昵称）→ 队伍/车型补全
        let roster2 = vec![crate::replay::playback::PlaybackPlayer {
            account_id: 1,
            nickname: "abc".into(),
            team: 1,
            tank_id: 1001,
        }];
        let model2 = ReplayModel::scan(&crate::replay::model::ScanInput {
            packets: &packets,
            roster: &roster2,
            author_account_id: 0,
            pitch_limits: &limits,
        })
        .unwrap();
        let facet2 = AiReviewFacet::from_model(&model2, &summary);
        assert!(facet2.rosters.iter().any(|r| r.eid == 0x33 && r.team == Some(1) && r.tank_id == Some(1001)));

        let ts: Vec<f32> = facet2.events.iter().map(|e| e.t()).collect();
        let mut sorted = ts.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(ts, sorted, "事件必须按 t 升序");

        assert!(facet2.events.iter().any(|e| matches!(e,
            AiEvent::Counter { code, count: 1, value: 1, .. } if *code == feedback_code::SPOTTED)));
        // 未知时长 → null（绝不写 0/0.0）
        assert_eq!(facet2.battle.duration_secs, None);
        assert_eq!(facet2.battle.meta_duration_secs, None);
    }
}
