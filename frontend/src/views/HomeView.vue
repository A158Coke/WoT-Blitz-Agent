<script setup>
// 迁移期首页：迁移状态与开发链路说明。功能页面落地后此页会被 Agent Tab（聊天）替换。
</script>

<template>
  <h2>Vue 3 迁移壳已就绪</h2>
  <p class="sub">Phase 0 · 前端工具链 / 二进制嵌入 / 双端伺服链路验证页</p>

  <div class="card">
    <h3 style="margin-top:0">迁移状态</h3>
    <ul class="status">
      <li class="done">Phase 0 — 地基：frontend 脚手架、rust-embed 嵌入、Vite 代理、构建脚本</li>
      <li>Phase 1 — TankDetail 试点</li>
      <li>Phase 2 — 主 GUI 六 Tab（Agent / Tankopedia / Player / Replay / Compare / Settings）</li>
      <li>Phase 3 — Playback 实时回放查看器</li>
      <li>Phase 4 — Armor Viewer 3D 装甲检视器</li>
      <li>Phase 5 — 收尾退役（删除嵌入 HTML、web/vendor 下线）</li>
    </ul>
    <p class="sub" style="margin:8px 0 0">
      迁移期间完整功能界面在 <a href="/legacy">/legacy</a>，方案见 docs/vue-migration-plan.md。
    </p>
  </div>

  <div class="card">
    <h3 style="margin-top:0">开发链路</h3>
    <ul class="status">
      <li>后端：<code>cargo run -- web</code> → http://127.0.0.1:18999（release 构建内嵌本前端，debug 构建运行时读 frontend/dist）</li>
      <li>前端热更新：<code>cd frontend &amp;&amp; npm run dev</code> → http://127.0.0.1:5173（API 代理到 18999）</li>
      <li>一键构建：<code>scripts\build-all.ps1</code>（npm build → cargo build）</li>
    </ul>
  </div>
</template>

<style scoped>
.status { margin:0; padding-left:20px; }
.status li { margin:6px 0; }
.status li:not(.done) { color:var(--muted); }
.status li.done::marker { content:'✔ '; color:var(--green); }
code {
  background:var(--panel3); border:1px solid var(--border); border-radius:6px;
  padding:1px 6px; font-size:0.9em;
}
a { color:var(--accent-2); }
</style>
