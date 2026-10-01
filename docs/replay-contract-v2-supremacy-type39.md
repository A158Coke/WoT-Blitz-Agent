# Replay Contract v2：Supremacy / Supremacy Points / Type39 Aim Frames

状态标记沿用 WotBTools 惯例：PROVEN（真实回放交叉验证）/ INFERRED / UNKNOWN。

## 1. Supremacy 基地状态（PROVEN，wrapper12/root11）

数据链：`Type 8 EntityMethod → subtype 48 (updateArena2) → wrapperFieldNumber=12 → root field 11 → repeated base 块`。

嵌套字段（varint）：

| field | 语义 | 约束 |
|---|---|---|
| 1 | base index，0..3 = A..D | absent 在 canonical 边界按 wire default 0（=A）；唯一补缺省处 |
| 2 | owner team | ∈ {0,1,2}；0 = 显式清空归属 |
| 3 | capturing team | ∈ {0,1,2}；0 = 显式清空占领方（连带清 progress） |
| 4 | capture progress | 0..99 |
| 5/6 | UNKNOWN | 原样透传，禁命名 |

wire 块是 **SPARSE UPDATE**，重建语义（`SupremacyBaseStateReconstructor` 逐行移植）：

- absent 字段 = 维持前值（不推断）
- 显式 0（owner/capturing）= 清空该字段
- 显式 capturing 清空 → progress 连带清空
- 占领中（capturing 在案）发生 owner 变更 → capturing 与 progress 一并清空
- 输出：`SupremacyBaseStateTransition { clock, base_id, owner_team, capturing_team, capture_progress }`——每条 raw 更新一条，携带该基地更新后的完整状态
- seek 消费：取 ≤t 的每基地最后一条逐字段折叠
- 门禁：wrapperFieldNumber 必须 == 12；不合法块整体跳过，绝不产出部分状态

## 2. Supremacy 实时点数（PROVEN，wrapper13/root12）

`subtype 48 → wrapper 13 → root field 12 → repeated team 块`；块内 field1=team（1/2）、field2=points（0..100000）。
门禁缺一不可：wrapper 必须 == 13（wrapper=1 名册等即使 root 结构相同也绝不产出点数事件）。
已对 5 场真实回放交叉验证（事件数 185/161/69/204/201，点数区间与击毁 ±40 点事件吻合）。
**只消费回放真实广播，绝不按游戏规则推算比分；点数不得反推基地归属**（归属只来自 wrapper12/root11）。

## 3. Type39 瞄准帧（PROVEN 子集，recorder-only）

Type39 = 作者 Avatar 瞄准/炮线帧（28B = 7×f32）：f0=世界系 yaw、f1=世界系 pitch（取负）、
f2..4=世界系射线一点、f5=相对偏航族（PARTIAL，死亡/观战后失效）、f6=车体系俯仰。

contract 投影 `AimFrame { time_sec, world_yaw, world_pitch, ray_point }` 只暴露已证明字段
（f5 不入 contract）；仅作者（Avatar 专属包，天然 recorder-only）；缺帧省略、不外推；
消费端按 death_events 门控存活期。禁止给其他车辆伪造瞄准线。

## 4. contract version guard

`PlaybackData.version` 1 → **2**（新增 `supremacy_bases` / `supremacy_points` / `aim_frames`，
空数组安全序列化）。消费端必须对版本显式拒绝：错版 WASM 不允许被静默解析成半残数据。
3D 仍处 feature flag，允许 breaking；2D 消费方随本契约同批升级。

## 5. gameplay mode 纪律

`meta.arenaBonusType` 不是 gameplay objective mode 的权威（只覆盖 random/training/tournament
类别）。第一版 Supremacy 目标状态存在性以 canonical base state timeline 为强事实；
Assault/Encounter 的多 candidate 变体映射无证据，fail-closed（消费端不猜）。

## 6. 实现

- `crates/replay-core/src/replay/combat/arena.rs`：`collect_supremacy_base_updates` /
  `reconstruct_supremacy_base_states` / `collect_supremacy_points` / `AimFrame`
- `crates/replay-core/src/replay/model.rs`：`Timeline.{supremacy_bases, supremacy_points, aim_frames}`
- `crates/replay-core/src/replay/playback.rs`：PlaybackData v2 字段
- 测试：`arena::supremacy_tests`（sparse 重建/显式清空/owner 变更清 capture/wrapper 门禁/
  非法块跳过/多字节 varint 点数）；`facets_smoke`（version=2 + 新键安全序列化）

provenance 源：WotBTools `docs/research/replay/supremacy-base-state.md`、
`java/wotb-core/.../EntityMethodDecoder.java`（parseRawSupremacyBaseUpdates /
parseSupremacyPoints / decodeUpdateArena2）、`SupremacyBaseStateReconstructor.java`。
