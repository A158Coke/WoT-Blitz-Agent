<script setup>
// Tankopedia：全部坦克图鉴 + 模糊搜索/筛选/排序。卡片点击在新窗口打开 /tank/{id} 详情页。
import { ref, computed, onMounted } from 'vue'
import { fetchTanks } from '../api/tank.js'
import { tankFuzzyScore } from '../utils/tankSearch.js'
import { TYPE_LABEL, TYPE_CLS, NATION_LABEL } from '../utils/tankStats.js'

// 模块级缓存（ref 保持响应性）：重复进入 Tab 不重新拉取（与旧版行为一致）
const tanksCache = ref([])

const q = ref('')
const tier = ref('')
const nation = ref('')
const type = ref('')
const sort = ref('name')
const count = ref('')
const gridError = ref('')

const tiers = ref([])
const nations = ref([])
const types = ref([])

async function load() {
  if (tanksCache.value.length) return
  gridError.value = ''
  count.value = 'Loading...'
  try {
    tanksCache.value = await fetchTanks()
    // 部分坦克(tanks.pb 无类别码)的 type 为空串——统一归一为 'unknown'
    tiers.value = [...new Set(tanksCache.value.map((t) => t.tier))].sort((a, b) => a - b)
    nations.value = [...new Set(tanksCache.value.map((t) => t.nation))].sort()
    types.value = [...new Set(tanksCache.value.map((t) => t.type || 'unknown'))].sort()
  } catch (e) {
    console.error('loadTanks failed:', e)
    gridError.value = 'Failed to load: ' + (e.stack || e.message || e)
  }
}

