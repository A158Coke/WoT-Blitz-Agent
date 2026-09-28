import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import TankDetailView from '../views/TankDetailView.vue'

// 路由按迁移阶段逐个落地（方案见 docs/vue-migration-plan.md）：
//   ✅ Phase 1: /tank/:id
//   Phase 2: /tankopedia /player /replay /compare /settings
//   Phase 3: /playback    Phase 4: /armor_view/view/:id
// 服务端对应页面路由同步切到 SPA（见 src/web/mod.rs 注释），未知路径服务端 404、客户端兜底回首页。
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/tank/:tankId(\\d+)', name: 'tank-detail', component: TankDetailView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router
