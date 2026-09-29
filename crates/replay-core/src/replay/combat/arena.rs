//! updateArena 流解析：subtype 过滤收集、PERIOD 阶段、wrapper6 击杀播报、
//! AoI 在场生命周期、0x0c 反馈计数、type=39 作者炮线帧。

use super::*;
use serde::{Deserialize, Serialize};

/// Avatar updateArena 的 methodID（method 流直方图 + 子类型 ID 分布双重实证）
pub const ARENA_UPDATE_METHOD: u32 = 48;

/// 子类型名（二进制名字表逐项导出；10=former_teamkills 为原表小写原名）
pub fn arena_subtype_name(id: u32) -> &'static str {
    match id {
        1 => "VEHICLE_LIST", 2 => "VEHICLE_ADDED", 3 => "PERIOD",
        4 => "STATISTICS", 5 => "VEHICLE_STATISTICS", 6 => "VEHICLE_KILLED",
        7 => "AVATAR_READY", 8 => "BASE_POINTS", 9 => "BASE_CAPTURED",
        10 => "former_teamkills", 11 => "VEHICLE_UPDATED", 12 => "STRATEGIC_POINT_STATUS",
        13 => "WIN_POINTS", 14 => "PLAYER_NAME", 15 => "RELOAD_TIME",
        16 => "OBSERVED_STATUS", 17 => "RELOAD_TIME_LIST", 18 => "GAME_MODE_DATA",
        19 => "VEHICLE_WAIT_RESPAWN", 20 => "VEHICLE_RESURRECT", 21 => "TEAM_RESPAWNS_LEFT",
        22 => "VAMPIRIC_CURSE", 23 => "BATTLE_HINTS_INFO", 24 => "BOSSMODE_INFO",
        25 => "TOTAL_GAME_MODE_INFO", 26 => "TIER_EQUALIZER_DATA", 27 => "UNKNOWN_TYPE",
        _ => "UNKNOWN",
    }
}

/// 一条 updateArena 更新（子类型 + 原始消息体；字段级解码按子类型另行解析）。
/// args 布局 = [subtype u8][len u8][protobuf]（len = 其后字节数，实测逐条吻合）。
///
/// 载荷以原始字节存储（收集零转换，消费方 kill_feed/periods/comps 直接读字节，
/// 不再"编码 hex 再解码回字节"往返）；JSON 契约保持旧 `payload_hex` hex 字符串字段
/// （序列化时惰性编码，仅诊断导出付一次 hex 成本）。
#[derive(Debug, Clone)]
pub struct ArenaUpdate {
    pub clock: f32,
    pub subtype: u32,
    pub name: &'static str,
    /// protobuf 消息体（原始字节）
    pub payload: Vec<u8>,
}

impl Serialize for ArenaUpdate {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("ArenaUpdate", 4)?;
        s.serialize_field("clock", &self.clock)?;
        s.serialize_field("subtype", &self.subtype)?;
        s.serialize_field("name", self.name)?;
        let hex: String = self.payload.iter().map(|b| format!("{:02x}", b)).collect();
        s.serialize_field("payload_hex", &hex)?;
        s.end()
    }
}

impl<'de> Deserialize<'de> for ArenaUpdate {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            clock: f32,
            subtype: u32,
            payload_hex: String,
        }
        let r = Raw::deserialize(d)?;
        let payload = decode_hex(&r.payload_hex)
            .ok_or_else(|| serde::de::Error::custom("payload_hex 非法 hex"))?;
        Ok(ArenaUpdate {
            clock: r.clock,
            subtype: r.subtype,
            name: arena_subtype_name(r.subtype),
            payload,
        })
    }
}

/// 收集 updateArena 流（作者 Avatar 实体广播；类型=8 方法流，methodID=48）。
/// args 布局 = [subtype u8][len u8][protobuf]；len 不符的包按健壮路径仍从偏移 2 解析
pub fn collect_arena_updates(packets: &[(u32, f32, &[u8])]) -> Vec<ArenaUpdate> {
    collect_arena_updates_filtered(packets, |_| true)
}

