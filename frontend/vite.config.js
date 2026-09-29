import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 开发链路：页面由 Vite dev server 伺服（热更新），API 与资源代理到 Axum 后端
// （先 `cargo run -- web` 起后端，再 `npm run dev`）。
// /legacy 是迁移期旧版主 GUI，同样代理到后端。
const backend = 'http://127.0.0.1:18999'

export default defineConfig({
  plugins: [vue()],
  build: {
    // Android WebView 兼容基线（现有页面已用 ESM/可选链，无降级需求）
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-vue': ['vue', 'vue-router'],
          'vendor-chart': ['chart.js'],
          'vendor-md': ['markdown-it', 'dompurify', 'katex'],
          // three（含 addons）单独成包：仅 /playback 与 /armor_view 两个场景路由需要，
          // 随路由懒加载按需取用，不再混入通用首屏 chunk
          'vendor-three': ['three'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/armor_view': backend,
      '/glb': backend,
      '/vendor': backend,
      '/screenshots': backend,
      '/legacy': backend,
    },
  },
})
