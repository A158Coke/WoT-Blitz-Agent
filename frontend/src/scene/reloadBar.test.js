import { describe, expect, it } from 'vitest'
import {
  PHASE_DRUM_SHELL, PHASE_DURATION_CHANGE, PHASE_MAG_INTERVAL, PHASE_START, fillOf, groupByVehicle,
  inferMagazineSize, isReloadPhase, shellStatesAt, usablePhases,
} from './reloadBar.js'

// 相位条目（facet `reloads` 的形状）：{ clock, eid, phase, duration_s, count }
const clip = (clock, eid, d) => ({ clock, eid, phase: PHASE_START, duration_s: d, count: null })
const gap = (clock, eid, d, count = null) => ({ clock, eid, phase: PHASE_MAG_INTERVAL, duration_s: d, count })
const drum = (clock, eid, d, count = null) => ({ clock, eid, phase: PHASE_DRUM_SHELL, duration_s: d, count })
const chg = (clock, eid, d) => ({ clock, eid, phase: PHASE_DURATION_CHANGE, duration_s: d, count: null })
const states = (arr) => arr.map((s) => s.state)

describe('reloadBar · 相位语义与筛选', () => {
  it('收 f2=3/4/6/7 且带正时长的条目；无时长的 5（就绪/取消）与其他码不参与', () => {
    const list = [clip(1, 7, 12.4), drum(2, 7, 6.5), gap(2.5, 7, 2.7), chg(3.5, 7, 5),
      { clock: 4, eid: 7, phase: 5, duration_s: null, count: 1 },
      { clock: 4.5, eid: 7, phase: 1, duration_s: null, count: 5 }]
    expect(usablePhases(list).map((e) => [e.clock, e.phase])).toEqual([[1, 3], [2, 6], [2.5, 7], [3.5, 4]])
  })

  it('"真装填"只算 f2=3/6；f2=7 是射击间隔，不装填', () => {
    expect(isReloadPhase(clip(1, 7, 12))).toBe(true)
    expect(isReloadPhase(drum(1, 7, 6.5))).toBe(true)
    expect(isReloadPhase(gap(1, 7, 2.7))).toBe(false)
    expect(isReloadPhase(chg(1, 7, 5))).toBe(false)
  })

  it('分组按 eid（保留全量条目：未闭环相位码上的 f4 也要用于 N 推断）', () => {
    const m = groupByVehicle([clip(1, 7, 12.4), gap(2, 9, 3), drum(3, 11, 6),
      { clock: 4, eid: 11, phase: 1, duration_s: null, count: 5 }])
    expect([...m.keys()].sort((a, b) => a - b)).toEqual([7, 9, 11])
    expect(m.get(11).length).toBe(2)
  })

  it('只有未闭环相位的车：条目在，但状态恒满（不给未闭环码赋时长语义）', () => {
    const ev = [{ clock: 1, eid: 7, phase: 1, duration_s: null, count: 5 }]
    expect(shellStatesAt(ev, [], 100, 1)).toEqual([{ state: 'full', progress: 1 }])
  })
})

