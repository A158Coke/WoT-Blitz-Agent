<script setup>
// 坦克详情页：自旧版 src/web/tank_detail.html 迁移。
// 数据流：/api/tank_detail/{id} + /api/tanks（同级 peer 基准，可失败降级）；
// 默认展示顶级配置（炮塔×主炮 + 引擎 + 履带），下拉可回看各级。
import { computed, ref, watch, watchEffect, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import Chart from 'chart.js/auto'
import { fetchTankDetail, fetchTanks } from '../api/tank.js'
import {
  TYPE_LABEL, TYPE_CLS, NATION_LABEL, normType, isPremiumShell, armorColorStyle, fmt,
  peerMetrics, peersOf, yawArcSvg, gunFanSvg,
} from '../utils/tankStats.js'

const route = useRoute()
const detail = ref(null)
const tanksAll = ref(null)
const error = ref('')
const loading = ref(false)
const cfgIdx = ref(0)
const engIdx = ref(0)
const trackIdx = ref(0)

const cfgs = computed(() => detail.value?.configs || [])
const cfg = computed(() => cfgs.value[cfgIdx.value] || null)
const engines = computed(() => cfg.value?.engines || [])
const tracks = computed(() => cfg.value?.tracks || [])
const eng = computed(() => engines.value[engIdx.value] || null)
const track = computed(() => tracks.value[trackIdx.value] || null)
const typeCls = computed(() => TYPE_CLS[detail.value?.type] || 't-unknown')
const typeTxt = computed(() => TYPE_LABEL[detail.value?.type] || detail.value?.type || 'Unknown')
const cfgOptions = computed(() =>
  cfgs.value.map((c) => `${c.label}${c.turret_name && c.turret_name !== c.label ? ` (${c.turret_name})` : ''}`))

// —— 总览（与旧版同口径：DPM/Alpha 按标准弹药，后端 standard_damage 优先 AP）——
const overview = computed(() => {
  const d = detail.value, c = cfg.value
  if (!d) return null
  const shells = (c && c.shells && c.shells.length ? c.shells : d.shells) || []
  const dmgMax = c?.standard_damage != null ? c.standard_damage
    : (shells.filter((s) => !/premium/i.test(s.type || '')).map((s) => s.damage || 0).reduce((a, b) => Math.max(a, b), 0) || d.damage_max)
  const dpm = c?.dpm != null ? Math.round(c.dpm) : null
  const hullHp = c?.hull_hp ?? null
  const turHp = c?.turret_health ?? null
  const w = c?.weight || null
  return {
    hpSub: hullHp != null && turHp != null ? `车体 ${hullHp} + 炮塔 ${turHp}` : '',
    dpm, caliber: c ? c.caliber : null,
    dmgMax: dmgMax != null ? Math.round(dmgMax) : null,
    ptw: eng.value && eng.value.power && w ? (eng.value.power / (w / 1000)).toFixed(1) : null,
    weightTxt: w ? (w / 1000).toFixed(1) + ' t' : null,
  }
})

// —— 火力：单发/弹夹/弹鼓三种装填文案 ——
const firepower = computed(() => {
  const c = cfg.value, d = detail.value
  if (!c) return null
  const isBurst = c.is_burst === true
  const isDrum = c.is_drum === true
  const burstSize = c.burst_size
  const burstInt = c.burst_interval && c.burst_interval > 0 ? c.burst_interval : null
  const burstReloads = c.burst_reloads || []
  let reloadVal, reloadSub
  if (isBurst && isDrum) {
    reloadVal = burstReloads.length ? burstReloads.map((x) => x.toFixed(1) + 's').join(' / ') : '-'
    reloadSub = `弹鼓 ${burstSize != null ? Math.round(burstSize) : '?'} 发 · 间隔 ${burstInt != null ? burstInt.toFixed(2) + 's' : '-'}`
  } else if (isBurst) {
    reloadVal = burstInt != null ? burstInt.toFixed(2) + 's' : '-'
    reloadSub = `弹夹 ${burstSize != null ? Math.round(burstSize) : '?'} 发 · 整夹 ${c.reload_time != null ? c.reload_time.toFixed(1) + 's' : '-'}`
  } else {
    reloadVal = c.reload_time != null ? c.reload_time.toFixed(1) + 's' : '-'
    reloadSub = ''
  }
  return {
    reloadLabel: isBurst ? (isDrum ? 'Drum Reload' : 'Burst') : 'Reload',
    reloadVal, reloadSub,
    aimVal: c.aim_time != null ? c.aim_time.toFixed(2) + 's' : null,
    dispVal: c.dispersion != null ? c.dispersion.toFixed(3) + ' m' : null,
    dispSub: c.dispersion != null ? `100m 散布圆直径 ≈ ${Math.round(c.dispersion * 200)} cm` : '',
    yawArc: yawArcSvg(c),
    gunFan: gunFanSvg(d.gun_depression, d.gun_elevation),
  }
})

// —— 弹药表 ——
const shellRows = computed(() => {
  const d = detail.value, c = cfg.value
  if (!d) return []
  const shells = (c && c.shells && c.shells.length ? c.shells : d.shells) || []
  return shells.map((s) => {
    const penFar = s.penetration_far != null && s.penetration_far > 0 && s.penetration_far !== s.penetration ? s.penetration_far : null
    return {
      raw: s,
      cls: normType(s.type) + (isPremiumShell(s) ? ' prem' : ''),
      label: normType(s.type).toUpperCase() + (isPremiumShell(s) ? ' ★' : ''),
      pen: s.penetration ?? '-',
      penFar,
      penDecay: penFar != null && s.penetration ? ((1 - penFar / s.penetration) * 100).toFixed(1) : null,
      damage: s.damage ?? '-',
      moduleDamage: s.module_damage ?? '-',
      velocity: s.velocity ? Math.round(s.velocity) : '-',
      range: s.range ? Math.round(s.range) : '-',
      normalization: s.normalization != null ? s.normalization + '°' : '-',
      ricochet: s.ricochet != null ? s.ricochet + '°' : '-',
      explosion: s.explosion_radius > 0 ? Number(s.explosion_radius).toFixed(1) + ' m' : '-',
      caliber: s.caliber != null ? s.caliber + ' mm' : '-',
    }
  })
})

// —— 装甲 ——
const armor = computed(() => {
  const d = detail.value, c = cfg.value
  if (!d) return null
  const a = d.armor || {}
  const spaced = []
  if ((c?.gun_spaced || []).length) spaced.push(`炮管间隙甲 ×${c.gun_spaced.length}`)
  if ((c?.turret_spaced || []).length) spaced.push(`炮塔间隙甲 ×${c.turret_spaced.length}`)
  return {
    a,
    hasTable: !!(a.turret_front || a.hull_front),
    gunThickness: c?.gun_thickness,
    gunMask: c?.gun_mask,
    spaced,
    hot: armorColorStyle,
  }
})

// —— 机动 ——
const mobility = computed(() => {
  const d = detail.value, c = cfg.value, tr = track.value
  if (!d) return null
  const w = c?.weight || null
  // 车体旋转速度由履带决定：优先选中履带，回退坦克级字段
  const hullTraverse = tr && tr.traverse_speed != null ? tr.traverse_speed : d.hull_traverse
  return {
    w,
    hullTraverse,
    engName: eng.value?.name || '-',
    engPower: eng.value?.power ? Math.round(eng.value.power) + ' hp' : '-',
    fireChance: eng.value?.fire_chance != null ? (eng.value.fire_chance * 100).toFixed(1) + '%' : '-',
    trackName: tr?.name || '-',
    trackTraverse: tr?.traverse_speed != null ? fmt(tr.traverse_speed, 1) + '°/s' : '-',
    trackWeight: tr?.weight ? Math.round(tr.weight / 1000) + ' t' : '-',
  }
})

// —— 侦察与炮塔 ——
const turretInfo = computed(() => {
  const d = detail.value, c = cfg.value
  if (!d) return null
  return {
    turName: c?.turret_name,
    viewRange: (c?.view_range != null ? c.view_range : d.view_range),
    turretTraverse: (c?.turret_traverse_speed != null ? c.turret_traverse_speed : d.turret_traverse_speed),
    turHp: c?.turret_health ?? null,
  }
})

// —— 同级对比 ——
const metrics = computed(() => (detail.value ? peerMetrics(detail.value, cfg.value, tanksAll.value) : null))
const peersCount = computed(() => peersOf(detail.value || {}, tanksAll.value)?.length ?? 0)
const pctRows = computed(() =>
  (metrics.value || [])
    .filter((m) => m.val != null && m.pct != null)
    .map((m) => ({
      label: m.label,
      cls: m.pct >= 75 ? 'g' : m.pct >= 40 ? 'o' : 'r',
      width: Math.max(2, m.pct).toFixed(1),
      disp: Number.isInteger(m.val) ? m.val : Number(m.val).toFixed(1),
      p: Math.round(m.pct),
    })))

// —— 雷达图（Chart.js；无 peer 基准时隐藏）——
const radarCanvas = ref(null)
let radarChart = null
watch([metrics, radarCanvas], () => {
  const canvas = radarCanvas.value
  if (!canvas) return
  if (radarChart) { radarChart.destroy(); radarChart = null }
  const m = metrics.value
  if (!m) { canvas.style.display = 'none'; return }
  canvas.style.display = ''
  radarChart = new Chart(canvas.getContext('2d'), {
    type: 'radar',
    data: {
      labels: m.map((x) => x.label),
      datasets: [{
        label: '同级百分位',
        data: m.map((x) => (x.pct == null ? 0 : Math.round(x.pct))),
        backgroundColor: 'rgba(255,138,61,0.22)',
        borderColor: '#ffb35c',
        borderWidth: 2,
        pointBackgroundColor: '#ffd29b',
        pointRadius: 3,
      }],
    },
    options: {
      responsive: false,
      plugins: { legend: { display: false }, tooltip: { enabled: true } },
      scales: { r: {
        min: 0, max: 100,
        ticks: { display: false, stepSize: 25 },
        grid: { color: 'rgba(255,255,255,0.09)' },
        angleLines: { color: 'rgba(255,255,255,0.09)' },
        pointLabels: { color: '#c8bba9', font: { size: 12, weight: '600' } },
      } },
    },
  })
})
onBeforeUnmount(() => { if (radarChart) { radarChart.destroy(); radarChart = null } })

async function loadDetail(id) {
  loading.value = true
  error.value = ''
  detail.value = null
  if (!id) { error.value = '无效的坦克 ID。'; loading.value = false; return }
  try {
    // 详情 + 全量坦克列表（同级百分位/雷达图基准）并行拉取；列表失败不影响主数据展示
    const [d, all] = await Promise.all([
      fetchTankDetail(id),
      fetchTanks().catch(() => null),
    ])
    detail.value = d
    // 默认按顶级模块展示（tanks.pb 内模块按研究顺序排列，末项为顶级）
    const cs = d.configs || []
    cfgIdx.value = Math.max(0, cs.length - 1)
    engIdx.value = Math.max(0, (((cs[cfgIdx.value] || {}).engines) || []).length - 1)
    trackIdx.value = Math.max(0, (((cs[cfgIdx.value] || {}).tracks) || []).length - 1)
    if (all) { try { tanksAll.value = all } catch { tanksAll.value = null } }
  } catch (e) {
    error.value = e.status ? `加载失败 (HTTP ${e.status})` : `加载失败: ${e.message}`
  } finally {
    loading.value = false
  }
}

watch(() => route.params.tankId, (id) => loadDetail(id), { immediate: true })
watchEffect(() => {
  document.title = detail.value ? `${detail.value.name || '坦克'} — WoTB Agent` : '坦克详情 — WoTB Agent'
})

function open3d() {
  window.open(`/armor_view/view/${detail.value.id}?config=${cfgIdx.value}`, '_blank')
}
</script>

<template>
  <main class="tank-detail">
    <RouterLink id="back" to="/legacy#tanks">← 返回坦克百科</RouterLink>

    <div v-if="loading" class="card loading-box"><span class="spinner"></span> 加载中...</div>
    <div v-else-if="error" class="card muted">{{ error }}</div>

    <template v-else-if="detail">
      <!-- 头部：封面 + 徽章 -->
      <div id="md-head">
        <img :src="detail.image" alt="">
        <div id="md-title">
          <h2>{{ detail.name }}</h2>
          <div class="row" style="margin:6px 0;gap:8px;">
            <span class="pill tier">Tier {{ detail.tier }}</span>
            <span class="pill nat">{{ NATION_LABEL[detail.nation] || detail.nation }}</span>
            <span class="pill" :class="typeCls">{{ typeTxt }}</span>
            <span v-if="detail.is_premium" class="pill gold">Premium ★</span>
            <span v-if="detail.is_collector" class="pill coll">Collectible ◆</span>
            <span v-if="cfg?.weight" class="pill weight">{{ (cfg.weight / 1000).toFixed(1) }} t</span>
          </div>
          <div class="sub-line">装甲 / 弹药 / 火力全属性 · 数据源 BlitzKit tanks.pb + 游戏文件解析</div>
        </div>
      </div>

      <!-- 模块切换器：炮塔/主炮（configs）、引擎、履带——多选一才显示下拉，单个显示名称 -->
      <div class="row mod-bar">
        <template v-if="cfgs.length > 1">
          <span class="mod-sel"><label class="muted">Gun/Turret 炮塔·主炮</label>
            <select v-model.number="cfgIdx"><option v-for="(o, i) in cfgOptions" :key="i" :value="i">{{ o }}</option></select></span>
        </template>
        <span v-else-if="cfg" class="muted mod-static">Gun/Turret: <b>{{ cfg.label }}</b></span>
        <template v-if="engines.length > 1">
          <span class="mod-sel"><label class="muted">Engine 引擎</label>
            <select v-model.number="engIdx"><option v-for="(e, i) in engines" :key="i" :value="i">{{ e.name || 'engine' }}</option></select></span>
        </template>
        <span v-else-if="eng" class="muted mod-static">Engine: <b>{{ eng.name || '-' }}</b></span>
        <template v-if="tracks.length > 1">
          <span class="mod-sel"><label class="muted">Tracks 履带</label>
            <select v-model.number="trackIdx"><option v-for="(t, i) in tracks" :key="i" :value="i">{{ t.name || 'track' }}</option></select></span>
        </template>
        <span v-else-if="track" class="muted mod-static">Tracks: <b>{{ track.name || '-' }}</b></span>
      </div>

      <!-- 总览 -->
      <div class="card" v-if="overview">
        <div class="sec-title">总览 Overview</div>
        <div class="ov-grid">
          <div class="stat-grid" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr));margin:0;align-content:start;">
            <div class="stat-box"><div class="lbl">HP</div><div class="val g">{{ detail.hp ?? '-' }}</div><div v-if="overview.hpSub" class="sub">{{ overview.hpSub }}</div></div>
            <div class="stat-box"><div class="lbl">DPM (AP)</div><div class="val o">{{ overview.dpm ?? '-' }}</div><div v-if="cfg?.is_burst" class="sub">连发射速</div></div>
            <div class="stat-box"><div class="lbl">Caliber</div><div class="val">{{ overview.caliber ?? '-' }} mm</div></div>
            <div class="stat-box"><div class="lbl">Alpha 单发</div><div class="val">{{ overview.dmgMax ?? '-' }}</div></div>
            <div class="stat-box"><div class="lbl">Power/Weight</div><div class="val b">{{ overview.ptw ?? '-' }} <span style="font-size:0.55em;">hp/t</span></div></div>
            <div class="stat-box"><div class="lbl">Weight</div><div class="val">{{ overview.weightTxt ?? '-' }}</div></div>
          </div>
          <div class="radar-wrap"><canvas ref="radarCanvas" width="300" height="270"></canvas></div>
        </div>
      </div>

      <!-- 火力 -->
      <div class="card" v-if="firepower">
        <div class="sec-title">火力 Firepower <span class="sec-note">{{ cfg?.label }}</span></div>
        <div class="stat-grid">
          <div class="stat-box"><div class="lbl">{{ firepower.reloadLabel }}</div><div class="val b">{{ firepower.reloadVal }}</div><div v-if="firepower.reloadSub" class="sub">{{ firepower.reloadSub }}</div></div>
          <div class="stat-box"><div class="lbl">Aim Time</div><div class="val">{{ firepower.aimVal ?? '-' }}</div></div>
          <div class="stat-box"><div class="lbl">Dispersion@100m</div><div class="val">{{ firepower.dispVal ?? '-' }}</div><div v-if="firepower.dispSub" class="sub">{{ firepower.dispSub }}</div></div>
          <div class="stat-box"><div class="lbl">Depression</div><div class="val">{{ detail.gun_depression != null ? '-' + detail.gun_depression + '°' : '-' }}</div></div>
          <div class="stat-box"><div class="lbl">Elevation</div><div class="val">{{ detail.gun_elevation != null ? '+' + detail.gun_elevation + '°' : '-' }}</div></div>
        </div>
        <div class="arcs-row">
          <div v-html="firepower.yawArc"></div>
          <div v-html="firepower.gunFan"></div>
        </div>
      </div>

      <!-- 弹药 -->
      <div class="card">
        <div class="sec-title">弹药 Shells <span class="sec-note">{{ cfg?.label }}</span></div>
        <div class="table-scroll"><table>
          <thead><tr><th>Type</th><th>Pen 100m→远</th><th>Dmg</th><th>Mod Dmg</th><th>Vel m/s</th><th>Range m</th><th>转正</th><th>跳弹角</th><th>爆炸半径</th><th>弹径</th></tr></thead>
          <tbody>
            <tr v-if="!shellRows.length"><td colspan="10" class="muted">No shell data</td></tr>
            <tr v-for="(s, i) in shellRows" :key="i">
              <td><span class="shb" :class="s.cls">{{ s.label }}</span></td>
              <td>{{ s.pen }}<template v-if="s.penFar != null"> → {{ s.penFar }} <span class="muted" style="font-size:0.82em;">(−{{ s.penDecay }}%)</span></template></td>
              <td>{{ s.damage }}</td>
              <td class="muted">{{ s.moduleDamage }}</td>
              <td>{{ s.velocity }}</td>
              <td>{{ s.range }}</td>
              <td>{{ s.normalization }}</td>
              <td>{{ s.ricochet }}</td>
              <td>{{ s.explosion }}</td>
              <td>{{ s.caliber }}</td>
            </tr>
          </tbody>
        </table></div>
      </div>

      <!-- 装甲 -->
      <div class="card" v-if="armor">
        <div class="sec-title">装甲 Armor</div>
        <div v-if="armor.hasTable" class="table-scroll"><table style="max-width:520px;">
          <thead><tr><th></th><th>Hull 车体</th><th>Turret 炮塔</th></tr></thead>
          <tbody>
            <tr><td class="muted">Front 正面</td><td class="hot" :style="armor.hot(armor.a.hull_front)">{{ armor.a.hull_front ?? '-' }}</td><td class="hot" :style="armor.hot(armor.a.turret_front)">{{ armor.a.turret_front ?? '-' }}</td></tr>
            <tr><td class="muted">Side 侧面</td><td class="hot" :style="armor.hot(armor.a.hull_sides)">{{ armor.a.hull_sides ?? '-' }}</td><td class="hot" :style="armor.hot(armor.a.turret_sides)">{{ armor.a.turret_sides ?? '-' }}</td></tr>
            <tr><td class="muted">Rear 后方</td><td class="hot" :style="armor.hot(armor.a.hull_rear)">{{ armor.a.hull_rear ?? '-' }}</td><td class="hot" :style="armor.hot(armor.a.turret_rear)">{{ armor.a.turret_rear ?? '-' }}</td></tr>
          </tbody>
        </table></div>
        <div v-else class="muted" style="margin:6px 0;">No armor summary data</div>
        <div v-if="armor.hasTable" class="muted" style="font-size:0.76em;margin:2px 0 8px;">厚度单位 mm · 绿≈厚 / 红≈薄（20–300mm 色阶）</div>
        <div class="stat-grid" style="margin-top:0;">
          <div v-if="armor.gunThickness != null" class="stat-box"><div class="lbl">Gun Barrel 炮管装甲</div><div class="val">{{ Math.round(armor.gunThickness) }} mm</div></div>
          <div v-if="armor.gunMask != null" class="stat-box"><div class="lbl">Gun Mantlet 炮盾</div><div class="val">{{ Math.round(armor.gunMask) }} mm</div></div>
        </div>
        <div v-if="armor.spaced.length" style="margin-top:4px;">
          <span v-for="s in armor.spaced" :key="s" class="spaced-badge">{{ s }}</span>
        </div>
      </div>

      <!-- 机动 -->
      <div class="card" v-if="mobility">
        <div class="sec-title">机动 Mobility</div>
        <div class="stat-grid">
          <div class="stat-box"><div class="lbl">Speed F/R</div><div class="val">{{ detail.speed_forward ?? '-' }} / {{ detail.speed_reverse ?? '-' }} <span style="font-size:0.55em;">km/h</span></div></div>
          <div class="stat-box"><div class="lbl">Hull Traverse</div><div class="val">{{ mobility.hullTraverse != null ? fmt(mobility.hullTraverse, 1) + '°/s' : '-' }}</div><div v-if="track" class="sub">由履带决定</div></div>
          <div class="stat-box"><div class="lbl">Weight</div><div class="val">{{ mobility.w ? (mobility.w / 1000).toFixed(1) + ' t' : '-' }}</div></div>
        </div>
        <div v-if="eng" class="table-scroll"><table style="max-width:560px;">
          <thead><tr><th>Engine 引擎</th><th>Power 功率</th><th>Fire Chance 起火率</th></tr></thead>
          <tbody><tr><td>{{ mobility.engName }}</td><td>{{ mobility.engPower }}</td><td>{{ mobility.fireChance }}</td></tr></tbody>
        </table></div>
        <div v-if="track" class="table-scroll"><table style="max-width:560px;">
          <thead><tr><th>Tracks 履带</th><th>Traverse 转速</th><th>Weight 重量</th></tr></thead>
          <tbody><tr><td>{{ mobility.trackName }}</td><td>{{ mobility.trackTraverse }}</td><td>{{ mobility.trackWeight }}</td></tr></tbody>
        </table></div>
      </div>

      <!-- 侦察与炮塔 -->
      <div class="card" v-if="turretInfo">
        <div class="sec-title">侦察与炮塔 Turret <span v-if="turretInfo.turName" class="sec-note">{{ turretInfo.turName }}</span></div>
        <div class="stat-grid">
          <div class="stat-box"><div class="lbl">View Range</div><div class="val b">{{ turretInfo.viewRange != null ? Math.round(turretInfo.viewRange) + ' m' : '-' }}</div></div>
          <div class="stat-box"><div class="lbl">Turret Traverse</div><div class="val">{{ turretInfo.turretTraverse != null ? fmt(turretInfo.turretTraverse, 1) + '°/s' : '-' }}</div></div>
          <div v-if="turretInfo.turHp != null" class="stat-box"><div class="lbl">Turret HP 炮塔血量</div><div class="val y">{{ turretInfo.turHp }}</div></div>
        </div>
      </div>

      <!-- 同级对比 -->
      <div class="card" v-if="metrics">
        <div class="sec-title">同级对比 Peers <span class="sec-note">Tier {{ detail.tier }} {{ TYPE_LABEL[detail.type] || detail.type || 'Unknown' }} · {{ peersCount }} 辆样本 · P 值为同型百分位</span></div>
        <div v-for="r in pctRows" :key="r.label" class="pct-row">
          <div class="pct-lbl">{{ r.label }}</div>
          <div class="pct-bar"><div :class="r.cls" :style="{ width: r.width + '%' }"></div></div>
          <div class="pct-val">{{ r.disp }} <span class="muted" style="font-weight:600;">P{{ r.p }}</span></div>
        </div>
      </div>

      <div class="card">
        <div class="sec-title">3D 装甲检视器</div>
        <button id="open-3d" @click="open3d">🔍 在新的浏览器窗口打开 3D 检视器</button>
      </div>
    </template>
  </main>
