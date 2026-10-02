import { getCurrentInstance, onBeforeUnmount, onMounted } from 'vue'

/**
 * 回放播放传输行为（与 wotbtools 的 composables/usePlaybackTransport.js 同构）。
 *
 * 不持有播放状态：时间与播放中标志的唯一 owner 仍是场景内核（scene/playbackScene.js），
 * 这里只通过 adapter 读写，统一三件事：
 * - 速度档位 / 默认速度 / 跳秒步长（单一常量来源，面板不再各自硬编码）；
 * - 拖动进度条：按下即暂停，松手时**若原先在播放**才自动继续；
 * - 键盘：空格 播放/暂停、←/→ ±5s；输入框 / 按钮聚焦时与播放器不可见时不响应。
 *
 * 档位与默认速度沿用本应用既有取值（比 wotbtools 多一档 16×、默认 2×）。
 */
export const PLAYBACK_SPEEDS = Object.freeze([0.5, 1, 2, 4, 8, 16])
export const DEFAULT_PLAYBACK_SPEED = 2
export const PLAYBACK_STEP_SECONDS = 5

export function isPlaybackSpeed(value) {
  return PLAYBACK_SPEEDS.includes(value)
}

/**
 * 键盘事件落在可输入 / 可操作控件上时不劫持。
 * 缺了这道闸，全场回放页的「.wotbreplay 文件路径」输入框里打空格会被吞掉，
 * 还会顺手把回放切了播放/暂停。
 */
export function isInteractiveTarget(target) {
  if (!target) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)
}

/**
 * @param {object} adapter
 * @param {() => boolean} adapter.isPlaying
 * @param {() => void} adapter.play
 * @param {() => void} adapter.pause
 * @param {(deltaSeconds: number) => void} adapter.step
 * @param {() => boolean} [adapter.isActive]  播放器当前是否可见 / 可交互（缺省视为可交互）
 * @param {() => boolean} [adapter.isReady]   时间轴是否已就绪（缺省视为就绪）
 * @param {object} [options]
 * @param {boolean} [options.keyboard=true]   是否在组件生命周期内挂全局键盘监听
 */
export function usePlaybackTransport(adapter, { keyboard = true } = {}) {
  let resumeAfterScrub = false
  let scrubbing = false

  function togglePlay() {
    if (adapter.isPlaying()) adapter.pause()
    else adapter.play()
  }

  function scrubStart() {
    if (scrubbing) return
    scrubbing = true
    resumeAfterScrub = adapter.isPlaying()
    if (resumeAfterScrub) adapter.pause()
  }

  function scrubEnd() {
    if (!scrubbing) return
    scrubbing = false
    if (resumeAfterScrub) adapter.play()
    resumeAfterScrub = false
  }

  function handleKeydown(event) {
    if (adapter.isActive && !adapter.isActive()) return
    if (adapter.isReady && !adapter.isReady()) return
    if (isInteractiveTarget(event.target)) return
    if (event.code === 'Space' || event.key === ' ') {
      event.preventDefault()
      togglePlay()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      adapter.step(event.key === 'ArrowLeft' ? -PLAYBACK_STEP_SECONDS : PLAYBACK_STEP_SECONDS)
    }
  }

  if (keyboard && getCurrentInstance() && typeof window !== 'undefined') {
    onMounted(() => window.addEventListener('keydown', handleKeydown))
    onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown))
  }

  return { togglePlay, scrubStart, scrubEnd, handleKeydown, isScrubbing: () => scrubbing }
}
