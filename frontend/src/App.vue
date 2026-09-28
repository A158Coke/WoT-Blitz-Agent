<script setup>
// 全局壳：顶栏 + 路由出口。样式基线来自旧版主 GUI（tokens.css + 顶栏规则平移）。
</script>

<template>
  <header id="nav">
    <span id="brand">WOTB<span class="dot">.</span>Agent</span>
    <nav id="tabs">
      <!-- 各功能 Tab 随迁移阶段逐个改为 router-link -->
      <RouterLink class="nav-btn active" to="/">Home</RouterLink>
    </nav>
    <a id="legacy-link" href="/legacy" title="迁移完成前的旧版完整界面">旧版界面 →</a>
  </header>
  <main>
    <RouterView />
  </main>
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
.nav-btn.active,
.nav-btn.router-link-active {
  background:linear-gradient(135deg,var(--accent),var(--accent-2)); color:#1a1208;
  box-shadow:0 4px 16px rgba(255,138,61,0.35);
}
#legacy-link {
  color:var(--muted); font-size:0.88em; text-decoration:none; padding:6px 10px;
  border:1px solid var(--border); border-radius:var(--radius-sm);
}
#legacy-link:hover { color:var(--accent-2); border-color:var(--border-hi); }

main {
  flex:1; min-height:0; width:100%; overflow-y:auto; padding:24px;
  max-width:1200px; margin:0 auto;
}
</style>
