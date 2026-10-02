<script setup>
// 基地状态条（3D 回放顶栏下方）：每个基地一枚圆形徽章——底色 = 当前归属（友绿 / 敌红 / 中立白），
// 外圈进度环 = 占领进度（颜色跟占领方）；单基地（攻防 / 遭遇战）协议不给占领方，徽章放旗帜、
// 进度环用目标色，右侧显示百分比。两端可选显示争霸积分。
// 输入是 scene/baseStatus.js 的视图模型（baseView）——本组件不做任何协议推断。
// （与 WotbTools 的 BaseStatusBar.vue 同构；本应用为中文单语，不用 i18n。）
import { computed } from 'vue'

defineOptions({ name: 'BaseStatusBar' })

const props = defineProps({
  /** [{ baseId, kind: 'supremacy'|'assault', owner, capturing, progress }] */
  bases: { type: Array, default: () => [] },
  friendlyPoints: { type: Number, default: null },
  enemyPoints: { type: Number, default: null },
})

const RADIUS = 14
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const OWNER_LABEL = { friendly: '己方', enemy: '敌方', neutral: '中立' }
const CAPTURING_LABEL = { friendly: '己方', enemy: '敌方' }

function ringDash(progress) {
  const filled = (Math.max(0, Math.min(100, progress)) / 100) * CIRCUMFERENCE
  return `${filled} ${CIRCUMFERENCE}`
}

function showRing(base) {
  return base.progress != null && (base.kind === 'assault' || base.capturing != null)
}

function baseLabel(base) {
  if (base.kind === 'assault') {
    const state = base.progress == null
      ? '无占领'
      : `占领进度 ${Math.round(base.progress)}%`
    return `基地：${state}`
  }
  const owner = OWNER_LABEL[base.owner]
  if (!showRing(base)) return `${base.baseId}：${owner}`
  return `${base.baseId}：${owner}，${CAPTURING_LABEL[base.capturing]}占领 ${Math.round(base.progress)}%`
}

const hasPoints = computed(() => props.friendlyPoints != null || props.enemyPoints != null)
</script>

<template>
  <div
    v-if="props.bases.length"
    class="base-status-bar"
    role="group"
    aria-label="基地状态"
    data-testid="base-status-bar"
  >
    <span
      v-if="props.friendlyPoints != null"
      class="base-points base-points-friendly"
      data-testid="base-points-friendly"
      :aria-label="`己方积分 ${Math.round(props.friendlyPoints)}`"
    >{{ Math.round(props.friendlyPoints) }}</span>

    <span
      v-for="base in props.bases"
      :key="base.baseId"
      class="base-badge"
      :class="[`is-owner-${base.owner}`, base.capturing ? `is-capturing-${base.capturing}` : '', `is-${base.kind}`]"
      role="img"
      :aria-label="baseLabel(base)"
      :title="baseLabel(base)"
      :data-testid="`base-badge-${base.baseId}`"
    >
      <span class="base-badge-core">
        <svg class="base-badge-svg" viewBox="-17 -17 34 34" aria-hidden="true">
          <circle class="base-badge-track" :r="RADIUS" />
          <circle
            v-if="showRing(base)"
            class="base-badge-ring"
            :r="RADIUS"
            :stroke-dasharray="ringDash(base.progress)"
            transform="rotate(-90)"
            data-testid="base-badge-ring"
          />
          <circle class="base-badge-fill" r="11" />
          <text v-if="base.kind === 'supremacy'" class="base-badge-letter" y="0.5">{{ base.baseId }}</text>
        </svg>
        <!-- 旗帜（单基地没有字母）：内联 lucide Flag 路径，避免为一个图标引入图标库 -->
        <svg v-if="base.kind === 'assault'" class="base-badge-flag" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
          <line x1="4" y1="22" x2="4" y2="15" />
        </svg>
      </span>
      <span v-if="base.kind === 'assault' && base.progress != null" class="base-objective-progress">{{ Math.round(base.progress) }}%</span>
    </span>

    <span
      v-if="props.enemyPoints != null"
      class="base-points base-points-enemy"
      data-testid="base-points-enemy"
      :aria-label="`敌方积分 ${Math.round(props.enemyPoints)}`"
    >{{ Math.round(props.enemyPoints) }}</span>
  </div>
</template>

<style scoped>
.base-status-bar {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
  padding: 3px 14px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(16, 20, 26, .86);
  backdrop-filter: blur(6px);
  pointer-events: auto;
}

.base-points { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
.base-points-friendly { color: var(--color-team-ally); }
.base-points-enemy { color: var(--color-team-enemy); }

.base-badge { display: inline-flex; align-items: center; gap: 4px; }
.base-badge-core { display: grid; place-items: center; }
.base-badge-core > * { grid-area: 1 / 1; }
.base-badge-svg { display: block; width: 26px; height: 26px; overflow: visible; }

.base-badge-track { fill: none; stroke: var(--border); stroke-width: 3; }
.base-badge-ring { fill: none; stroke-width: 3; stroke-linecap: round; }
.is-capturing-friendly .base-badge-ring { stroke: var(--color-team-ally); }
.is-capturing-enemy .base-badge-ring { stroke: var(--color-team-enemy); }
.is-assault .base-badge-ring { stroke: var(--color-objective); }

.base-badge-fill { fill: var(--color-team-neutral); }
.is-owner-friendly .base-badge-fill { fill: var(--color-team-ally); }
.is-owner-enemy .base-badge-fill { fill: var(--color-team-enemy); }

.base-badge-letter {
  fill: var(--color-on-team-neutral);
  font-size: 15px;
  font-weight: 800;
  text-anchor: middle;
  dominant-baseline: central;
}

/* 旗帜图标叠在徽章圆心（单基地没有字母） */
.base-badge-flag { fill: none; stroke: var(--color-on-team-neutral); stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.base-objective-progress { color: var(--color-objective); font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }

@media (width < 768px) {
  .base-status-bar { gap: 6px; padding: 2px 10px; }
}
</style>
