import { describe, expect, it } from 'vitest'
import {
  PHASE_MAG_INTERVAL, PHASE_START, groupByVehicle, inferMagazineSize, reloadViewAt, usablePhases,
} from './reloadBar.js'

// 相位条目（facet `reloads` 的形状）：{ clock, eid, phase, duration_s, count }
const clip = (clock, eid, d) => ({ clock, eid, phase: PHASE_START, duration_s: d, count: null })
const mag = (clock, eid, d) => ({ clock, eid, phase: PHASE_MAG_INTERVAL, duration_s: d, count: null })
const ready = (clock, eid) => ({ clock, eid, phase: 0, duration_s: 12.4, count: 1 })

describe('reloadBar · 可用相位筛选', () => {
  it('只收 f2=3/7 且带正时长的条目；就绪（f4=1）与未闭环相位码不参与', () => {
    const list = [clip(1, 7, 12.4), ready(2, 7), { clock: 3, eid: 7, phase: 1, duration_s: null, count: 5 },
      { clock: 4, eid: 7, phase: 8, duration_s: null, count: null }, mag(5, 7, 2.5)]
    expect(usablePhases(list).map((e) => [e.clock, e.phase])).toEqual([[1, 3], [5, 7]])
  })

  it('分组按 eid；没有可用相位的车不出现', () => {
    const m = groupByVehicle([clip(1, 7, 12.4), mag(2, 9, 3), ready(3, 11)])
    expect([...m.keys()].sort()).toEqual([7, 9])
  })
})

describe('reloadBar · 弹夹容量推断', () => {
  it('单发车（无弹夹内间隔）→ 1', () => {
    expect(inferMagazineSize([clip(1, 7, 12.4), clip(30, 7, 12.4)])).toBe(1)
    expect(inferMagazineSize([])).toBe(1)
  })
  it('3 发弹夹：整夹装填之间 2 次弹夹内间隔 → N=3', () => {
    const ev = [clip(10, 7, 3.0), mag(1, 7, 3), mag(2, 7, 3), clip(40, 7, 3.0), mag(1, 7, 3), mag(2, 7, 3)]
    expect(inferMagazineSize(ev)).toBe(3)
  })
  it('取最长的一串（夹内间隔数不齐时按最大者）', () => {
    const ev = [clip(10, 7, 3.0), mag(1, 7, 3), clip(20, 7, 3.0), mag(1, 7, 3), mag(2, 7, 3), mag(3, 7, 3)]
    expect(inferMagazineSize(ev)).toBe(4)
  })
})

describe('reloadBar · 时刻求值（二分）', () => {
  const events = [clip(10, 7, 4), clip(30, 7, 4)]

  it('整夹装填：条带 0→1（单发车同构）', () => {
    expect(reloadViewAt(events, 10, 1)).toMatchObject({ active: true, kind: 'clip', fill: 0 })
    expect(reloadViewAt(events, 12, 1).fill).toBeCloseTo(0.5, 6)
    expect(reloadViewAt(events, 14, 1)).toMatchObject({ active: false, fill: 1 })
  })

  it('相位结束后（下一个起点之前）条带为满，不残留进度', () => {
    expect(reloadViewAt(events, 20, 1).fill).toBe(1)
    expect(reloadViewAt(events, 30, 1).fill).toBe(0)
  })

  it('第一条相位之前（或空表）→ 满（视为已装填）', () => {
    expect(reloadViewAt(events, 5, 1)).toEqual({ active: false, fill: 1, kind: null })
    expect(reloadViewAt([], 5, 1)).toEqual({ active: false, fill: 1, kind: null })
  })

  it('弹夹内单发：3 发弹夹只补一发 → 从 2/3 填到 1', () => {
    const ev = [clip(10, 7, 3), mag(20, 7, 3)]
    expect(reloadViewAt(ev, 20, 3).fill).toBeCloseTo(2 / 3, 6)
    expect(reloadViewAt(ev, 21.5, 3).fill).toBeCloseTo((2 + 0.5) / 3, 6)
    expect(reloadViewAt(ev, 23, 3)).toMatchObject({ active: false, fill: 1 })
  })

  it('求值与调用顺序无关（seek 乱序求值结果一致）', () => {
    const a = reloadViewAt(events, 12, 1).fill
    reloadViewAt(events, 35, 1)
    expect(reloadViewAt(events, 12, 1).fill).toBe(a)
  })
})
