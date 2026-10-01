# 数据解耦：进度与剩余项（BlitzKit → 本机客户端自产）

> 2026-10-02 整理。回答一个问题：**"用本机客户端自产替代 BlitzKit 数据源"这件事，现在到哪了、还差什么**。
> 分项证据见 [feasibility-pb-local-extraction.md](feasibility-pb-local-extraction.md)（报告 A）、
> [feasibility-glb-local-export.md](feasibility-glb-local-export.md)（报告 B）、
> [local-model-export.md](local-model-export.md)（GLB 实现与验收）。本文是**进度总览与剩余清单**。

## 0. 一句话现状

**解耦本体（把来源换掉）一行未动**：运行期仍读 BlitzKit，对外发布的资产面里坦克 GLB 与 BlitzKit 缓存
逐字节相同。已完成的是"**能不能替**"的验证，以及两条**并行**的自产管线（GLB 几何/贴图、封面图）——
它们只产出到 `data/cache/` 下的独立目录，**不接管任何现有路径**。

## 1. 已完成

| 项 | 状态 | 证据/入口 |
|---|---|---|
| 两处 protobuf 字段号 bug（引擎起火率、履带地形阻力） | ✅ 已提交 `5032251` | 报告 A §8；`data/tank_data/*.json` 已重生成 |
| **GLB 自产管线**（`model.glb` / `collision.glb`） | ✅ 可用，未接管 | `tools/export_tank_glb.py` + `tools/compare_tank_glb.py`；`collision` 735/735、`model` 733/735 **逐字节**等价（含 UV0/1/2 与节点顺序）；规则见 [local-model-export.md](local-model-export.md) §3 |
| **封面图自产管线** | ✅ 可用，未接管 | `tools/export_tank_icons.py`；703/735（详见 §4） |
| 全向炮塔拖拽角度无界累加 | ✅ 已提交 `b74774f` | 与解耦无关的顺带修复 |

## 2. 换源本体：全部未做

- **运行期**：`src/` 里对本地自产管线的引用 **0 处**（`grep -rn "local_models\|export_tank_glb" src/` 为空）；
  GLB 仍走 `data/cache/models/`（`tank_configs.rs:100` `model_cache_path`）。
- **BlitzKit 消费点 33 处**，分布在 9 个文件：`wargaming/{tank_configs, tank_resolver, game_extract,
  model_fetch}.rs`、`web/{mod, assets}.rs`、`agent/tools.rs`、`replay/loadout.rs`、`main.rs`。
- **发布资产面仍是 BlitzKit 产物**：`release/asset_pack/glb/{id}/model.glb` 的 sha256 与
  `data/cache/models/` 相同（9489 `4cb9338df21b`、7169 `7c0d301f6162`），与本地自产的不同
  （`b2f2b9a0072e`、`8a5e964a10dd`）。即：**即便能力已就绪，对外分发的还是 BK 那份**。

## 3. 按数据类别的剩余工作

| 数据 | 现状 | 剩余 |
|---|---|---|
| `tanks.pb` / `models.pb` | 语义映射**已验证**（报告 A） | **提取器未写**（`extract-vehicles`）：报告 A 估 2–3 人日 + 桥接 0.5–1 + 全量回归 0.5–1 |
| `tank_id ↔ 游戏模型名` 桥 | 未固化 | 按报告 A 路线 B 把 735 条映射**入库**；当前 GLB 导出器是**运行时从 pb field32 派生**，这条依赖还在 |
| GLB 几何 + 贴图 | 生成器**已可用** | **生产化未做**：落进 `release/asset_pack/glb/`、把"按可达节点求和 + 逐字节"固化为 CI 门禁、与 `tank_configs` 的 `turret_index`/`gun_index` 硬耦合做一致性校验（两源不可混用同一辆车） |
| 封面图 `tank_images/` | 生成器**已可用** | 见 §4；另外**素材不同**需先决策观感是否可接受 |
| `tank_data/*.json` | 已随字段修复重生成；资产面快照当前一致 | 换源后需重导 + 增量上传 |
| COS 资产面 | `tank/` 与本地一致；`glb/`、`tank_images/` 仍是 BK | 换源后按 `game-data-sources.md` §5.2 的流程重导出 + 增量上传（该流程文档**尚在分支**上） |

## 4. 封面图：能力已就绪，但"换素材 ≠ 等价替换"

### 4.1 来源与形态（实测）

| 项 | 值 |
|---|---|
| 大图标 | `Data/Gfx/UI/BigTankIcons/<name>.packed.webp.dvpl`（2312 个，含 `@2x` 与 `_skinN`） |
| 小图标（兜底） | `Data/Gfx/UI/BattleScreenHUD/SmallTankIcons/<name>.packed.webp.dvpl`（1474 个） |
| 容器 | DVPL 壳里**就是裸 webp**（`RIFF…WEBP`）——**剥壳即得，不重编码** |
| 分辨率 | 基础 256×128 / `@2x` 512×256 / 小图 128×32 |

### 4.2 命名域：图标名是**第三套命名**，与模型名不规则对应

