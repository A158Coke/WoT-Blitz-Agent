import { createRouter, createWebHistory } from 'vue-router'
import { DEFAULT_VIEW, ROUTES, isAllowedView } from './views.js'

// Phase 2 起主 GUI 六 Tab 全部路由化；✅ Phase 3: /playback；✅ Phase 4: /armor_view/view/:id。
// 服务端对应页面路径均挂 SPA index（见 src/web/mod.rs），未知路径服务端 404、客户端兜底回首页。
// 视图表在 router/views.js（合法视图的单一事实源，深链 URL 也由它构造）。
// 全部路由懒加载（动态 import）：three.js + 5300 行场景代码此前随静态 import 全部
// 打进首屏单 chunk（~970KB），Chat 首屏白付解析；分包后按需加载（vendor-three 见
// vite.config.js manualChunks）。
const routes = [
  ...ROUTES,
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// fail-closed：未注册的视图名一律回默认视图。深链来自书签 / 旧链接（含 window.open
// 打开的独立窗口），不该静默留在半渲染状态。
router.beforeEach((to) => {
  if (to.name && !isAllowedView(to.name)) return { name: DEFAULT_VIEW, replace: true }
  return true
})

export default router
