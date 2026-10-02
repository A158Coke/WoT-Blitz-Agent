import { describe, expect, it } from 'vitest'
import { pointsAt } from './supremacyPoints.js'

const samples = [
  { clock: 0, team: 1, points: 0 }, { clock: 0, team: 2, points: 0 },
  { clock: 10, team: 1, points: 120 }, { clock: 10, team: 2, points: 80 },
  { clock: 20, team: 1, points: 300 }, { clock: 20, team: 2, points: 260 },
]

describe('pointsAt', () => {
  it('取 clock <= t 的最后一组采样', () => {
    expect(pointsAt(samples, 5, 1)).toEqual({ friend: 0, enemy: 0 })
    expect(pointsAt(samples, 10, 1)).toEqual({ friend: 120, enemy: 80 })
    expect(pointsAt(samples, 15, 1)).toEqual({ friend: 120, enemy: 80 })
    expect(pointsAt(samples, 999, 1)).toEqual({ friend: 300, enemy: 260 })
  })

  it('friendlyTeam = 2 时映射对调', () => {
    expect(pointsAt(samples, 20, 2)).toEqual({ friend: 260, enemy: 300 })
  })

  it('确定性：无采样 / 阵营未知都返回 null/null，而不是省略字段', () => {
    expect(pointsAt([], 10, 1)).toEqual({ friend: null, enemy: null })
    expect(pointsAt(undefined, 10, 1)).toEqual({ friend: null, enemy: null })
    // unknown ≠ enemy：阵营不是显式 1 / 2 时绝不建立 friend/enemy 映射
    expect(pointsAt(samples, 20, 0)).toEqual({ friend: null, enemy: null })
    expect(pointsAt(samples, 20, null)).toEqual({ friend: null, enemy: null })
  })

  it('既非 friend 也非 enemy 的队伍（team=0 未知）不参与统计', () => {
    const withUnknown = [...samples, { clock: 30, team: 0, points: 999 }]
    expect(pointsAt(withUnknown, 30, 1)).toEqual({ friend: 300, enemy: 260 })
  })
})
