<script setup>
// Replay 分析：批量扫描报告 + 射击复现（单场解析/射击者筛选/3D 复现链接/实时回放入口）。
import { ref, computed, onMounted } from 'vue'
import { scanReplays, replayShots, playerSearch } from '../api/stats.js'
import { fmtInt, wrCls, wrText, fmtDur } from '../utils/format.js'
import { isTauri, tauriDialogOpen, tauriInvoke, uploadReplay } from '../utils/tauri.js'
import { useToast } from '../composables/useToast.js'

const { toast } = useToast()

// ---------- 扫描报告 ----------
const scanDir = ref('')
const scanMode = ref('all')
const scanDays = ref('')
const scanning = ref(false)
const scanError = ref('')
const report = ref(null)
const showImport = ref(true) // 导入按钮：Tauri=对话框多选；浏览器=单文件上传
const importFileEl = ref(null)

async function doScan(scanOverride) {
  scanning.value = true
  scanError.value = ''
  report.value = null
  // 后端按运行平台自动转换 Windows/WSL 路径风格
  const body = {
    dir: scanDir.value,
    mode: scanMode.value,
    days: scanDays.value ? parseInt(scanDays.value) : null,
  }
  // 移动端导入流程：显式文件列表 → 报告只覆盖本次实际导入的文件
  if (scanOverride && Array.isArray(scanOverride.files) && scanOverride.files.length) body.files = scanOverride.files
  try {
    const d = await scanReplays(body)
    if (d.error) { scanError.value = d.error; return }
    report.value = d
  } catch (e) {
    scanError.value = '⚠ 请求失败: ' + (e.message || e)
  } finally {
    scanning.value = false
  }
}

function wrBarColor(wr) {
  const cls = wrCls(wr)
  return cls === 'g' ? 'var(--green)' : cls === 'y' ? 'var(--yellow)' : 'var(--red)'
}

// 扫描卡导入：Tauri=选择回放目录（批量同步进私有库后扫描）；浏览器=单文件上传导入
async function importReplays() {
  if (isTauri()) {
    let picked = null
    try {
      picked = await tauriDialogOpen({
        multiple: true,
        filters: [{ name: 'WoTB Replay', extensions: ['wotbreplay'] }],
      })
    } catch (e) { toast('导入失败: ' + (e && e.message || e)); return }
    if (!picked) return
    const list = Array.isArray(picked) ? picked : [picked]
    const imported = []
    for (let i = 0; i < list.length; i++) {
      try {
        const dest = await tauriInvoke('import_replay', { src: list[i] })
        if (dest) imported.push(dest)
      } catch (err) { console.warn('import failed:', list[i], err) }
    }
    toast(`已导入 ${imported.length}/${list.length} 个回放，开始扫描…`)
    scanDir.value = ''
    doScan({ files: imported })
  } else {
    importFileEl.value?.click()
  }
}
async function onImportFile(e) {
  const f = e.target.files[0]
  if (!f) return
  try {
    const d = await uploadReplay(f)
    toast('已导入: ' + f.name)
    scanDir.value = ''
    doScan({ files: [d.path] })
  } catch (err) { toast('导入失败: ' + (err && err.message || err)) }
  e.target.value = ''
}

// ---------- 射击复现 ----------
const srFile = ref('')
const srParsing = ref(false)
const srError = ref('')
const srParsed = ref(false)
const srData = ref([])
const srAuthorTank = ref(0)
const srShells = ref([])
const srPlayers = ref([])
const srNotes = ref([])
const srShooter = ref('all')
const srQuality = ref(localStorageSafeGet())
const srImportFileEl = ref(null)

function localStorageSafeGet() {
  try {
    const q = localStorage.getItem('pb_quality')
    if (['low', 'mid', 'high'].includes(q)) return q
  } catch { /* ignore */ }
  // 无记录时移动端默认低、桌面默认高
  return isTauri() || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'low' : 'high'
}
function onQualityChange() {
  try { localStorage.setItem('pb_quality', srQuality.value) } catch { /* ignore */ }
}

