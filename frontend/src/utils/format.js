// 通用格式化工具：自旧版 index.html 平移。

// 胜率配色分级：<45% 红 / 45-55% 黄 / >55% 绿
export function wrCls(wr) { return wr == null ? '' : (wr >= 55 ? 'g' : wr >= 45 ? 'y' : 'r') }
export const wrText = (wr) => (wr == null ? '-' : wr.toFixed(1) + '%')
export function fmtInt(v) { return v == null ? '-' : Math.round(v).toLocaleString('en-US') }
export function fmtDur(sec) {
  // 先对总秒数取整再分解：59.6 秒必须是 1:00，不是 0:60
  if (sec == null) return '-'
  const total = Math.round(sec)
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}
export function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
