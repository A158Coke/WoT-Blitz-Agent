# 架构债留存：长期改动方案（未实施）

> 2026-09-29 代码审查产出。本轮已完成全部快修/性能项（正确性、热路径、构建、CI），
> 以下三项为**长期结构性改动**，牵涉面大、需要专门回归窗口，按用户决定留存为文档
> 而非立即实施。实施前请先读本文件的"前置条件"。

## 1. combat.rs 拆分（3577 行 → combat/ 模块目录）

**现状**：`crates/replay-core/src/replay/combat.rs` 单文件承担 10+ 种职责：
数据结构（`ShotReplayData` 50+ 字段等）、**四套独立手写 varint/protobuf 解析器**
（`proto_fields`、`pb_varint`、`find_field`/`field_value`/`read_varint`，外加
`wargaming/battle_results_extra.rs` 的第四套）、15+ 个 `collect_*` 包收集器、
锚点选择（`select_anchor_state`）、渲染层（`render_anchor`/`render_timeline`）、
俯仰解码（`decode_prop2_gun_pitch`）、作者/他人两条提取巨型函数、CLI 打印
（`print_timeline`/`print_shots`——表现层混入核心库，违背 lib.rs 自述的"不绑定 IO"）。

**建议拆分**（保持公共 API 不变，全部走 `combat/mod.rs` re-export）：

```
replay/combat/
├── mod.rs        # re-export + GunPitchLimits 等公共类型
├── events.rs     # CombatEvent / CombatTimeline / HpEvent / print_*（或 print 移出库）
├── pb.rs         # 统一一套 varint/field 解析（四套合并，battle_results_extra 复用）
├── arena.rs      # ArenaUpdate / collect_arena_updates* / kill_feed / periods
├── collect.rs    # launches / endpoints / direct_hits8 / warnings32 / terrain / tick / refresh
├── indexes.rs    # build_entity_indexes / St10Index / Prop2Index / prop2_at 系列
├── anchors.rs    # select_anchor_state / render_anchor / render_timeline
├── pitch.rs      # SectorLimits / GunPitchRange / decode_prop2_gun_pitch
└── shots.rs      # ShotScanShared + 作者/他人提取路径
```

**前置条件**：
- 已有测试基础（16 单测 + `playback_probe` 端到端 P1-P4）可作为拆分回归网；
- 建议先补 `extract_shot_replays_with_limits` / `extract_other_shot_replays_with_limits`
  的快照测试（固定样本 → 固定 JSON），拆分时逐位对照；
- 四套 varint 合并时注意各套的溢出/截断策略略有差异（`pb_varint` 63-bit 上限、
  `find_field` 的 wire 6/7 拒收），合并实现取最严格语义。

## 2. 作者/他人两条射击提取路径合并（~40% 逐行同构）

**现状**：`extract_shot_replays_from_shared`（作者严格，~700 行）与
`extract_other_shot_replays_from_shared`（他人宽松，~410 行）的 tick 采样组装、
渲染锚点/时间线、炮塔/炮管俯仰解码链、`ShotReplayData` 组装全是复制粘贴后改
fallback 策略。**漂移已发生**：`ShotReplayData` 字段注释说射手渲染时间线是
"开火 −2.0~+2.0s"，但两条路径代码实际都传 `-3.0, 2.0`——注释与代码不一致。

**建议**：把"缺失时怎么办"参数化：

```rust
enum MissingPolicy { FailFast, Skip { counter: &'a mut usize }, Fallback(FallbackKind) }
```

组装逻辑（锚点/时间线/俯仰/tick 采样/字段填充）合并为单函数，两路径只注入
各自的 policy 与 Avatar 专属数据（`Option<AuthorExtras>`：method38/aim/type39 等）。

**前置条件**：先裁决注释 vs 代码的时间线窗口语义（−2.0 还是 −3.0，以 WI 对照
实测为准），修掉现存漂移；再做合并，否则会把漂移固化。

## 3. HTTP 表现层收敛 + 前端懒加载/模块拆分

**现状**：
- `src/wargaming/viewer.rs`（~980 行）等 4 个文件散着 axum handler，而
  `crate::replay`（解析层）反向依赖 `viewer::resolve_config_index` / `shell_index_by_global_id`
  ——解析层依赖查看器模块，方向倒置；`GLOBAL_RESOLVER` 全局态三方竞争写入
  （web 启动 / standalone / agent 工具），first-set-wins。
