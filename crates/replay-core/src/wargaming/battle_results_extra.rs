// battle_results.dat 结算 protobuf 的补充字段解码。
//
// 背景：外部 crate `wotbreplay-parser` 的 PlayerResultsInfo 只暴露部分字段（credits/xp/shots/
// damage 等）；WotbTools `battle-results.md`（PROVEN）给出了完整字段表，其中本项目需要的
// 1/16/24/25/105/119/120 未被 crate 暴露。本模块用最小 protobuf 扫描器从
// `Replay::read_battle_results_dat()` 的原始 buffer 中补齐（unknown ≠ 0：字段缺失保留 None，
// 不猜 0）。
//
// 字段号权威来源：WotbTools battle-results.md + 本项目全量遍历（回放未解析数据清单.md）：
//   #301（每战斗者一条，repeated length-delimited）内：
//   1=终局血量 i32（-2=自动击毁/不活动哨兵、-3 语义禁猜）  16=点亮敌人数
//   24=存活寿命整秒                                        25=击杀者 ID
//   105=死亡原因 i32（-1=存活哨兵、缺省=普通击毁、1=火焰、2=撞击、3=世界/环境）
//   119=毁灭协助次数（≥25% 伤害后盟友击毁）                120=炮印 0..3
//   101=账号 ID（键）  103=车辆 comp descriptor（键）
//
// 交叉验证（WotbTools）：`initialActualHp = max(hitpoints_left, 0) + damage_received(11)`
// 可与 type=5 开局血量互验（暂未消费，留待 P3 settlement 层）。

/// 单个战斗者的结算补充字段（crate 未暴露部分）。
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct PlayerSettlement {
    pub account_id: u32,
    pub tank_id: u32,
    /// 终局剩余血量；负值=哨兵族（-2 自动击毁、-3 未闭合禁猜），正=幸存余血
    pub hitpoints_left: Option<i32>,
    /// 死亡原因：-1=存活哨兵、缺省=普通击毁、1=火焰、2=撞击、3=世界/环境（4 未观测禁猜）
    pub death_reason: Option<i32>,
    /// 存活寿命（整秒；实时死亡包缺失的 4/287 场景仅此秒级回退，禁止合成亚秒时间戳）
    pub life_time_secs: Option<u32>,
    /// 击杀者（result/entity ID）
    pub killer_id: Option<u32>,
    /// 点亮敌人数（与实时 method12 baseType2 终值收口，WotbTools 15/15）
    pub n_enemies_spotted: Option<u32>,
    /// 毁灭协助次数（对目标造成 ≥25% 伤害后盟友将其击毁；== 实时 baseType15 终值 34/34）
    pub destruction_assistance: Option<u32>,
    /// 炮印数 0..3（持久 player×tank 状态，==wrapper1 field26 476/476）
    pub gun_marks: Option<u32>,
}

fn read_varint(b: &[u8], o: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    let mut s = 0u32;
    loop {
        let x = *b.get(*o)?;
        *o += 1;
        v |= ((x & 0x7f) as u64) << s;
        if x & 0x80 == 0 { return Some(v); }
        s += 7;
        if s > 63 { return None; }
    }
}

/// 跳过一个未知字段；返回 false = 流不合法。
fn skip_field(b: &[u8], o: &mut usize, wire_type: u64) -> bool {
    match wire_type {
        0 => read_varint(b, o).is_some(),
        1 => { *o += 8; *o <= b.len() }
        2 => match read_varint(b, o) {
            Some(len) => { *o += len as usize; *o <= b.len() }
            None => false,
        },
        5 => { *o += 4; *o <= b.len() }
        _ => false,
    }
}

/// 解析单条 PlayerResultsInfo 子消息（字段表见模块注释）。
fn parse_player_entry(b: &[u8]) -> Option<PlayerSettlement> {
    let mut s = PlayerSettlement::default();
    let mut o = 0usize;
    while o < b.len() {
        let key = read_varint(b, &mut o)?;
        let (field, wt) = (key >> 3, key & 7);
        if wt == 0 {
            let v = read_varint(b, &mut o)?;
            let v32 = v as i32;
            match field {
                1 => s.hitpoints_left = Some(v32),
                16 => s.n_enemies_spotted = Some(v as u32),
                24 => s.life_time_secs = Some(v as u32),
                25 => s.killer_id = Some(v as u32),
                101 => s.account_id = v as u32,
                103 => s.tank_id = v as u32,
                105 => s.death_reason = Some(v32),
                119 => s.destruction_assistance = Some(v as u32),
                120 => s.gun_marks = Some(v as u32),
                _ => {}
            }
        } else if !skip_field(b, &mut o, wt) {
            return None;
        }
    }
    Some(s)
}

/// 解析结算 protobuf 根消息（`BattleResultsDat.buffer`）：提取全部 #301 战斗者条目。
/// 线格式（crate PlayerResults 模型佐证）：#301 = `{ result_id: u32 @1,
/// info: PlayerResultsInfo @2 (length-delimited) }`——字段在嵌套的 info 里，需进两层。
/// 流不合法时返回已成功解析的前缀（fail-soft，调用方按账号联表）。
pub fn parse_settlement_extras(proto: &[u8]) -> Vec<PlayerSettlement> {
    let mut out = Vec::new();
    let mut o = 0usize;
    while o < proto.len() {
        let Some(key) = read_varint(proto, &mut o) else { break };
        let (field, wt) = (key >> 3, key & 7);
        if field == 301 && wt == 2 {
            let Some(len) = read_varint(proto, &mut o) else { break };
            let end = o + len as usize;
            if end > proto.len() { break }
            // 进两层：#301 → tag1 result_id（跳过）/ tag2 = PlayerResultsInfo
            let entry = &proto[o..end];
            let mut io = 0usize;
            while io < entry.len() {
                let Some(ikey) = read_varint(entry, &mut io) else { break };
                let (ifield, iwt) = (ikey >> 3, ikey & 7);
                if ifield == 2 && iwt == 2 {
                    let Some(ilen) = read_varint(entry, &mut io) else { break };
                    let iend = io + ilen as usize;
                    if iend > entry.len() { break }
                    if let Some(s) = parse_player_entry(&entry[io..iend]) {
                        out.push(s);
                    }
                    io = iend;
                } else if !skip_field(entry, &mut io, iwt) {
                    break;
                }
            }
            o = end;
        } else if !skip_field(proto, &mut o, wt) {
            break;
        }
    }
    out
}