async function srParse() {
  const f = srFile.value.trim()
  if (!f) { srError.value = 'Enter a .wotbreplay path.'; return }
  srParsing.value = true
  srError.value = ''
  try {
    const d = await replayShots(f)
    srData.value = d.shots || []
    srAuthorTank.value = d.author_tank_id || 0
    srShells.value = d.author_shells || []
    srPlayers.value = d.players || []
    srNotes.value = d.extraction_notes || []
    srShooter.value = 'all'
    srParsed.value = true
  } catch (e) {
    srError.value = '⚠ ' + (e.status ? `HTTP ${e.status}` : e.message)
  } finally {
    srParsing.value = false
  }
}

// 射击者筛选下拉：battle_results 玩家列表按队伍分组（我方=作者阵营，作者置顶）
const shooterGroups = computed(() => {
  const players = srPlayers.value
  if (!players.length) return null
  const authorTeam = (players.find((p) => p.is_author) || {}).team
  const shotCount = {}
  srData.value.forEach((s) => { shotCount[s.shooter_name] = (shotCount[s.shooter_name] || 0) + 1 })
  const mk = (p) => ({ name: p.name, miss: (p.fire_events || 0) - (shotCount[p.name] || 0) })
  return {
    allies: players.filter((p) => p.team === authorTeam)
      .sort((a, b) => (b.is_author ? 1 : 0) - (a.is_author ? 1 : 0)).map(mk),
    enemies: players.filter((p) => p.team !== authorTeam).map(mk),
  }
})

// 汇总摘要（随筛选联动）：命中率 = 有 flags 或非作者命中的比例；穿透率 = 击穿/命中（不含跳弹）
const shotSummary = computed(() => {
  const rows = filteredShots.value
  const isHit = (s) => (s.is_author ? (s.hit_flags || 0) !== 0 : !!s.target_name)
  const total = rows.length
  const hits = rows.filter(isHit).length
  const pens = rows.filter((s) => (s.is_author ? s.hit_flags & 0x0010 : s.game_hit_result === 3)).length
  const rics = rows.filter((s) => (s.is_author ? s.hit_flags & 0x0008 : false)).length
  const heHits = rows.filter((s) => s.is_author && s.hit_flags & 0x1000).length
  const kills = rows.filter((s) => s.is_kill).length
  const dmgTotal = rows.reduce((a, s) => a + (s.damage || 0), 0)
  return {
    total, hits, pens, rics, heHits, kills, dmgTotal,
    hitRate: total ? 100 * hits / total : 0,
    penRate: hits ? 100 * pens / hits : 0,
  }
})

// 数据质量徽章：ShotQuality 降级/陈旧项汇总（⚠ 悬停显示详情）
function qualityTitle(s) {
  const q = s.quality
  if (!q) return ''
  const issues = []
  if (q.shooter_pos_from_muzzle) issues.push('射手位置为炮口坐标兜底（快照缺失）')
  if (Math.abs(q.shooter_state_dt_ms || 0) >= 300) issues.push(`射手快照偏 ${q.shooter_state_dt_ms}ms`)
  if (q.target_state_dt_ms != null && Math.abs(q.target_state_dt_ms) >= 300) issues.push(`目标快照偏 ${q.target_state_dt_ms}ms`)
  if ((q.turret_degraded || []).includes('shooter')) issues.push('射手炮塔角降级为车体朝向')
  if ((q.turret_degraded || []).includes('target')) issues.push('目标炮塔角降级为车体朝向')
  if (q.dmg_unattributed) issues.push('伤害未记账（血量链无区间）')
  if (q.target_anchor_src === 'nearest') issues.push('命中通知缺失，目标锚点回退命中时刻最近包')
  else if (q.target_anchor_src === 'extrapolated') issues.push('命中通知缺失，目标姿态超出最后采样，按末段速度外推')
  else if (q.target_anchor_src === 'filtered') issues.push('命中通知缺失，目标锚点回退命中时刻插值')
  if (q.shooter_anchor_src === 'extrapolated') issues.push('射手姿态超出最后采样，按末段速度外推')
  else if (q.shooter_anchor_src === 'nearest') issues.push('射手快照用最近包（AoI 稀疏）')
  if (q.shell_from_broadcast) issues.push('弹种来自开火广播兜底（命中通知未转发）')
  if (q.shell_from_terrain) issues.push('弹种来自地形命中广播兜底（0x1b，含精确落点）')
  if (q.shooter_pitch_from_velocity) issues.push('射手炮管俯仰由弹道推算（他人视角无该状态）')
  if (s.target_name && !s.shell_id) issues.push('弹种未知（通知与广播均缺失）')
  if (s.target_name && s.game_hit_result === 255) issues.push('服务器未通知命中结果')
  return issues.join('; ')
}

