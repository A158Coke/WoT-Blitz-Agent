// 通用格式化工具：自旧版 index.html 平移。

// 胜率配色分级：<45% 红 / 45-55% 黄 / >55% 绿
export function wrCls(wr) { return wr == null ? '' : (wr >= 55 ? 'g' : wr >= 45 ? 'y' : 'r') }
export const wrText = (wr) => (wr == null ? '-' : wr.toFixed(1) + '%')
export function fmtInt(v) { return v == null ? '-' : Math.round(v).toLocaleString('en-US') }
export function fmtDur(sec) {
  return sec != null ? Math.floor(sec / 60) + ':' + String(Math.round(sec % 60)).padStart(2, '0') : '-'
}
export function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
