<script setup>
// 实时回放面板：Vue 只负责 loader/顶栏/名册/击杀流/控制条等 UI，
// three.js 场景内核在 scene/playbackScene.js（命令式，逐行平移自旧版）。
// 面板状态由 scene 每 tick 写入 store；控件事件回调 scene 方法。
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { initPlayback, QUALITY_PRESETS } from '../scene/playbackScene.js'
import { createPlaybackStore } from '../scene/playbackStore.js'

const route = useRoute()
const store = createPlaybackStore()
const sceneEl = ref(null)
const seekEl = ref(null)
let scene = null

const SPEEDS = [0.5, 1, 2, 4, 8, 16]
// 争霸点数上限（满值即胜利分）
const POINTS_MAX = 1000
const pointsPct = (v) => (v == null ? 0 : Math.max(0, Math.min(100, (v / POINTS_MAX) * 100)))
// 紧凑血量数值（万位以上折算 k，避免顶栏被长数字撑开）
function fmtHp(n) {
  const v = Math.max(0, Math.round(n || 0))
  return v >= 10000 ? (v / 1000).toFixed(1) + 'k' : String(v)
}
const CAMS = [ { k: 'free', label: '自由' }, { k: 'top', label: '俯视' }, { k: 'follow', label: '跟随' } ]
const QUALITY_ORDER = Object.keys(QUALITY_PRESETS)

function loadFile() {
  const v = store.filePath.trim()
  if (v) scene.loadData(v)
}
// 本地文件通道（契约 §6：文件不出本机，浏览器 WASM 解析）——产出与服务端通道同形
function onLocalFile(e) {
  const f = e.target.files && e.target.files[0]
  if (f) {
    store.filePath = f.name
    scene.loadData({ kind: 'local', file: f })
  }
  e.target.value = ''
}
function onSeekInput(e) {
  scene.seekFraction(e.target.value / 1000)
}

// 进度条为非受控输入（旧版语义）：滑块值由场景 tick 直接写 DOM。
// 不用 :value 绑定——Vue 每帧重渲染会把 value 强制写回 store.seekFrac（旧值），
// 与用户拖拽打架导致滑块不跟手。seeking 期间（用户按住）场景不回写。
watch(() => store.seekFrac, (v) => {
  if (seekEl.value && !store.seeking) seekEl.value = String(v)
})

onMounted(() => {
  scene = initPlayback(sceneEl.value, store)
  // URL ?file= 直达加载（Replay Tab「实时回放」入口）
  const f = route.query.file
  if (f) { store.filePath = String(f); scene.loadData(String(f)) }
})
onBeforeUnmount(() => { if (scene) scene.destroy() })
</script>

