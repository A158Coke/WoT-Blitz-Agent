/**
 * 回放时间轴终点：**比赛结束**（进入战后阶段）的时刻，而不是录像流的结束。
 *
 * 录像在比赛打完之后通常还会继续录一段结算过程，若用 `meta.duration` 当终点：
 * 比赛打完进度条才走到一半、胜负横幅也要等结算画面放完才出现。
 *
 * 数据侧 `periods` 里 `period >= 4` 即战后阶段（`playbackScene.js` 的 `gameTimerLabel`
 * 用 `period < 3` 判预热点，同源判据）。取第一条 clock 晚于录像起点的战后条目。
 *
 * @param {{ meta: { t_start: number, duration: number }, periods?: Array<{ clock: number, period: number }> }} data
 * @returns {number} 时间轴终点（绝对秒，落在 (t_start, meta.duration] 内）
 */
const AFTER_BATTLE_PERIOD = 4

export function battleEndTime(data) {
  const start = Number(data?.meta?.t_start) || 0
  const streamEnd = Number(data?.meta?.duration) || 0
  const periods = Array.isArray(data?.periods) ? data.periods : []
  const afterBattle = periods.find((p) => p && p.period >= AFTER_BATTLE_PERIOD && Number(p.clock) > start)
  if (!afterBattle) return streamEnd
  return Math.min(Number(afterBattle.clock), streamEnd)
}
