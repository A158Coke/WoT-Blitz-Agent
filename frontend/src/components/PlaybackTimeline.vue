<script setup>
// 回放进度条：拖动期间显示“用户手里的值”，不跟场景每帧写回的当前时间打架。
//
// 旧写法是**非受控** input（无 :value 绑定）+ 场景直接写 DOM + `store.seeking` 标志
// 抑制回写——能用，但把“谁在拖”这件事变成了跨层隐式协议。这里改用
// `dragValue ?? currentTime`：拖动时展示权在用户，松手后交回场景，声明式且无副作用。
// （与 wotbtools 的 PlaybackTimeline.vue 同构。）
import { computed, onBeforeUnmount, ref } from 'vue'

defineOptions({ name: 'PlaybackTimeline' })

const props = defineProps({
  currentTime: { type: Number, default: 0 },
  /** 时间轴起点（绝对秒；回放从 meta.t_start 开始） */
  startTime: { type: Number, default: 0 },
  duration: { type: Number, default: 0 },
  /** 时间轴不可用（无数据）时进度条必须显式禁用，否则拖动是静默空操作 */
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['drag-start', 'drag-end', 'seek'])

const dragValue = ref(null)
const shownValue = computed(() => dragValue.value ?? props.currentTime)
const max = computed(() => (props.duration > props.startTime ? props.duration : props.startTime + 1))

function onPointerDown() {
  dragValue.value = props.currentTime
  emit('drag-start')
  // 松手可能发生在滑块之外（拖出去再放开），所以在 window 上等这一次 pointerup / pointercancel
  window.addEventListener('pointerup', endDrag, { once: true })
  window.addEventListener('pointercancel', endDrag, { once: true })
}

function onInput(event) {
  const value = Number(event.target.value)
  if (dragValue.value !== null) dragValue.value = value
  emit('seek', value)
}

function endDrag() {
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', endDrag)
  if (dragValue.value === null) return
  dragValue.value = null
  emit('drag-end')
}

onBeforeUnmount(endDrag)
</script>

<template>
  <input
    id="seek"
    class="pb-range"
    type="range"
    :min="props.startTime"
    :max="max"
    step="0.1"
    :value="shownValue"
    :disabled="props.disabled"
    aria-label="回放进度"
    @pointerdown="onPointerDown"
    @blur="endDrag"
    @input="onInput"
  >
</template>

<style scoped>
.pb-range { display: block; flex: 1; min-width: 0; margin: 0; padding: 0; border: none;
            background: transparent; border-radius: 0; accent-color: var(--accent); }
/* UA 给 input[type=range] 带 2px 外边距，与 flex:1 相加会造成行内横向溢出，必须归零 */
.pb-range:disabled { opacity: .45; cursor: not-allowed; }
</style>
