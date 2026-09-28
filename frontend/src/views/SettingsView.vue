<script setup>
// Settings：模型配置（重启后生效）+ Token 用量统计。
import { reactive, ref, onMounted } from 'vue'
import { configGet, configSet, usageGet } from '../api/config.js'
import { fmtInt } from '../utils/format.js'
import { useToast } from '../composables/useToast.js'

const { toast } = useToast()

const cfg = reactive({
  model: '', endpoint: '', apiKey: '', context: '', maxtok: '', budget: '', thinking: 'false',
})
const apiKeyPlaceholder = ref('未配置（请输入 API Key）')
const usage = ref(null)

async function loadConfig() {
  try {
    const d = await configGet()
    cfg.model = d.llm.model || ''
    cfg.endpoint = d.llm.endpoint || ''
    cfg.context = d.llm.context_length || ''
    cfg.maxtok = d.llm.max_tokens || ''
    cfg.budget = d.llm.budget ?? ''
    cfg.thinking = String(d.llm.thinking_mode)
    // API Key：不回显明文，仅显示"已配置 / 未配置"状态。
    cfg.apiKey = ''
    apiKeyPlaceholder.value = d.llm.api_key_set ? '已配置（留空则不修改）' : '未配置（请输入 API Key）'
  } catch (e) { toast('配置加载失败: ' + (e.message || e)) }
}

async function saveConfig() {
  const body = {
    model: cfg.model,
    endpoint: cfg.endpoint,
    context_length: parseInt(cfg.context) || 0,
    max_tokens: parseInt(cfg.maxtok) || 0,
    budget: parseFloat(cfg.budget),
    thinking_mode: cfg.thinking === 'true',
  }
  const keyVal = cfg.apiKey.trim()
  if (keyVal) body.api_key = keyVal // 仅当用户输入了新 key 才提交，避免覆盖为空白
  try {
    const d = await configSet(body)
    toast(d.status === 'saved' ? '已保存 — 重启服务后生效' : 'Error')
  } catch (e) { toast('保存失败: ' + (e.message || e)) }
  loadConfig() // 刷新状态(已配置/未配置)
}

async function loadUsage() {
  try { usage.value = await usageGet() } catch { /* ignore */ }
}

onMounted(() => { loadConfig(); loadUsage() })
</script>

<template>
  <section class="tab-view">
    <div class="card">
      <h2>Model Config</h2>
      <div class="row"><label class="muted" style="width:80px;">Model</label><input v-model="cfg.model"></div>
      <div class="row"><label class="muted" style="width:80px;">Endpoint</label><input v-model="cfg.endpoint"></div>
      <div class="row"><label class="muted" style="width:80px;">API Key</label><input v-model="cfg.apiKey" type="password" :placeholder="apiKeyPlaceholder"></div>
      <div class="row"><label class="muted" style="width:80px;">Context</label><input v-model="cfg.context" type="number"></div>
      <div class="row"><label class="muted" style="width:80px;">Max Tokens</label><input v-model="cfg.maxtok" type="number"></div>
      <div class="row"><label class="muted" style="width:80px;">Budget ($)</label><input v-model="cfg.budget" type="number"></div>
      <div class="row"><label class="muted" style="width:80px;">Thinking</label><select v-model="cfg.thinking"><option value="false">off</option><option value="true">on</option></select></div>
      <div class="row">
        <button class="btn btn-primary" @click="saveConfig">Save Config</button>
        <button class="btn" @click="loadConfig">Reload</button>
      </div>
      <div class="row" style="color:#e8a33d;font-size:12px;">⚠ 修改 API Key / 模型等配置后需<b>重启服务</b>才能生效（已开启的会话仍使用旧配置）</div>
    </div>

    <div class="card">
      <h2>Token Usage</h2>
      <template v-if="usage">
        <div class="stat-grid">
          <div class="stat-box"><div class="lbl">Calls</div><div class="val">{{ usage.call_count }}</div></div>
          <div class="stat-box"><div class="lbl">Input tok</div><div class="val">{{ usage.total_input_tokens }}</div></div>
          <div class="stat-box"><div class="lbl">Output tok</div><div class="val">{{ usage.total_output_tokens }}</div></div>
          <div class="stat-box"><div class="lbl">Total tok</div><div class="val">{{ usage.total_tokens }}</div></div>
          <div class="stat-box"><div class="lbl">Cost ($)</div><div class="val o">{{ usage.total_cost.toFixed(4) }}</div></div>
        </div>
        <table v-if="(usage.calls || []).length">
          <thead><tr><th>Time</th><th>Model</th><th>in/out</th><th>cost</th></tr></thead>
          <tbody>
            <tr v-for="(c, i) in usage.calls" :key="i">
              <td>{{ c.timestamp }}</td>
              <td>{{ c.model }}</td>
              <td>{{ c.input_tokens }}/{{ c.output_tokens }}</td>
              <td>${{ c.cost.toFixed(4) }}</td>
            </tr>
          </tbody>
        </table>
      </template>
      <div v-else class="muted">Loading...</div>
    </div>
  </section>
</template>
