// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import {
  DEFAULT_PLAYBACK_SPEED, PLAYBACK_SPEEDS, PLAYBACK_STEP_SECONDS,
  isInteractiveTarget, isPlaybackSpeed, usePlaybackTransport,
} from './usePlaybackTransport.js'

function makeAdapter(initiallyPlaying = false) {
  const state = { playing: initiallyPlaying, steps: [] }
  const adapter = {
    isPlaying: () => state.playing,
    play: vi.fn(() => { state.playing = true }),
    pause: vi.fn(() => { state.playing = false }),
    step: vi.fn((d) => { state.steps.push(d) }),
  }
  return { state, adapter }
}

/** 构造一个 keydown 事件，并把 target 指向给定元素（jsdom/happy-dom 下不能只靠 dispatch） */
function key(init, target = document.body) {
  const event = new KeyboardEvent('keydown', { ...init, cancelable: true })
  Object.defineProperty(event, 'target', { value: target })
  return event
}

const el = (tag) => document.createElement(tag)

describe('usePlaybackTransport · 常量', () => {
  it('档位与默认速度是单一来源', () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([0.5, 1, 2, 4, 8, 16])
    expect(DEFAULT_PLAYBACK_SPEED).toBe(2)
    expect(PLAYBACK_STEP_SECONDS).toBe(5)
  })

  it('isPlaybackSpeed 只认档位表内的值', () => {
    expect(isPlaybackSpeed(1)).toBe(true)
    expect(isPlaybackSpeed(16)).toBe(true)
    expect(isPlaybackSpeed(3)).toBe(false)
    expect(isPlaybackSpeed('2')).toBe(false)
  })
})

describe('usePlaybackTransport · isInteractiveTarget', () => {
  it('输入类控件与 contenteditable 都算可交互', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']) {
      expect(isInteractiveTarget(el(tag))).toBe(true)
    }
    const div = el('div')
    Object.defineProperty(div, 'isContentEditable', { value: true })
    expect(isInteractiveTarget(div)).toBe(true)
  })

  it('普通元素与空目标不算', () => {
    expect(isInteractiveTarget(el('div'))).toBe(false)
    expect(isInteractiveTarget(null)).toBe(false)
  })
})

describe('usePlaybackTransport · 拖动语义', () => {
  it('原先在播放：按下暂停，松手继续', () => {
    const { state, adapter } = makeAdapter(true)
    const t = usePlaybackTransport(adapter, { keyboard: false })
    t.scrubStart()
    expect(state.playing).toBe(false)
    t.scrubEnd()
    expect(state.playing).toBe(true)
  })

  it('原先暂停：松手仍暂停（不凭空开始播放）', () => {
    const { state, adapter } = makeAdapter(false)
    const t = usePlaybackTransport(adapter, { keyboard: false })
    t.scrubStart()
    t.scrubEnd()
    expect(state.playing).toBe(false)
  })

  it('重复 scrubStart 不叠加 resume 状态', () => {
    const { state, adapter } = makeAdapter(true)
    const t = usePlaybackTransport(adapter, { keyboard: false })
    t.scrubStart()
    t.scrubStart()
    expect(adapter.pause).toHaveBeenCalledTimes(1)
    t.scrubEnd()
    expect(state.playing).toBe(true)
    // 已结束，再次 scrubEnd 不应重复 play
    t.scrubEnd()
    expect(adapter.play).toHaveBeenCalledTimes(1)
  })
})

describe('usePlaybackTransport · 键盘', () => {
  it('空格切换播放，←/→ 按步长跳秒', () => {
    const { adapter } = makeAdapter(false)
    const t = usePlaybackTransport(adapter, { keyboard: false })
    t.handleKeydown(key({ code: 'Space', key: ' ' }))
    expect(adapter.play).toHaveBeenCalledTimes(1)
    t.handleKeydown(key({ key: 'ArrowRight' }))
    t.handleKeydown(key({ key: 'ArrowLeft' }))
    expect(adapter.step).toHaveBeenNthCalledWith(1, PLAYBACK_STEP_SECONDS)
    expect(adapter.step).toHaveBeenNthCalledWith(2, -PLAYBACK_STEP_SECONDS)
  })

  it('落在输入框 / 按钮上的空格不劫持也不 preventDefault', () => {
    const { adapter } = makeAdapter(false)
    const t = usePlaybackTransport(adapter, { keyboard: false })
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']) {
      const e = key({ code: 'Space', key: ' ' }, el(tag))
      t.handleKeydown(e)
      expect(adapter.play).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(false)
    }
  })

  it('播放器不可见 / 时间轴未就绪时不响应', () => {
    const { adapter } = makeAdapter(false)
    const hidden = usePlaybackTransport({ ...adapter, isActive: () => false }, { keyboard: false })
    hidden.handleKeydown(key({ code: 'Space', key: ' ' }))
    const notReady = usePlaybackTransport({ ...adapter, isReady: () => false }, { keyboard: false })
    notReady.handleKeydown(key({ code: 'Space', key: ' ' }))
    expect(adapter.play).not.toHaveBeenCalled()
  })
})

// 回归：这正是一次真实故障——回放页的「.wotbreplay 文件路径」输入框里打空格
// 会被全局监听吞掉，还顺手切了播放/暂停。此测试锁住"输入框里的空格归输入框"。
describe('usePlaybackTransport · 组件内注册（回归）', () => {
  it('输入框聚焦时打空格：不切播放，且空格真的落到输入框', async () => {
    const { adapter } = makeAdapter(false)
    const wrapper = mount({
      template: '<div><input id="path" type="text" /><button id="play">play</button></div>',
      setup() {
        return usePlaybackTransport(adapter, { keyboard: true })
      },
    })
    const input = wrapper.find('#path').element
    input.focus()

    const e = key({ code: 'Space', key: ' ' }, input)
    window.dispatchEvent(e)

    expect(adapter.play).not.toHaveBeenCalled()
    expect(adapter.pause).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)

    // 焦点在普通容器上时，空格仍然生效
    const bodyEvent = key({ code: 'Space', key: ' ' }, document.body)
    window.dispatchEvent(bodyEvent)
    expect(adapter.play).toHaveBeenCalledTimes(1)
  })

  it('组件卸载后监听被摘除', () => {
    const { adapter } = makeAdapter(false)
    const wrapper = mount({ template: '<div></div>', setup: () => usePlaybackTransport(adapter, { keyboard: true }) })
    wrapper.unmount()
    window.dispatchEvent(key({ code: 'Space', key: ' ' }, document.body))
    expect(adapter.play).not.toHaveBeenCalled()
  })
})
