// 回放时钟的纯函数：推进 / 钳制 / 格式化。
// 与 wotbtools 同源语义（对方在 utils/playbackClock.ts），2D 面板与 3D 场景共用一套。

export function clampPlaybackTime(sec, duration) {
  const max = Number.isFinite(duration) ? Math.max(0, duration) : 0
  const value = Number.isFinite(sec) ? sec : 0
  return Math.min(max, Math.max(0, value))
}

/** 按帧推进：`deltaMs` 墙钟毫秒 × `speed` 倍速。NaN/负值一律当 0，避免时钟被污染后不可逆。 */
export function advancePlaybackTime(current, duration, deltaMs, speed) {
  const delta = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0
  const rate = Number.isFinite(speed) ? Math.max(0, speed) : 0
  return clampPlaybackTime(current + (delta / 1000) * rate, duration)
}

/** 秒 → MM:SS。先对总秒数统一取整再分解，避免 59.6s 显示成 00:60。 */
export function formatPlaybackClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00'
  const total = Math.round(sec)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