<template>
  <div id="pb-root">
    <div id="scene" ref="sceneEl"></div>

    <div id="topbar" class="panel">
      <!-- 行 1：地图名 / 时间 -->
      <div class="tb-row">
        <span class="map">{{ store.mapName }}</span>
        <span class="timer">{{ store.timer }}</span>
      </div>
      <!-- 行 2：双方队伍血量条（含具体数值）+ 中间战果 -->
      <div class="tb-row">
        <span class="hpline">
          <em class="hpnum hpnum-f">{{ fmtHp(store.hpFriend) }} / {{ fmtHp(store.hpFriendMax) }}</em>
          <span class="hpbar hp-f" :title="'己方 ' + store.hpFriendPct.toFixed(0) + '%'">
            <i :style="{ width: store.hpFriendPct + '%' }"></i>
          </span>
          <span class="score"><span class="t1">{{ store.score1 }}</span> : <span class="t2">{{ store.score2 }}</span></span>
          <span class="hpbar hp-e" :title="'敌方 ' + store.hpEnemyPct.toFixed(0) + '%'">
            <i :style="{ width: store.hpEnemyPct + '%' }"></i>
          </span>
          <em class="hpnum hpnum-e">{{ fmtHp(store.hpEnemy) }} / {{ fmtHp(store.hpEnemyMax) }}</em>
        </span>
      </div>
      <!-- 行 3：争霸实时点数（上限 1000）。数值在外侧、两条紧贴中线——
           两条均自中线向外增长，左右完全对称；整行 flex 居中，宽度变化不漂移。 -->
      <div v-if="store.pointsFriend != null || store.pointsEnemy != null" class="tb-row tb-points">
        <b class="pdv pdv-f" :title="'己方点数 ' + (store.pointsFriend ?? 0) + ' / ' + POINTS_MAX">{{ store.pointsFriend ?? '—' }}</b>
        <span class="pointsbar pb-f" :title="'己方 ' + (store.pointsFriend ?? 0) + ' / ' + POINTS_MAX">
          <i :style="{ width: pointsPct(store.pointsFriend) + '%' }"></i>
        </span>
        <span class="pdiv"></span>
        <span class="pointsbar pb-e" :title="'敌方 ' + (store.pointsEnemy ?? 0) + ' / ' + POINTS_MAX">
          <i :style="{ width: pointsPct(store.pointsEnemy) + '%' }"></i>
        </span>
        <b class="pdv pdv-e" :title="'敌方点数 ' + (store.pointsEnemy ?? 0) + ' / ' + POINTS_MAX">{{ store.pointsEnemy ?? '—' }}</b>
      </div>
    </div>

    <div id="team1" class="team panel">
      <h3>队伍 1</h3>
      <div class="roster">
        <div
          v-for="p in store.roster.team1" :key="p.eid"
          class="pl" :class="{ dead: p.dead, followed: p.followed }"
          @click="scene.setFollow(p.eid)"
        >
          <span class="dot" :style="{ background: p.dot }"></span>
          <span class="nick">{{ p.nick }}</span>
          <span class="tank">{{ p.tank }}</span>
          <span class="hpbar"><i :style="{ width: p.frac + '%' }"></i></span>
        </div>
      </div>
    </div>
    <div id="team2" class="team panel">
      <h3>队伍 2</h3>
      <div class="roster">
        <div
          v-for="p in store.roster.team2" :key="p.eid"
          class="pl" :class="{ dead: p.dead, followed: p.followed }"
          @click="scene.setFollow(p.eid)"
        >
          <span class="dot" :style="{ background: p.dot }"></span>
          <span class="nick">{{ p.nick }}</span>
          <span class="tank">{{ p.tank }}</span>
          <span class="hpbar"><i :style="{ width: p.frac + '%' }"></i></span>
        </div>
      </div>
    </div>
    <!-- 未知阵营（team=0，联表失败/观察者）：中性 fail-visible，不并入任何一队 -->
    <div v-if="store.roster.unknown.length" id="team-unknown" class="team panel unknown">
      <h3>未识别阵营</h3>
      <div class="roster">
        <div
          v-for="p in store.roster.unknown" :key="p.eid"
          class="pl" :class="{ dead: p.dead, followed: p.followed }"
          @click="scene.setFollow(p.eid)"
        >
          <span class="dot" :style="{ background: p.dot }"></span>
          <span class="nick">{{ p.nick }}</span>
          <span class="tank">{{ p.tank }}</span>
          <span class="hpbar"><i :style="{ width: p.frac + '%' }"></i></span>
        </div>
      </div>
    </div>

    <div id="killfeed">
      <div v-for="kf in store.killfeed" :key="kf.id" class="kf">
        <template v-if="kf.kill"><span class="k">{{ kf.killer }}</span> 击毁 {{ kf.victim }}</template>
        <template v-else>{{ kf.text }}</template>
      </div>
    </div>
    <div v-if="store.banner" id="banner" :style="{ color: store.banner.color, display: 'block' }">{{ store.banner.text }}</div>

    <div id="controls" class="panel">
      <div class="row">
        <button id="playBtn" @click="scene.togglePlay()">{{ store.playing ? '⏸ 暂停' : '▶ 播放' }}</button>
        <span id="speeds">
          <button
            v-for="s in SPEEDS" :key="s" class="speed-btn"
            :class="{ on: store.speed === s }" @click="scene.setSpeed(s)"
          >{{ s }}x</button>
        </span>
        <input
          type="range" id="seek" ref="seekEl" min="0" max="1000" value="0"
          @pointerdown="store.seeking = true" @pointerup="store.seeking = false"
          @blur="store.seeking = false" @input="onSeekInput"
        >
        <span class="time">{{ store.time.toFixed(1) }}s / {{ store.duration.toFixed(1) }}s</span>
      </div>
      <div class="row">
        <span style="color:var(--dim)">镜头</span>
        <button
          v-for="c in CAMS" :key="c.k" :data-cam="c.k"
          :class="{ on: store.cam === c.k }" @click="scene.setCam(c.k)"
        >{{ c.label }}</button>
        <span style="flex:1"></span>
        <label class="toggle" :title="store.glbAllowed ? '' : '低画质档不加载真实车模（中/高档可用）'">
          <input type="checkbox" :checked="store.glbOn" :disabled="!store.glbAllowed" @change="scene.setGlb($event.target.checked)"> 真实车模（GLB）
        </label>
        <label class="toggle">
          <input type="checkbox" :checked="store.labelsOn" @change="scene.setLabels($event.target.checked)"> 昵称标签
        </label>
        <span id="qBadge" title="画质档在加载前选择：主页面回放入口、本页弹层，或 URL ?q=low|mid|high">{{ store.qualityLabel }}</span>
      </div>
    </div>

    <div v-if="!store.hasData" id="loader">
      <h2>全场实时回放</h2>
      <div class="row">
        <input type="text" v-model="store.filePath" placeholder=".wotbreplay 文件路径（或 URL 加 ?file=）" @keydown.enter="loadFile">
        <input ref="localFile" type="file" accept=".wotbreplay" style="display:none" @change="onLocalFile" />
        <button type="button" @click="$refs.localFile.click()">本地文件</button>
        <button id="loadBtn" :disabled="store.loading" @click="loadFile">{{ store.loading ? '解析中…' : '加载' }}</button>
      </div>
      <div class="row" id="qSel">
        <span style="color:var(--dim)">画质</span>
        <button
          v-for="k in QUALITY_ORDER" :key="k" :data-q="k"
          :class="{ on: store.qualityKey === k }" @click="scene.setQuality(k)"
        >{{ QUALITY_PRESETS[k].label }}</button>
        <span style="color:var(--dim);font-size:11px">低=小地图地面（无建筑/盒子车模）· 中=烘焙底图+建筑 · 高=分层地表+建筑+抗锯齿</span>
      </div>
      <div class="hint">14 车全场连续回放：滤波渲染位姿 + 炮塔/炮管随动 + 弹道飞行动画 + 实时血量/击杀流。<br>
      数据由本机解析（AvatarFilter 渲染层 + prop2 炮塔角），加载需数秒。</div>
      <div id="err">{{ store.err }}</div>
    </div>
  </div>
