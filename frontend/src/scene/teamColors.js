/**
 * 阵营 / 目标调色 —— **单一事实源**（3D 场景与 DOM 面板共用）。
 *
 * 本模块存在的原因：此前同一批阵营色在四处各自硬编码——`playbackScene.js` 的
 * `COLOR_*`、`BASE_OWNER_*`、`teamColor()` 内联值、以及 `PlaybackView.vue` 的
 * 视图私有 `--ally/--enemy/--unknown/--accent`。任一处调整都会让 3D 标记与面板
 * 颜色失去一致（“同一个己方，两处不同绿”）。
 *
 * CSS 侧的语义 token 名（`styles/tokens.css` 的 `--color-team-*` / `--color-objective`）
 * 与本表一一对应；改色时两处同时改，token 注释指向本模块。
 *
 * 口径保留说明：亮色口径与深色口径**不是同一用途**，不可互相替换——
 * 亮色画在深浅不一的地形/贴图上（基地环、旗帜、炮线），深色用于
 * 明亮地表上的文字与大块填充（昵称标签卡、花名册圆点、无 GLB 的代理车体）。
 * 这是原作者经过对比度调整的结论，合并会退化可读性。
 */

/** 亮色口径：画在地形 / 地图贴图之上（基地归属、旗帜、炮线、边界） */
export const TEAM_COLORS = Object.freeze({
  ally: '#2ecc71',
  enemy: '#ef4444',
  neutral: '#f5f5f5', // 中立与未知阵营一律白（unknown ≠ enemy）
  objective: '#ffc24b', // 单基地占领进度：非阵营语义，不暗示“谁在占领”
})

/** 深色口径：明亮地表上的文字 / 大块填充（标签卡、花名册圆点、无 GLB 的代理车体） */
export const TEAM_COLORS_DEEP = Object.freeze({
  ally: '#26794a',
  enemy: '#98322a',
})

/** DOM 面板口径：深色半透明面板之上的文案与描边。
 *  对应 styles/tokens.css 的 --color-team-ally / -enemy（那边是 DOM 的唯一出口）。 */
export const TEAM_COLORS_PANEL = Object.freeze({
  ally: '#3fa66a',
  enemy: '#c05046',
})

/** '#rrggbb' → 0xrrggbb（three.js 需要数值色，此处是唯一的字符串→数值转换点） */
export function hexToInt(hex) {
  return parseInt(String(hex).replace('#', ''), 16)
}
