import { createRouter, createWebHistory } from 'vue-router'

// Phase 2 起主 GUI 六 Tab 全部路由化；✅ Phase 3: /playback；✅ Phase 4: /armor_view/view/:id。
// 服务端对应页面路径均挂 SPA index（见 src/web/mod.rs），未知路径服务端 404、客户端兜底回首页。
// 全部路由懒加载（动态 import）：three.js + 5300 行场景代码此前随静态 import 全部
// 打进首屏单 chunk（~970KB），Chat 首屏白付解析；分包后按需加载（vendor-three 见
// vite.config.js manualChunks）。
const routes = [
  { path: '/', name: 'home', component: () => import('../views/ChatView.vue') },
  { path: '/tank/:tankId(\\d+)', name: 'tank-detail', component: () => import('../views/TankDetailView.vue') },
  { path: '/tankopedia', name: 'tankopedia', component: () => import('../views/TankopediaView.vue') },
  { path: '/player', name: 'player', component: () => import('../views/PlayerView.vue') },
  { path: '/replay', name: 'replay', component: () => import('../views/ReplayView.vue') },
  { path: '/compare', name: 'compare', component: () => import('../views/CompareView.vue') },
  { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
  { path: '/playback', name: 'playback', component: () => import('../views/PlaybackView.vue') },
  { path: '/armor_view/view/:tankId(\\d+)', name: 'armor-view', component: () => import('../views/ArmorView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
