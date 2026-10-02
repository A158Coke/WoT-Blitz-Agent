import { describe, expect, it } from 'vitest'
import { firstIndexAfter } from './seekPointer.js'

const events = [{ t: 0 }, { t: 5 }, { t: 5 }, { t: 9 }]

describe('firstIndexAfter', () => {
  it('返回第一条时刻严格大于 t 的下标（seek 语义：不重放历史 transient）', () => {
    expect(firstIndexAfter(events, -1)).toBe(0)
    expect(firstIndexAfter(events, 0)).toBe(1)
    expect(firstIndexAfter(events, 4)).toBe(1)
    // t 恰好等于某个事件时刻：该事件本身已发生过，跳过（严格大于）
    expect(firstIndexAfter(events, 5)).toBe(3)
    expect(firstIndexAfter(events, 9)).toBe(4)
  })

  it('全部 <= t 时返回长度；空数组返回 0', () => {
    expect(firstIndexAfter(events, 100)).toBe(4)
    expect(firstIndexAfter([], 0)).toBe(0)
  })

  it('支持自定义取时刻函数（不同事件源字段名不同）', () => {
    const shots = [{ t_fire: 1 }, { t_fire: 7 }]
    expect(firstIndexAfter(shots, 1, (x) => x.t_fire)).toBe(1)
    expect(firstIndexAfter(shots, 0, (x) => x.t_fire)).toBe(0)
  })
})