客户端没有任何权威清单（车辆 XML 与 `list.xml` 都不引用图标名；`list.xml` 的 `<userString>` 键只是车辆名本身），
所以只能逆出规则。实测样本：

| 模型名 | 图标名 | 差异 |
|---|---|---|
| `Ch01_Type59` | `china-Type59` | 丢 `Ch01_` |
| `Ch_WZ-112v2` | `china-WZ-112v2` | 丢**无数字**前缀 `Ch_` |
| `GB10_Black_Prince` | `britsh-BlackPrince` | 丢 `GB10_`、去下划线、国家标签**错拼** `britsh` |
| `StuGIII` | `germany-StugIII` | 大小写不同 |
| `Oth08_WH_Vindicator` | `other-Oth08_Vindicator` | 丢中缀 `WH_` |
| `S04_Lago-I` | `european-S04_Lago_I` | `-`↔`_` |
| `Oth10_WarDuck` | `WarDuck` | **无国家前缀** |
| `Sherman_Jumbo` | `usa-M4A3E2_Sherman_Jumbo` | 多 `M4A3E2`（来自**显示名**） |
| `M48A1` | `usa-M48A1_Patton` | 显示名是 "M48 Patton"，又是第三种拼法 |

实现（`tools/export_tank_icons.py`）：**归一化索引 + 候选梯子**。两侧都"去国家标签 → 转小写 → 去非字母数字"
后比对；候选 = 模型名 / 去 `XxNN_` 前缀 / 去 `Ch_` 类非数字前缀 / 去 `WH_` 中缀 / **显示名**
（`Strings/en.yaml`，实测多救回 16 辆）/ 模型名＋显示名多出的词。

### 4.3 覆盖与残差

**703/735（95.6%）**，其中 3 个退到小图标，**未误用皮肤图**（皮肤变体在排序里被压到最后）。

未命中 32 辆已逐个归因：

- **17 辆客户端确实没有大图标**：`IS-4`、`ST-I`、`E50_Ausf_M`、`AMX_M4_1945`、`T1_Cunningham`、`M2_med`、
  `T2_med`、`D1`、`Vickers Mk II/III`、`Churchill Gun Carrier`、`T7_Combat_Car`、`Leopard Prototyp A`、
  `ISU-122S`、`AMX Chasseur`、`112 Glacial`、`Barkhan`。
- **15 辆是名字变体**：`GB116_Harry_Hopkins`→`british-GB116_Harry_Hopkins_I`、`JagdTiger_SdKfz_185`→
  `germany-JagdTiger`、`S01_Frankentank`→`Frankentank_event` 等。
- **刻意不启用模糊匹配**：实验里模糊匹配会落到**别的车**（`PzV_PzIV`→`PzIV`、`GB24_Centurion_Mk3`→
  `Oth41_Centurion_Mk3_S2`），宁可留空也不串车。

### 4.4 ⚠️ 与 BlitzKit 封面不是同一幅画

保持宽高比（信筒缩放）后逐辆比对：**NCC 中位 0.21、没有任何一对 ≥ 0.7**（BlitzKit 的是它自己的
渲染/裁切、约 147×100 且逐车变尺寸；客户端的是官方 2D 肖像、256×128）。即**换的是素材、不是等价替换**，
前端观感会变。人工判定用对照图：`data/cache/local_tank_icons/_vs_blitzkit.png`（12 辆，NCC 最高/最低各 6）。

## 5. 阻塞与待决策口径

### C1 数据模型塌缩（项目侧缺陷，不是客户端不可信）

- **`TrackData` 是单条**（`blitzkit.rs:159`）：一辆车只有一组 `module_id / weight / traverse_speed /
  resistance_hard / medium`，而客户端 `tracks[]` 可以有**多个底盘**，各自有重量/转速/阻力。
- **`track_thickness: Option<f32>` 是单值**（`blitzkit.rs:310`），赋值处
  `if track_thickness.is_none() { track_thickness = thickness }`（933-934）——**取第一个遇到的板厚**，
  不是按模块或顶级底盘确定；消费点 `tank_configs.rs:51` 直接拿它拼 `ChassisArmor`。`gun_thickness` 同型。
- **症状**：多底盘车的履带厚度/阻力只能显示一条，且丢掉了"这条属于哪个底盘"的对应关系。
- **选项**：改 schema 与客户端同构（+2–3 人日）；或接受"取顶级配置"近似并**显式记录**。

### C2 25 辆车没有本地化显示名（本机实测；报告 A 记 24）

方法：`list.xml` 的 `<userString>#<nat>_vehicles:KEY</userString>` → 用 KEY 查 `Strings/en.yaml.dvpl`。
典型缺失：`GB94_Centurion_Mk5-1_RAAC`(uk)、`Oth53_Rammer`(other)、`Cz20_ShPTK_TVP_100`(european)、
`ARL_44BP`、`S07_Strv74BP`（联动/BP 车占多数）。

