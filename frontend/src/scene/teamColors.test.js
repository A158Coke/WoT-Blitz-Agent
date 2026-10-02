import { describe, expect, it } from 'vitest'
import { TEAM_COLORS, TEAM_COLORS_DEEP, TEAM_COLORS_PANEL, hexToInt } from './teamColors.js'

describe('teamColors · 单一事实源', () => {
  it('亮色口径：绿 / 红 / 白 + 目标色', () => {
    expect(TEAM_COLORS.ally).toBe('#2ecc71')
    expect(TEAM_COLORS.enemy).toBe('#ef4444')
    expect(TEAM_COLORS.neutral).toBe('#f5f5f5')
    expect(TEAM_COLORS.objective).toBe('#ffc24b')
  })

  it('深色口径与面板口径是各自独立的一组，不与亮色口径重合', () => {
    expect(TEAM_COLORS_DEEP.ally).toBe('#26794a')
    expect(TEAM_COLORS_DEEP.enemy).toBe('#98322a')
    expect(TEAM_COLORS_PANEL.ally).toBe('#3fa66a')
    expect(TEAM_COLORS_PANEL.enemy).toBe('#c05046')
    const bright = new Set([TEAM_COLORS.ally, TEAM_COLORS.enemy])
    for (const v of [...Object.values(TEAM_COLORS_DEEP), ...Object.values(TEAM_COLORS_PANEL)]) {
      expect(bright.has(v)).toBe(false)
    }
  })

  it('hexToInt 是唯一的字符串→数值转换点', () => {
    expect(hexToInt('#2ecc71')).toBe(0x2ecc71)
    expect(hexToInt('#ffffff')).toBe(0xffffff)
    expect(hexToInt(TEAM_COLORS.neutral)).toBe(0xf5f5f5)
  })
})