</template>

<style scoped>
/* 面板配色体系自旧版 playback 页独立平移（与主应用 tokens 不同系） */
#pb-root {
  position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden;
  --panel: rgba(16, 20, 26, .82); --line: #2c3542; --fg: #d8dee7; --dim: #8a94a3;
  --ally: #3fa66a; --enemy: #c05046; --unknown: #8a94a3; --accent: #e8b23c;
  background: #0d1117; color: var(--fg);
  font: 13px/1.45 "Segoe UI", "Microsoft YaHei", sans-serif;
}
#scene { position: absolute; inset: 0; }
.panel { position: absolute; background: var(--panel); border: 1px solid var(--line);
         border-radius: 8px; backdrop-filter: blur(4px); }
#topbar { top: 10px; left: 50%; transform: translateX(-50%); padding: 6px 18px;
          display: flex; flex-direction: column; gap: 4px; align-items: center; white-space: nowrap; }
#topbar .tb-row { display: flex; gap: 14px; align-items: center; justify-content: center; }
#topbar .tb-points { font-size: 13px; color: var(--dim); gap: 4px; }   /* 收紧：两条贴近中线 */
/* 点数条：左条己方（自右向左填充）、右条敌方；中间数值固定列宽使整行居中 */
#topbar .pointsbar { display: inline-block; width: 92px; height: 7px;
                    background: rgba(255,255,255,.13); overflow: hidden; }
/* 两条紧贴中线：左条圆角在左端、右条在右端，中线处相接 */
#topbar .pb-f { border-radius: 4px 0 0 4px; }
#topbar .pb-e { border-radius: 0 4px 4px 0; }
#topbar .pointsbar > i { display: block; height: 100%; transition: width .18s linear; }
/* 自中线向外增长：左条填充贴右端（靠中线），右条填充贴左端（靠中线） */
#topbar .pb-f > i { background: var(--ally); float: right; }
#topbar .pb-e > i { background: var(--enemy); float: left; }
#topbar .pdiv { width: 1px; height: 13px; background: var(--line); }
#topbar .pdv { min-width: 44px; font-variant-numeric: tabular-nums; font-size: 13px; }
#topbar .pdv-f { color: var(--ally); text-align: right; }
#topbar .pdv-e { color: var(--enemy); text-align: left; }
#topbar .timer { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
#topbar .score { font-size: 16px; font-weight: 600; }
#topbar .score .t1 { color: var(--ally); }
#topbar .score .t2 { color: var(--enemy); }
#topbar .map { color: var(--dim); }
/* 双方血量条 + 比分（WotBTools HUD 同构：左己方 / 右敌方 / 中间战果） */
#topbar .hpline { display: inline-flex; align-items: center; gap: 6px; }
#topbar .hpnum { font-style: normal; font-size: 11px; font-variant-numeric: tabular-nums; }
#topbar .hpnum-f { color: var(--ally); text-align: right; }
#topbar .hpnum-e { color: var(--enemy); text-align: left; }
#topbar .hpbar { display: inline-block; width: 92px; height: 9px; border-radius: 5px;
                 background: rgba(255,255,255,.13); overflow: hidden; }
