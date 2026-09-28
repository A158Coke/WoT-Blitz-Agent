<script setup>
// Compare：近期回放表现 vs API 历史累计（双柱状图 + Δ 表）+ Prematch 阵容分析。
import { ref, nextTick } from 'vue'
import Chart from 'chart.js/auto'
import { scanReplays, playerSearch, prematchAnalyze } from '../api/stats.js'
import { fmtInt, wrCls, wrText } from '../utils/format.js'

// ---------- Compare ----------
const cmpNick = ref('')
const cmpDir = ref('')
const cmpMode = ref('rating')
const cmpLoading = ref(false)
const cmpError = ref('')
const cmp = ref(null)
const wrCanvas = ref(null)
const dmgCanvas = ref(null)
let cmpCharts = []

async function doCompare() {
  cmpLoading.value = true
  cmpError.value = ''
  cmp.value = null
  cmpCharts.forEach((c) => c.destroy()); cmpCharts = []
  try {
    const scan = await scanReplays({ dir: cmpDir.value, mode: cmpMode.value, days: null })
    const p = (await playerSearch(cmpNick.value.trim())).players?.[0]
    if (!scan.total_battles || !p) { cmpError.value = 'Not enough data.'; return }
    // API 总战绩口径：随机+排位合计（与旧版一致）
    const apiBattles = p.random_battles + p.rating_battles
    const apiWins = p.random_wins + (p.rating_wins || 0)
    const apiWr = apiBattles ? 100 * apiWins / apiBattles : null
    const apiDmg = (p.random_damage_dealt + (p.rating_damage_dealt || 0)) / (apiBattles || 1)
    cmp.value = {
      repWr: scan.win_rate, repDmg: scan.avg_damage, repBattles: scan.total_battles,
      apiWr, apiDmg, apiBattles,
    }
    nextTick(renderCmpCharts)
  } catch (e) {
    cmpError.value = '⚠ ' + (e.status ? `扫描出错 (HTTP ${e.status})` : (e.message || e))
  } finally {
    cmpLoading.value = false
  }
}

function renderCmpCharts() {
  const c = cmp.value
  if (!c || !wrCanvas.value || !dmgCanvas.value) return
  const mk = (canvas, label, rep, api, fmt) => {
    const ctx = canvas.getContext('2d')
    const g = ctx.createLinearGradient(0, 0, 0, 220)
    g.addColorStop(0, 'rgba(255,138,61,0.75)')
    g.addColorStop(1, 'rgba(255,138,61,0.25)')
    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels: ['Replay 近期', 'API 累计'],
        datasets: [{
          label, data: [rep, api],
          backgroundColor: [g, 'rgba(95,168,232,0.7)'],
          borderColor: ['#ff8a3d', '#5fa8e8'], borderWidth: 1, borderRadius: 8,
          maxBarThickness: 90,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (item) => fmt(item.parsed.y) } } },
        scales: {
          x: { ticks: { color: '#c8bba9', font: { size: 12 } }, grid: { display: false } },
          y: { min: 0, ticks: { color: '#9c8f7f' }, grid: { color: 'rgba(255,255,255,0.06)' } },
        },
      },
    })
  }
  cmpCharts = [
    mk(wrCanvas.value, 'Win rate %', +c.repWr.toFixed(1), c.apiWr != null ? +c.apiWr.toFixed(1) : 0, (v) => v + '%'),
    mk(dmgCanvas.value, 'Avg damage', Math.round(c.repDmg), Math.round(c.apiDmg), (v) => fmtInt(v)),
  ]
}

// 差值单元格：正绿负红
function deltaCls(v) { return v == null || !isFinite(v) ? '' : v >= 0 ? 'wr-g' : 'wr-r' }
function deltaText(v, d = 0) {
  if (v == null || !isFinite(v)) return '-'
  return (v >= 0 ? '+' : '') + v.toFixed(d)
}

// ---------- Prematch ----------
const preNames = ref('')
const preLoading = ref(false)
const preError = ref('')
const lineup = ref(null)
const preInfo = ref('')

// 单名玩家卡：昵称 + 排位核心指标（威胁/薄弱点/最强最弱共用）
function luCard(p, tag, tagCls) {
  return {
    tag, tagCls,
    nickname: p.nickname || '-',
    wr: p.win_rate,
    dmg: fmtInt(p.avg_damage),
    battles: fmtInt(p.battles),
    rating: p.rating != null ? Number(p.rating).toFixed(1) : null,
  }
}