describe('reloadBar · 弹夹容量推断（f4=开火后剩余发数 → N = 最大剩余 + 1）', () => {
  it('单发车（只有整夹相位、无计数）→ 1', () => {
    expect(inferMagazineSize([clip(1, 7, 12.4), clip(30, 7, 12.4)])).toBe(1)
    expect(inferMagazineSize([])).toBe(1)
  })

  it('3 发弹鼓（真实序列：tank 4481，f4 = 2/1，无整夹相位）→ N=3', () => {
    // tournament-14-14-example eid 12558556：客户端 burst_size=3 / burst_interval=2.727 / burst_reloads=[14,10,7]
    const ev = [gap(39.97, 7, 2.63, 2), drum(42.56, 7, 6.56, 2), gap(42.86, 7, 2.63, 1),
      drum(45.47, 7, 9.38, 1), drum(54.85, 7, 6.56, 2)]
    expect(inferMagazineSize(ev)).toBe(3)
  })

  it('2 发弹夹（tank 11073，f4=1）→ N=2', () => {
    expect(inferMagazineSize([gap(99.72, 7, 2.5, 1), clip(103.72, 7, 15.63), gap(123.92, 7, 2.5, 1)])).toBe(2)
  })

  it('4 发弹夹（tank 19025，f4 = 3/2/1）→ N=4', () => {
    expect(inferMagazineSize([gap(84.1, 7, 2, 3), gap(86.6, 7, 2, 2), gap(91.0, 7, 2, 1), clip(94.19, 7, 16.93)])).toBe(4)
  })

  it('f4 出现在未闭环相位码上时也要用（实测 f2=1 也带剩余发数）：tank 19825 → N=6', () => {
    const ev = [
      { clock: 33.62, eid: 7, phase: 1, duration_s: null, count: 5 },
      { clock: 33.81, eid: 7, phase: 1, duration_s: null, count: 4 },
      gap(34.16, 7, 3, 3),
      { clock: 39.33, eid: 7, phase: 1, duration_s: null, count: 2 },
      { clock: 39.52, eid: 7, phase: 1, duration_s: null, count: 1 },
      clip(39.85, 7, 12.73),
    ]
    expect(inferMagazineSize(ev)).toBe(6)
  })

  it('f2=5 的 f4=1 是"就绪标志"，不参与容量推断（单发车不被推成 2 发）', () => {
    const ev = [clip(10, 7, 12.4), { clock: 22, eid: 7, phase: 5, duration_s: null, count: 1 }]
    expect(inferMagazineSize(ev)).toBe(1)
  })

  it('无 f4 时回退到"整夹之间最长连续逐发相位串 + 1"', () => {
    const ev = [clip(10, 7, 3), gap(11, 7, 3), gap(12, 7, 3), clip(40, 7, 3), gap(41, 7, 3)]
    expect(inferMagazineSize(ev)).toBe(3)
  })

  it('既无 f4 也无整夹相位 → 1（不拿间隔串猜：单发车也可能连发 f2=7）', () => {
    const ev = [gap(10, 7, 2.63), gap(20, 7, 2.63), gap(30, 7, 2.63)]
    expect(inferMagazineSize(ev)).toBe(1)
  })

  it('f4 明显越界（脏数据）→ 退回启发式，不产生荒唐容量', () => {
    expect(inferMagazineSize([gap(10, 7, 2.5, 99), clip(20, 7, 12)])).toBe(2)
    expect(inferMagazineSize([gap(10, 7, 2.5, -1), clip(20, 7, 12)])).toBe(2)
  })
})