/// [`collect_arena_updates`] 的 subtype 过滤版：高频子类型（RELOAD_TIME ~20B/条）在
/// 收集期即丢弃，不再"全量收集 → 消费方按 subtype 挑拣"。现有消费方只需 {1,3,6}
/// （comps/periods/kill_feed），无过滤的全量收集纯属浪费。
pub fn collect_arena_updates_filtered(
    packets: &[(u32, f32, &[u8])],
    keep_subtype: impl Fn(u32) -> bool,
) -> Vec<ArenaUpdate> {
    let mut out = Vec::new();
    for (_t, clock, p) in packets {
        if p.len() < 15 { continue; }
        if u32::from_le_bytes([p[4], p[5], p[6], p[7]]) != ARENA_UPDATE_METHOD { continue; }
        let alen = u32::from_le_bytes([p[8], p[9], p[10], p[11]]) as usize;
        if 12 + alen > p.len() || alen < 2 { continue; }
        let subtype = p[12] as u32;
        if !keep_subtype(subtype) { continue; }
        out.push(ArenaUpdate {
            clock: *clock,
            subtype,
            name: arena_subtype_name(subtype),
            payload: p[14..12 + alen].to_vec(),
        });
    }
    out
}

/// AoI 实体在场生命周期（WotbTools visibility-lifecycle PROVEN）：
/// Type33(预备)→~0.4s→Type5(物化)=进入观察集；Type4=离开（硬黑屏，485/485 隐藏段零更新）。
/// Type4 ≠ 死亡（503/503 敌方、485/485 同 eid 重入）；死亡面 = prop1/血量终态（death_events）。
/// 消费：OBSERVED（段内可精确播）/ LAST_KNOWN（Type4 前最后 type10，中位 0.101s）/ 隐藏段禁插值。
/// playback 的 coverage（采样间隙 >2s 断开）已承担渲染侧插值防护；本收集器提供协议精确边界
/// （0.094~2s 的短隐藏段 coverage 不断，协议面可收紧——P3/前端消费）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AoiPresence {
    pub eid: u32,
    /// 进入观察集（Type5 物化时刻）
    pub t_in: f32,
    /// 离开（Type4 时刻）；None = 战斗结束仍在场
    pub t_out: Option<f32>,
}

/// 收集 AoI 在场区段：Type33 与 Type5 一一配对（3,869:3,869，间隔 0.046~1.207s）取 Type5
/// 时刻为进入；Type4 关闭当前段。跨场段数 0..N（敌方重入常见，485/503 重入）。
pub fn collect_aoi_lifecycle(packets: &[(u32, f32, &[u8])]) -> Vec<AoiPresence> {
    // 文件序状态机：Type33 记 pending（按 eid，取首个）；Type5 消费 pending 开段；Type4 关段
    let mut pending33: std::collections::HashSet<u32> = Default::default();
    let mut open: std::collections::HashMap<u32, f32> = Default::default();
    let mut out: Vec<AoiPresence> = Vec::new();
    for (ptype, clock, p) in packets {
        if p.len() < 4 { continue; }   // Type17 等零长/短包无 eid 头（payloadLen==0 合法）
        let eid = u32::from_le_bytes([p[0], p[1], p[2], p[3]]);
        match *ptype {
            33 => { pending33.insert(eid); }
            5 => {
                if pending33.remove(&eid) && !open.contains_key(&eid) {
                    open.insert(eid, *clock);
                }
            }
            4 => {
                if let Some(t_in) = open.remove(&eid) {
                    out.push(AoiPresence { eid, t_in, t_out: Some(*clock) });
                }
                pending33.remove(&eid);
            }
            _ => {}
        }
    }
    for (eid, t_in) in open {
        out.push(AoiPresence { eid, t_in, t_out: None });
    }
    out.sort_by(|a, b| a.eid.cmp(&b.eid).then(a.t_in.partial_cmp(&b.t_in).unwrap()));
    out
}

/// type=39 作者瞄准/炮线帧（len=28，**7×f32**；WotbTools PROVEN，本地 B 组交叉验证闭合）：
/// f0=世界系瞄准/炮线 yaw（度，开火锚定 0.27°）、f1=世界系 pitch（度，取负存储，0.45°）、
/// f2..4=世界系瞄准射线一点、f5=相对炮塔偏航族（PARTIAL——死亡/观战后失效，禁当炮塔角）、
/// f6=车体系炮管俯仰（rad，开火时刻 0.17°；仰角上限呈车型离散档）。
/// 门控：作者死亡/观战切换后 f0/f1 旋转、f5 冻结——消费须限作者存活期（death_events 门）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Type39Frame {
    pub clock: f32,
    /// f0 世界系炮线 yaw（rad，由度转换）
    pub gun_yaw: f32,
    /// f1 世界系炮线 pitch（rad，取负还原；正=仰角约定与项目一致需按 −f1）
    pub gun_pitch_world: f32,
    /// f2..4 世界系瞄准射线一点
    pub ray_point: [f32; 3],
    /// f5 相对偏航族（PARTIAL，原样透传）
    pub f5_rel_yaw: f32,
    /// f6 车体系炮管俯仰（rad）
    pub gun_pitch_local: f32,
}

