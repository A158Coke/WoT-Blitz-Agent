// Tankopedia 模糊搜索打分：自旧版 index.html 平移，语义保持一致。

// 归一化：小写 + 去除空格/连字符/点等符号（e100↔E 100、t34↔T-34、obj261↔Object 261）。
// 保留 Unicode 字母/数字（\p{L}\p{N}）：中文车名归一化后原样保留，可被子串/子序列命中。
const normTank = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

// 单 token 对名称打分：① 归一化子串（越靠前越高，前缀再加分）② 子序列（匹配越紧凑越高）。0 = 不匹配。
function tankTokenScore(name, tok) {
  const nn = normTank(name), nq = normTank(tok)
  if (!nq) return 0
  const idx = nn.indexOf(nq)
  if (idx >= 0) return 200 - Math.min(idx, 50) + (idx === 0 ? 50 : 0)
  let first = -1, last = -1, pi = 0
  for (let i = 0; i < nn.length && pi < nq.length; i++) {
    if (nn[i] === nq[pi]) { if (first < 0) first = i; last = i; pi++ }
  }
  if (pi >= nq.length) return Math.max(40, 100 - (last - first + 1 - nq.length))
  return 0
}

// 多 token AND（空格分隔，如 "t28 def"），总分为排序依据
export function tankFuzzyScore(name, q) {
  const toks = q.split(/\s+/).filter(Boolean)
  if (!toks.length) return 1
  let total = 0
  for (const t of toks) {
    const s = tankTokenScore(name, t)
    if (!s) return 0
    total += s
  }
  return total
}