影响 `tanks.pb` 的 `name`：换源后这些车要么回退 `dev_name`（用户会看到 `ARL_44BP` 这类 slug），
要么用 WG API 补，要么继续保留 BlitzKit 名表。

**两条对报告 A 的修正**：

1. 报告 A 称"uk 的前缀是 `gb_vehicles`"——**实测是 `uk_vehicles`**（`#uk_vehicles:GB19_Sherman_Firefly`）。
   按它写会**漏掉整个英系**（按错误口径测会得到"62 辆无显示名"的假数字）。
2. **`list.xml` 的 userString 键与模型名不一致的有 7 例**（`AMX_50B`→`AMX_50_68t`、`Object252`→`IS-6`、
   `Oth06_Sega_Lupus`→`Sega_Lupus` 等）——本地化查询必须用 list 的键而不是模型名。

### C3 `is_collector` 三分显示（缺口比报告说的小）

- `data/tank_cache.json` 的字段确实**只有 `is_premium`**，没有 `is_collector`。
- **运行期不缺**：API 现算——`web/mod.rs:1043` 从 `blitzkit::tank_full(id).is_collector`（= pb field13 == 2）
  取值并输出，前端 `TankopediaView.vue:100` 已在用它做 `collector` 样式。
- 真正的缺口在**快照/分发面**：`tank_cache.json` 随 asset pack 分发（离线/移动端），读快照的消费方拿不到
  三分标记。换源时应把 field13（或 `list.xml` 的金价 + `collectible`）写进快照生成器。

### C4 `hull_traverse`（pb field27）与客户端非同量

链路其实是通的：`blitzkit.rs:425` 读 field27（fixed32）→ `tank_resolver.rs:252` 做 rad/s→deg/s（`×180/π`）
→ 落进 `tank_cache.json` → `web/mod.rs:992/1013` 在 API 透出。**但前端零引用**（`grep frontend/src` 无命中），
且数值与客户端 chassis 的 `<rotationSpeed>` 不是同一个量（报告 A：T-34 换算 16.5 deg/s vs 客户端 46 deg/s
——后者才是车体原地转向）。结论：**已解析、已透出、无人消费**；换源时别拿它当车体转速权威值
（客户端该取 chassis `<rotationSpeed>`），保留为对照或在 schema 标废弃。

### 已决

- 贴图验收口径 = **semantic**（按 PBR 语义正确装配），不再提供"复刻 BlitzKit 指派"的口径
  ——后者在 PBR 语义上不成立且 occlusion 的 R/B 通道无客户端来源，见 [local-model-export.md](local-model-export.md) §4。

## 6. 已定案、不再算待办（BlitzKit 侧不可复刻，留作对照基线）

| 类别 | 规模 | 内容 |
|---|---|---|
| 几何 | 2 辆 | `Ch52_WZ_122_6_F3` 元素装配重写；`М4А3Е8_ВР` 的 windows-1252 mojibake |
| 贴图相位 | 158 槽位 | BlitzKit 的 PVR 读法比容器布局晚 16 字节 |
| 图片条目 | 4 辆 | BlitzKit 重复/悬挂的 image 条目（内容相同） |
| 材质名 | 2 辆 | 纯命名（贴图槽与路径逐字相同） |
| 序列化 | 735 / 567 / 77 | 采样器省略默认值；accessor 与 mesh 去重策略 |
| `alphaMode` | 13 辆 / 14 材质 | BlitzKit 侧判据（10 例它漏判、4 例它多判） |

详见 [local-model-export.md](local-model-export.md) §3/§5。

## 7. 工程落地清单

- **本地自产工具**：`tools/export_tank_glb.py`、`tools/compare_tank_glb.py`、`tools/export_tank_icons.py`、
  `tools/probe_switch.py`（逆向探针）。产物落 `data/cache/local_models/`、`data/cache/local_tank_icons/`
  ——均在 gitignore 内，且被 `bundle` 特性的 `cache/**` 排除规则挡在 exe 之外。
- **查看器要看到炮塔修复需重编 exe**（`frontend/dist` 已重建，但 exe 仍是旧构建；dist 是编译期嵌入的）。
- **`docs/game-data-sources.md`（解耦总纲：`tank_id` 缺口三条路线 + COS 发布流程）与 field32 修复
  仍在分支 `fix/game-data-field32-resolution`，未并入 main。**

## 8. 复跑

```bash
# GLB：自产 + 逐字节对照
python tools/export_tank_glb.py --all --texture-mode semantic --jobs 8
python tools/compare_tank_glb.py --all --audit --jobs 8

# 封面图：自产（默认只用大图标；--allow-small 退小图标）
python tools/export_tank_icons.py --all --allow-small

# 诊断（tmp_glb_reverify/，不入库）
python tmp_glb_reverify/full_diff_inventory.py    # 逐维度差异清单
python tmp_glb_reverify/a2_cullmode.py            # doubleSided 判据验证（1598/1598）
python tmp_glb_reverify/icon_tail.py              # 图标残差归因
python tmp_glb_reverify/en_yaml_missing.py        # C2 显示名缺失复核
```