/// method38 (0x26) resultFlags 位常量（WotbTools 全 16 位 PROVEN，11.19 China；样本复现）。
/// 高 16 位 = headerHi（多数 0x0002=录像者/直击关联位；Maus 批量边界见 0x0012/0x0028，
/// 保留 raw 禁当命中位解码）。位 0x0001/0x0004 潜在例外：撞击死（reason=2）与延迟火烧死不置 0x0001。
pub mod hit_flags_mod {
    pub const DIRECT_KILL: u32 = 0x0001;
    pub const TARGET_ALREADY_DEAD: u32 = 0x0002;
    pub const FIRE_STARTED: u32 = 0x0004;
    pub const RICOCHET: u32 = 0x0008;
    pub const MATERIAL_PENETRATION: u32 = 0x0010;
    pub const NON_PENETRATION: u32 = 0x0020;
    pub const SPACED_PIERCED: u32 = 0x0040;
    pub const SPACED_NOT_PIERCED: u32 = 0x0080;
    pub const DEVICE_PIERCED: u32 = 0x0100;
    pub const DEVICE_NOT_PIERCED: u32 = 0x0200;
    pub const TRACK_DAMAGED: u32 = 0x0400;
    pub const GUN_DAMAGED: u32 = 0x0800;
    pub const EXPLOSION_MATERIAL: u32 = 0x1000;
    pub const EXPLOSION_SPACED: u32 = 0x2000;
    pub const EXPLOSION_DEVICE_INVOLVED: u32 = 0x4000;
    pub const EXPLOSION_DEVICE_DAMAGED: u32 = 0x8000;
    /// 穿透族谓词（WotbTools PROVEN：对结算 penetrations 269/270，r≈0.9924；版本门控，勿命名官方掩码）
    pub const PENETRATION_FAMILY: u32 = MATERIAL_PENETRATION | DEVICE_PIERCED | EXPLOSION_MATERIAL;
}

/// 收集 type=39 帧流（作者 avatar 观战相机域；28B=7×f32）。
pub fn collect_type39_frames(packets: &[(u32, f32, &[u8])]) -> Vec<Type39Frame> {
    let mut out = Vec::new();
    for (_t, clock, p) in packets {
        if *_t != 39 || p.len() < 28 { continue; }
        let f = |o: usize| f32::from_le_bytes([p[o], p[o + 1], p[o + 2], p[o + 3]]);
        out.push(Type39Frame {
            clock: *clock,
            gun_yaw: f(0).to_radians(),
            gun_pitch_world: -f(4).to_radians(),
            ray_point: [f(8), f(12), f(16)],
            f5_rel_yaw: f(20),
            gun_pitch_local: f(24),
        });
    }
    out
}

/// VEHICLE_KILLED（subtype 6，WotbTools wrapper6）击杀播报事件。
/// 字段语义（WotbTools PROVEN，283 例 post-start 闭合）：
/// field1=victim 实体、field2=killer 实体、field3=>50% 先前伤害助攻者（官方 >50% 通知规则，
/// 46/46 = 最高伤害非击杀源；阈值版本门控：8.1=51% / 9.3+=50%）、field4=可选非默认死亡原因
/// （1=火 2=撞 3=世界 5=溺水，缺省=普通击毁）。field5 稀疏未解，忽略。
/// 注意：开局初始化段也有 wrapper6 记录（非真实击杀），消费方须用时序门控。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KillFeedEvent {
    pub clock: f32,
    pub victim_eid: u32,
    pub killer_eid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assister_eid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub death_reason: Option<u32>,
}

/// 收集击杀播报时间线（subtype 6；全实体广播经作者 Avatar）。
/// 载荷结构（本地 dump + WotbTools wrapper6→root field6 双证）：protobuf **root field6
/// (length-delimited)** 包裹击杀记录，内层 field1=victim / field2=killer / field3=助攻 /
/// field4=死因（varint）。
/// 开局初始化记录（period 3 之前）照样收录，消费方用 clock 门控（战斗开始锚点见 wrapper3）。
pub fn collect_kill_feed(packets: &[(u32, f32, &[u8])]) -> Vec<KillFeedEvent> {
    kill_feed_from_updates(&collect_arena_updates_filtered(packets, |s| s == 6))
}