async function doPrematch() {
  preLoading.value = true
  preError.value = ''
  lineup.value = null
  const names = preNames.value.split(',').map((s) => s.trim()).filter(Boolean)
  try {
    const d = await prematchAnalyze(names)
    if (!d.lineup) {
      preError.value = `${d.status} ${d.info || ''} —— 未能查询到玩家战绩（昵称拼写或 API 限制）。`
      return
    }
    lineup.value = d.lineup
    preInfo.value = d.info || ''
  } catch (e) {
    preError.value = '⚠ HTTP ' + (e.status || '') + ': ' + (e.message || e)
  } finally {
    preLoading.value = false
  }
}
</script>

<template>
  <section class="tab-view">
    <div class="card">
      <h2>Compare (Replay vs API)</h2>
      <div class="sub">近期回放表现 vs 历史累计对比</div>
      <div class="row">
        <input v-model="cmpNick" placeholder="Nickname (e.g. Anonyme)">
        <input v-model="cmpDir" placeholder="Replay directory (blank = config)">
        <select v-model="cmpMode"><option value="rating">Rating</option><option value="all">All</option></select>
        <button class="btn btn-primary" @click="doCompare">Compare</button>
      </div>
      <div v-if="cmpLoading" class="muted"><span class="spinner"></span> comparing...</div>
      <div v-else-if="cmpError" class="muted">⚠ {{ cmpError }}</div>
      <template v-else-if="cmp">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;height:240px;margin:8px 0;">
          <div style="position:relative;min-width:0;"><canvas ref="wrCanvas"></canvas></div>
          <div style="position:relative;min-width:0;"><canvas ref="dmgCanvas"></canvas></div>
        </div>
        <table>
          <thead><tr><th>Metric</th><th>Replay 近期</th><th>API 累计</th><th>Δ</th></tr></thead>
          <tbody>
            <tr>
              <td>Win rate</td>
              <td v-html="wrText(cmp.repWr)"></td>
              <td>{{ wrText(cmp.apiWr) }}</td>
              <td><span :class="deltaCls(cmp.repWr - cmp.apiWr)">{{ deltaText(cmp.repWr - cmp.apiWr, 1) }}%</span></td>
            </tr>
            <tr>
              <td>Avg damage</td>
              <td>{{ fmtInt(cmp.repDmg) }}</td>
              <td>{{ fmtInt(cmp.apiDmg) }}</td>
              <td><span :class="deltaCls(cmp.repDmg - cmp.apiDmg)">{{ deltaText(cmp.repDmg - cmp.apiDmg, 0) }}</span></td>
            </tr>
            <tr>
              <td>Battles</td>
              <td>{{ cmp.repBattles }}</td>
              <td>{{ fmtInt(cmp.apiBattles) }}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
        <div class="muted" style="font-size:0.8em;margin-top:6px;">Δ = Replay − API；正值绿 / 负值红（当前状态相对长期水平）</div>
      </template>
    </div>

    <div class="card">
      <h2>Prematch Lineup</h2>
      <div class="sub">分析阵容强度、识别威胁与薄弱点</div>
      <div class="row">
        <input v-model="preNames" placeholder="Comma-separated nicknames">
        <button class="btn btn-primary" @click="doPrematch">Analyze</button>
      </div>
      <div v-if="preLoading" class="muted"><span class="spinner"></span> analyzing...</div>
      <div v-else-if="preError" class="muted">⚠ {{ preError }}</div>
      <template v-else-if="lineup">
        <div class="stat-grid" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr));">
          <div class="stat-box"><div class="lbl">Players</div><div class="val">{{ lineup.total_players }}</div></div>
          <div class="stat-box"><div class="lbl">Avg WR</div><div class="val" :class="wrCls(lineup.avg_win_rate)">{{ lineup.avg_win_rate != null ? lineup.avg_win_rate.toFixed(1) + '%' : '-' }}</div></div>
          <div class="stat-box"><div class="lbl">Avg dmg</div><div class="val b">{{ lineup.avg_damage != null ? fmtInt(lineup.avg_damage) : '-' }}</div></div>
        </div>
        <h4>威胁与薄弱点</h4>
        <div class="lu-grid">
          <div v-if="lineup.strongest && lineup.strongest.nickname" class="stat-box" style="padding:14px;">
            <div class="lbl"><span class="lu-tag top">最强</span> {{ lineup.strongest.nickname || '-' }}</div>
            <div class="val" style="font-size:1.05em;margin-top:6px;">{{ wrText(lineup.strongest.win_rate) }} <span class="muted" style="font-size:0.72em;font-weight:600;">WR</span></div>
            <div class="sub">{{ fmtInt(lineup.strongest.avg_damage) }} dmg/场 · {{ fmtInt(lineup.strongest.battles) }} 场<template v-if="lineup.strongest.rating != null"> · 评级 {{ Number(lineup.strongest.rating).toFixed(1) }}</template></div>
          </div>
          <div v-if="lineup.weakest && lineup.weakest.nickname" class="stat-box" style="padding:14px;">
            <div class="lbl"><span class="lu-tag weak">最弱</span> {{ lineup.weakest.nickname || '-' }}</div>
            <div class="val" style="font-size:1.05em;margin-top:6px;">{{ wrText(lineup.weakest.win_rate) }} <span class="muted" style="font-size:0.72em;font-weight:600;">WR</span></div>
            <div class="sub">{{ fmtInt(lineup.weakest.avg_damage) }} dmg/场 · {{ fmtInt(lineup.weakest.battles) }} 场<template v-if="lineup.weakest.rating != null"> · 评级 {{ Number(lineup.weakest.rating).toFixed(1) }}</template></div>
          </div>
          <div v-for="p in lineup.threats || []" :key="'t' + p.nickname" class="stat-box" style="padding:14px;">
            <div class="lbl"><span class="lu-tag threat">威胁</span> {{ p.nickname || '-' }}</div>
            <div class="val" style="font-size:1.05em;margin-top:6px;">{{ wrText(p.win_rate) }} <span class="muted" style="font-size:0.72em;font-weight:600;">WR</span></div>
            <div class="sub">{{ fmtInt(p.avg_damage) }} dmg/场 · {{ fmtInt(p.battles) }} 场<template v-if="p.rating != null"> · 评级 {{ Number(p.rating).toFixed(1) }}</template></div>
          </div>
          <div v-for="p in (lineup.weaknesses || []).filter((x) => x.nickname !== lineup.weakest?.nickname)" :key="'w' + p.nickname" class="stat-box" style="padding:14px;">
            <div class="lbl"><span class="lu-tag weak">集火</span> {{ p.nickname || '-' }}</div>
            <div class="val" style="font-size:1.05em;margin-top:6px;">{{ wrText(p.win_rate) }} <span class="muted" style="font-size:0.72em;font-weight:600;">WR</span></div>
            <div class="sub">{{ fmtInt(p.avg_damage) }} dmg/场 · {{ fmtInt(p.battles) }} 场<template v-if="p.rating != null"> · 评级 {{ Number(p.rating).toFixed(1) }}</template></div>
          </div>
        </div>
        <div v-if="lineup.suggestion" class="lu-suggest">💡 {{ lineup.suggestion }}</div>
        <div v-if="preInfo" class="muted" style="margin-top:10px;font-size:0.85em;">{{ preInfo }}</div>
      </template>
    </div>
  </section>
</template>

<style>
/* 阵容分析 */
.lu-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; margin: 10px 0; }
.lu-tag { display: inline-block; padding: 1px 8px; border-radius: 9px; font-size: 0.72em; font-weight: 800; }
.lu-tag.threat { background: rgba(255, 107, 107, 0.16); color: var(--red); }
.lu-tag.weak { background: rgba(95, 191, 122, 0.16); color: var(--green); }
.lu-tag.top { background: rgba(255, 207, 92, 0.16); color: var(--yellow); }
.lu-suggest { border-left: 3px solid var(--accent-2); background: rgba(255, 179, 92, 0.06); border-radius: 0 10px 10px 0; padding: 10px 14px; margin-top: 12px; font-size: 0.92em; }
/* 胜率分级配色 */
.wr-g { color: var(--green); font-weight: 700; }
.wr-y { color: var(--yellow); font-weight: 700; }
.wr-r { color: var(--red); font-weight: 700; }
</style>