// 弹种徽标：shell_kind → AP/APCR/HEAT/HE + premium 标记；缺 kind 时槽位/id 兜底
function shellBadge(s) {
  const kindOf = (t) => {
    t = (t || '').toLowerCase()
    if (/^(ap_cr|apcr)/.test(t)) return 'APCR'
    if (/^(hc|heat)/.test(t)) return 'HEAT'
    if (/^he/.test(t)) return 'HE'
    if (/^ap/.test(t)) return 'AP'
    return ''
  }
  const sh = s.shell_slot != null ? srShells.value[s.shell_slot] : null
  const t = s.shell_kind || (sh && sh.shell_type) || ''
  const label = kindOf(t)
  if (!label) {
    if (s.is_author && sh) return { fallback: '槽' + s.shell_slot }
    if (s.shell_id) return { fallbackSmall: 'id' + s.shell_id }
    return {}
  }
  return {
    label,
    gold: /premium/.test(t),
    pen: sh && sh.penetration ? sh.penetration + 'mm' : null,
  }
}

// 结果徽标：hit_flags 位图 → 击穿/HE/跳弹/未穿/脱靶；非作者按 game_hit_result 降级
function resultBadge(s) {
  const f = s.hit_flags || 0
  if (!s.is_author && !f) {
    const r = s.game_hit_result
    if (r == null || r === 255 || r === 0) return { text: 'MISS', cls: 'miss' }
    if (r === 3) return { text: '击穿', cls: 'pen' }
    if (r === 4) return { text: '履带', cls: 'track' }
    return { text: '未穿', cls: 'nopen' }
  }
  if (!f) return { text: 'MISS', cls: 'miss' }
  if (f & 0x1000) return { text: 'HE', cls: 'he-res' }
  if (f & 0x0010) return { text: '击穿', cls: 'pen' }
  if (f & 0x0008) return { text: '跳弹', cls: 'ric' }
  return { text: '未穿', cls: 'nopen' }
}

// 行内 3D 复现可用性：命中弹必有弹道；脱靶弹也可复现（ball_a→ball_b 弹道 + terrain_impact 落点/材质，world 模式）
function rowHas3d(s) {
  const miss = !s.target_name
  return !miss || (Array.isArray(s.ball_b) && (s.ball_b[0] || s.ball_b[1] || s.ball_b[2]))
}

function dmgColor(s) {
  const d = s.damage || 0
  return !d ? 'var(--muted)' : d >= 1000 ? 'var(--red)' : d >= 600 ? 'var(--accent-2)' : 'var(--txt)'
}

// 3D 查看器 URL：命中弹用目标车辆；脱靶弹（无 target_tank_id）用射手车辆兜底
function srViewerUrl(s) {
  const shooterTank = s.shooter_tank_id || srAuthorTank.value || 0
  const tid = s.target_tank_id || shooterTank || 0
  const sh = shooterTank ? '&shooter=' + shooterTank : ''
  // 弹种下标：优先确定性 shell_id 匹配结果，回退作者槽位
  const shIdx = s.shooter_shell_idx != null ? s.shooter_shell_idx : (s.is_author && s.shell_slot != null) ? s.shell_slot : null
  const ammo = shIdx != null ? '&shell=' + shIdx : ''
  // 实际搭载配置：命中弹用目标配置，脱靶弹用射手配置
  const cfgId = s.target_tank_id ? s.target_config_idx : (s.shooter_config_idx ?? s.target_config_idx)
  const cfg = cfgId != null ? '&config=' + cfgId : ''
  return `/armor_view/view/${tid}?heatmap=1&shot=${s.index}${sh}${ammo}${cfg}&world=1`
}
function openShotInViewer(no) {
  const shot = srData.value.find((s) => s.index === no)
  if (shot) window.open(srViewerUrl(shot), '_blank', 'width=' + Math.round(window.innerWidth * 0.85) + ',height=' + Math.round(window.innerHeight * 0.85))
}

const filteredShots = computed(() => {
  const sel = srShooter.value
  return sel === 'all' ? srData.value : srData.value.filter((s) => s.shooter_name === sel)
})

