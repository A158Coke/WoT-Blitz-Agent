import { describe, expect, it } from 'vitest'
import { esc, fmtDur, fmtInt, wrCls, wrText } from './format.js'

describe('fmtDur', () => {
  it('分:秒', () => {
    expect(fmtDur(0)).toBe('0:00')
    expect(fmtDur(59)).toBe('0:59')
    expect(fmtDur(60)).toBe('1:00')
    expect(fmtDur(605)).toBe('10:05')
  })

  it('先取整再分解：59.6 秒是 1:00，不是 0:60', () => {
    expect(fmtDur(59.6)).toBe('1:00')
    expect(fmtDur(59.4)).toBe('0:59')
    expect(fmtDur(119.7)).toBe('2:00')
  })

  it('缺值显示 -', () => {
    expect(fmtDur(null)).toBe('-')
    expect(fmtDur(undefined)).toBe('-')
  })
})

describe('其余格式化', () => {
  it('wrCls 分级 / wrText', () => {
    expect(wrCls(null)).toBe('')
    expect(wrCls(60)).toBe('g')
    expect(wrCls(50)).toBe('y')
    expect(wrCls(40)).toBe('r')
    expect(wrText(52.34)).toBe('52.3%')
    expect(wrText(null)).toBe('-')
  })

  it('fmtInt 千位分隔', () => {
    expect(fmtInt(1234567)).toBe('1,234,567')
    expect(fmtInt(null)).toBe('-')
  })

  it('esc 转义四个 HTML 元字符', () => {
    expect(esc('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
    expect(esc(null)).toBe('')
  })
})
