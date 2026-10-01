# 文档索引

> 全部 Markdown 文档的定位与状态一览（2026-09-28 整理）。入口永远是根目录 [README](../README.md)。

## 使用文档（随项目演进，保持最新）

| 文档 | 定位 |
|---|---|
| [README.md](../README.md) | 项目总入口：功能总览、快速开始、Web UI/CLI/打包/移动端、仓库结构 |
| [回放射击事件逆向分析.md](../回放射击事件逆向分析.md) | 回放数据段**权威参考**：每个数据段的字节布局、已破解语义、本项目使用状态（使用中/辅助/未使用） |
| [回放未解析数据清单.md](../回放未解析数据清单.md) | 主文档配套速查表：全部数据段使用状态一页总览 + 回退链/质量标记 + 死路清单 |
| [docs/wotbtools-cross-reference.md](wotbtools-cross-reference.md) | 与 WotbTools 逆向结论的逐条裁决记录（采纳/驳回/互证），防止误采或回退已定案 |

## 方案文档（已执行完毕，留档）

| 文档 | 状态 |
|---|---|
| [docs/vue-migration-plan.md](vue-migration-plan.md) | ✅ 已完成（2026-09-28）：前端四页全部切流 Vue 3 SPA，嵌入 HTML 与 web/vendor 已退役 |
| [docs/mobile_plan.md](mobile_plan.md) | ✅ 已完成（2026-09）：Android 双形态 APK 已分发；实际实现与方案的差异见文首注记 |

## 可行性评估（待决策，2026-10-01）

用本机客户端解包替代 BlitzKit 数据源的评估。两份报告均含逐字段/逐项验证数字与反例清单，
并已登记**两处既有 bug**（`tanks.pb` 引擎起火率与履带阻力读错 protobuf 字段号，见报告 A §8）：

| 文档 | 结论摘要 | 状态 |
|---|---|---|
| [docs/feasibility-pb-local-extraction.md](feasibility-pb-local-extraction.md) | `tanks.pb`/`models.pb` 可替代；735/735 覆盖、零实质分歧；唯一缺口 `tank_id`（有两条替代路径） | ⬜ 待决策（约 3–5 人日） |
| [docs/feasibility-glb-local-export.md](feasibility-glb-local-export.md) | 客户端自行导出 `model.glb`/`collision.glb`：全量 735 辆验收——collision **735/735 完全等价**、model **700/735 等价**（余 35 辆已归为 4 类规则缺口）；贴图槽位已完整逆向，**待决策验收口径** | ⬜ 待决策（约 4–7 人日） |

## 逆向分析报告（历史定稿，部分单点结论已被后续修正）

这三篇是逆向过程的阶段性完整报告，反汇编/协议事实仍然有效；
已被修正的结论在文首"整理注记"中逐条标明，**以主文档与代码现状为准**：

| 文档 | 定稿日期 | 已过时要点（详见文内注记） |
|---|---|---|
| [游戏回放数据处理分析报告.md](../游戏回放数据处理分析报告.md) | 2026-09-23 | prop9 语义（俯仰→偏航镜像）、§6.2 突破口已关闭、hitMarks 已证死路 |
| [客户端弹道与命中位置逆向报告.md](../客户端弹道与命中位置逆向报告.md) | 2026-09-23 | §六 Rust 侧弹孔解码链已删除（功能移至前端 tankViewer.js）、prop9 时间线数据源 |
| [WI射击参数与命中位置分析.md](../WI射击参数与命中位置分析.md) | 2026-09-25 | 基本现行有效；§九遗留项中 type=32 尾字节布局对照主文档 §5.1（WI 侧 segment 另有服务端重编码因素，见其 §5.2） |

## 约定

- 逆向结论的**唯一权威**是《回放射击事件逆向分析.md》（主文档）；其余文档与其冲突时，
  先查 [wotbtools-cross-reference.md](wotbtools-cross-reference.md) 是否已有裁决。
- 历史推导过程不在工作区文件中保留（早期 `backup_pre_wi_align/` 存档目录已删除），
  需要时查 git 历史。
- `examples/`（逆向探针脚本）与 `tmp_*/`（分析转储）不入库，文档中提及处仅作证据出处记录。
