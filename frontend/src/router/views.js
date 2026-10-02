/**
 * 视图注册表 —— **“合法视图”的单一事实源**（路由表 + 深链 URL 构造 + 参数白名单）。
 *
 * 为什么要单独一层：本应用有两类入口会手写路径——主 GUI 的路由跳转，以及
 * `ReplayView` / `TankDetailView` 用 `window.open('/playback?file=…')`、
 * `/armor_view/view/:id?heatmap=1&…` 打开的独立窗口（Android WebView 下被
 * `utils/tauri.js` 改写成当前页跳转）。此前路径字符串散落在各调用点，且兜底
 * 路由是静默 `redirect: '/'`：一旦某个视图退役，旧深链既不报错也不提示，
 * 只是悄悄落到首页。
 *
 * 这里把三件事收成一处：
 * 1. `ROUTES`：视图名 ↔ 路径 ↔ 组件；
 * 2. `ALLOWED_VIEWS` / `viewFromName`：**fail-closed** —— 未注册的名字一律回默认视图；
 * 3. `locationForView`：唯一 URL 构造点，附带**参数白名单**（每个视图只接受自己
 *    声明的 query key，跨视图跳转时陈旧参数不会跟着漏过去）。
 */

export const DEFAULT_VIEW = 'home'

export const ROUTES = [
  { path: '/', name: 'home', component: () => import('../views/ChatView.vue') },
  { path: '/tank/:tankId(\\d+)', name: 'tank-detail', component: () => import('../views/TankDetailView.vue') },
  { path: '/tankopedia', name: 'tankopedia', component: () => import('../views/TankopediaView.vue') },
  { path: '/player', name: 'player', component: () => import('../views/PlayerView.vue') },
  { path: '/replay', name: 'replay', component: () => import('../views/ReplayView.vue') },
  { path: '/compare', name: 'compare', component: () => import('../views/CompareView.vue') },
  { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
  { path: '/playback', name: 'playback', component: () => import('../views/PlaybackView.vue') },
  { path: '/armor_view/view/:tankId(\\d+)', name: 'armor-view', component: () => import('../views/ArmorView.vue') },
]

const byName = new Map(ROUTES.map((r) => [r.name, r]))

export const ALLOWED_VIEWS = Object.freeze(ROUTES.map((r) => r.name))

export function isAllowedView(name) {
  return byName.has(name)
}

/** 未注册的视图名一律回默认视图（不抛错：深链来自书签 / 旧链接，不是编程错误）。 */
export function viewFromName(name) {
  return isAllowedView(name) ? name : DEFAULT_VIEW
}

// 各视图接受的 query key 白名单。未声明的视图不接受任何 query。
const VIEW_QUERY_KEYS = Object.freeze({
  playback: ['file', 'q'],
  'armor-view': ['shooter', 'shell', 'scfg', 'config', 'shot', 'heatmap', 'world', 'view'],
  'tank-detail': ['config'],
})

// 路径构造：需要路径参数的视图在此声明；其余视图直接用 ROUTES 里的字面路径。
const VIEW_PATHS = Object.freeze({
  'tank-detail': (p) => `/tank/${Number(p.tankId) || 0}`,
  'armor-view': (p) => `/armor_view/view/${Number(p.tankId) || 0}`,
})

/**
 * 构造某视图的规范 URL（path + 白名单内的 query）。
 *
 * @param {string} name 视图名（未注册 → 落到默认视图）
 * @param {Record<string, unknown>} [params] 路径参数与 query 参数混在一个对象里
 * @returns {string} 形如 `/playback?file=…`
 */
export function locationForView(name, params = {}) {
  const view = viewFromName(name)
  const route = byName.get(view)
  const path = VIEW_PATHS[view] ? VIEW_PATHS[view](params) : route.path
  const allowed = VIEW_QUERY_KEYS[view] || []
  const qs = new URLSearchParams()
  for (const key of allowed) {
    const v = params[key]
    if (v === undefined || v === null || v === '') continue
    qs.set(key, String(v))
  }
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}
