# 架构债：长期改动方案与实施状态

> 2026-09-29 代码审查产出；同日第二轮回填实施状态。三项长期结构性改动中
> **第 1、2 项已实施完毕**（字节级回归验证），**第 3 项大部分实施**（前端
> 懒加载/共享 rig/ESLint 门禁已落地；tankViewer 巨石闭包的完整目录拆分
> 仍留存）。历史方案细节保留在下文，供后续实施对照。

## 实施状态总览（2026-09-29 第二轮）

| 项 | 状态 | 验证 |
|----|------|------|
| 1. combat.rs 拆分 | ✅ 完成 | 8 样本 combat JSON 字节级一致；63 测试 + 探针 P1-P4 + wasm32 全绿 |
| 2. 双射击路径合并 | ✅ 完成（同构段收敛为共享实现） | 同上字节级一致 |
| 3a. HTTP 层收敛 + 配置下沉 | ✅ 完成 | 测试全过 + 浏览器烟雾（装甲/回放） |
| 3b. 前端路由懒加载 | ✅ 完成 | 首屏 entry chunk 970KB → 8.3KB |
| 3c. tankViewer 目录拆分 | ⬜ 留存（见下） | eslint + glbRig 共享已就位 |

---

## 1. combat.rs 拆分（已实施 ✅）

**落地形态**：`replay/combat/` 目录八子模块，公共 API 经 `mod.rs` 网格再导出，
`crate::replay::combat::*` 路径不变：

- `events`（CombatTimeline/CombatEvent/HpEvent 事件层）；
- `pb`（protobuf wire 解析助手——battle_results_extra 的重复 `read_varint`
  已消除，复用 `pb_varint`，两实现逐字节同语义）；
- `arena`（updateArena 流：subtype 过滤收集/PERIOD/击杀播报/AoI/反馈计数/type39）；
- `collect`（射击路径收集器：launch/endpoint/direct8/warning32/地形命中/降幅/tick）；
- `indexes`（st10/prop2 索引与二分求值）；
- `anchors`（判定锚点与渲染层滤波时间线）；
- `pitch`（俯仰极限模型与 frac 解码）；
- `shots`（ShotReplayData/ShotScanShared 与两条提取路径）。

`print_timeline`/`print_shots` 已移出核心库到 `main.rs`（库不绑定 IO 契约）。

## 2. 作者/他人双路径合并（已实施 ✅）

**裁决**：两条路径代码一致使用渲染窗口 −3.0~+2.0（受击）/−3.0~+2.0（射手）
与炮塔角射手 −2.0~+2.0——注释"射手方开火 −2.0"为过时表述，已修注释保持零行为变化。

**落地形态**（比原方案保守：单循环 + 策略枚举会把 8 处 bail/跳过分叉变成
分支噪音，可读性反降；改为同构段收敛为共享实现，漂移面清零）：

- `turret_rel_at`：炮塔相对角链（流序快照 → 时钟序兜底）；
- `pitch_from_prop2`：prop2 frac 俯仰解码链（双方同构，回退留给调用方）；
- `shot_render_pack`：单发渲染层包（锚点 + 四条时间线，**数字窗口集中单处**）；
- `tick_window_samples`：type=10 采样窗口（锚点截断 + 渲染位合成）。

两条路径的 50 字段组装字面量保留（差异本质化后不再有逐行复制段）。

## 3. HTTP 收敛 + 前端（部分实施）

**已落地**：
- `wargaming/tank_configs.rs`：build_configs/resolve_config_index/
  shell_index_by_global_id/synth_armor_model/tank_data_value/GLOBAL_RESOLVER
  下沉——解析层→查看器的方向倒置消除；
- `web/assets.rs`：查看器路由与全部 handler、GLB/图片资产伺服、热力图门控
  收敛；viewer.rs 只留 serve/start_* 入口；tank_image 双份实现合一；
- `build_playback_json`/`playback_data_response` resolver 注入（web 走
  AppState mtime 缓存实例，GLOBAL_RESOLVER 降为缺省回退）；
- 路由全量懒加载 + `vendor-three` 分包（首屏 970KB → 8.3KB）；
- `scene/glbRig.js`：poseFromYPR 共享（两场景逐字重复消除）；
- ESLint 门禁（`npm run lint` + CI）：`no-undef` 恰好拦截 replaySource.js
  漏 import 那类"构建通过、运行时才炸"的错误。

**仍留存（3c）**：tankViewer.js（~3900 行巨石闭包，92 嵌套函数 + 114 闭包
状态变量）的完整目录拆分。原方案：

```
viewer/
├── scene.js        # 渲染器/相机/resize/destroy
├── armorShaders.js # 穿透材质多 pass（206-827 区域，独立性最好）
├── glbRig.js       # ✅ 已抽（poseFromYPR）；装配链继续并入
├── shotOverlay.js  # 射击弹道/命中复现叠加层
├── pickerUi.js     # 坦克选择器 DOM
└── api.js          # 统一 apiGet（替换 10+ 处裸 fetch 与 window 全局传参）
```

实施要点：先以 URL 参数契约（`?shooter=&shell=&shot=&heatmap=1`）立浏览器
回归基准；闭包状态改为显式 state 对象在模块间传递；`initTankViewer({ tankId,
shooterId, query })` 显式参数替换 `window.__INITIAL_TANK__`。eslint 已就位
（死代码已清），拆分时的 no-undef/no-unused-vars 即时兜底。

## 附：次级观察清单（未实施，按需取用）

- `blitzkit.rs` `models_vec` 为 `Vec`，`model_info` 线性 `find` + 深克隆——
  `TankResolver::from_blitzkit` 构建期 O(N²)。改 `HashMap<u32, TankModelInfo>`
  + 返回引用可消。
- `scanner.rs` 批量扫描串行，可加可选 `rayon` feature（WASM 目标保持串行）。
- replay-core 错误处理三元混用（anyhow 中文 bail + 库内 eprintln），建议
  `thiserror` 定义 `ReplayError`；与库内诊断输出走 notes 通道。
- `CombatEvent.entity_name` 每事件 clone 昵称 String，可改 `Rc<str>` 或只存 eid。
- `bundle.rs` `is_data_ready` 仅以 tanks.pb 判定，首释中途崩溃停留残缺态——
  先释放到临时目录再原子 rename。
- `agent/tools.rs` 每次工具调用新建 Tokio Runtime；view_tank 无头服务器无
  端口注册表；find_chrome 探测无缓存。
- tankViewer 穿透模式 `refreshPenetrationResolution()` 每帧全场景 traverse，
  实际只需 resize 时跑。
- `armor_tank_data_handler` 与 `/api/tank` 主实现仍是两份相近 JSON 组装
  （历史契约差异：前缀与 resolver 来源），可再收敛。