- 前端 `router/index.js` 9 个视图全部静态 `import`：three.js + ~5300 行场景代码
  全打进首屏单 chunk（~970KB），vite manualChunks 分包被路由层抵消。
- `tankViewer.js` 3927 行巨石闭包（92 个嵌套函数、114 个闭包状态变量），
  与 `playbackScene.js` 存在同构重复（`collectConfigNodes`/`poseFromYPR`/
  `poseShooterTurretGun`）；绕过统一 API 层裸 fetch（10+ 处），用
  `window.__INITIAL_TANK__` 全局变量传参。

**建议**：
1. axum handler 统一移入 `src/web/`；`build_configs`/`resolve_config_index` 下沉到
   replay-core 或独立 `tank_configs` 模块；`GLOBAL_RESOLVER` 改 AppState 注入；
   `tank_image_handler` 两份实现（web/mod.rs 与 viewer.rs）合一。
2. 路由改 `component: () => import('../views/X.vue')`，manualChunks 加
   `vendor-three`——约 10 行改动，首屏收益立现（可单独先做，不必等模块拆分）。
3. tankViewer.js 拆为 `viewer/` 目录（scene / armorShaders / glbRig / shotOverlay /
   pickerUi / api），`glbRig` 与 playbackScene 共享；`initTankViewer({ tankId,
   shooterId, query })` 显式参数替代 window 全局。拆分时以现有 URL 参数契约
   （`?shooter=&shell=&shot=&heatmap=1`）立回归基准。

## 附：本轮未实施的次级观察（顺手记录）

- `blitzkit.rs` `models_vec` 为 `Vec`，`model_info` 对 700+ 项线性 `find` 后整体深
  clone——`TankResolver::from_blitzkit` 构建期为 O(N²)。改 `HashMap<u32, TankModelInfo>`
  + 返回引用可消。
- `scanner.rs` 批量扫描完全串行，可加可选 `rayon` feature（WASM 目标保持串行回退）。
- replay-core 错误处理三元混用（anyhow 中文 bail + 库内 eprintln/println），
  建议 `thiserror` 定义 `ReplayError`（`NotBattleReplay`/`LayoutDrift`/`AmbiguousPairing`），
  诊断输出走回调/notes 通道；与拆分（第 1 项）一并做。
- `CombatEvent.entity_name` 每事件 clone 昵称 String（上万条），可改 `Rc<str>` 或
  只存 eid 由消费方查 `entity_names` 表。
- `bundle.rs` `is_data_ready` 仅以 tanks.pb 判定，首释中途崩溃（tanks.pb 已写、
  其余未写完）会停留在残缺态——建议先释放到临时目录再原子 rename。
- `agent/tools.rs` 每次工具调用新建 Tokio Runtime；`view_tank` 的无头服务器无端口
  注册表，多次调用积累常驻进程；`find_chrome` 每次同步探测 5 个子进程无缓存。
- `tankViewer.js` 穿透模式下 `refreshPenetrationResolution()`（全场景 traverse）
  每帧执行，实际只需 resize 时跑。
- 前端无 eslint；5500 行手写场景 JS 拆分时建议同步引入（至少 no-unused-vars 兜底）。

## 本轮已完成的关联改动（供对照）

- `ShotScanShared` 共享扫描（两射击路径复用，探针 P1-P4 全绿，最大样本 2.6x 提速）；
  `ArenaUpdate` 载荷改原始字节（serde 层保持 hex 契约）+ subtype 过滤；
  `prop2_at` 系列改 `partition_point` 二分。
- web 侧三条最重路径补 `spawn_blocking`（replay_shots / playback_data / GLB curl）；
  `build_configs` 按 tank_id 进程级缓存；gzip 响应缓存；上传 body 上限 64MB。
- 前端 tankViewer/playbackScene 资源生命周期修复（destroy 钩子 + mesh dispose）。
- build.rs 占位页哨兵；rust-embed 排除 dist/release；bundle 去重 replay_samples；
  workspace 依赖集中；CI clippy 门禁 + bundle 特性验证 + release 前测试。
