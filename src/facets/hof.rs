//! 名人堂切面（架构契约第 5/8 节）：battle_results 结算的精简消费视图
//! → JSON → WotBTools Java → PostgreSQL。
//!
//! 纯结算投影：不含任何时序数据；字段缺失一律 null（unknown ≠ 0 ≠ 没发生）。
//! 助攻保持点亮/断带两列分列（合并是内部视图的显示口径，榜单需要分别排行）。

use serde::Serialize;

use crate::models::battle::BattleSummary;

/// 名人堂切面（单场）
#[derive(Debug, Clone, Serialize)]
pub struct HofFacet {
    /// 契约版本（当前 1；不兼容变更递增）
    pub version: u32,
    pub battle: HofBattle,
    /// 全部战斗者（含作者；胜利方 = team == battle.winner）
    pub entries: Vec<HofEntry>,
}

/// 战斗身份（榜单归档键）
#[derive(Debug, Clone, Serialize)]
pub struct HofBattle {
    /// 战斗开始 Unix 秒
    pub start_time: i64,
    pub map_id: u32,
    pub map_name: String,
    /// Rating / Regular / TrainingRoom
    pub room_type: String,
    /// 获胜队伍（1/2）
    pub winner: u8,
    /// 结算口径整秒时长（battle_results root5 尚未解码 → null，禁用 meta 口径冒充）
    pub duration_secs: Option<u32>,
}

/// 单战斗者精简行（发服务器的全部内容——不含位置/炮线/镜头帧）
#[derive(Debug, Clone, Serialize)]
pub struct HofEntry {
    pub account_id: u32,
    pub nickname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clan_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platoon_id: Option<u32>,
    pub team: u8,
    pub tank_id: u32,
    pub tank_name: String,
    pub damage_dealt: u32,
    pub damage_blocked: u32,
    /// 点亮协助伤害（结算 damage_assisted_1）
    pub damage_assisted_spot: u32,
    /// 断带协助伤害（结算 damage_assisted_2）
    pub damage_assisted_track: u32,
    pub kills: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub killer_id: Option<u32>,
    /// -1=存活哨兵推导；None = 结算缺失，不猜
    #[serde(skip_serializing_if = "Option::is_none")]
    pub survived: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub life_time_secs: Option<u32>,
    pub n_shots: u32,
    pub n_hits: u32,
    pub n_penetrations: u32,
    pub n_enemies_damaged: u32,
    pub n_hits_received: u32,
    pub n_penetrations_received: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n_enemies_spotted: Option<u32>,
    /// 毁灭协助次数（≥25% 伤害后盟友击毁）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destruction_assistance: Option<u32>,
    /// 炮印数（0..3）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gun_marks: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mm_rating: Option<f32>,
    pub xp: u32,
    pub credits: u32,
}

impl HofFacet {
    /// 从结算联表投影（纯函数，不触碰包流）。
    pub fn from_settlement(summary: &BattleSummary) -> Self {
        let entries = summary.players.iter().map(|p| HofEntry {
            account_id: p.account_id,
            nickname: p.nickname.clone(),
            clan_tag: p.clan_tag.clone(),
            platoon_id: p.platoon_id,
            team: p.team,
            tank_id: p.tank_id,
            tank_name: p.tank_name.clone(),
            damage_dealt: p.damage_dealt,
            damage_blocked: p.damage_blocked,
            damage_assisted_spot: p.damage_assisted_1,
            damage_assisted_track: p.damage_assisted_2,
            kills: p.n_enemies_destroyed,
            killer_id: p.killer_id,
            survived: p.survived,
            life_time_secs: p.life_time_secs,
            n_shots: p.n_shots,
            n_hits: p.n_hits_dealt,
            n_penetrations: p.n_penetrations_dealt,
            n_enemies_damaged: p.n_enemies_damaged,
            n_hits_received: p.n_hits_received,
            n_penetrations_received: p.n_penetrations_received,
            n_enemies_spotted: p.n_enemies_spotted,
            destruction_assistance: p.destruction_assistance,
            gun_marks: p.gun_marks,
            mm_rating: p.mm_rating,
            xp: p.base_xp,
            credits: p.credits_earned,
        }).collect();
        Self {
            version: 1,
            battle: HofBattle {
                start_time: summary.timestamp,
                map_id: summary.map_id,
                map_name: summary.map_name.clone(),
                room_type: summary.room_type.clone(),
                winner: summary.winner_team,
                duration_secs: None, // root5 未解码；宁缺勿冒充
            },
            entries,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::battle::{AuthorStats, PlayerSummary};

    /// 投影不变式：行数 = 花名册、助攻两列分列、缺失字段保持 None（不编码 0/false）。
    #[test]
    fn settlement_projection() {
        let mut summary = BattleSummary::from_naive(1_760_000_000);
        summary.map_id = 19;
        summary.map_name = "Mines".into();
        summary.room_type = "Regular".into();
        summary.winner_team = 1;
        summary.players.push(PlayerSummary {
            account_id: 42,
            nickname: "tester".into(),
            team: 1,
            platoon_id: None,
            clan_tag: Some("CLAN".into()),
            tank_id: 1001,
            tank_name: "E-100".into(),
            base_xp: 900,
            credits_earned: 50_000,
            n_shots: 10,
            n_hits_dealt: 7,
            n_penetrations_dealt: 5,
            damage_dealt: 4321,
            damage_blocked: 210,
            damage_assisted_1: 333,
            damage_assisted_2: 444,
            n_hits_received: 6,
            n_penetrations_received: 4,
            n_enemies_damaged: 5,
            n_enemies_destroyed: 2,
            mm_rating: None,
            display_rating: None,
            death_reason: Some(1),
            survived: Some(false),
            life_time_secs: Some(300),
            killer_id: Some(7),
            n_enemies_spotted: None, // 结算缺失：切面必须保持 null
            destruction_assistance: Some(1),
            gun_marks: None,
        });
        summary.author = AuthorStats {
            hitpoints_left: 0,
            total_credits: 50_000,
            total_xp: 900,
            n_shots: 10,
            n_hits: 7,
            n_splashes: 1,
            n_penetrations: 5,
            damage_dealt: 4321,
            is_auto_destroyed: false,
        };

        let facet = HofFacet::from_settlement(&summary);
        assert_eq!(facet.entries.len(), 1);
        assert_eq!(facet.battle.winner, 1);
        assert_eq!(facet.battle.duration_secs, None, "root5 未解码必须为 null");
        let e = &facet.entries[0];
        assert_eq!(e.damage_assisted_spot, 333, "点亮协助分列");
        assert_eq!(e.damage_assisted_track, 444, "断带协助分列");
        assert_eq!(e.kills, 2);
        assert_eq!(e.n_enemies_spotted, None, "缺失保持 None");
        assert_eq!(e.xp, 900);
        assert_eq!(e.credits, 50_000);
        // 序列化：None 字段整体省略（skip），JSON 无 0/false 伪装
        let json = serde_json::to_value(&facet.entries[0]).unwrap();
        assert!(json.get("n_enemies_spotted").is_none());
        assert!(json.get("gun_marks").is_none());
    }
}