</template>

<!-- 页面级样式：自旧版 tank_detail.html 平移（v-html 内容无法用 scoped 命中，保持全局但以 .tank-detail 命名空间隔离） -->
<style>
.tank-detail { max-width: 1120px; margin: 0 auto; padding: 0; }
.tank-detail #back { display: inline-block; margin: 0 0 14px 0; color: var(--muted); background: var(--panel2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 16px; cursor: pointer; font-size: 0.9em; text-decoration: none; }
.tank-detail #back:hover { color: var(--txt); border-color: var(--border-hi); }
.tank-detail .loading-box { padding: 24px; }
.tank-detail #md-head { display: flex; gap: 22px; padding: 22px; border: 1px solid var(--border); border-radius: var(--radius); background: linear-gradient(180deg, var(--panel), var(--panel2)); align-items: center; box-shadow: var(--shadow); }
.tank-detail #md-head img { width: 170px; height: 124px; object-fit: contain; background: linear-gradient(180deg, #201b18, #171310); border-radius: 12px; padding: 6px; }
.tank-detail #md-title { flex: 1; min-width: 0; }
.tank-detail #md-title h2 { margin: 0 0 6px 0; font-size: 1.65em; }
.tank-detail #md-title .sub-line { color: var(--muted); font-size: 0.85em; margin-top: 5px; }
.tank-detail .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.tank-detail .mod-bar { margin: 12px 0 0 0; gap: 14px; }
.tank-detail .mod-static { font-size: 0.85em; }
.tank-detail .mod-static b { color: var(--txt); }
.tank-detail .mod-sel { display: inline-flex; align-items: center; gap: 8px; }
.tank-detail .mod-sel label { font-size: 0.82em; }
.tank-detail .pill { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 0.75em; font-weight: 700; }
.tank-detail .pill.tier { background: rgba(255, 207, 92, 0.16); color: var(--yellow); }
.tank-detail .pill.nat { background: rgba(95, 168, 232, 0.16); color: var(--blue); }
.tank-detail .pill.gold { background: rgba(255, 207, 92, 0.16); color: var(--yellow); }
.tank-detail .pill.coll { background: rgba(95, 168, 232, 0.16); color: var(--blue); }
/* 车种配色：Light 绿 / Medium 黄 / Heavy 红 / TD 蓝 */
.tank-detail .pill.t-light { background: rgba(95, 191, 122, 0.16); color: var(--green); }
.tank-detail .pill.t-medium { background: rgba(255, 207, 92, 0.14); color: var(--yellow); }
.tank-detail .pill.t-heavy { background: rgba(255, 107, 107, 0.15); color: var(--red); }
.tank-detail .pill.t-td { background: rgba(95, 168, 232, 0.16); color: var(--blue); }
.tank-detail .pill.t-unknown { background: rgba(156, 143, 127, 0.18); color: var(--muted); }
.tank-detail .pill.weight { background: rgba(255, 255, 255, 0.06); color: var(--txt); }
.tank-detail input, .tank-detail select, .tank-detail button { font-size: 0.95em; padding: 9px 13px; background: var(--panel3); color: var(--txt); border: 1px solid var(--border); border-radius: var(--radius-sm); transition: border-color .15s ease, box-shadow .15s ease; font-family: inherit; }
.tank-detail select { max-width: 340px; }
.tank-detail .sec-title { display: flex; align-items: center; gap: 9px; margin: 0 0 12px 0; font-size: 1.02em; font-weight: 800; }
.tank-detail .sec-title::before { content: ''; flex: none; width: 4px; height: 17px; border-radius: 2px; background: linear-gradient(180deg, var(--accent), var(--accent-2)); }
.tank-detail .sec-title .sec-note { font-size: 0.72em; font-weight: 600; color: var(--muted); }
.tank-detail .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; margin: 10px 0; }
.tank-detail .stat-box { background: linear-gradient(180deg, var(--panel2), var(--panel3)); border: 1px solid var(--border); border-radius: 12px; padding: 13px 14px; transition: transform .12s ease; }
.tank-detail .stat-box:hover { transform: translateY(-2px); }
.tank-detail .stat-box .lbl { color: var(--muted); font-size: 0.74em; text-transform: uppercase; letter-spacing: .4px; }
.tank-detail .stat-box .val { font-size: 1.3em; font-weight: 800; margin-top: 4px; }
.tank-detail .stat-box .sub { color: var(--muted); font-size: 0.72em; margin-top: 3px; }
.tank-detail .val.g { color: var(--green); }
.tank-detail .val.o { color: var(--accent-2); }
.tank-detail .val.b { color: var(--blue); }
.tank-detail .val.r { color: var(--red); }
.tank-detail .val.y { color: var(--yellow); }
.tank-detail table { width: 100%; border-collapse: collapse; font-size: 0.92em; }
.tank-detail th, .tank-detail td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.tank-detail th { color: var(--muted); font-weight: 600; font-size: 0.8em; text-transform: uppercase; letter-spacing: .4px; white-space: nowrap; }
.tank-detail td { white-space: nowrap; }
.tank-detail tbody tr:hover td { background: rgba(255, 255, 255, 0.03); }
.tank-detail .table-scroll { overflow-x: auto; margin: 8px 0; }
.tank-detail .muted { color: var(--muted); }
.tank-detail .spinner { display: inline-block; width: 13px; height: 13px; border: 2px solid var(--muted); border-top-color: var(--accent); border-radius: 50%; animation: td-spin 0.8s linear infinite; vertical-align: middle; }
@keyframes td-spin { to { transform: rotate(360deg); } }
/* 弹种徽章 */
.tank-detail .shb { display: inline-block; padding: 1px 9px; border-radius: 11px; font-size: 0.8em; font-weight: 800; letter-spacing: .4px; }
.tank-detail .shb.ap { background: rgba(205, 205, 215, 0.13); color: #cdcdd9; }
.tank-detail .shb.apcr { background: rgba(95, 168, 232, 0.17); color: #8fc3f2; }
.tank-detail .shb.heat { background: rgba(255, 138, 61, 0.18); color: #ffb35c; }
.tank-detail .shb.he { background: rgba(255, 107, 107, 0.17); color: #ff9b9b; }
.tank-detail .shb.prem { box-shadow: 0 0 0 1.5px rgba(255, 207, 92, 0.6); }
/* 装甲热力单元格 */
.tank-detail td.hot { border-radius: 6px; font-weight: 800; }
/* 射界 / 俯仰图 */
.tank-detail .arcs-row { display: flex; gap: 26px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
.tank-detail .arc-box { background: linear-gradient(180deg, var(--panel2), var(--panel3)); border: 1px solid var(--border); border-radius: 12px; padding: 10px 14px 6px; text-align: center; }
.tank-detail .arc-box .lbl { color: var(--muted); font-size: 0.74em; text-transform: uppercase; letter-spacing: .4px; }
.tank-detail .yaw-arc .fan { fill: rgba(255, 255, 255, 0.05); }
.tank-detail .yaw-arc .allow { fill: rgba(255, 138, 61, 0.30); stroke: var(--accent-2); stroke-width: 1.5; }
.tank-detail .yaw-arc .barrel { stroke: var(--accent-3); stroke-width: 2.5; stroke-linecap: round; }
.tank-detail .yaw-arc text { fill: var(--txt); font-size: 12px; font-weight: 700; }
.tank-detail .yaw-arc .sub { fill: var(--muted); font-size: 9.5px; font-weight: 600; }
.tank-detail .gun-fan .up { fill: rgba(95, 191, 122, 0.30); stroke: var(--green); stroke-width: 1.5; }
.tank-detail .gun-fan .down { fill: rgba(95, 168, 232, 0.30); stroke: var(--blue); stroke-width: 1.5; }
.tank-detail .gun-fan .hline { stroke: rgba(255, 255, 255, 0.25); stroke-width: 1; stroke-dasharray: 3 3; }
.tank-detail .gun-fan text { fill: var(--txt); font-size: 11px; font-weight: 700; }
/* 同级百分位条 */
.tank-detail .pct-row { display: grid; grid-template-columns: 110px 1fr 150px; gap: 12px; align-items: center; margin: 7px 0; }
.tank-detail .pct-lbl { color: var(--muted); font-size: 0.82em; }
.tank-detail .pct-bar { height: 10px; background: var(--panel3); border-radius: 5px; overflow: hidden; }
.tank-detail .pct-bar > div { height: 100%; border-radius: 5px; }
.tank-detail .pct-bar .g { background: linear-gradient(90deg, #4a9e63, var(--green)); }
.tank-detail .pct-bar .o { background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
.tank-detail .pct-bar .r { background: linear-gradient(90deg, #c94f4f, var(--red)); }
.tank-detail .pct-val { font-size: 0.9em; font-weight: 700; text-align: right; white-space: nowrap; }
/* 总览两栏 */
.tank-detail .ov-grid { display: grid; grid-template-columns: 1fr 330px; gap: 20px; align-items: stretch; }
@media (max-width: 820px) { .tank-detail .ov-grid { grid-template-columns: 1fr; } }
.tank-detail .radar-wrap { display: flex; align-items: center; justify-content: center; }
.tank-detail .radar-wrap canvas { max-width: 100%; }
/* 间隙甲徽章 */
.tank-detail .spaced-badge { display: inline-block; margin: 2px 6px 2px 0; padding: 2px 10px; border-radius: 11px; font-size: 0.78em; font-weight: 700; background: rgba(255, 207, 92, 0.12); color: var(--yellow); border: 1px dashed rgba(255, 207, 92, 0.45); }
.tank-detail #open-3d { width: 100%; padding: 11px; background: var(--panel3); border: 1px solid var(--border-hi); color: var(--txt); font-weight: 700; font-size: 0.95em; border-radius: var(--radius-sm); cursor: pointer; }
.tank-detail #open-3d:hover { border-color: var(--accent); }
</style>