const filtered = computed(() => {
  const list = tanksCache.value
  const base = list.filter((t) =>
    (!tier.value || String(t.tier) === tier.value) &&
    (!nation.value || t.nation === nation.value) &&
    (!type.value || (t.type || 'unknown') === type.value)
  )
  if (!q.value.trim()) return base
  const query = q.value.trim().toLowerCase()
  // 模糊匹配 + 按得分降序（精确/前缀命中排最前），同分按名称
  return base
    .map((t) => ({ t, s: tankFuzzyScore(t.name, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.t.name || '').localeCompare(b.t.name || ''))
    .map((x) => x.t)
})

// 排序：默认名称；数值列 null 沉底
const sorted = computed(() => {
  const byNum = (key) => (a, b) => (b[key] ?? -1) - (a[key] ?? -1) || (a.name || '').localeCompare(b.name || '')
  const cmp = {
    name: (a, b) => (a.name || '').localeCompare(b.name || ''),
    tier: (a, b) => (b.tier ?? 0) - (a.tier ?? 0) || (a.name || '').localeCompare(b.name || ''),
    hp: byNum('hp'),
    armor: byNum('armor_front'),
    pen: byNum('pen_max'),
  }[sort.value] || ((a, b) => (a.name || '').localeCompare(b.name || ''))
  return filtered.value.slice().sort(cmp)
})

function openTank(id) { window.open('/tank/' + id, '_blank') }

onMounted(load)
</script>

<template>
  <section class="tab-view">
    <h2>Tankopedia</h2>
    <div class="sub">全部坦克图鉴 — 点击卡片查看装甲 / 弹种 / 属性详情</div>
    <div class="card">
      <div id="tp-toolbar">
        <input id="tp-search" v-model="q" placeholder="Search (fuzzy): e100 · is7 · def…">
        <select id="tp-tier" v-model="tier"><option value="">Tier</option><option v-for="t in tiers" :key="t" :value="String(t)">Tier {{ t }}</option></select>
        <select id="tp-nation" v-model="nation"><option value="">Nation</option><option v-for="n in nations" :key="n" :value="n">{{ NATION_LABEL[n] || n }}</option></select>
        <select id="tp-type" v-model="type"><option value="">Type</option><option v-for="t in types" :key="t" :value="t">{{ TYPE_LABEL[t] || t }}</option></select>
        <select id="tp-sort" v-model="sort">
          <option value="name">Sort: Name</option>
          <option value="tier">Sort: Tier ↓</option>
          <option value="hp">Sort: HP ↓</option>
          <option value="armor">Sort: Armor ↓</option>
          <option value="pen">Sort: Pen ↓</option>
        </select>
        <span id="tp-count">{{ gridError ? '' : sorted.length + ' / ' + tanksCache.length }}</span>
      </div>
      <div v-if="gridError" class="muted">{{ gridError }}</div>
      <div v-else-if="!tanksCache.length" class="muted">Loading tanks...</div>
      <div v-else-if="!sorted.length" class="muted">No tanks match.</div>
      <div v-else id="tp-grid">
        <div
          v-for="t in sorted" :key="t.id"
          class="tank-card"
          :class="{ premium: t.is_premium, collector: t.is_collector }"
          @click="openTank(t.id)"
        >
          <img class="tc-img" loading="lazy" :src="`/api/tank_image/${t.id}`" alt="">
          <div class="tc-body">
            <div class="tc-name" :title="t.name">{{ t.name }}</div>
            <div class="tc-meta">
              <span class="pill tier">T{{ t.tier }}</span>
              <span class="pill nat">{{ NATION_LABEL[t.nation] || t.nation }}</span>
              <span class="pill" :class="TYPE_CLS[t.type] || 't-unknown'">{{ TYPE_LABEL[t.type] || t.type || 'Unknown' }}</span>
            </div>
            <div class="tc-stats">
              <div><i>HP</i>{{ t.hp ?? '-' }}</div>
              <div><i>Armor</i>{{ t.armor_front ?? '-' }}<span style="color:var(--muted);">/</span>{{ t.armor_turret ?? '-' }}</div>
              <div><i>Pen</i>{{ t.pen_max ?? '-' }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style>
.tab-view { animation: fadeIn .25s ease; }
#tp-toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
#tp-search { flex: 1; min-width: 200px; max-width: 340px; }
#tp-toolbar select { min-width: 110px; }
#tp-count { color: var(--muted); font-size: 0.85em; }
#tp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 16px; }
.tank-card {
  position: relative;
  background: linear-gradient(180deg, var(--panel), var(--panel2)); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; cursor: pointer;
  transition: transform .14s ease, box-shadow .14s ease, border-color .14s ease; box-shadow: var(--shadow);
}
.tank-card:hover { transform: translateY(-4px); border-color: var(--border-hi); box-shadow: 0 16px 38px rgba(0, 0, 0, 0.5); }
.tank-card.premium { border-color: rgba(255, 207, 92, 0.4); }
.tank-card.premium:hover { border-color: rgba(255, 207, 92, 0.75); }
/* 收藏车：蓝色窗框 */
.tank-card.collector { border-color: rgba(95, 168, 232, 0.5); }
.tank-card.collector:hover { border-color: var(--blue); }
.tank-card .tc-img { width: 100%; height: 118px; object-fit: contain; background: linear-gradient(180deg, #201b18, #171310); display: block; padding: 6px; }
.tank-card .tc-body { padding: 8px 11px 11px; }
/* 名称完整可见：最多两行，超出裁剪 */
.tank-card .tc-name { font-size: 0.88em; font-weight: 700; line-height: 1.3; max-height: 2.6em; overflow: hidden; }
.tank-card .tc-meta { display: flex; justify-content: space-between; align-items: center; gap: 5px; margin-top: 7px; font-size: 0.74em; flex-wrap: wrap; }
.tank-card .tc-stats { display: grid; grid-template-columns: 1fr 1.25fr 1fr; gap: 4px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border); }
.tank-card .tc-stats > div { text-align: center; font-size: 0.74em; font-weight: 800; }
.tank-card .tc-stats i { display: block; font-style: normal; color: var(--muted); font-weight: 600; font-size: 0.88em; letter-spacing: .4px; }
/* 车种 pill 配色 */
.pill.t-light { background: rgba(95, 191, 122, 0.16); color: var(--green); }
.pill.t-medium { background: rgba(255, 207, 92, 0.14); color: var(--yellow); }
.pill.t-heavy { background: rgba(255, 107, 107, 0.15); color: var(--red); }
.pill.t-td { background: rgba(95, 168, 232, 0.16); color: var(--blue); }
.pill.t-unknown { background: rgba(156, 143, 127, 0.18); color: var(--muted); }
</style>
