<script setup>
// 全局壳：顶栏（六 Tab 路由）+ 路由出口 + 全局 toast + 模型库悬浮组件。
// Agent Tab（首页）用视口级三区布局：main 撑满不滚动，滚动交给 #chat-log。
import { useRoute } from 'vue-router'
import { useToast } from './composables/useToast.js'
import ModelsChip from './components/ModelsChip.vue'

const route = useRoute()
const { toastState } = useToast()

const tabs = [
  { name: 'home', label: 'Agent', to: '/' },
  { name: 'tankopedia', label: 'Tankopedia', to: '/tankopedia' },
  { name: 'player', label: 'Player', to: '/player' },
  { name: 'replay', label: 'Replay', to: '/replay' },
  { name: 'compare', label: 'Compare', to: '/compare' },
  { name: 'settings', label: 'Settings', to: '/settings' },
]
</script>

<template>
  <header id="nav">
    <span id="brand">WoTB<span class="dot">.</span>Agent</span>
    <nav id="tabs">
      <RouterLink
        v-for="t in tabs" :key="t.name" :to="t.to"
        class="nav-btn" active-class="active" :class="{ active: route.name === t.name }"
      >{{ t.label }}</RouterLink>
    </nav>
  </header>
  <main :class="{ 'chat-mode': route.name === 'home', 'fullbleed': route.name === 'playback' || route.name === 'armor-view' }">
    <RouterView />
  </main>
  <div id="toast" :class="{ show: toastState.visible }">{{ toastState.text }}</div>
  <ModelsChip />
</template>

<style scoped>
#nav {
  display:flex; gap:6px; padding:12px 20px; position:sticky; top:0; z-index:60;
  background:rgba(27,24,23,0.8); backdrop-filter:blur(14px); border-bottom:1px solid var(--border);
  align-items:center;
}
#brand { font-weight:800; letter-spacing:.5px; font-size:1.05em; margin-right:12px; }
#brand .dot { color:var(--accent); }
#tabs { display:flex; gap:6px; flex:1; }
.nav-btn {
  background:transparent; border:1px solid transparent; color:var(--muted);
  padding:9px 16px; border-radius:var(--radius-sm); cursor:pointer; font-size:0.93em; font-weight:600;
  transition:all .15s ease; text-decoration:none;
}
.nav-btn:hover { color:var(--txt); background:rgba(255,255,255,0.05); }
.nav-btn.active {
  background:linear-gradient(135deg,var(--accent),var(--accent-2)); color:#1a1208;
  box-shadow:0 4px 16px rgba(255,138,61,0.35);
}

main {
  flex:1; min-height:0; width:100%; overflow-y:auto; padding:24px;
  max-width:1200px; margin:0 auto;
}
/* Agent tab 视口级三区布局：main 撑满且自身不滚动，滚动交给 #chat-log */
main.chat-mode { max-width:none; padding:0; overflow:hidden; display:flex; }
/* 实时回放：视口级全幅（面板/场景绝对定位） */
main.fullbleed { max-width:none; padding:0; overflow:hidden; display:flex; }
</style>