// 射击复现卡导入（导入后自动填入路径输入框）
async function srImport() {
  if (isTauri()) {
    try {
      const picked = await tauriDialogOpen({
        multiple: false,
        filters: [{ name: 'WoTB Replay', extensions: ['wotbreplay'] }],
      })
      if (!picked) return
      const dest = await tauriInvoke('import_replay', { src: picked })
      srFile.value = dest || ''
    } catch (e) { toast('导入失败: ' + (e && e.message || e)) }
  } else {
    srImportFileEl.value?.click()
  }
}
async function onSrImportFile(e) {
  const f = e.target.files[0]
  if (!f) return
  try {
    const d = await uploadReplay(f)
    srFile.value = d.path
    toast('已导入: ' + f.name)
  } catch (err) { toast('导入失败: ' + (err && err.message || err)) }
  e.target.value = ''
}

function openPlayback() {
  const f = srFile.value.trim()
  if (!f) { srError.value = 'Enter a .wotbreplay path.'; return }
  window.open('/playback?file=' + encodeURIComponent(f) + '&q=' + srQuality.value, '_blank')
}

onMounted(() => {
  // 射击复现支持 ?file= 直达（保留旧版可收藏性由路径输入承担，这里不做自动解析）
})
</script>

<template>
  <section class="tab-view">
    <div class="card">
      <h2>Replay Scan Report</h2>
      <div class="sub">批量扫描回放目录，聚合胜率 / 伤害 / 坦克 / 地图</div>
      <div class="row">
        <input v-model="scanDir" placeholder="Replay directory (blank = config)">
        <select v-model="scanMode"><option value="all">All</option><option value="rating">Rating</option><option value="regular">Regular</option></select>
        <input v-model="scanDays" type="number" placeholder="Days" style="max-width:100px;">
        <button class="btn btn-primary" @click="doScan()">Scan</button>
        <button v-show="showImport" class="btn" :title="isTauri() ? '导入回放（可多选）' : '导入回放'" @click="importReplays">
          {{ isTauri() ? '📥 导入回放（可多选）' : '📥 导入回放' }}
        </button>
        <input ref="importFileEl" type="file" accept=".wotbreplay" style="display:none;" @change="onImportFile">
      </div>
      <div v-if="scanning" class="muted"><span class="spinner"></span> scanning...</div>
      <div v-else-if="scanError" class="muted">⚠ {{ scanError }}</div>
      <template v-else-if="report">
        <h3>{{ report.author_name || '' }} — {{ report.room_type }}</h3>
        <div class="muted" style="font-size:0.85em;margin:-6px 0 10px;">
          {{ report.date_range || '' }} · {{ report.wins ?? 0 }} 胜 / {{ report.losses ?? 0 }} 负<template v-if="report.auto_destroyed_count"> · {{ report.auto_destroyed_count }} 场自动击毁</template>
        </div>
        <div class="stat-grid">
          <div class="stat-box"><div class="lbl">Battles</div><div class="val">{{ report.total_battles }}</div></div>
          <div class="stat-box"><div class="lbl">Win rate</div><div class="val" :class="wrCls(report.win_rate)">{{ report.win_rate.toFixed(1) }}%</div></div>
          <div class="stat-box"><div class="lbl">Avg dmg</div><div class="val b">{{ fmtInt(report.avg_damage) }}</div></div>
          <div class="stat-box"><div class="lbl">Avg frags</div><div class="val">{{ report.avg_frags.toFixed(2) }}</div></div>
          <div class="stat-box"><div class="lbl">Hit rate 命中率</div><div class="val">{{ report.hit_rate != null ? report.hit_rate.toFixed(1) + '%' : '-' }}</div></div>
          <div class="stat-box"><div class="lbl">Pen rate 穿透率</div><div class="val o">{{ report.penetration_rate != null ? report.penetration_rate.toFixed(1) + '%' : '-' }}</div></div>
          <div class="stat-box"><div class="lbl">Avg blocked 格挡</div><div class="val">{{ fmtInt(report.avg_damage_blocked) }}</div></div>
          <div class="stat-box"><div class="lbl">Avg assisted 助攻</div><div class="val">{{ fmtInt(report.avg_assisted) }}</div></div>
          <div class="stat-box"><div class="lbl">Avg XP</div><div class="val">{{ fmtInt(report.avg_xp) }}</div></div>
          <div class="stat-box"><div class="lbl">Avg duration</div><div class="val">{{ fmtDur(report.avg_battle_duration) }}</div></div>
        </div>
        <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:18px;margin-top:10px;">
          <div>
            <h4>Tanks</h4>
            <table class="inline-table-sm">
              <thead><tr><th>Tank</th><th>B</th><th>WR</th><th>dmg</th><th>frags</th></tr></thead>
              <tbody>
                <tr v-for="t in (report.tank_usage || []).slice(0, 8)" :key="t.tank_id">
                  <td><img loading="lazy" :src="`/api/tank_image/${t.tank_id}`" style="width:34px;height:24px;object-fit:contain;vertical-align:middle;margin-right:6px;">{{ t.tank_name }}</td>
                  <td>{{ t.battles }}</td>
                  <td>{{ wrText(t.win_rate) }}<span class="wrbar"><i :style="{ width: Math.min(100, t.win_rate).toFixed(0) + '%', background: wrBarColor(t.win_rate) }"></i></span></td>
                  <td>{{ Math.round(t.avg_damage) }}</td>
                  <td>{{ t.avg_frags.toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <h4>Maps</h4>
            <table class="inline-table-sm">
              <thead><tr><th>Map</th><th>B</th><th>WR</th></tr></thead>
              <tbody>
                <tr v-for="(m, i) in (report.map_stats || []).slice(0, 8)" :key="i">
                  <td>{{ m.map_name || m.map_id }}</td>
                  <td>{{ m.battles }}</td>
                  <td>{{ wrText(m.win_rate) }}<span class="wrbar"><i :style="{ width: Math.min(100, m.win_rate).toFixed(0) + '%', background: wrBarColor(m.win_rate) }"></i></span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </div>

    <div class="card">
      <h2>Shot Replay (射击复现)</h2>
      <div class="sub">解析单场回放，还原每发射击的双方位置/朝向与伤害，点击在 3D 查看器中复现该发</div>
      <div class="row">
        <input v-model="srFile" placeholder="Path to the .wotbreplay file (Windows or WSL path)" style="flex:1;">
        <button v-show="true" class="btn" @click="srImport">📂 导入</button>
        <button class="btn btn-primary" @click="srParse">Parse</button>
        <select v-model="srQuality" title="实时回放画质：低=小地图地面（无建筑/盒子车模）· 中=烘焙底图+建筑 · 高=分层地表+建筑+抗锯齿" @change="onQualityChange">
          <option value="low">画质 · 低</option>
          <option value="mid">画质 · 中</option>
          <option value="high">画质 · 高</option>
        </select>
        <button class="btn" title="全场连续实时回放（新窗口）" @click="openPlayback">▶ 实时回放</button>
        <input ref="srImportFileEl" type="file" accept=".wotbreplay" style="display:none;" @change="onSrImportFile">
      </div>

      <div v-if="srParsing" class="muted"><span class="spinner"></span> parsing replay...</div>
      <div v-else-if="srError" class="muted">{{ srError }}</div>
      <template v-else-if="srData.length">
        <!-- 射击者筛选 -->
        <div v-if="shooterGroups" style="margin:8px 0;display:flex;align-items:center;gap:8px;">
          <span class="muted" style="font-size:11px;">射击者：</span>
          <select v-model="srShooter" style="background:#1a1612;color:var(--txt);border:1px solid #555;border-radius:4px;padding:4px 8px;font-size:11px;">
            <option value="all">全部玩家 ({{ srData.length }})</option>
            <optgroup label="我方"><option v-for="p in shooterGroups.allies" :key="p.name" :value="p.name">{{ p.name }}<template v-if="p.miss > 0"> ·缺{{ p.miss }}发</template></option></optgroup>
            <optgroup label="敌方"><option v-for="p in shooterGroups.enemies" :key="p.name" :value="p.name">{{ p.name }}<template v-if="p.miss > 0"> ·缺{{ p.miss }}发</template></option></optgroup>
          </select>
          <span class="muted" style="font-size:10px;">·缺N发 = 有开火事件但弹丸数据未收录（AoI 裁剪）；⚠ = 该发数据降级（悬停看详情）</span>
        </div>
        <div v-if="srNotes.length" class="muted" style="font-size:10px;color:var(--accent);margin:4px 0;">⚠ 数据边界：{{ srNotes.join('；') }}</div>

        <template v-if="filteredShots.length">
          <div class="stat-grid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr));">
            <div class="stat-box"><div class="lbl">Shots</div><div class="val">{{ shotSummary.total }}</div></div>
            <div class="stat-box"><div class="lbl">Hit rate</div><div class="val" :class="wrCls(shotSummary.hitRate)">{{ shotSummary.hitRate.toFixed(0) }}%</div><div class="sub">{{ shotSummary.hits }}/{{ shotSummary.total }}</div></div>
            <div class="stat-box"><div class="lbl">Pen rate</div><div class="val o">{{ shotSummary.penRate.toFixed(0) }}%</div><div class="sub">{{ shotSummary.pens }}/{{ shotSummary.hits }}</div></div>
            <div class="stat-box"><div class="lbl">Total dmg</div><div class="val b">{{ fmtInt(shotSummary.dmgTotal) }}</div></div>
            <div class="stat-box"><div class="lbl">Rico / HE</div><div class="val">{{ shotSummary.rics }} / {{ shotSummary.heHits }}</div></div>
            <div class="stat-box"><div class="lbl">Kills</div><div class="val r">{{ shotSummary.kills }}</div></div>
          </div>
          <table class="inline-table-sm shot-table">
            <thead><tr><th>#</th><th>Time</th><th>Shooter</th><th>Dmg</th><th>Shell</th><th>Result</th><th>Target</th><th></th></tr></thead>
            <tbody>
              <tr v-for="s in filteredShots" :key="s.index" :style="rowHas3d(s) ? 'cursor:pointer;' : ''" @click="rowHas3d(s) && openShotInViewer(s.index)">
                <td>#{{ s.index }}</td>
                <td>{{ s.time_s.toFixed(1) }}s</td>
                <td>
                  <b v-if="s.is_author" style="color:var(--accent-2);">★{{ s.shooter_name }}</b>
                  <span v-else :style="{ color: s.shooter_team === 'enemy' ? 'var(--red)' : 'var(--txt)' }">{{ s.shooter_name }}</span>
                  <span v-if="qualityTitle(s)" :title="qualityTitle(s)" style="color:var(--accent);cursor:help;font-size:10px;">⚠</span>
                </td>
                <td><b :style="{ color: dmgColor(s) }">{{ s.damage || 0 }}</b></td>
                <td>
                  <template v-if="shellBadge(s).fallback"><span class="muted">{{ shellBadge(s).fallback }}</span></template>
                  <template v-else-if="shellBadge(s).fallbackSmall"><span class="muted" style="font-size:10px;">{{ shellBadge(s).fallbackSmall }}</span></template>
                  <template v-else>
                    <span class="pill" :class="{ gold: shellBadge(s).gold }" style="font-size:10px;">{{ shellBadge(s).label }}</span>
                    <span v-if="shellBadge(s).pen" class="muted" style="font-size:10px;"> {{ shellBadge(s).pen }}</span>
                  </template>
                </td>
                <td>
                  <span class="pill" :class="resultBadge(s).cls" style="font-size:10px;">{{ resultBadge(s).text }}</span>
                  <span v-if="s.is_kill" class="pill kill" style="font-size:10px;">KILL</span>
                </td>
                <td>
                  <span v-if="!s.target_name" class="muted">—</span>
                  <template v-else>
                    <img v-if="s.target_tank_id" loading="lazy" :src="`/api/tank_image/${s.target_tank_id}`" style="width:36px;height:25px;object-fit:contain;vertical-align:middle;margin-right:6px;">{{ s.target_name }}
                  </template>
                </td>
                <td @click.stop>
                  <a v-if="rowHas3d(s)" class="btn" style="padding:2px 10px;display:inline-block;" :href="srViewerUrl(s)" target="_blank">3D View</a>
                  <span v-else class="muted">—</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div class="muted" style="margin-top:6px;">点击行 → 直接打开 3D 世界模式查看器；脱靶弹按弹道终点提供 3D 复现（落点/材质，无目标装甲判定）；★ = 回放作者</div>
        </template>
        <div v-else class="muted">No shots for this shooter.</div>
      </template>
      <div v-else-if="srParsed && !srData.length" class="muted">No shots detected.</div>
    </div>
  </section>
</template>
