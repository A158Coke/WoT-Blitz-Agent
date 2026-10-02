import { describe, expect, it } from 'vitest'
import { impactKind } from './impactKind.js'

describe('impactKind · 作者路径（hit_flags 权威）', () => {
  it('0x0008 跳弹', () => {
    expect(impactKind({ target_eid: 5, hit_flags: 0x0008, is_author: true })).toBe('ricochet')
  })

  it('击穿族任一位置位即击穿', () => {
    for (const bit of [0x0010, 0x0040, 0x0100, 0x1000]) {
      expect(impactKind({ target_eid: 5, hit_flags: bit, is_author: true })).toBe('pen')
    }
  })

  it('有 target 但没有任何相关位 → 未击穿', () => {
    expect(impactKind({ target_eid: 5, hit_flags: 0x0001, is_author: true })).toBe('nonpen')
  })
})

describe('impactKind · 非作者路径（game_hit_result 降级）', () => {
  it('3 = 有伤害 → 击穿', () => {
    expect(impactKind({ target_eid: 5, game_hit_result: 3 })).toBe('pen')
  })

  it('该枚举里没有跳弹取值：1 / 2 / 4 一律未击穿，绝不伪造跳弹', () => {
    for (const r of [1, 2, 4]) {
      expect(impactKind({ target_eid: 5, game_hit_result: r })).toBe('nonpen')
    }
  })

  it('0 / 255 / 未知取值 → 不生成 target impact', () => {
    expect(impactKind({ target_eid: 5, game_hit_result: 0 })).toBe(null)
    expect(impactKind({ target_eid: 5, game_hit_result: 255 })).toBe(null)
    expect(impactKind({ target_eid: 5 })).toBe(null)
  })
})

describe('impactKind · 脱靶', () => {
  it('无 target_eid 一律 null（不生成 target impact）', () => {
    expect(impactKind({ target_eid: null, hit_flags: 0x0010, is_author: true })).toBe(null)
    expect(impactKind({ hit_flags: 0x0010, is_author: true })).toBe(null)
  })

  it('作者标记但 hit_flags 为 0 → 不走作者路径，降级到 result', () => {
    expect(impactKind({ target_eid: 5, hit_flags: 0, is_author: true, game_hit_result: 3 })).toBe('pen')
  })
})