/// [`collect_kill_feed`] 的共享扫描形态：从已收集的 subtype=6 update 流解析
/// （`ReplayModel::scan` 与 comps/periods 合用一次 arena pass 时复用）。
pub fn kill_feed_from_updates(updates: &[ArenaUpdate]) -> Vec<KillFeedEvent> {
    let mut out = Vec::new();
    for u in updates {
        if u.subtype != 6 { continue; }
        let bytes = &u.payload;
        let Some(record) = find_field(bytes, 6) else { continue };
        let mut o = 0usize;
        let (mut victim, mut killer) = (0u32, 0u32);
        let (mut assister, mut reason) = (None, None);
        let mut ok = true;
        while o < record.len() {
            let Some(key) = pb_varint(record, &mut o) else { ok = false; break };
            let (field, wt) = (key >> 3, key & 7);
            if wt == 0 {
                let Some(v) = pb_varint(record, &mut o) else { ok = false; break };
                match field {
                    1 => victim = v as u32,
                    2 => killer = v as u32,
                    3 => assister = Some(v as u32),
                    4 => reason = Some(v as u32),
                    _ => {}
                }
            } else {
                let skip = match wt {
                    2 => pb_varint(record, &mut o).map(|l| l as usize),
                    1 => Some(8),
                    5 => Some(4),
                    _ => None,
                };
                match skip {
                    Some(n) if o + n <= record.len() => o += n,
                    _ => { ok = false; break }
                }
            }
        }
        if ok && victim != 0 {
            out.push(KillFeedEvent { clock: u.clock, victim_eid: victim, killer_eid: killer, assister_eid: assister, death_reason: reason });
        }
    }
    out
}

// ---------- 0x0c 战斗反馈计数（作者 Avatar method12；主文档 §3.10【已破解→使用中】） ----------

/// 0x0c 事件码（baseType，WotbTools PROVEN）；未列出的码原样透传，不猜语义。
pub mod feedback_code {
    pub const DAMAGE_DEALT: u16 = 1;
    pub const SPOTTED: u16 = 2;
    pub const KILL: u16 = 3;
    pub const BLOCKED: u16 = 5;
    pub const DESTRUCTION_ASSIST: u16 = 15;
    pub const TOTAL_ASSIST: u16 = 17;
}

/// 一条战斗反馈计数事件：作者个人过程计数的带时标广播。
/// args 6B = [eventCode u16][count u16][value u16]（envelope = 作者 Avatar 实体）。
/// count/value 的累计口径未与结算逐项复核——消费方以 [`super::facets 互验`]/CLI 对账为准，
/// 对不上保持原样透传并在诊断层标注，不猜语义。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedbackCounterEvent {
    pub clock: f32,
    /// 作者 Avatar 实体 id（envelope）
    pub avatar_eid: u32,
    pub event_code: u16,
    pub count: u16,
    pub value: u16,
}

/// 收集战斗反馈计数流（作者 Avatar 专属；队友无对应广播，点亮归因只有结算总量）。
/// 解析健壮性：args <6B 或截断的包跳过（帧错误不猜）；事件按包序即时钟序（作者流单调）。
pub fn collect_feedback_counters(packets: &[(u32, f32, &[u8])]) -> Vec<FeedbackCounterEvent> {
    let mut out = Vec::new();
    for (_, clock, p) in packets {
        if p.len() < 12 + 6 { continue; }
        if u32::from_le_bytes([p[4], p[5], p[6], p[7]]) != 0x0C { continue; }
        let alen = u32::from_le_bytes([p[8], p[9], p[10], p[11]]) as usize;
        if alen < 6 || 12 + alen > p.len() { continue; }
        let a = &p[12..12 + alen];
        out.push(FeedbackCounterEvent {
            clock: *clock,
            avatar_eid: u32::from_le_bytes([p[0], p[1], p[2], p[3]]),
            event_code: u16::from_le_bytes([a[0], a[1]]),
            count: u16::from_le_bytes([a[2], a[3]]),
            value: u16::from_le_bytes([a[4], a[5]]),
        });
    }
    out
}

