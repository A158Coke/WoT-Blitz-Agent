// 坦克详情纯函数工具：自旧版 tank_detail.html 平移，语义保持一致。

export const TYPE_LABEL = { lightTank: 'Light', mediumTank: 'Medium', heavyTank: 'Heavy', 'AT-SPG': 'TD' }
export const TYPE_CLS = { lightTank: 't-light', mediumTank: 't-medium', heavyTank: 't-heavy', 'AT-SPG': 't-td' }
export const NATION_LABEL = {
  ussr: 'USSR', usa: 'USA', germany: 'Germany', uk: 'UK', japan: 'Japan',
  china: 'China', france: 'France', european: 'EU', other: 'Other',
}

// 弹种显示名（开发名 ap_cr/hc_premium → APCR/HEAT）
export const normType = (t) => {
  t = (t || '').toLowerCase()
  if (t === 'hc' || t === 'hc_premium' || t === 'heat') return 'heat'
  if (t === 'ap_cr' || t === 'ap_cr_premium' || t === 'apcr') return 'apcr'
  if (t === 'he' || t === 'he_premium') return 'he'
  if (t === 'ap' || t === 'ap_premium') return 'ap'
  return t
}
export const shellLabel = (s) => normType(s.type).toUpperCase()
export const isPremiumShell = (s) => /premium/i.test(s.type || '')

// 装甲厚度热力色：20–300mm 映射 红→黄→绿（HSL 色相 0→120）
export function armorColorStyle(mm) {
  if (mm == null) return {}
  const t = Math.max(0, Math.min(1, (mm - 20) / 280))
  const hue = Math.round(t * 120)
  return {
    background: `hsla(${hue},58%,46%,0.22)`,
    color: `hsl(${hue},68%,${68 - t * 8}%)`,
  }
}

export const fmt = (v, d = 0) => (v != null ? Number(v).toFixed(d) : '-')

// 同型 peer 百分位（0-100）：自身值在样本中 ≤ 的比例
export function percentile(arr, x) {
  const a = (arr || []).filter((v) => v != null)
  if (!a.length || x == null) return null
  return (a.filter((v) => v <= x).length / a.length) * 100
}

// 当前车的同级同类型 peer 集合；样本 <5 辆视为不可比
export function peersOf(d, tanksAll) {
  if (!Array.isArray(tanksAll)) return null
  const type = d.type || 'unknown'
  const peers = tanksAll.filter((t) => t.tier === d.tier && (t.type || 'unknown') === type)
  return peers.length >= 5 ? peers : null
}

// 六维指标：自身值 + 同级百分位（供百分位条与雷达图共用）
export function peerMetrics(d, cfg, tanksAll) {
  const peers = peersOf(d, tanksAll)
  if (!peers) return null
  const shells = (cfg && cfg.shells && cfg.shells.length ? cfg.shells : d.shells) || []
  const pens = shells.map((s) => s.penetration).filter((v) => v != null)
  const dmgs = shells.map((s) => s.damage).filter((v) => v != null)
  const col = (a) => a.map((t) => t[1]).filter((v) => v != null)
  const rows = [
    ['HP', d.hp, peers.map((t) => t.hp), 0],
    ['车体装甲', d.armor && d.armor.hull_front, col(peers.map((t) => [0, t.armor_front])), 0],
    ['炮塔装甲', d.armor && d.armor.turret_front, col(peers.map((t) => [0, t.armor_turret])), 0],
    ['最大穿深', pens.length ? Math.max(...pens) : null, peers.map((t) => t.pen_max), 0],
    ['单发伤害', dmgs.length ? Math.max(...dmgs) : null, peers.map((t) => t.damage_max), 0],
    ['视野', (cfg && cfg.view_range) || d.view_range, peers.map((t) => t.view_range), 0],
  ]
  return rows.map(([label, val, arr]) => ({ label, val, pct: percentile(arr, val) }))
}

