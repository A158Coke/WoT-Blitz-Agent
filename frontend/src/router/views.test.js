import { describe, expect, it } from 'vitest'
import { ALLOWED_VIEWS, DEFAULT_VIEW, ROUTES, isAllowedView, locationForView, viewFromName } from './views.js'

describe('视图注册表', () => {
  it('每个路由都有唯一的视图名', () => {
    const names = ROUTES.map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
    expect(ALLOWED_VIEWS).toEqual(names)
  })

  it('默认视图在表内', () => {
    expect(isAllowedView(DEFAULT_VIEW)).toBe(true)
  })

  it('fail-closed：未注册的视图名回默认视图', () => {
    expect(viewFromName('armor-view')).toBe('armor-view')
    expect(viewFromName('playback')).toBe('playback')
    // 已退役 / 拼错的视图名（旧书签、旧深链）一律回默认视图
    expect(viewFromName('rating-v2-admin')).toBe(DEFAULT_VIEW)
    expect(viewFromName('')).toBe(DEFAULT_VIEW)
    expect(viewFromName(undefined)).toBe(DEFAULT_VIEW)
  })
})

describe('locationForView', () => {
  it('tab 视图直接用字面路径', () => {
    expect(locationForView('replay')).toBe('/replay')
    expect(locationForView('home')).toBe('/')
  })

  it('带路径参数的视图按模板拼路径', () => {
    expect(locationForView('armor-view', { tankId: 28689 })).toBe('/armor_view/view/28689')
    expect(locationForView('tank-detail', { tankId: 7 })).toBe('/tank/7')
  })

  it('只保留该视图白名单内的 query，且跳过空值', () => {
    expect(locationForView('playback', { file: 'a.wotbreplay', q: 'high' }))
      .toBe('/playback?file=a.wotbreplay&q=high')
    // q 不在 playback 的白名单里 → 丢掉；空串跳过
    expect(locationForView('armor-view', { tankId: 1, shot: 4, heatmap: 1, scfg: '' }))
      .toBe('/armor_view/view/1?shot=4&heatmap=1')
  })

  it('不对未声明参数的视图泄漏 query（跨视图跳转不带陈旧参数）', () => {
    expect(locationForView('replay', { file: 'x.wotbreplay', shot: 3 })).toBe('/replay')
  })

  it('file 需要转义（路径含空格 / & 时）', () => {
    expect(locationForView('playback', { file: 'my replay.wotbreplay' }))
      .toBe('/playback?file=my+replay.wotbreplay')
  })

  it('未注册视图名回落到默认视图的路径', () => {
    expect(locationForView('nope', { tankId: 1 })).toBe('/')
  })
})
