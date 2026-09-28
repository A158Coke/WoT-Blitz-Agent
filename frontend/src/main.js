import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { installTauriShims } from './utils/tauri.js'
import './styles/tokens.css'

// Tauri 移动端 shim（fetch POST 走 IPC 桥、window.open 同源改跳转）必须先于应用挂载安装
installTauriShims()

createApp(App).use(router).mount('#app')