// 火炮水平射界 SVG：yaw_limits 为度数 {min,max}；实际可转区间 = [-max, -min]（左负右正）
export function yawArcSvg(cfg) {
  const yl = cfg && cfg.yaw_limits
  let a0, a1
  if (yl && typeof yl.min === 'number' && typeof yl.max === 'number') { a0 = -yl.max; a1 = -yl.min }
  else { a0 = -180; a1 = 180 }
  if (a0 > a1) { const t = a0; a0 = a1; a1 = t }
  const span = a1 - a0
  const full = span >= 359.5
  const cx = 110, cy = 100, r = 82
  const pt = (a) => { const rad = (a * Math.PI) / 180; return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)] }
  let allow = ''
  if (!full) {
    const [x0, y0] = pt(a0), [x1, y1] = pt(a1)
    const large = span > 180 ? 1 : 0
    allow = `<path class="allow" d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z"/>`
  }
  const [bx0, by0] = pt(-90), [bx1, by1] = pt(90)
  return `<div class="arc-box"><div class="lbl">Gun Arc 水平射界</div>
  <svg class="yaw-arc" width="220" height="118" viewBox="0 0 220 118">
      <path class="fan" d="M${cx},${cy} L${bx0.toFixed(1)},${by0.toFixed(1)} A${r},${r} 0 0 1 ${bx1.toFixed(1)},${by1.toFixed(1)} Z"/>
      ${allow}
      <line class="barrel" x1="${cx}" y1="${cy}" x2="${cx}" y2="${(cy - r + 6).toFixed(1)}"/>
      <text x="${cx}" y="${cy - 30}" text-anchor="middle">${full ? '360° 全旋转' : Math.round(a0) + '° ~ ' + Math.round(a1) + '°'}</text>
      <text class="sub" x="${cx}" y="${cy - 14}" text-anchor="middle">${full ? '' : '射界跨度 ' + Math.round(span) + '°'}</text>
  </svg></div>`
}

// 俯仰扇形 SVG：上=elevation(绿) 下=depression(蓝)
export function gunFanSvg(dep, elev) {
  if (dep == null && elev == null) return ''
  const d = Math.max(0, Math.min(30, dep ?? 0)), e = Math.max(0, Math.min(30, elev ?? 0))
  const cx = 80, cy = 76, r = 58
  const pt = (a) => { const rad = (a * Math.PI) / 180; return [cx + r * Math.cos(rad), cy - r * Math.sin(rad)] }
  const arc = (from, to, cls) => {
    const [x0, y0] = pt(from), [x1, y1] = pt(to)
    const large = Math.abs(to - from) > 180 ? 1 : 0
    // to>from 逆时针（屏幕坐标）→ sweep=0
    return `<path class="${cls}" d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 0 ${x1.toFixed(1)},${y1.toFixed(1)} Z"/>`
  }
  let fans = ''
  if (e > 0.5) fans += arc(0, e, 'up')
  if (d > 0.5) fans += arc(0, -d, 'down')
  const [ex, ey] = pt(e), [dx, dy] = pt(-d)
  return `<div class="arc-box"><div class="lbl">Gun Pitch 俯仰区间</div>
  <svg class="gun-fan" width="184" height="102" viewBox="0 0 184 102">
      ${fans}
      <line class="hline" x1="${cx - r - 8}" y1="${cy}" x2="${cx + r + 8}" y2="${cy}"/>
      <line class="barrel" style="stroke:var(--accent-3);stroke-width:2.5;stroke-linecap:round;" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r + 4}"/>
      ${e > 0.5 ? `<text x="${Math.min(ex + 6, 152).toFixed(1)}" y="${Math.max(10, ey - 2).toFixed(1)}" fill="var(--green)">+${Math.round(e)}°</text>` : ''}
      ${d > 0.5 ? `<text x="${Math.min(dx + 6, 152).toFixed(1)}" y="${Math.min(dy + 12, 98).toFixed(1)}" fill="var(--blue)">-${Math.round(d)}°</text>` : ''}
  </svg></div>`
}
