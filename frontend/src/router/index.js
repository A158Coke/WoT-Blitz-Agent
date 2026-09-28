import { createRouter, createWebHistory } from 'vue-router'
import ChatView from '../views/ChatView.vue'
import TankDetailView from '../views/TankDetailView.vue'
import TankopediaView from '../views/TankopediaView.vue'
import PlayerView from '../views/PlayerView.vue'
import ReplayView from '../views/ReplayView.vue'
import CompareView from '../views/CompareView.vue'
import SettingsView from '../views/SettingsView.vue'
import PlaybackView from '../views/PlaybackView.vue'
import ArmorView from '../views/ArmorView.vue'

// Phase 2 起主 GUI 六 Tab 全部路由化；✅ Phase 3: /playback；✅ Phase 4: /armor_view/view/:id。
// 服务端对应页面路径均挂 SPA index（见 src/web/mod.rs），未知路径服务端 404、客户端兜底回首页。
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: ChatView },
    { path: '/tank/:tankId(\\d+)', name: 'tank-detail', component: TankDetailView },
    { path: '/tankopedia', name: 'tankopedia', component: TankopediaView },
    { path: '/player', name: 'player', component: PlayerView },
    { path: '/replay', name: 'replay', component: ReplayView },
    { path: '/compare', name: 'compare', component: CompareView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/playback', name: 'playback', component: PlaybackView },
    { path: '/armor_view/view/:tankId(\\d+)', name: 'armor-view', component: ArmorView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router
