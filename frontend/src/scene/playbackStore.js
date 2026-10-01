// 实时回放的响应式 UI 状态：scene（playbackScene.js，命令式 three.js 内核）每 tick 写入，
// Vue 面板组件只读渲染；控件事件回调 scene 方法。字段与旧版 DOM 触点一一对应。
import { reactive } from 'vue'

export function createPlaybackStore() {
  return reactive({
    // loader 弹层
    filePath: '',
    loading: false,
    err: '',
    qualityKey: '',
    qualityLabel: '',
    // 顶栏
    mapName: '',
    timer: '--:--',
    score1: 0,
    score2: 0,
    // 控制条
    playing: false,
    speed: 2,
    time: 0,
    duration: 0,
    seekFrac: 0,
    seeking: false, // 用户拖动进度条期间场景不回写
    cam: 'free',
    glbOn: false,
    glbAllowed: true,
    labelsOn: true,
    // 顶栏：双方队伍血量（百分比 + 绝对值，按全队 max_hp 汇总）与争霸实时点数
    hpFriendPct: 100, hpEnemyPct: 100,
    hpFriend: 0, hpFriendMax: 0, hpEnemy: 0, hpEnemyMax: 0,
    pointsFriend: null, pointsEnemy: null,   // null = 该场无点数广播（非争霸）
    // 覆盖层
    banner: null, // { text, color }
    killfeed: [], // { id, text }
    // team 未知（0）的车进 unknown 中性组——绝不允许污染 team1（旧 hack `team!==2→team1`）
    roster: { team1: [], team2: [], unknown: [] }, // { eid, dot, nick, tank, frac, dead, followed, isAuthor }
    hasData: false,
  })
}
