import { describe, expect, it } from 'vitest'
import { advancePlaybackTime, clampPlaybackTime, formatPlaybackClock } from './playbackClock.js'

describe('clampPlaybackTime', () => {
  it('钳制到 [0, duration]', () => {
    expect(clampPlaybackTime(-5, 100)).toBe(0)
    expect(clampPlaybackTime(150, 100)).toBe(100)
    expect(clampPlaybackTime(42, 100)).toBe(42)
  })

  it('sec 非有限值一律归 0，不产生 NaN', () => {
    expect(clampPlaybackTime(NaN, 100)).toBe(0)
    // ±Infinity 同样按"非有限值 → 0"处理（宁可冻结在起点，也不让 NaN / Infinity 传播进时钟）
    expect(clampPlaybackTime(Infinity, 100)).toBe(0)
    expect(clampPlaybackTime(-Infinity, 100)).toBe(0)
  })

  it('duration 非有限值时上界退化为 0', () => {
    expect(clampPlaybackTime(10, NaN)).toBe(0)
  })
})

describe('advancePlaybackTime', () => {
  it('按墙钟毫秒 × 倍速推进', () => {
    expect(advancePlaybackTime(10, 100, 1000, 1)).toBe(11)
    expect(advancePlaybackTime(10, 100, 1000, 2)).toBe(12)
    expect(advancePlaybackTime(10, 100, 500, 2)).toBe(11)
  })

  it('推进到终点即钳住；负增量 / 脏参数当 0', () => {
    expect(advancePlaybackTime(99.5, 100, 5000, 4)).toBe(100)
    expect(advancePlaybackTime(50, 100, -1000, 1)).toBe(50)
    expect(advancePlaybackTime(50, 100, NaN, 1)).toBe(50)
    expect(advancePlaybackTime(50, 100, 1000, NaN)).toBe(50)
  })
})

describe('formatPlaybackClock', () => {
  it('秒 → MM:SS', () => {
    expect(formatPlaybackClock(0)).toBe('00:00')
    expect(formatPlaybackClock(9)).toBe('00:09')
    expect(formatPlaybackClock(75)).toBe('01:15')
    expect(formatPlaybackClock(600)).toBe('10:00')
  })

  it('先取整再分解：59.6s 是 01:00，不是 00:60', () => {
    expect(formatPlaybackClock(59.6)).toBe('01:00')
    expect(formatPlaybackClock(59.4)).toBe('00:59')
    expect(formatPlaybackClock(119.7)).toBe('02:00')
  })

  it('非法输入退回 00:00', () => {
    expect(formatPlaybackClock(-1)).toBe('00:00')
    expect(formatPlaybackClock(NaN)).toBe('00:00')
    expect(formatPlaybackClock(Infinity)).toBe('00:00')
  })
})
