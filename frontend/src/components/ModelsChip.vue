<script setup>
// 模型库悬浮组件：状态轮询 + 点击全量预下载（进度加速轮询 10 分钟）。
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { modelsStatus, modelsDownloadAll } from '../api/config.js'

const chipHtml = ref('📦 模型库 状态不可用')
const chipTitle = ref('坦克 GLB 模型库：点击全量预下载（约 2GB，需网络）')
let fastTimer = null
let slowTimer = null

async function refresh() {
  try {
    const d = await modelsStatus()
    const pct = d.total_tanks ? Math.round(d.ready_tanks / d.total_tanks * 100) : 0
    chipTitle.value = '坦克 GLB 模型库：点击全量预下载（约 2GB，需网络）'
    if (d.running) {
      chipHtml.value = `📦 模型库 下载中 ${d.done_files}/${d.total_files}（就绪 ${pct}%）<br><span style="color:#8fa3c8">失败 ${d.failed} · ${(d.bytes / 1048576).toFixed(0)} MB — 服务器后台执行</span>`
    } else if (d.total_tanks && d.ready_tanks >= d.total_tanks) {
      chipHtml.value = `📦 模型库 ${d.ready_tanks}/${d.total_tanks} 已就绪（离线可用）`
    } else {
      chipHtml.value = `📦 模型库 ${d.ready_tanks}/${d.total_tanks}（${pct}%）— 点击补齐全量`
    }
  } catch { chipHtml.value = '📦 模型库 状态不可用' }
}

async function onClick() {
  const d = await modelsStatus()
  if (d.running || (d.total_tanks && d.ready_tanks >= d.total_tanks)) { refresh(); return }
  await modelsDownloadAll()
  if (!fastTimer) {
    fastTimer = setInterval(refresh, 2000)
    setTimeout(() => { clearInterval(fastTimer); fastTimer = null }, 600000)
  }
  refresh()
}

onMounted(() => {
  refresh()
  slowTimer = setInterval(refresh, 30000)
})
onBeforeUnmount(() => { clearInterval(fastTimer); clearInterval(slowTimer) })
</script>

<template>
  <div id="models-chip" :title="chipTitle" v-html="chipHtml" @click="onClick"></div>
</template>

<style>
#models-chip {
  position: fixed; left: 12px; bottom: 12px; z-index: 9999;
  background: #1d2330f2; color: #cfd8ea; border: 1px solid #33405c; border-radius: 10px;
  padding: 8px 12px; font-size: 12px; font-family: system-ui, sans-serif;
  box-shadow: 0 4px 16px #0006; cursor: pointer; user-select: none;
  max-width: 300px; line-height: 1.5;
}
</style>