#topbar .hpbar > i { display: block; height: 100%; transition: width .18s linear; }
/* 两条贴比分侧（靠中线）：己方填充贴右端、敌方贴左端——与点数条同构 */
#topbar .hp-f > i { background: var(--ally); float: right; }
#topbar .hp-e > i { background: var(--enemy); float: left; }
#topbar .points { display: inline-flex; align-items: center; gap: 6px; }
#topbar .points .plbl { color: var(--dim); font-size: 11px; }
#topbar .points b { font-size: 15px; font-variant-numeric: tabular-nums; }
.team { top: 60px; width: 240px; padding: 6px; max-height: calc(100% - 190px); overflow-y: auto; }
#team1 { left: 10px; }
#team2 { right: 10px; }
/* 未知阵营中性组：居中挂靠顶部下方，灰调 fail-visible */
#team-unknown { left: 50%; transform: translateX(-50%); width: 220px; }
#team-unknown h3 { color: #9aa5b1; }
.team h3 { font-size: 12px; color: var(--dim); margin: 2px 4px 6px; font-weight: 500; }
.pl { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 5px; cursor: pointer; }
.pl:hover { background: rgba(255, 255, 255, .06); }
.pl.dead { opacity: .42; }
.pl.dead .nick { text-decoration: line-through; }
.pl.followed { outline: 1px solid var(--accent); }
.pl .dot { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.pl .nick { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl .tank { color: var(--dim); font-size: 11px; max-width: 86px; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
.pl .hpbar { width: 52px; height: 5px; background: #222a34; border-radius: 3px; flex: none; }
.pl .hpbar i { display: block; height: 100%; border-radius: 3px; background: var(--ally); }
#killfeed { position: absolute; top: 132px; left: 50%; transform: translateX(-50%);
            display: flex; flex-direction: column; align-items: center; gap: 4px; pointer-events: none; }
.kf { background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
      padding: 3px 12px; font-size: 12px; animation: kfin .18s ease-out; white-space: nowrap; }
.kf .k { color: var(--accent); font-weight: 600; }
@keyframes kfin { from { opacity: 0; transform: translateY(-6px); } }
#controls { bottom: 10px; left: 50%; transform: translateX(-50%); width: min(880px, 94%);
            padding: 8px 14px; display: flex; flex-direction: column; gap: 6px; }
#controls .row { display: flex; gap: 8px; align-items: center; }
/* 全局 tokens.css 的 input{padding:9px 13px;border...;flex:1;min-width:120px} 会破坏
   滑块的原生渲染与命中判定、撑大开关复选框——恢复各自自然形态 */
#controls input[type=range] { flex: 1; min-width: 0; accent-color: var(--accent); padding: 0; border: none; background: transparent; border-radius: 0; }
#pb-root input[type="checkbox"] { flex: none; min-width: 0; width: auto; margin: 0; }
#controls .time { font-variant-numeric: tabular-nums; color: var(--dim); min-width: 96px; text-align: center; }
#pb-root button, #pb-root select { background: #1d242e; color: var(--fg); border: 1px solid var(--line);
                   border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
#pb-root button:hover { border-color: var(--accent); }
#pb-root button.on { background: var(--accent); color: #14181e; border-color: var(--accent); font-weight: 600; }
#playBtn { width: 74px; font-weight: 600; }
#speeds .speed-btn { min-width: 38px; }
label.toggle { display: flex; gap: 4px; align-items: center; color: var(--dim); cursor: pointer; }
#banner { position: absolute; top: 38%; left: 50%; transform: translate(-50%, -50%);
          font-size: 42px; font-weight: 700; padding: 14px 44px;
          background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
#loader { position: absolute; inset: 0; background: rgba(10, 13, 17, .94); z-index: 10;
          display: flex; flex-direction: column; gap: 14px; align-items: center;
          justify-content: center; }
#loader h2 { font-weight: 500; }
#loader .row { display: flex; gap: 8px; }
#loader input[type=text] { width: 420px; background: #141a22; color: var(--fg);
    border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; }
#loader .hint { color: var(--dim); max-width: 560px; text-align: center; }
#err { color: #e07b7b; max-width: 640px; white-space: pre-wrap; }
#qSel button { min-width: 44px; }
</style>