describe('reloadBar · 逐发状态（对齐客户端 Full / Active / Inactive）', () => {
  it('无相位流（敌方/零起点车）→ 恒满，不猜', () => {
    expect(states(shellStatesAt([], [], 100, 1))).toEqual(['full'])
    expect(states(shellStatesAt([], [50], 100, 3))).toEqual(['full', 'full', 'full'])
  })

  it('单发车整夹装填：整条按进度填（0 → 1）', () => {
    const ev = [clip(10, 7, 4), clip(30, 7, 4)]
    expect(shellStatesAt(ev, [], 10, 1)).toEqual([{ state: 'loading', progress: 0 }])
    expect(shellStatesAt(ev, [], 12, 1)[0].progress).toBeCloseTo(0.5, 6)
    expect(states(shellStatesAt(ev, [], 14, 1))).toEqual(['full'])          // 相位走完 = 已就绪
    expect(states(shellStatesAt(ev, [], 5, 1))).toEqual(['full'])           // 第一条相位之前
  })

  it('弹夹整夹装填：**所有发一起**按同一进度填（不是逐发先后到位）', () => {
    const ev = [clip(10, 7, 4)]
    const half = shellStatesAt(ev, [], 12, 3)
    expect(states(half)).toEqual(['loading', 'loading', 'loading'])
    expect(half.map((s) => s.progress)).toEqual([0.5, 0.5, 0.5])
    expect(states(shellStatesAt(ev, [], 14, 3))).toEqual(['full', 'full', 'full'])
  })

  it('弹夹内射击间隔（f2=7）**不补发**：打掉一发后一直保持空，直到整夹装填', () => {
    // 真实形态（tank 11073）：开火 → f2=7 2.5s（射击间隔）→ 打第二发 → f2=3 整夹 15.63s
    const ev = [gap(99.72, 7, 2.5, 1), clip(103.72, 7, 15.63)]
    // 打掉 1 发后、间隔中/间隔结束都只有 2 发在膛（旧模型会在这里"补回来"）
    expect(states(shellStatesAt(ev, [99.62], 100.5, 2))).toEqual(['full', 'empty'])
    expect(states(shellStatesAt(ev, [99.62], 102.6, 2))).toEqual(['full', 'empty'])
    // 打第二发后整夹装填：两发一起填
    const mid = shellStatesAt(ev, [99.62, 103.62], 111.5, 2)
    expect(states(mid)).toEqual(['loading', 'loading'])
    expect(mid[0].progress).toBeCloseTo((111.5 - 103.72) / 15.63, 6)
    expect(states(shellStatesAt(ev, [99.62, 103.62], 120.0, 2))).toEqual(['full', 'full'])
  })

  it('弹鼓逐发装填（f2=6）：只补最左空位那一发；f2=7 的间隔期间不装填', () => {
    // 真实序列（tank 4481）：开火 39.86（f4=2）→ f2=7 2.63s（间隔）→ f2=6 6.56s（装填第 3 发）
    const ev = [gap(39.97, 7, 2.63, 2), drum(42.56, 7, 6.56, 2)]
    expect(inferMagazineSize(ev)).toBe(3)
    // 间隔期间（39.97~42.60）：空位就是空位，没有任何进度
    expect(states(shellStatesAt(ev, [39.86], 41.0, 3))).toEqual(['full', 'full', 'empty'])
    // 装填期间（42.56~49.12）：第 3 发在装填
    const mid = shellStatesAt(ev, [39.86], 46.0, 3)
    expect(states(mid)).toEqual(['full', 'full', 'loading'])
    expect(mid[2].progress).toBeCloseTo((46.0 - 42.56) / 6.56, 6)
    // 装完：整夹满
    expect(states(shellStatesAt(ev, [39.86], 49.3, 3))).toEqual(['full', 'full', 'full'])
  })

  it('装填被开火打断 → 不结算（那发没到位）', () => {
    const ev = [drum(10, 7, 5)]
    // 12s 时开火打断；15s（原定结束）之后也不该把打出的那发算回来
    expect(states(shellStatesAt(ev, [12], 16, 3))).toEqual(['full', 'full', 'empty'])
  })

  it('整夹装填中途时长变更（f2=4）→ 刷新进度基准', () => {
    const ev = [clip(40, 7, 8), chg(44, 7, 4)]
    const st = shellStatesAt(ev, [], 46, 2)          // 基准改为 44 起、4s → 0.5（按原 8s 才是 0.75）
    expect(st.map((s) => s.progress)).toEqual([0.5, 0.5])
  })

  it('手动重装（打掉两发后整夹重装）：静置如实显示空位；重装期间整夹锁住一起填', () => {
    const ev = [clip(10, 7, 4), clip(40, 7, 8)]
    expect(states(shellStatesAt(ev, [15, 25], 30, 3))).toEqual(['full', 'empty', 'empty'])
    const mid = shellStatesAt(ev, [15, 25], 42, 3)
    expect(states(mid)).toEqual(['loading', 'loading', 'loading'])
    expect(mid.map((s) => s.progress)).toEqual([0.25, 0.25, 0.25])
    expect(states(shellStatesAt(ev, [15, 25], 50, 3))).toEqual(['full', 'full', 'full'])
  })

  it('打空整夹后静置：全空（等整夹装填相位）', () => {
    const ev = [clip(10, 7, 4), clip(40, 7, 8)]
    expect(states(shellStatesAt(ev, [15, 25, 35], 38, 3))).toEqual(['empty', 'empty', 'empty'])
  })

  it('求值与调用顺序无关（seek 乱序求值一致）', () => {
    const ev = [clip(10, 7, 4), drum(20, 7, 3)]
    const a = shellStatesAt(ev, [15], 21.5, 3)
    shellStatesAt(ev, [15], 40, 3)
    expect(shellStatesAt(ev, [15], 21.5, 3)).toEqual(a)
  })

  it('聚合比：满=1、空档=在膛发数/N、装填中=进度（整夹与逐发同式）', () => {
    const ev = [clip(10, 7, 4), clip(40, 7, 8)]
    expect(fillOf(shellStatesAt(ev, [], 50, 3))).toBe(1)
    expect(fillOf(shellStatesAt(ev, [15], 30, 3))).toBeCloseTo(2 / 3, 6)
    expect(fillOf(shellStatesAt(ev, [15, 25], 30, 3))).toBeCloseTo(1 / 3, 6)
    expect(fillOf(shellStatesAt(ev, [], 12, 3))).toBeCloseTo(0.5, 6)   // 整夹一起装填：聚合 = 进度
  })
})