/// PERIOD (subtype=3) 解析结果：战局阶段时间线
/// 消息体 = protobuf field3 嵌套 { field1 varint: period, field2 fixed64: 阶段剩余秒, field3 varint: 阶段时长 }
/// 实测 J39：period 1=准备(60s) → 2=倒计时(7s) → 3=战斗(duration=420s)；
/// 剩余秒与包时刻互洽（t=0.17 时准备期剩 59.4s）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArenaPeriod {
    pub clock: f32,
    pub period: u64,
    /// 阶段剩余秒（f64）
    pub remaining_s: f64,
    pub duration_s: u64,
}

/// 从 updateArena 流解析 PERIOD 时间线（fail-soft：解析失败的单条跳过）
pub fn parse_arena_periods(updates: &[ArenaUpdate]) -> Vec<ArenaPeriod> {
    let mut out = Vec::new();
    for u in updates {
        if u.subtype != 3 { continue; }
        let b = &u.payload[..];
        // 顶层 field3 (tag 0x1a) 长度前缀嵌套
        let nested = match find_field(b, 3) { Some(n) => n, None => continue };
        let period = read_varint(nested, 1);
        let remaining = read_fixed64(nested, 2);
        let duration = read_varint(nested, 3);
        if let (Some(period), Some(remaining)) = (period, remaining) {
            out.push(ArenaPeriod { clock: u.clock, period, remaining_s: remaining, duration_s: duration.unwrap_or(0) });
        }
    }
    out
}

#[cfg(test)]
mod arena_tests {
    use super::*;

    /// J39 真实 PERIOD 包（subtype=3）：period=3(战斗)、剩余 420.0s、时长 420s
    #[test]
    fn arena_period_decode() {
        let u = ArenaUpdate {
            clock: 18.727,
            subtype: 3,
            name: "PERIOD",
            payload: decode_hex("1a0e0803110000000000407a4018a403").unwrap(),
        };
        let periods = parse_arena_periods(&[u]);
        assert_eq!(periods.len(), 1);
        let p = &periods[0];
        assert_eq!(p.period, 3);
        assert!((p.remaining_s - 420.0).abs() < 1e-9, "remaining={}", p.remaining_s);
        assert_eq!(p.duration_s, 420);
    }

    /// 子类型名表完整性（二进制名字表 27 项）
    #[test]
    fn arena_subtype_names() {
        assert_eq!(arena_subtype_name(1), "VEHICLE_LIST");
        assert_eq!(arena_subtype_name(3), "PERIOD");
        assert_eq!(arena_subtype_name(6), "VEHICLE_KILLED");
        assert_eq!(arena_subtype_name(10), "former_teamkills");
        assert_eq!(arena_subtype_name(17), "RELOAD_TIME_LIST");
        assert_eq!(arena_subtype_name(27), "UNKNOWN_TYPE");
        assert_eq!(arena_subtype_name(28), "UNKNOWN");
    }

    /// 0x0c 反馈计数：合成包帧 [eid][mid=0x0C][alen=6][code u16][count u16][value u16]，
    /// 帧/字段解码 + 非 0x0c 方法不误收 + args 截断包跳过（帧错误不猜）。
    #[test]
    fn feedback_counter_decode() {
        let mk = |mid: u32, args: &[u8]| {
            let mut p = Vec::new();
            p.extend_from_slice(&0x5Au32.to_le_bytes()); // eid
            p.extend_from_slice(&mid.to_le_bytes());
            p.extend_from_slice(&(args.len() as u32).to_le_bytes());
            p.extend_from_slice(args);
            p
        };
        let ok = mk(0x0C, &[2, 0, 5, 0, 3, 0]);
        let other = mk(0x01, &[1, 0, 2, 0, 3, 0, 0]);
        let truncated = mk(0x0C, &[2, 0, 5]);
        let packets: Vec<(u32, f32, &[u8])> = vec![
            (8, 10.0, &ok), (8, 11.0, &other), (8, 12.0, &truncated),
        ];
        let ev = collect_feedback_counters(&packets);
        assert_eq!(ev.len(), 1, "只应收录合法 0x0c 包");
        assert_eq!(ev[0].avatar_eid, 0x5A);
        assert_eq!(ev[0].event_code, feedback_code::SPOTTED);
        assert_eq!(ev[0].count, 5);
        assert_eq!(ev[0].value, 3);
        assert!((ev[0].clock - 10.0).abs() < 1e-6);
    }
}
