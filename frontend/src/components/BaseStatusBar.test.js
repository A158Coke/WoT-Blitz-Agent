// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import BaseStatusBar from './BaseStatusBar.vue'

const supremacy = [
  { baseId: 'A', kind: 'supremacy', owner: 'friendly', capturing: null, progress: null },
  { baseId: 'B', kind: 'supremacy', owner: 'enemy', capturing: 'friendly', progress: 45 },
  { baseId: 'C', kind: 'supremacy', owner: 'neutral', capturing: null, progress: null },
]

describe('BaseStatusBar', () => {
  it('无基地时不渲染', () => {
    const w = mount(BaseStatusBar, { props: { bases: [] } })
    expect(w.find('[data-testid="base-status-bar"]').exists()).toBe(false)
  })

  it('争霸：每基地一枚徽章，占领中才画进度环，两端显示积分', () => {
    const w = mount(BaseStatusBar, {
      props: { bases: supremacy, friendlyPoints: 320, enemyPoints: 180 },
    })
    expect(w.findAll('.base-badge')).toHaveLength(3)
    for (const id of ['A', 'B', 'C']) {
      expect(w.find(`[data-testid="base-badge-${id}"]`).exists()).toBe(true)
    }
    // 只有 B 在占领中 → 只有它带进度环；徽章同时带归属 / 占领方的语义 class
    expect(w.findAll('[data-testid="base-badge-ring"]')).toHaveLength(1)
    expect(w.find('[data-testid="base-badge-B"]').classes()).toContain('is-capturing-friendly')
    expect(w.find('[data-testid="base-badge-B"]').classes()).toContain('is-owner-enemy')
    expect(w.find('[data-testid="base-badge-A"]').classes()).toContain('is-owner-friendly')
    expect(w.find('[data-testid="base-badge-C"]').classes()).toContain('is-owner-neutral')
    expect(w.get('[data-testid="base-points-friendly"]').text()).toBe('320')
    expect(w.get('[data-testid="base-points-enemy"]').text()).toBe('180')
  })

  it('无点数广播（非争霸）时不显示积分', () => {
    const w = mount(BaseStatusBar, { props: { bases: supremacy, friendlyPoints: null, enemyPoints: null } })
    expect(w.find('[data-testid="base-points-friendly"]').exists()).toBe(false)
    expect(w.find('[data-testid="base-points-enemy"]').exists()).toBe(false)
  })

  it('单基地：徽章恒为中性 + 旗帜 + 百分比；无进度广播时不给 0', () => {
    const withProgress = mount(BaseStatusBar, {
      props: { bases: [{ baseId: 'BASE', kind: 'assault', owner: 'neutral', capturing: null, progress: 72 }] },
    })
    expect(withProgress.find('.base-badge-flag').exists()).toBe(true)
    expect(withProgress.get('.base-objective-progress').text()).toBe('72%')
    expect(withProgress.find('[data-testid="base-badge-ring"]').exists()).toBe(true)
    expect(withProgress.get('.base-badge').attributes('title')).toBe('基地：占领进度 72%')

    // 目标在但当前无占领进度：不画进度环、不出百分比、文案区分于 0%
    const idle = mount(BaseStatusBar, {
      props: { bases: [{ baseId: 'BASE', kind: 'assault', owner: 'neutral', capturing: null, progress: null }] },
    })
    expect(idle.find('.base-objective-progress').exists()).toBe(false)
    expect(idle.find('[data-testid="base-badge-ring"]').exists()).toBe(false)
    expect(idle.get('.base-badge').attributes('title')).toBe('基地：无占领')
  })

  it('徽章说明文案随归属 / 占领方变化', () => {
    const w = mount(BaseStatusBar, { props: { bases: supremacy } })
    expect(w.find('[data-testid="base-badge-A"]').attributes('title')).toBe('A：己方')
    expect(w.find('[data-testid="base-badge-B"]').attributes('title')).toBe('B：敌方，己方占领 45%')
    expect(w.find('[data-testid="base-badge-C"]').attributes('title')).toBe('C：中立')
  })
})
