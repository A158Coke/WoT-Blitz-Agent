/**
 * 实时装填条求值（纯函数；3D 标签的装填条用）。
 *
 * 数据来源：回放 facet `reloads`（arena updateArena subtype 15/17 相位条目，**仅本方全队**——
 * 协议广播范围如此，敌方无该流）。相位语义只取**已交叉验证**的子集
 * （见 core `crates/replay-core/src/replay/combat/arena.rs` 段注释与探针
 * `src/bin/probe_arena_reload.rs`）：
 *   - f2=3 装填开始（`duration_s` = 本次相位时长，**不是倒计时**）
 *   - f2=7 弹夹/弹鼓内单发装填间隔（`duration_s` = 该发时长）
 *   - f4=1 就绪（本条只作为「相位已结束」的证据；进度由 `起点 + 时长` 求值）
 * 其余相位码与计数**未闭环** → 本模块一律忽略，不参与求值。
 *
 * 展示口径（与需求一致）：条带 = 当前装填进度；**单发车整条 = 一发**；弹夹/弹鼓车
 * 1/N 条 = 一发：
 *   - 整夹装填（f2=3）：整个弹夹在重装 → 条带 0→1（与单发车同构）；
 *   - 弹夹内单发（f2=7）：只补一发 → 条带从 (N−1)/N 填到 1（前面 N−1 段已满）；
 *   - 非装填中 → 条带满（1）。
 * N 由**数据**推导（相邻两次整夹装填之间的连续弹夹内间隔数 + 1），不依赖静态车辆数据，
 * 也不使用未闭环的 f4 计数。
 *
 * 求值一律按**时间二分**（不累加计时器）→ seek / 拖动进度条天然正确。
 */

/** f2 = 装填开始（整夹） */
export const PHASE_START = 3;
/** f2 = 弹夹/弹鼓内单发装填间隔 */
export const PHASE_MAG_INTERVAL = 7;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** 相位条目是否可用于求值：f2 ∈ {3,7} 且带正的时长（未闭环者与就绪条目不参与） */
export function isUsablePhase(e) {
  if (!e || (e.phase !== PHASE_START && e.phase !== PHASE_MAG_INTERVAL)) return false;
  const d = Number(e.duration_s);
  return Number.isFinite(d) && d > 0;
}

/** 取可用相位（保持原顺序；facet 已按 clock 升序） */
export function usablePhases(reloads) {
  return (reloads || []).filter(isUsablePhase);
}

/** 按 eid 分组：Map<eid, 可用相位[]>（无可用相位的车不出现在 Map 里） */
export function groupByVehicle(reloads) {
  const m = new Map();
  for (const e of usablePhases(reloads)) {
    let a = m.get(e.eid);
    if (!a) { a = []; m.set(e.eid, a); }
    a.push(e);
  }
  return m;
}

/**
 * 推导弹夹容量 N（单发车 = 1）：相邻两次整夹装填之间**最多的连续弹夹内间隔数** + 1。
 *
 * 没有整夹装填（f2=3）相位时一律返回 1——**不能用弹夹内间隔的连串长度去猜**：
 * 单发车（如 J39 样本 eid=1467934）只发 f2=7 且一发一串，连串长度 ≈ 开火次数（实测 17），
 * 猜出来的 N 会让条带常年停在 94%+。研究也把这类「零起点」车列为未闭环项。
 * 代价：真正有弹夹但本场没打出整夹的车（如 Emil II）也按单发显示（0→1 逐发），
 * 属于「数据不足以分段」的保守显示，不猜。
 */
export function inferMagazineSize(events) {
  const list = events || [];
  if (!list.some((e) => e.phase === PHASE_START)) return 1;
  let run = 0, maxRun = 0;
  for (const e of list) {
    if (e.phase === PHASE_MAG_INTERVAL) {
      run += 1;
      if (run > maxRun) maxRun = run;
    } else if (e.phase === PHASE_START) {
      run = 0;   // 整夹装填把「本夹内的间隔串」清零
    }
  }
  return maxRun + 1;
}

/** 最后一个 clock ≤ t 的下标（二分；无 → -1） */
export function lastIndexAtOrBefore(events, t) {
  let lo = 0, hi = events.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].clock <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

/**
 * t 时刻的装填视图：{ active, fill, kind }
 * - fill：条带应填充的比例 0..1（口径见文件头）
 * - kind：'clip' 整夹装填 | 'mag' 弹夹内单发 | null 非装填中
 */
export function reloadViewAt(events, t, size = 1) {
  if (!events || !events.length) return { active: false, fill: 1, kind: null };
  const i = lastIndexAtOrBefore(events, t);
  if (i < 0) return { active: false, fill: 1, kind: null };
  const e = events[i];
  const d = Number(e.duration_s);
  if (!Number.isFinite(d) || d <= 0 || t >= e.clock + d) return { active: false, fill: 1, kind: null };
  const p = clamp01((t - e.clock) / d);
  if (e.phase === PHASE_MAG_INTERVAL) {
    const n = Math.max(1, Math.round(size) || 1);
    return { active: true, fill: clamp01(((n - 1) + p) / n), kind: 'mag' };
  }
  return { active: true, fill: p, kind: 'clip' };
}
