// 实时回放 three.js 场景内核：自 playback_viewer.rs 的 INDEX_HTML 模块脚本逐行平移。
// 渲染语义（位姿滤波/炮塔随动/弹道动画/分层地表/画质档/GLB 姿态）一行不改；
// 唯一改动是原 DOM 面板触点（$('timer') 等）全部改写 store（playbackStore.js）。
//
// 会话生命周期（契约 v2 / 评审 P0-2）：同场景实例换回放必须 teardown 上一场——
// load A → dispose A → load B；路由/组件销毁 → dispose 当前会话。会话拥有的资源
// （车辆低模/GLB 克隆/标签/弹道特效/地图与地表纹理/GLB 模板缓存）显式 dispose，
// 异步资产加载带 generation guard（迟到完成不得污染新会话，迟到的已加载资源随旧
// 会话缓存一并释放）。GLB 模板缓存为 session-scoped：同 tank 会话内复用，会话结束
// 对 unique shared resources dispose 一次并清缓存（clone 共享模板资源，不逐克隆
// 深度 dispose）；cross-session refcount/LRU 不在本层。
import * as THREE from 'three'

import { loadPlaybackData, mapStaticUrl, resolveMapKey, serverMapUrl } from './replaySource.js'
import { poseFromYPR } from './glbRig.js'
import mapBasesData from './mapBases.json'
import { firstIndexAfter } from './seekPointer.js'
import { impactKind } from './impactKind.js'
import { pointsAt } from './supremacyPoints.js'
import {
  ASSAULT_BASE_ID, SUPREMACY_BASE_IDS, assaultHasObjective, baseView,
  foldAssaultProgress, foldSupremacyTransitions,
} from './baseStatus.js'
import { orientDiscUv } from './baseDecal.js'
import { fillOf, groupByVehicle, inferMagazineSize, shellStatesAt } from './reloadBar.js'
import playableBoundsData from './playableBounds.json'
import { assetUrl } from './assetBase.js'
import { battleEndTime } from './battleEnd.js'
import { advancePlaybackTime } from '../utils/playbackClock.js'
import { isPlaybackSpeed } from '../composables/usePlaybackTransport.js'
import { TEAM_COLORS, TEAM_COLORS_DEEP, TEAM_COLORS_PANEL, hexToInt } from './teamColors.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const GRID_DT = 0.1

// 场景静态 GLB 的曝光修整系数（只作用于 convMat 里的 MeshLambertMaterial，
// 即建筑/岩石/栅栏/集装箱；坦克代理车与 GLB 车模各走各的路径，不受影响）。
//
// 缘起：整套光照（HemisphereLight 2.4 + DirectionalLight 3.0）是按坦克 GLB
// （MeshStandardMaterial，有 metalness/roughness）调的，而场景是降级到 Lambert 渲染的
// ——朝上/朝阳的面被整体推亮，最典型的是岩石（贴图 albedo 仅 87.5/255，却渲染到
// 150/255 上下、四成像素越过 180 近白）。实测（各系数只改本项，机位与场景不变；
// 4 块岩石 + 各 2 个建筑样本的平均）：
//   系数   岩石亮度  岩石近白占比   红房子   集装箱   白栅栏
//   1.00     151        40.1%        74      127      156
//   0.75     134        26.9%        60      109      144   ← 取值
//   0.60     121        16.4%        50       95      135
//   0.50     110         7.8%        42       84      126
//
// 取值理由与已知代价：红房子在 1.00 时其实接近其 albedo 的正确曝光（88/255 → 74），
// 所以**任何全局压暗都会连带伤到已正确的一侧**——岩石过曝的根因是朝上面吃满了天光，
// 属光照动态范围问题，不是材质问题，全局旋钮无法两全。0.75 是"近白像素砍掉三分之一、
// 暗侧再暗约 13%"的折中；想彻底消除近白可取 0.6（代价是红房子掉到 50，明显偏暗）。
// 真正的解法是重平衡光照或补环境光遮蔽，但那会同时改变坦克观感，故不在前端单方面动。
// 还原原状：设为 1。
const SCENERY_LAMBERT_EXPOSURE = 0.75

// 叶卡 alpha 裁切阈值。客户端 AlphaBlend 软边缘 + 0.05 低阈值会让近透明像素仍写
// 深度（叶片互相遮挡 → 破洞/闪烁）；提到 MASK 量级消除，并保留软边缘。
const CARD_ALPHA_CUT = 0.33

// 三档渲染预设（面板与场景共用；桌面默认高，Tauri/移动 WebView 默认低）。
// 抗锯齿/DPR/场景资源在渲染器与场景首次创建时一次性定型，加载后改档需整页刷新。
export const QUALITY_PRESETS = {
  low:  { label: '低', antialias: false, maxDpr: 1,   scenery: false, groundLayers: false, miniMap: true,  anisotropy: 1, terrainSeg: 192, allowGlb: false },
  mid:  { label: '中', antialias: false, maxDpr: 1.5, scenery: true,  groundLayers: false, miniMap: false, anisotropy: 4, terrainSeg: 256, allowGlb: true },
  high: { label: '高', antialias: true,  maxDpr: 2,   scenery: true,  groundLayers: true,  miniMap: false, anisotropy: 8, terrainSeg: 512, allowGlb: true },
}

export function initPlayback(container, store) {
  // ---------- 全局状态 ----------
  let DATA = null;                 // PlaybackData（当前会话）
  let V = [];                      // 车辆运行时 {def, group, turretG, gunPivot, label, meshHull, glb}
  let T = 0, PLAYING = false, SPEED = store.speed;
  // 时间轴终点（绝对秒）：比赛结束，不是录像流结束（见 battleEnd.js）。
  // 全部"是否播到头 / 进度条分母 / seek 上界"都读它，不再散落比较 meta.duration。
  let END = 0;
  let CAM = 'free', FOLLOW_EID = 0;
  let shotPtr = 0, killPtr = 0;
  const tracers = [], impacts = [];
  let renderer = null, scene, camera, controls, clock, raycaster;
  let labelScene = null, labelRenderer = null;
  let glbCache = new Map(), glbOn = false;
  let mapPlane = null;
  let mapTexture = null, mapMetaInfo = null;          // 底图贴图 + 铺设参数
  // 分层地表（客户端 tilemask-fp.sl 实时合成）：{layers: 合成参数, texs: {cm,tile,mask,hmap}}。
  // 缺失（未导出/404）时回退整图烘焙底图
  let groundLayers = null;
  let terrainMesh = null, heightField = null, heightMeta = null;  // 3D 地形
  let mapScenery = null;                              // 静态场景 GLB（建筑等）
  let groundMesh = null, gridHelper = null;           // buildWorld 的占位地面/网格（会话拥有）
  let boundaryGroup = null;                           // 地图边界红线（会话拥有）
  // 阵营/中立调色：green / red / white——炮线、基地归属、标签、
  // 中立与未知阵营一律用 white（unknown ≠ enemy）。
  // 唯一事实源在 scene/teamColors.js，与 DOM 侧 token（--color-team-*）同源。
  const COLOR_FRIENDLY = hexToInt(TEAM_COLORS.ally);
  const COLOR_ENEMY = hexToInt(TEAM_COLORS.enemy);
  const COLOR_UNKNOWN = hexToInt(TEAM_COLORS.neutral);
  let baseObjects = [];                               // 基地（争霸 A–D / 单基地）{baseId, kind, ring, disc, canvas, ...}
  let destroyed = false;
  let kfId = 0;
  // 会话代数：loadData/teardown 各自递增，全部异步续体持旧代数即失效
  let sessionGen = 0;
  // 渲染帧句柄：destroy 显式 cancel（旧实现依赖 destroyed 标志的自然退出，
  // 帧回调在 destroy 后仍可能再排队一次）
  let rafId = 0;
  // 诊断强引用仅在显式 debug 下创建（生产不挂 window.__scene 等长生命周期引用）
  const DEBUG = (() => { try { return new URLSearchParams(location.search).has('debug'); } catch (e) { return false; } })();

  // ---------- 画质分档 ----------
  // 解析优先级：URL ?q= > localStorage > 设备默认；三档都开 3D 地形（仅分段数降档）。
  // （预设表用模块级 QUALITY_PRESETS，与面板共享）
  function resolveQuality() {
    const usp = new URLSearchParams(location.search);
    let q = (usp.get('q') || '').toLowerCase();
    if (!QUALITY_PRESETS[q]) { try { q = localStorage.getItem('pb_quality') || ''; } catch (e) {} }
    if (!QUALITY_PRESETS[q]) {
      const mobile = !!window.__TAURI__ || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
      q = mobile ? 'low' : 'high';
    }
    try { localStorage.setItem('pb_quality', q); } catch (e) {}
    return q;
  }
  let QKEY = resolveQuality(), Q = QUALITY_PRESETS[QKEY];
  store.qualityKey = QKEY;
  store.qualityLabel = '画质 · ' + Q.label;
  function setQuality(k) {
    if (!QUALITY_PRESETS[k] || k === QKEY) return;
    const apply = () => {
      QKEY = k; Q = QUALITY_PRESETS[k];
      try { localStorage.setItem('pb_quality', k); } catch (e) {}
      store.qualityKey = QKEY;
      store.qualityLabel = '画质 · ' + Q.label;
      applyGlbGate();
    };
    if (DATA) {
      // 已在播放：渲染参数一次性定型，切换档位需带新 ?q= 整页重载
      // （Tauri WebView 不弹 confirm 对话框，直接重载）
      if (window.__TAURI__ || confirm('切换到「' + QUALITY_PRESETS[k].label + '」画质将重新加载回放，继续？')) {
        try { localStorage.setItem('pb_quality', k); } catch (e) {}
        const u = new URL(location.href); u.searchParams.set('q', k); location.replace(u);
      }
      return;   // 取消则维持原档
    }
    apply();
  }
  // 低档强制盒子代理（14 车 ×数 MB GLB 下载 + PBR 填充率是移动端主要瓶颈之一）
  function applyGlbGate() {
    store.glbAllowed = Q.allowGlb;
    if (!Q.allowGlb) {
      store.glbOn = false;
      if (glbOn) applyGlbToggle(false);
    }
  }

  // ---------- 工具 ----------
  const fmtTime = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
  const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

  function idxOf(t) { return Math.floor((t - DATA.meta.t_start) / GRID_DT); }

  function posAt(v, t, out) {
    const i = idxOf(t), n = DATA.meta.samples;
    const i0 = Math.max(0, Math.min(i, n - 1)), i1 = Math.min(i0 + 1, n - 1);
    const f = Math.max(0, Math.min(1, (t - DATA.meta.t_start) / GRID_DT - i0));
    const p = v.def.pos;
    out.set(-(p[i0*3] + (p[i1*3] - p[i0*3]) * f),
             p[i0*3+1] + (p[i1*3+1] - p[i0*3+1]) * f,
             p[i0*3+2] + (p[i1*3+2] - p[i0*3+2]) * f);
    return out;
  }
  function yawAt(v, t) { return arrAt(v.def.hull_yaw, t); }
  function turretAbsAt(v, t) { return arrAt(v.def.turret_yaw, t); }
  function gunPitchAt(v, t) { return arrAt(v.def.gun_pitch, t); }
  function arrAt(arr, t) {
    const i = idxOf(t), n = DATA.meta.samples;
    const i0 = Math.max(0, Math.min(i, n - 1)), i1 = Math.min(i0 + 1, n - 1);
    const f = Math.max(0, Math.min(1, (t - DATA.meta.t_start) / GRID_DT - i0));
    return arr[i0] + (arr[i1] - arr[i0]) * f;
  }
  function hpAt(v, t) {
    const hp = v.def.hp; let cur = v.def.max_hp;
    for (const [ht, hv] of hp) { if (ht <= t) cur = hv; else break; }
    return cur;
  }
  function deathAt(v, t) { return v.def.death_t == null ? false : t >= v.def.death_t; }
  function visibleAt(v, t) {
    const c = v.def.coverage;
    for (let k = 0; k + 1 < c.length; k += 2) if (t >= c[k] && t <= c[k+1]) return true;
    return false;
  }
  function gameTimerLabel(t) {
    const ps = DATA.periods; let p = null;
    for (const pe of ps) { if (pe.clock <= t) p = pe; else break; }
    if (!p || p.period < 3) return p ? (p.period === 1 ? '准备' : '倒计时') : fmtTime(t);
    const elapsed = (t - p.clock) + (p.duration_s - p.remaining_s);
    return fmtTime(Math.max(0, p.duration_s - elapsed));
  }

  // ---------- 场景 ----------
  function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x11161d);
    if (DEBUG) window.__scene = scene;   // 诊断钩子（仅显式 ?debug，destroy 时清除）
    // SPA 壳内渲染：视口尺寸取容器（main 区域），而非整窗（顶部导航占 67px）
    camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.5, 4000);
    camera.position.set(0, 180, 220);
    renderer = new THREE.WebGLRenderer({ antialias: Q.antialias });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, Q.maxDpr));
    if (DEBUG) window.__renderer = renderer;   // 诊断钩子（renderer 创建后才可引用；仅 ?debug）
    // three r165+ 恒为物理光照单位（Lambert 除以 π），旧强度会让建筑/车模暗到发黑；
    // 与装甲查看器一致：ACES 色调映射 + ×π 级别的光强
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);
    // 昵称标签独立覆盖画布：按设备像素比满分辨率渲染，清晰度不受画质档 maxDpr 影响
    //（低档锁主画布 DPR=1 会让 HiDPI 屏上的标签文字发糊）。alpha 透明叠在主画布上，
    // pointer-events 穿透，标签恒在主场景之上（与原 depthTest:false 语义一致）。
    labelScene = new THREE.Scene();
    labelRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
    labelRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    labelRenderer.setSize(container.clientWidth, container.clientHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.inset = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(labelRenderer.domElement);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.maxPolarAngle = Math.PI / 2 - 0.02;
    clock = new THREE.Clock();
    raycaster = new THREE.Raycaster();
    scene.add(new THREE.HemisphereLight(0xbfd4e8, 0x2a2f36, 2.4));
    const sun = new THREE.DirectionalLight(0xffffff, 3.0); sun.position.set(120, 260, 80); scene.add(sun);
    addEventListener('resize', onResize);
    // 点选车辆 → 跟随
    renderer.domElement.addEventListener('pointerdown', onScenePointerDown);
  }
  function onResize() {
    if (!renderer) return;
    // 尺寸取整一次、两个画布共用（主场景 + 标签覆盖层）：全屏/最大化时
    // clientWidth/Height 可能为小数且两层取整不同 → 合成错位 1px → 画面抖。
    const w = Math.max(1, Math.round(container.clientWidth));
    const h = Math.max(1, Math.round(container.clientHeight));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (labelRenderer) labelRenderer.setSize(w, h);
    resizeLabelCanvases();   // 标签贴图分辨率随视口高度重算（卡片屏幕占比恒定）
  }
  function onScenePointerDown(e) {
    if (e.button !== 0) return;
    const r = container.getBoundingClientRect();
    const nd = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(nd, camera);
    const hits = raycaster.intersectObjects(V.map(v => v.group), true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && !o.userData.eid) o = o.parent;
      if (o) setFollow(o.userData.eid);
    }
  }

  function buildWorld() {
    // 数据范围（直接取自 DATA；去 2% 离群后取整百）。注意必须在 buildVehicles 之前也可用——
    // 运行时数组 V 此时尚未填充
    const xs = [], zs = [];
    for (const def of DATA.vehicles)
      for (let i = 0; i < def.pos.length; i += 9) { xs.push(def.pos[i]); zs.push(def.pos[i+2]); }
    xs.sort((a,b)=>a-b); zs.sort((a,b)=>a-b);
    const q = (a, f) => a.length ? a[Math.floor((a.length-1) * f)] : 0;
    const ex = Math.max(q(xs, .98) - q(xs, .02), 200) * 0.65;
    const ez = Math.max(q(zs, .98) - q(zs, .02), 200) * 0.65;
    const m = Math.max(ex, ez);
    const ext = isFinite(m) && m > 0 ? Math.ceil(m / 50) * 50 : 300;
    const cx = (q(xs, .98) + q(xs, .02)) / 2, cz = (q(zs, .98) + q(zs, .02)) / 2;

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(ext * 2 + 100, ext * 2 + 100),
      new THREE.MeshLambertMaterial({ color: 0x202a36 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(cx, 0, cz);
    scene.add(ground);
    groundMesh = ground;
    const grid = new THREE.GridHelper(ext * 2 + 100, Math.floor((ext * 2 + 100) / 50), 0x3a4a5e, 0x273140);
    grid.position.set(cx, 0.02, cz); scene.add(grid);
    gridHelper = grid;
    // 边界只按权威可玩范围画（见 buildBoundary 的 fail-closed 说明）：
    // 此处地图资产尚未加载，命中打包表则先画，否则不画，rebuildGround 再按 terrain meta 重建
    buildBoundary(playableBoundsFor(DATA.meta.map_id), BOUNDARY_THICK);
    WORLD_CENTER = { cx, cz, ext };
    camera.position.set(cx, ext * 1.1, cz + ext * 1.2);
    controls.target.set(cx, 0, cz);
    applyCameraClamp();   // 世界范围决定 min/max 距离（初值，实测再调）
  }
  let WORLD_CENTER = { cx: 0, cz: 0, ext: 300 };

  // 地图边界：四条绝对直线发光红线正方形（常驻、不闪烁不脉冲）。几何 = 地图真实
  // 世界范围（size×size，中心 meta.x/z；缺资产时回退 world bounds）。注意这只是
  // **render/map bounds**，非已证明的游戏内真实战场边界；拿到精确边界只换数据源。
  // 地表高度（米）+ 微小抬升：贴地元素（边界带/基地圆环/HUD）共用——地形有起伏，
  // 固定 y 会被坡地埋住（此前 0.14/0.22 在起伏地形下即"沉入地下"）
  function groundY(x, z) {
    return sampleHeight(x, z) + 0.12;
  }

  // 游戏内实际战场边界（WotBTools map-semantics 的 playableBoundsMeters——比真实
  // 地图 worldBounds(±300) 小，即战场可玩区；来源 common/map-semantics/*.semantic.json，
  // 与回放同坐标系：x = 回放 x、y = 回放 z）。场景为 x 镜像系（scene x = −回放 x），
  // 故场景内 x 区间 = [−xMax, −xMin]、z 区间 = [yMin, yMax]。无语义数据时回退地图 span。
  function playableBoundsFor(mapId) {
    // 优先取服务端 terrain meta（heightMeta.playableBounds，由 agent 导出器从场景
    // MapBorderComponent.mbc.rect 实时提取——新地图导出即自带）；否则回退打包副本
    const pb = (heightMeta && heightMeta.playableBounds) || playableBoundsData[String(mapId)];
    if (!pb) return null;
    const sxMin = -pb.xMax, sxMax = -pb.xMin;
    return { cx: (sxMin + sxMax) / 2, cz: (pb.yMin + pb.yMax) / 2,
             hx: (sxMax - sxMin) / 2, hz: (pb.yMax - pb.yMin) / 2 };
  }

  const BOUNDARY_COLOR = 0xff2f2f;
  // 边界：连续三角形带（非离散分段）——沿四条边密集取点，每点按地形高度贴地，
  // 生成单一 BufferGeometry（1 draw call，无分段接缝）。可粗、直角、随地形起伏。
  const BOUNDARY_STEP = 2.0;       // 采样步长（米）：越小越贴合地形
  const BOUNDARY_THICK = 1.8;
  function clearBoundary() {
    if (!boundaryGroup) return;
    const old = boundaryGroup.userData.sharedMaterial;
    if (old) old.dispose();
    scene.remove(boundaryGroup);
    disposeObject3D(boundaryGroup);
    boundaryGroup = null;
  }

  // 边界只认权威可玩范围（playableBounds）：**fail-closed**——拿不到就不画。
  // 车辆范围 / 地形 span / worldBounds 都不是「游戏内红色战场边界」的证据，
  // 不得作为兜底（历史实现曾用 ext 兜底，会凭空画出一条与玩法不符的边界）。
  function buildBoundary(bounds, thick) {
    clearBoundary();
    if (!bounds) return;
    const { cx, cz, hx, hz } = bounds;
    const x0 = cx - hx, x1 = cx + hx, z0 = cz - hz, z1 = cz + hz;
    // 闭合路径（顺时针四条边，角点精确落在 (±hx, ±hz)）
    const path = [];
    const push = (ax, az, bx, bz) => {
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(2, Math.ceil(len / BOUNDARY_STEP));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        path.push([ax + (bx - ax) * t, az + (bz - az) * t]);
      }
    };
    push(x0, z0, x1, z0);   // 北
    push(x1, z0, x1, z1);   // 东
    push(x1, z1, x0, z1);   // 南
    push(x0, z1, x0, z0);   // 西
    const N = path.length;
    const pos = new Float32Array(N * 2 * 3);
    const idx = [];
    const half = thick / 2;
    for (let i = 0; i < N; i++) {
      const [px, pz] = path[i];
      const [nx2, nz2] = path[(i + 1) % N];
      const [ox, oz] = path[(i - 1 + N) % N];
      // 切线 → 左法线（水平面内）
      let tx = nx2 - ox, tz = nz2 - oz;
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const lx = -tz, lz = tx;
      const y = groundY(px, pz) + 0.06;   // 贴地面（随地形）
      const a = (px + lx * half) * 1, b = (pz + lz * half);
      const c = (px - lx * half), d = (pz - lz * half);
      pos[i * 6] = a; pos[i * 6 + 1] = y; pos[i * 6 + 2] = b;
      pos[i * 6 + 3] = c; pos[i * 6 + 4] = y; pos[i * 6 + 5] = d;
    }
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      idx.push(i * 2, i * 2 + 1, j * 2, i * 2 + 1, j * 2 + 1, j * 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color: BOUNDARY_COLOR, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,   // 防与地形 z-fighting
    });
    const mesh = new THREE.Mesh(geo, mat);
    const g = new THREE.Group();
    g.add(mesh);
    g.userData.sharedMaterial = mat;
    boundaryGroup = g;
    scene.add(g);
    if (DEBUG) window.__bnd = { cx: +cx.toFixed(1), cz: +cz.toFixed(1), hx: +hx.toFixed(1), hz: +hz.toFixed(1), verts: N * 2 };
  }

  // 相机距离钳制（评审批准初值）：禁止无限 zoom-out 与把 orbit target 拖到地图外。
  // min/max 基于 world extent；数值为 initial value，实机实测后调。
  function applyCameraClamp() {
    const { ext } = WORLD_CENTER;
    controls.minDistance = Math.max(20, ext * 0.08);
    controls.maxDistance = ext * 2.2;
  }
  // 每帧夹 target（用户拖拽会平移 target；超界拉回，防止相机飞到几公里外）
  function clampCameraTarget() {
    const { cx, cz, ext } = WORLD_CENTER;
    const lim = ext * 1.1;
    const t = controls.target;
    const nx = Math.min(cx + lim, Math.max(cx - lim, t.x));
    const nz = Math.min(cz + lim, Math.max(cz - lim, t.z));
    if (nx !== t.x) t.x = nx;
    if (nz !== t.z) t.z = nz;
  }

  // ---------- 底图 + 3D 地形 ----------
  // 后端返回小地图贴图 + X-Map-Meta 铺设参数（size_m/x/z/rot90/flip_x）。
  // 方向约定：图上边 = 世界 +z，图右边 = 游戏 +x = 场景 −x（与 pos = (−x,y,z) 镜像自洽，
  // 故平面 rotation.z = π）。底图/高度场覆盖世界 [-300,+300]²（600m 方框，原点居中）。
  // terrain 端点返回 u16 LE 高度场（行 0=南，行主序）+ X-Terrain-Meta（size/zmax/span）；
  // 有高度场时用起伏地形替换 2D 平面，404 时保持 2D。
  // SpeedTree 叶卡 billboard 材质（客户端 speedtree-materials-vp.sl 同构）：
  // POSITION=锚点 pivot，_corner=(角点偏移, pivot.w)。客户端每帧在【视空间】把
  // 角点偏移（旋转风摆相位后）加回锚点——叶卡恒面向相机，这是其树丛立体感的
  // 来源；静态渲染的展开角点则是"片层堆叠"观感的根因。COLOR_0=烘焙遮挡灰度：
  // 输出 = albedo × SH(标定 1.77) × (遮挡/遮挡均值)——按均值归一化保留内暗外亮
  // 的纵深变化，又不会把整体亮度压到校准水平之下（各图贴图明暗差异大，固定
  // 系数会把暗色贴图的灌木压成黑色）。风摆为动态效果，静态导出不参与。
  // 场景 GLB 材质实例缓存：同一（name,map,color,alphaTest,transparent,opacity,occMean）
  // 复用同一材质对象。此前每个 mesh 各建一份（实测 2107 mesh ↔ 2107 材质）——材质/着色器
  // 实例与 program 切换随 mesh 数线性膨胀，是当前最大的性能开销来源。
  // 生命周期：teardown 时随 mapScenery dispose 并清空本表（勿复用已 dispose 实例）。
  const sceneryMatCache = new Map();
  function cachedSceneryMat(key, factory) {
    let m = sceneryMatCache.get(key);
    if (!m) { m = factory(); sceneryMatCache.set(key, m); }
    return m;
  }
  // 水体判定（GLB mesh/材质名启发式：seaplane/water/fountain/lake/river）
  const isWaterName = (n) => /water|sea|lake|river|fountain/i.test(n || '');

  function makeBillboardMaterial(m) {
    // GLB 的 material.extras 由 GLTFLoader 的 assignExtrasToUserData 用
    // Object.assign 平铺进 userData（不是嵌在 userData.extras 下）——写成
    // userData.extras.occMean 会恒取到 undefined，退化成 0.8 固定值，
    // 使各材质"按自身贴图均值归一化遮挡"的标定失效。
    const occRaw = m.userData && Number(m.userData.occMean);
    const occMean = Number.isFinite(occRaw) && occRaw > 0 ? occRaw : 0.8;
    // 每实体的 SH(L0) 染色：导出器把它写进 baseColorFactor（松树 1.7725 / 灌木 0.669）。
    // 客户端是 albedo × 自身 SH(L0)——此前硬编码 1.77（正好等于松树的取值），
    // 灌木因此亮 2.65×。改读材质自身取值。
    const shTintRaw = m.color ? Number(m.color.r) : NaN;
    const shTint = Number.isFinite(shTintRaw) && shTintRaw > 0 ? shTintRaw : 1.77;
    // 客户端着色器为伽马空间直采直写：关闭 sRGB 纹理解码（自定义着色器无输出
    // 重编码，sRGB 采样得到的线性值直出会整体发黑）
    if (m.map) { m.map.colorSpace = THREE.NoColorSpace; m.map.needsUpdate = true; }
    return new THREE.ShaderMaterial({
      uniforms: {
        map: { value: m.map || null },
        uSH: { value: shTint },
        uOccMean: { value: occMean },
        uAlphaCut: { value: CARD_ALPHA_CUT },
      },
      vertexShader: `
        attribute vec4 _corner;
        attribute vec4 color;
        varying vec2 vUv;
        varying float vOcc;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vec3 vp = (viewMatrix * wp).xyz;
          float ws = length(vec3(modelMatrix[0][0], modelMatrix[1][0], modelMatrix[2][0]));
          vp += _corner.xyz * ws;
          gl_Position = projectionMatrix * vec4(vp, 1.0);
          vUv = uv;
          vOcc = color.r;
        }`,
      // 用 discard 裁切走不透明管线（transparent=false）：叶卡之间排序无关，
      // 消除互遮挡闪烁（此前 transparent=true + depthWrite=true 二者冲突），
      // 同时省掉透明通道的排序开销
      transparent: false,
      depthWrite: true,
      fragmentShader: `
        uniform sampler2D map;
        uniform float uSH;
        uniform float uOccMean;
        uniform float uAlphaCut;
        varying vec2 vUv;
        varying float vOcc;
        void main() {
          vec4 c = texture2D(map, vUv);
          if (c.a < uAlphaCut) discard;
          float occ = min(vOcc / max(uOccMean, 0.001), 1.25);
          gl_FragColor = vec4(c.rgb * min(occ * uSH, 1.35), c.a);
        }`,
      side: THREE.DoubleSide,
    });
  }

  async function loadMapImage() {
    // generation guard：回放替换/销毁后，旧会话的地图资产续体一律失效——
    // 迟到的已加载纹理就地 dispose，不得写入新会话的共享状态或场景
    const gen = sessionGen;
    const stale = () => gen !== sessionGen;
    if (mapPlane) { scene.remove(mapPlane); mapPlane = null; }
    if (terrainMesh) { scene.remove(terrainMesh); terrainMesh = null; }
    if (mapScenery) { scene.remove(mapScenery); mapScenery = null; }
    mapTexture = null; mapMetaInfo = null; heightField = null; heightMeta = null;
    groundLayers = null;
    // 地面加载方式由画质档决定（低=小地图底图、中/高=分层地表），3D 地形有高度场即开启
    // 地图端点用回放数字 id（与客户端 arenaTypeID → maps.yaml 同链）；
    // 显示名可能与解析器枚举名不一致，仅作后备
    const mid = DATA.meta.map_id || 0;
    const mapq = mid ? ('id=' + mid) : ('name=' + encodeURIComponent(DATA.meta.map_name || ''));
    // 静态资产面的 key 解析（必须在 mapq 构造之后——曾放在函数首行引用未初始化的
    // mapq，TDZ ReferenceError 让整个函数静默死亡，地图/地形/场景一个请求都不发，
    // 全画质档回退占位网格）
    await resolveMapKey(mapq).catch(() => {});
    if (stale()) return;
    try {
      // 低档 res=mini：客户端小地图作地面（比高清底图小一个量级，保留 3D 起伏）
      const resp = await fetch((Q.miniMap ? mapStaticUrl('map-mini') : null) ?? mapStaticUrl('map') ?? serverMapUrl('map', mapq, Q.miniMap ? '&res=mini' : ''));
      if (stale()) return;
      if (resp.ok) {
        mapMetaInfo = JSON.parse(resp.headers.get('X-Map-Meta') || '{}');
        const url = URL.createObjectURL(await resp.blob());
        mapTexture = await new THREE.TextureLoader().loadAsync(url);
        URL.revokeObjectURL(url);
        if (stale()) { mapTexture.dispose(); mapTexture = null; return; }
        mapTexture.colorSpace = THREE.SRGBColorSpace;
        mapTexture.anisotropy = Math.min(Q.anisotropy, renderer.capabilities.getMaxAnisotropy());
        if (mapMetaInfo.flip_x) { mapTexture.wrapS = THREE.RepeatWrapping; mapTexture.repeat.x = -1; mapTexture.offset.x = 1; }
      }
    } catch (e) { console.warn('底图加载失败（回退网格）:', e); }
    try {
      const terrainBin = mapStaticUrl('terrain');
      let tmeta = {}; let tbuf = null;
      if (terrainBin) {
        // 静态资产面：meta 来自打包器物化的 terrain.json sidecar
        const m = await fetch(mapStaticUrl('terrain-meta'));
        if (stale()) return;
        if (m.ok) {
          tmeta = await m.json();
          // span = 水平世界跨度（服务端 terrain_scale 同式 max(dx,dy)，map_assets.rs）。
          // 打包器 v0.1.7 的 sidecar 误写垂直高度差（zmax-zmin，malinovka=60）——按
          // sidecar 自带的 worldBounds 自愈，否则地形被压成 span×span 小块、高度采样
          // 坍缩（地图大片露出背景色，看起来"部分贴图是黑的"）。与服务端 X-Terrain-Meta
          // 的取值一致；WotBTools 消费端同款自愈。
          const wb = tmeta.worldBounds;
          if (Array.isArray(wb?.min) && Array.isArray(wb?.max)) {
            const dx = wb.max[0] - wb.min[0];
            const dy = wb.max[1] - wb.min[1];
            if (dx > 0 || dy > 0) tmeta.span = Math.max(dx, dy);
          }
        }
        const b = await fetch(terrainBin);
        if (stale()) return;
        if (b.ok) tbuf = await b.arrayBuffer();
      } else {
        const resp = await fetch(serverMapUrl('terrain', mapq));
        if (stale()) return;
        if (resp.ok) {
          tmeta = JSON.parse(resp.headers.get('X-Terrain-Meta') || '{}');
          tbuf = await resp.arrayBuffer();
        }
      }
      {
        const meta = tmeta;
        const n = meta.size || 512;
        const buf = tbuf;
        if (buf && buf.byteLength === n * n * 2) {
          const u16 = new Uint16Array(buf);
          heightMeta = meta;
          // 预转米制高度（行 0=南，行主序；zmin 缺省 0）
          heightField = new Float32Array(n * n);
          const zmin = meta.zmin || 0;
          const k = ((meta.zmax || 100) - zmin) / 65535;
          for (let i = 0; i < u16.length; i++) heightField[i] = u16[i] * k + zmin;
        }
      }
    } catch (e) { console.warn('地形加载失败（回退 2D）:', e); }
    // 客户端同款分层地表：colormap/lightmap/tile 细节/mask/(HeightBlend 高度图)，
    // tile 纹理前端按 textureTiling 平铺全分辨率采样——清晰度等同客户端，不受整图烘焙
    // 分辨率限制。任一分层缺失则整体回退烘焙底图。
    // 注意分层一律无 alpha（Chrome 把带 alpha 的 webp 预乘解码，GPU 侧会压暗
    // 近黑），第 4 通道在独立灰度图里（tile1/mask1/hmap1 的 R）。
    // 低/中档跳过分层地表：直接走整图烘焙底图（省 4–8 张纹理下载与显存）
    if (Q.groundLayers) try {
      const mresp = await fetch(mapStaticUrl('groundmeta') ?? serverMapUrl('groundmeta', mapq));
      if (stale()) return;
      if (mresp.ok) {
        const L = await mresp.json();
        const need = L.height_blend
          ? ['cm', 'lm', 'tile0', 'tile1', 'mask0', 'mask1', 'hmap0', 'hmap1']
          : ['cm', 'lm', 'tile0', 'tile1', 'mask0', 'mask1'];
        const texs = {};
        let ok = true;
        for (const k of need) {
          try {
            const r = await fetch(mapStaticUrl('groundtex', k) ?? serverMapUrl('groundtex', mapq, '&k=' + k));
            if (!r.ok) { ok = false; break; }
            const u = URL.createObjectURL(await r.blob());
            texs[k] = await new THREE.TextureLoader().loadAsync(u);
            URL.revokeObjectURL(u);
            if (stale()) { texs[k].dispose(); delete texs[k]; ok = false; break; }
          } catch { ok = false; break; }
        }
        if (ok) {
          const ani = Math.min(Q.anisotropy, renderer.capabilities.getMaxAnisotropy());
          for (const k of ['tile0', 'tile1', 'hmap0', 'hmap1']) if (texs[k]) {
            texs[k].wrapS = texs[k].wrapT = THREE.RepeatWrapping;
            texs[k].anisotropy = ani;
          }
          // colormap/mask 也开各向异性：掠射角（坦克视角）下不糊
          for (const k of ['cm', 'lm', 'mask0', 'mask1']) if (texs[k]) {
            texs[k].anisotropy = ani;
          }
          groundLayers = { layers: L, texs };
        } else {
          // 半途失效/缺失：已加载的分层纹理就地释放，不留悬挂 GPU 资源
          for (const k in texs) texs[k]?.dispose?.();
        }
      }
    } catch (e) { console.warn('分层地表加载失败（回退烘焙底图）:', e); }
    if (stale()) return;
    // 诊断钩子：window.__gdbg 查看地表实际走的路径与已加载分层（仅 ?debug）
    if (DEBUG) window.__gdbg = { layers: !!groundLayers, texs: groundLayers ? Object.keys(groundLayers.texs) : [],
                                 meta: !!mapMetaInfo, sizeM: mapMetaInfo?.size_m ?? null };
    rebuildGround();
    // 静态场景模型（建筑/桥/岩石，tools/export_map_glb.py 预生成；缺失静默跳过）。
    // GLB 为游戏系（z 上、+y 北），qFrame = Ry(π)·Rx(-π/2)（YXZ 序）转到回放场景系——
    // 与坦克 GLB 同一帧变换，纯旋转无镜像，绕序天然正确。
    // 中/低档跳过场景 GLB（单图 11–67MB 下载 + 大块显存，是画质档最大的分流项）
    if (Q.scenery) try {
      const gltf = await new Promise((res) => {
        new GLTFLoader().load(mapStaticUrl('scenery') ?? serverMapUrl('scenery', mapq),
          (g) => res(g), undefined, () => res(null));
      });
      if (stale()) return;   // 迟到的场景 GLB：整体 GC（未渲染即未上传 GPU），不入新会话场景
      if (gltf && gltf.scene) {
        // GLTFLoader 默认 MeshStandardMaterial（PBR）比场景 Lambert 光照吃光得多，
        // 建筑会渲染成近黑——统一降级为 Lambert 并保留贴图/透明/平直着色。
        // 几何含 _CORNER 属性的叶卡走 billboard 材质（见 makeBillboardMaterial）
        const convMat = (m, isCard) => cachedSceneryMat(
          // alphaTest/transparent 必须进键：GLTFLoader 不暴露 alphaMode，同 name+map
          // 的 MASK 与 OPAQUE 材质只靠这两项区分，漏掉会串用（先建的赢）
          // （`m.alphaMode` 当前恒为 undefined，保留仅作将来 GLTFLoader 补上时的保护）
          // 染色值取原始分量而非 getHexString：后者会把 >1 的 SH(L0) 钳到 ffffff，
          // 于是"同一张贴图、不同 SH 染色"的材质在键上无法区分（叶卡 uSH 就取它）。
          [isCard ? 'C' : 'M', m.name || '', m.map ? m.map.uuid : '',
           m.color ? [m.color.r, m.color.g, m.color.b].map((v) => v.toFixed(4)).join(',') : '',
           m.alphaMode || '', m.alphaTest ?? 0, !!m.transparent, m.opacity ?? 1,
           (m.userData && m.userData.occMean) || ''].join('|'),
          () => (isCard ? makeBillboardMaterial(m) : (() => {
          // ST|（SpeedTree 树/灌木）：客户端 speedtree-materials-fp = albedo × SH，
          // 无场景光照——用不受光材质（染色值经 baseColorFactor→color 传入）
          // 客户端 SpeedTree = AlphaTest+AlphaBlend 双通道。但导出材质多为
          // 【不透明度=1 的伪透明】（transparent 却 opacity 1）：这类走混合通道会进
          // 透明渲染队列，大量重叠植被面按深度排序不稳定 → 成片闪烁。按不透明度分流：
          //   不透明度≈1 → 不透明管线 + 裁切（排序无关，消除闪烁且更快）
          //   真透明      → 混合 + 不写深度（减少互遮挡）
          const opaqueEnough = (m.opacity ?? 1) >= 0.99;
          if ((m.name || '').startsWith('ST|')) {
            const bm = new THREE.MeshBasicMaterial({
              map: m.map || null,
              color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
              transparent: !opaqueEnough,
              opacity: m.opacity ?? 1,
              side: THREE.DoubleSide,
              depthWrite: opaqueEnough ? true : false,
            });
            bm.alphaTest = opaqueEnough ? 0.33 : 0.05;   // 不透明：按 MASK 量级裁切
            bm.toneMapped = false;
            return bm;
          }
          // 伪透明（BLEND 但不透明度≈1）一律转不透明 + 裁切，消除透明排序闪烁；
          // 真透明保持混合但不写深度（避免互遮挡抖动）
          const pseudoOpaque = !!m.transparent && (m.opacity ?? 1) >= 0.99;
          const nm = new THREE.MeshLambertMaterial({
            map: m.map || null,
            // 曝光修整：这套光照是按坦克 GLB 调的，场景降级到 Lambert 后朝上面过曝
            // （岩石贴图 87.5/255 却渲染到 137/255、27% 像素近白）。只作用于本函数
            // 建出的场景材质，代理车/GLB 车模不受影响。系数表见 SCENERY_LAMBERT_EXPOSURE。
            color: (m.color ? m.color.clone() : new THREE.Color(0xffffff))
              .multiplyScalar(SCENERY_LAMBERT_EXPOSURE),
            transparent: !!m.transparent && !pseudoOpaque,
            opacity: m.opacity ?? 1,
            side: THREE.DoubleSide,
          });
          // 镂空材质必须继承 GLTFLoader 解析好的 alphaTest。GLTFLoader 不把 glTF 的
          // alphaMode 挂到材质上——MASK 只体现为 alphaTest（alphaCutoff ?? 0.5），
          // BLEND 只体现为 transparent。旧判据 `m.alphaMode === 'MASK'` 恒为 false
          // （该属性不存在），重建材质又只拷了 map/color/opacity/side，于是 MASK 的
          // 裁切被整个丢掉：铁丝网（wirebarricade）/藤蔓（ivy）/蕨/标牌这类镂空贴图
          // 按整片方片照绘，背景没被剔除——那些贴图的背景恰是纯黑（实测 ivy 背景区
          // 亮度 0.0），看上去就是一张实心黑片。
          if (m.alphaTest > 0) nm.alphaTest = m.alphaTest;
          if (pseudoOpaque) nm.alphaTest = Math.max(nm.alphaTest || 0, 0.33);
          if (nm.transparent) nm.depthWrite = false;
          nm.flatShading = true;
          return nm;
        })()));
        // 退化几何隔离（防护）：旧版导出器把树的三角列表误判为 strip 解析，
        // 产生横跨整个模型的长条三角形（撕裂）并使面数虚高（实测 20–29 面/顶点，
        // 修正后同批树为 7–10）。阈值 15 恰好区分：已重导出的地图保留树，
        // 未重导出地图的撕裂批次整批移除（不渲染/不占 draw call/回收显存）。
        // 允许 ?degrade=N 覆盖（调试用）。
        const degradedMeshes = [];
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          const g0 = o.geometry;
          const vc = g0.attributes.position ? g0.attributes.position.count : 0;
          const ic = g0.index ? g0.index.count : vc;
          const degLimit = (() => {
            const q = Number(new URLSearchParams(location.search).get('degrade'));
            return Number.isFinite(q) && q > 0 ? q : 15;
          })();
          if (vc > 0 && (ic / 3) / vc > degLimit) degradedMeshes.push(o);
        });
        for (const o of degradedMeshes) {
          o.removeFromParent();
          o.geometry.dispose();   // 每 mesh 独立几何；材质为共享（缓存）不在此释放
        }
        if (DEBUG) window.__degradedSkipped = degradedMeshes.length;
        gltf.scene.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          // GLTFLoader 会把自定义属性名转小写：GLB 里的 _CORNER → geometry._corner
          const isCard = !!o.geometry.attributes._corner;
          o.material = Array.isArray(o.material) ? o.material.map((m) => convMat(m, isCard))
                                                 : convMat(o.material, isCard);
          // 水体（海平面等半透明大面）：透明 + depthWrite=true + DoubleSide 会与
          // 地形/自身共面产生 z-fighting 与透明互遮挡闪烁。改单面渲染 + 不写深度
          // （透明面靠排序绘制），并置后渲染顺序。
          if (isWaterName(o.name)) {
            const ms = Array.isArray(o.material) ? o.material : [o.material];
            for (const mm of ms) {
              if (!mm || !mm.transparent) continue;
              // 实测（erlenberg）：水面为恒定高度的水平面（y 恒定），与地形高度差
              // -6.9~+7.7m 且无一采样点接近 0 → 并非与地形共面，排除 z-fighting。
              // 其几何极简（少数大三角形），depthWrite=false 时大三角形上的深度插值
              // 精度不足，与 512² 地形逐像素比较会在大面积上帧间交替 → 闪。
              // 该面是无厚度水平面（双面同深度、不自我遮挡），且为全场唯一透明物 →
              // 让其正常写深度最稳：比较结果由水面自身深度一次决定。
              mm.depthWrite = true;
              mm.side = THREE.DoubleSide;
              mm.depthTest = true;
              mm.needsUpdate = true;
            }
            // 不设 renderOrder：交给 THREE 在透明队列内按摄像机距离排序
            //（此前设 -1 让水面最先绘制，与其余半透明层遮挡关系错乱，接近时抖）
          }
          if (isCard) {
            // 包围球按锚点计算，角点向外超出——扩 2m 防视锥剔除边缘闪没
            if (o.geometry.boundingSphere) o.geometry.boundingSphere.radius += 2;
          }
        });
        mapScenery = new THREE.Group();
        mapScenery.rotation.order = 'YXZ';
        mapScenery.rotation.set(-Math.PI / 2, Math.PI, 0);
        mapScenery.add(gltf.scene);
        scene.add(mapScenery);
        regroundBases();   // 场景就位后把基地圆环/圆盘贴回地表

        // 天空盒（SkyFlattenSphere 天穹）不显示；草地已整体移除（GLB 无草地网格）
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          if (/sky/i.test(o.name || '')) o.visible = false;
        });
        if (DEBUG) window.__sceneryHealth = (match) => {
          // 几何健康度：面片边长相对模型尺寸的分布。若大量面片边长远超模型
          // 自身尺寸（长边/对角线 → 1），说明顶点连接错乱（撕裂）；正常网格
          // 绝大多数边应远小于对角线。
          const pick = (o) => /Linden|Spruce|bush|tree/i.test(o.name || '');
          const out = [];
          gltf.scene.traverse((o) => {
            if (!o.isMesh || !pick(o)) return;
            if (match && !(o.name || '').includes(match)) return;
            const g = o.geometry;
            const pos = g.attributes.position;
            if (!pos) return;
            g.computeBoundingBox();
            const bb = g.boundingBox;
            const diag = bb.min.distanceTo(bb.max) || 1;
            const idx = g.index ? g.index.array : null;
            const n = idx ? idx.length : pos.count;
            let maxEdge = 0, over = 0, count = 0, sum = 0;
            const A = new THREE.Vector3(), B = new THREE.Vector3();
            const step = Math.max(3, Math.floor(n / 3 / 3000) * 3);   // 采样 ~3000 面
            for (let i = 0; +i < n - 2; i += step) {
              const a1 = idx ? idx[i] : i, b1 = idx ? idx[i + 1] : i + 1, c1 = idx ? idx[i + 2] : i + 2;
              const vs = [a1, b1, c1];
              for (let k = 0; k < 3; k++) {
                A.fromBufferAttribute(pos, vs[k]);
                B.fromBufferAttribute(pos, vs[(k + 1) % 3]);
                const e = A.distanceTo(B);
                maxEdge = Math.max(maxEdge, e); sum += e; count++;
                if (e > diag * 0.3) over++;
              }
            }
            out.push({ name: o.name, vtx: pos.count, tris: Math.round(n / 3),
                       diag: +diag.toFixed(2), maxEdge: +maxEdge.toFixed(2),
                       ratioMax: +(maxEdge / diag).toFixed(3),
                       avgEdge: +(sum / Math.max(1, count)).toFixed(3),
                       longEdgePct: +(100 * over / Math.max(1, count)).toFixed(1) });
          });
          return out.slice(0, 10);
        };
        if (DEBUG) window.__waterVsTerrain = () => {
          // 水面顶点高度 vs 该处地形采样高度：差值接近 0 即深度竞争区（闪烁源）
          const out = [];
          gltf.scene.traverse((o) => {
            if (!o.isMesh || !isWaterName(o.name)) return;
            const g = o.geometry; const pos = g.attributes.position;
            if (!pos) return;
            o.updateWorldMatrix(true, false);
            const v = new THREE.Vector3();
            let yMin = Infinity, yMax = -Infinity, dMin = Infinity, dMax = -Infinity, near0 = 0, n = 0;
            const step = Math.max(1, Math.floor(pos.count / 300));
            for (let i = 0; i < pos.count; i += step) {
              v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
              const th = sampleHeight(v.x, v.z);          // 该处地形高度（米）
              const d = v.y - th;
              yMin = Math.min(yMin, v.y); yMax = Math.max(yMax, v.y);
              dMin = Math.min(dMin, d); dMax = Math.max(dMax, d);
              if (Math.abs(d) < 0.5) near0++;
              n++;
            }
            out.push({ mesh: o.name, samples: n, waterY: [+yMin.toFixed(2), +yMax.toFixed(2)],
                       diffTerrain: [+dMin.toFixed(2), +dMax.toFixed(2)],
                       nearZeroPct: +(100 * near0 / Math.max(1, n)).toFixed(1),
                       renderOrder: o.renderOrder, depthWrite: (Array.isArray(o.material)?o.material[0]:o.material).depthWrite });
          });
          return out;
        };
        if (DEBUG) window.__transparentMeshes = () => {
          // 列出全部透明网格（闪烁排查）：名 / opacity / depthWrite / side / 材质名
          const out = [];
          gltf.scene.traverse((o) => {
            if (!o.isMesh || !o.material) return;
            const ms = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of ms) {
              if (!m || !m.transparent) continue;
              const g = o.geometry;
              const idx = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
              out.push({
                mesh: (o.name || '').slice(0, 34),
                mat: (m.name || '').slice(0, 22),
                opacity: m.opacity, depthWrite: m.depthWrite, depthTest: m.depthTest,
                side: m.side, tris: Math.round(idx / 3),
                waterRe: /water|sea|lake|river|fountain/i.test(o.name || ''),
              });
            }
          });
          return { count: out.length, big: out.filter(x => x.tris > 200).slice(0, 25) };
        };
        if (DEBUG) window.__sceneryDetail = () => {
          const groups = new Map(); const all = [];
          gltf.scene.traverse((o) => {
            if (!o.isMesh) return;
            const g = o.geometry;
            const vtx = g.attributes.position ? g.attributes.position.count : 0;
            const tri = (g.index ? g.index.count : vtx) / 3;
            const card = !!g.attributes._corner;
            const base = (o.name || '(unnamed)').replace(/[0-9_]+$/, '');
            const key = base + (card ? ' [card]' : '');
            const e = groups.get(key) || { n: 0, tri: 0, vtx: 0, card };
            e.n++; e.tri += tri; e.vtx += vtx; groups.set(key, e);
            all.push({ name: o.name, tri: Math.round(tri), vtx, card,
                       mat: (Array.isArray(o.material) ? o.material[0] : o.material)?.type });
          });
          const top = [...groups.entries()].sort((x, y) => y[1].tri - x[1].tri).slice(0, 12)
            .map(([k, v]) => ({ key: k, meshes: v.n, tris: Math.round(v.tri),
                                avgTri: Math.round(v.tri / v.n), vtx: v.vtx, card: v.card }));
          all.sort((x, y) => y.tri - x.tri);
          const cards = all.filter((x) => x.card);
          return { topGroups: top, biggest: all.slice(0, 8),
                   cardMeshes: cards.length,
                   cardTris: Math.round(cards.reduce((a2, b2) => a2 + b2.tri, 0)),
                   totalMeshes: all.length };
        };
        if (DEBUG) window.__sceneryStats = () => {
          let meshes = 0, tris = 0, transparent = 0;
          const mats = new Set(); const names = new Map(); const waterish = [];
          gltf.scene.traverse((o) => {
            if (!o.isMesh) return;
            meshes++;
            const ms = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of ms) {
              if (!m) continue;
              mats.add(m.uuid);
              if (m.transparent) transparent++;
              const key = (m.name || o.name || '(unnamed)');
              names.set(key, (names.get(key) || 0) + 1);
              if (/water|sea|lake|river/i.test((m.name || '') + ' ' + (o.name || ''))) {
                waterish.push({ mesh: o.name, mat: m.name, type: m.type,
                  transparent: m.transparent, depthWrite: m.depthWrite,
                  opacity: m.opacity, side: m.side, alphaTest: m.alphaTest ?? null });
              }
            }
            const g = o.geometry;
            const cnt = g.index ? g.index.count : (g.attributes.position?.count || 0);
            tris += cnt / 3;
          });
          const top = [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
          return { meshes, uniqueMaterials: mats.size, transparentMeshes: transparent,
                   triangles: Math.round(tris), topMaterialNames: top, waterish };
        };
      }
    } catch (e) { console.warn('场景模型加载失败（忽略）:', e); }
  }

  // 双线性采样世界 (x,z) 处高度（米）；无高度场返回 0
  function sampleHeight(x, z) {
    if (!heightField) return 0;
    const n = heightMeta.size, span = heightMeta.span || 600;
    const fx = (x / span + 0.5) * (n - 1), fy = (z / span + 0.5) * (n - 1);
    const x0 = Math.max(0, Math.min(n - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(n - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
    const at = (r, c) => heightField[r * n + c];
    const top = at(y0, x0) * (1 - tx) + at(y0, x0 + 1) * tx;
    const bot = at(y0 + 1, x0) * (1 - tx) + at(y0 + 1, x0 + 1) * tx;
    return top * (1 - ty) + bot * ty;
  }

  // 依据 mapTexture/heightField 重建地面（2D 平面或 3D 地形二选一）
  // 客户端 Landscape/tilemask-fp.sl 非 PBR 路径的实时合成材质（离线着色器解码
  // 逐分支核对）：GLOBAL_TINT（globalFlatColor×2 + lightmap 通道 brightness/
  // contrast/gamma 调整）、SCALED_TILES（每通道各自 tileScale）、HEIGHT_BLEND
  // （tilemaskWeight×(mask×2−1) + hMap×scale + offset，softness 归一加权）。
  // UV 在片元由世界坐标反推（colormap 原始空间，分层贴图行序未翻转：
  // u = 0.5−X/s、v = 0.5−Z/s）；tile/height 用 Repeat 平铺原生分辨率采样，
  // 清晰度等同客户端。伽马空间直出（客户端着色器同为 sRGB 纹理直采直写）。
  function groundShaderMaterial(L, texs, size, cx, cz) {
    return new THREE.ShaderMaterial({
      defines: {
        GLOBAL_TINT: !!L.flatcolor,
        SEPARATE_LM: !!L.separate_lm,
        SCALED_TILES: !!L.scaled_tiles,
        HEIGHT_BLEND: !!L.height_blend,
      },
      uniforms: {
        uCM: { value: texs.cm }, uLM: { value: texs.lm },
        uTile0: { value: texs.tile0 }, uTile1: { value: texs.tile1 },
        uMask0: { value: texs.mask0 }, uMask1: { value: texs.mask1 },
        uHMap0: { value: texs.hmap0 || texs.tile0 },
        uHMap1: { value: texs.hmap1 || texs.tile1 },
        uSize: { value: size }, uCenter: { value: new THREE.Vector2(cx, cz) },
        uTiling: { value: new THREE.Vector2(L.tiling[0], L.tiling[1]) },
        uTileScale: { value: new THREE.Vector4(L.tile_scale[0], L.tile_scale[1],
                                               L.tile_scale[2], L.tile_scale[3]) },
        uTC: { value: L.tile_colors.map((c) => new THREE.Vector3(c[0], c[1], c[2])) },
        uFlatColor: { value: new THREE.Vector3(L.flat_color[0], L.flat_color[1], L.flat_color[2]) },
        uLmAdjust: { value: new THREE.Vector3(L.lm_adjust[0], L.lm_adjust[1], L.lm_adjust[2]) },
        uTmWeight: { value: L.tilemask_weight },
        uHbScale: { value: new THREE.Vector4(L.hb_scale[0], L.hb_scale[1],
                                             L.hb_scale[2], L.hb_scale[3]) },
        uHbOffset: { value: new THREE.Vector4(L.hb_offset[0], L.hb_offset[1],
                                              L.hb_offset[2], L.hb_offset[3]) },
        uHbSoft: { value: new THREE.Vector4(L.hb_softness[0], L.hb_softness[1],
                                            L.hb_softness[2], L.hb_softness[3]) },
      },
      vertexShader: `
        varying vec2 vXZ;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vXZ = wp.xz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform sampler2D uCM;
        uniform sampler2D uLM;
        uniform sampler2D uTile0;
        uniform sampler2D uTile1;
        uniform sampler2D uMask0;
        uniform sampler2D uMask1;
        uniform sampler2D uHMap0;
        uniform sampler2D uHMap1;
        uniform float uSize;
        uniform vec2 uCenter;
        uniform vec2 uTiling;
        uniform vec4 uTileScale;
        uniform vec3 uTC[4];
        uniform vec3 uFlatColor;
        uniform vec3 uLmAdjust;
        uniform float uTmWeight;
        uniform vec4 uHbScale;
        uniform vec4 uHbOffset;
        uniform vec4 uHbSoft;
        varying vec2 vXZ;

        void main() {
          vec2 tc = vec2(0.5 - (vXZ.x - uCenter.x) / uSize,
                         0.5 - (vXZ.y - uCenter.y) / uSize);
          vec3 colorAlbedo = texture2D(uCM, tc).rgb;
          float lmA = texture2D(uLM, tc).r;
          #ifdef GLOBAL_TINT
          colorAlbedo *= uFlatColor * 2.0;
          #ifdef SEPARATE_LM
          lmA = pow(lmA, uLmAdjust.b);
          lmA = (lmA - 0.5) * uLmAdjust.g + 0.5;
          lmA += uLmAdjust.r;
          #endif
          #endif
          #ifdef SEPARATE_LM
          vec3 shadowColor = colorAlbedo * lmA;
          #else
          vec3 shadowColor = colorAlbedo;
          #endif

          vec4 mask = vec4(texture2D(uMask0, tc).rgb, texture2D(uMask1, tc).r);
          vec2 tuv = tc * uTiling;
          #ifdef SCALED_TILES
          vec4 tileColor = vec4(
            texture2D(uTile0, tuv * uTileScale.x).r,
            texture2D(uTile0, tuv * uTileScale.y).g,
            texture2D(uTile0, tuv * uTileScale.z).b,
            texture2D(uTile1, tuv * uTileScale.w).r);
          #else
          vec4 tileColor = vec4(texture2D(uTile0, tuv).rgb, texture2D(uTile1, tuv).r);
          #endif

          #ifdef HEIGHT_BLEND
          #ifdef SCALED_TILES
          vec4 hMap = vec4(
            texture2D(uHMap0, tuv * uTileScale.x).r,
            texture2D(uHMap0, tuv * uTileScale.y).g,
            texture2D(uHMap0, tuv * uTileScale.z).b,
            texture2D(uHMap1, tuv * uTileScale.w).r);
          #else
          vec4 hMap = vec4(texture2D(uHMap0, tuv).rgb, texture2D(uHMap1, tuv).r);
          #endif
          vec4 mask2 = clamp(uTmWeight * (mask * 2.0 - 1.0)
                             + hMap * uHbScale + uHbOffset, 0.0, 1.0);
          float mx = max(max(mask2.x, mask2.y), max(mask2.z, mask2.w));
          vec4 hb = max(mask2 - (vec4(mx) - uHbSoft), vec4(0.001));
          vec3 detail = (tileColor.r * uTC[0] * hb.x + tileColor.g * uTC[1] * hb.y +
                         tileColor.b * uTC[2] * hb.z + tileColor.a * uTC[3] * hb.w) /
                        (hb.x + hb.y + hb.z + hb.w);
          #else
          vec3 detail = tileColor.r * mask.r * uTC[0] + tileColor.g * mask.g * uTC[1] +
                        tileColor.b * mask.b * uTC[2] + tileColor.a * mask.a * uTC[3];
          #endif

          gl_FragColor = vec4(detail * shadowColor * 2.0, 1.0);
        }`,
    });
  }

  function rebuildGround() {
    if (mapPlane) { scene.remove(mapPlane); mapPlane = null; }
    if (terrainMesh) { scene.remove(terrainMesh); terrainMesh = null; }
    if (!mapTexture && !heightField) return;
    const meta = mapMetaInfo || {};
    const size = meta.size_m || heightMeta?.span || 600;
    if (heightField) {
      // 3D 地形：高度场为场景系（列 0 = 场景 x −300，即已含游戏 x 取负），行 0 = z −300。
      // 平面经 rotation(-π/2,0,π) 放置后：世界 x = −局部x（场景镜像系）、世界 z = 局部y、
      // 高度沿局部 +z。车辆/建筑全部位于场景系 → 采样必须用**世界 x（= −局部x）**。
      // 若误用局部 x（少取一次负），地形东西镜像，坦克会陷入地内或悬空。
      // 地形网格按画质档分段（低 192 / 中 256 / 高 512）：顶点仍走双线性高度采样，
      // 降段只影响地形轮廓精度，不破坏 (x,z)→高度映射
      const geo = new THREE.PlaneGeometry(size, size, Q.terrainSeg, Q.terrainSeg);
      const pos = geo.attributes.position;
      for (let k = 0; k < pos.count; k++) {
        pos.setZ(k, sampleHeight(-pos.getX(k), pos.getY(k)));
      }
      geo.computeVertexNormals();
      // 分层地表（客户端 tilemask-fp.sl 实时合成，tile 原生分辨率平铺）优先；
      // 缺失时回退整图烘焙贴图（已含烘焙光照，不受光材质避免二次压暗；
      // toneMapped=false 保持烘焙色彩逐像素对齐客户端）
      let mat;
      if (groundLayers) {
        mat = groundShaderMaterial(groundLayers.layers, groundLayers.texs,
          size, meta.x || 0, meta.z || 0);
      } else {
        mat = new THREE.MeshBasicMaterial({ map: mapTexture });
        mat.toneMapped = false;
      }
      terrainMesh = new THREE.Mesh(geo, mat);
      terrainMesh.rotation.set(-Math.PI / 2, 0, Math.PI);
      terrainMesh.position.set(meta.x || 0, 0, meta.z || 0);
      scene.add(terrainMesh);
    } else if (mapTexture) {
      const mat = new THREE.MeshBasicMaterial({ map: mapTexture });
      mat.toneMapped = false;
      mapPlane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
      mapPlane.rotation.set(-Math.PI / 2, 0, Math.PI + (meta.rot90 || 0) * Math.PI / 2);
      mapPlane.position.set(meta.x || 0, 0.04, meta.z || 0);
      scene.add(mapPlane);
    }
    // 边界按权威可玩范围重建（terrain meta 的 playableBounds 优先，否则打包表）；
    // 两者皆缺则不画（fail-closed，绝不用 terrain span 冒充战场边界）
    buildBoundary(playableBoundsFor(DATA.meta.map_id), BOUNDARY_THICK);
    regroundBases();   // 地形就绪后把基地圆环/圆盘重新贴回地表
  }

  // ---------- 基地（争霸 A–D / 单基地）：贴地标记 ----------
  // 几何来自 mapBases.json（客户端 .sc2 提取，世界坐标；scene x = −游戏 x 镜像自洽）；
  // 状态口径与顶部基地状态条（components/BaseStatusBar.vue）共用 scene/baseStatus.js
  //（seek 折叠：每基地取 clock ≤ t 的最后一条）。渲染只做呈现，不推断协议。
  //
  // 地上只画两样，全部贴着地形（起伏地形上平面几何会被坡地埋掉）：
  //   · 圆环：当前归属色（友绿 / 敌红 / 中立白）；
  //   · 圆盘：淡归属底色 + 按占领进度从下往上“灌水”（占领方颜色）+ 圆心字母（单基地为旗帜）。
  // 圆盘贴图随相机水平朝向转正——平躺在地上，但从任何方向看字都是正的。空中不再有 HUD。
  // 颜色走 teamColors.js 的亮色口径（画在地形/贴图之上：基地环、旗帜、炮线）。
  const BASE_TEX = 256;
  const BASE_COLOR_HEX = { friendly: COLOR_FRIENDLY, enemy: COLOR_ENEMY, neutral: COLOR_UNKNOWN,
                           objective: hexToInt(TEAM_COLORS.objective) };
  const BASE_COLOR_CSS = { friendly: TEAM_COLORS.ally, enemy: TEAM_COLORS.enemy,
                           neutral: TEAM_COLORS.neutral, objective: TEAM_COLORS.objective };
  const ASSAULT_RADIUS_FALLBACK = 20;      // 客户端 scene 常不声明 radius：20m 仅呈现兜底
  let supremacyBaseIds = [];               // 本场出现过的争霸基地（轨迹 ∪ 几何），状态条按它列出
  let lastBaseViewsKey = '';

  // 逐顶点贴地的圆环（内/外两圈按地形高度采样；闭合成环带）
  function makeGroundedRing(gx, gz, radius, seg = 72) {
    const pos = new Float32Array((seg + 1) * 2 * 3);
    const idx = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const xo = gx + ca * radius, zo = gz + sa * radius;
      const xi = gx + ca * radius * 0.9, zi = gz + sa * radius * 0.9;
      pos[i * 6] = xo; pos[i * 6 + 1] = groundY(xo, zo) + 0.08; pos[i * 6 + 2] = zo;
      pos[i * 6 + 3] = xi; pos[i * 6 + 4] = groundY(xi, zi) + 0.08; pos[i * 6 + 5] = zi;
    }
    for (let i = 0; i < seg; i++) {
      idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  // 逐顶点贴地圆盘（极坐标网格，中心 + rings 圈）。offsets 记录每个顶点相对圆心的归一化
  // 偏移，UV 由 orientDiscUv 按观察方向旋转计算——几何本身不随视角重建。
  function makeGroundedDisc(gx, gz, radius, rings = 10, seg = 48) {
    const count = 1 + rings * seg;
    const pos = new Float32Array(count * 3);
    const offsets = new Float32Array(count * 2);
    pos[0] = gx; pos[1] = groundY(gx, gz) + 0.05; pos[2] = gz;
    let k = 1;
    for (let i = 1; i <= rings; i++) {
      const rr = (i / rings) * radius;
      for (let j = 0; j < seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const dx = Math.cos(a) * rr, dz = Math.sin(a) * rr;
        pos[k * 3] = gx + dx; pos[k * 3 + 1] = groundY(gx + dx, gz + dz) + 0.05; pos[k * 3 + 2] = gz + dz;
        offsets[k * 2] = dx / radius; offsets[k * 2 + 1] = dz / radius;
        k++;
      }
    }
    const idx = [];
    for (let j = 0; j < seg; j++) idx.push(0, 1 + j, 1 + ((j + 1) % seg));
    for (let i = 1; i < rings; i++) {
      const a0 = 1 + (i - 1) * seg, b0 = 1 + i * seg;
      for (let j = 0; j < seg; j++) {
        const j1 = (j + 1) % seg;
        idx.push(a0 + j, b0 + j, b0 + j1, a0 + j, b0 + j1, a0 + j1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    geo.setIndex(idx);
    geo.userData.offsets = offsets;
    return geo;
  }

  function orientDisc(geo, ux, uz) {
    orientDiscUv(geo.userData.offsets, geo.attributes.uv.array, ux, uz);
    geo.attributes.uv.needsUpdate = true;
  }

  function clearBases() {
    for (const b of baseObjects) {
      scene.remove(b.ring); b.ring.geometry.dispose(); b.ring.material.dispose();
      scene.remove(b.disc); b.disc.geometry.dispose(); b.disc.material.dispose(); b.tex.dispose();
    }
    baseObjects = [];
    supremacyBaseIds = [];
    lastBaseViewsKey = '';
    store.baseViews = [];
  }

  function addBaseMarker(baseId, kind, gx, gz, r) {
    const ring = new THREE.Mesh(
      makeGroundedRing(gx, gz, r),
      new THREE.MeshBasicMaterial({ color: BASE_COLOR_HEX.neutral, side: THREE.DoubleSide,
                                    transparent: true, opacity: 0.9, depthWrite: false,
                                    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    scene.add(ring);
    const canvas = document.createElement('canvas'); canvas.width = BASE_TEX; canvas.height = BASE_TEX;
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
    const disc = new THREE.Mesh(
      makeGroundedDisc(gx, gz, r * 0.9),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, depthWrite: false,
                                    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    scene.add(disc);
    const b = { baseId, kind, gx, gz, r, ring, disc, canvas, ctx: canvas.getContext('2d'), tex,
                stateKey: undefined, uvDir: null, ringHex: null,
                // 地形异步就绪后：按新高度场重建贴地环带与圆盘
                reground: () => {
                  ring.geometry.dispose(); ring.geometry = makeGroundedRing(gx, gz, r);
                  disc.geometry.dispose(); disc.geometry = makeGroundedDisc(gx, gz, r * 0.9);
                  b.uvDir = null;
                } };
    baseObjects.push(b);
  }

  function buildBases() {
    clearBases();
    const tracks = DATA.supremacy_bases;
    if (tracks && tracks.length) {
      // 非争霸场次不画（不靠静态几何猜模式）；无几何的地图不猜坐标，但状态条照样列出
      const seen = new Set(tracks.map((tr) => SUPREMACY_BASE_IDS[tr.base_id]).filter(Boolean));
      const entry = mapBasesData[String(DATA.meta.map_id)];
      const pts = (entry && entry.supremacy) || [];
      for (const p of pts) {
        if (!SUPREMACY_BASE_IDS.includes(p.baseId)) continue;
        seen.add(p.baseId);
        addBaseMarker(p.baseId, 'supremacy', -p.x, p.y, p.radius || 15);
      }
      supremacyBaseIds = SUPREMACY_BASE_IDS.filter((id) => seen.has(id));
    }
    if (assaultHasObjective(DATA)) {
      const entry = mapBasesData[String(DATA.meta.map_id)];
      const pts = (entry && entry.assault) || [];
      // 多 candidate 无证据 fail-closed（与 2D basesAt 同式）：几何不唯一就不画地面标记
      if (pts.length === 1) {
        addBaseMarker(ASSAULT_BASE_ID, 'assault', -pts[0].x, pts[0].y, pts[0].radius || ASSAULT_RADIUS_FALLBACK);
      }
    }
    if (DEBUG) window.__bases = baseObjects;   // 调试钩子：?debug 可查基地对象
  }
  // 调试钩子（?debug）：始终指向当前 baseObjects（clearBases 换数组后不失效）
  if (DEBUG) Object.defineProperty(window, '__curBases', { get: () => baseObjects, configurable: true });

  // 地形异步加载完成后调用：基地圆环/圆盘按真实地形高度重新贴地
  function regroundBases() {
    for (const b of baseObjects) b.reground();
  }

  /** 当前时刻的基地视图模型（顶部基地状态条与贴地标记共用同一口径） */
  function baseViewsAt(t) {
    const ft = DATA.meta.friendly_team;
    const views = [];
    if (supremacyBaseIds.length) {
      for (const state of foldSupremacyTransitions(DATA.supremacy_bases, t)) {
        if (supremacyBaseIds.includes(state.baseId)) views.push(baseView(state, ft));
      }
    }
    if (assaultHasObjective(DATA)) views.push(baseView(foldAssaultProgress(DATA.assault_bases, t), ft));
    return views;
  }

  function drawBaseDecal(b, view) {
    const ctx = b.ctx, S = BASE_TEX, c = S / 2, R = S / 2 - 2;
    const owner = BASE_COLOR_CSS[view.owner];
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.clip();
    ctx.globalAlpha = 0.2; ctx.fillStyle = owner; ctx.fillRect(0, 0, S, S);
    const fillColor = view.kind === 'assault'
      ? BASE_COLOR_CSS.objective
      : (view.capturing ? BASE_COLOR_CSS[view.capturing] : null);
    if (fillColor && view.progress != null) {
      // 从下往上“灌水”（下 = 靠近相机一侧，贴图随视角转正）
      const h = 2 * R * (view.progress / 100);
      ctx.globalAlpha = 0.5; ctx.fillStyle = fillColor; ctx.fillRect(0, c + R - h, S, h);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'round'; ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(0,0,0,.6)';
    if (view.kind === 'supremacy') {
      ctx.font = 'bold 132px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.strokeText(b.baseId, c, c + 6); ctx.fillStyle = owner; ctx.fillText(b.baseId, c, c + 6);
    } else {
      // 旗帜（单基地没有字母）：旗杆 + 三角旗
      ctx.beginPath(); ctx.moveTo(c - 26, c + 54); ctx.lineTo(c - 26, c - 54);
      ctx.lineTo(c + 42, c - 30); ctx.lineTo(c - 26, c - 6);
      ctx.stroke(); ctx.strokeStyle = BASE_COLOR_CSS.neutral; ctx.lineWidth = 8; ctx.stroke();
    }
    b.tex.needsUpdate = true;
  }

  function updateBases() {
    if (!DATA) return;
    const views = baseViewsAt(T);
    const key = views.map((v) => v.baseId + ':' + v.owner + '/' + v.capturing + '/' + v.progress).join('|');
    if (key !== lastBaseViewsKey) { lastBaseViewsKey = key; store.baseViews = views; }
    for (const b of baseObjects) {
      const view = views.find((v) => v.baseId === b.baseId);
      if (!view) continue;
      const stateKey = view.owner + '/' + view.capturing + '/' + view.progress;
      if (b.stateKey !== stateKey) { b.stateKey = stateKey; drawBaseDecal(b, view); }
      const ringHex = BASE_COLOR_HEX[view.owner];
      if (b.ringHex !== ringHex) { b.ring.material.color.setHex(ringHex); b.ringHex = ringHex; }
      // 贴图转正：字母“上”指向远离相机的方向；水平朝向变化超过约 2° 才重算 UV
      const dx = b.gx - camera.position.x, dz = b.gz - camera.position.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      const ux = dx / len, uz = dz / len;
      if (!b.uvDir || ux * b.uvDir[0] + uz * b.uvDir[1] < 0.9994) {
        orientDisc(b.disc.geometry, ux, uz);
        b.uvDir = [ux, uz];
      }
    }
  }

  // 队伍色：深绿 / 深红（teamColors.js 的深色口径）。原先亮色偏亮，在明亮地表与浅色贴图上
  // 对比不足。同源供标签卡片、花名册圆点、无 GLB 时的代理车体三处使用，保持同一调色。
  function teamColor(v) {
    const f = DATA.meta.friendly_team, t = v.def.team;
    if (t === 0 || f === 0) return COLOR_UNKNOWN;   // 中立＝白（green / red / white 口径）
    return t === f ? hexToInt(TEAM_COLORS_DEEP.ally) : hexToInt(TEAM_COLORS_DEEP.enemy);
  }

  // 标签文字/血条的阵营色——对齐 WotbTools 2D 的 TEAM_TOKENS（ALLY=GREEN / ENEMY=RED，
  // data/mapTeamColors.js）：3D 卡片不再自带阵营色底/描边/竖条，阵营语义全部由文字与血条
  // 颜色承载。未知阵营（team=0 或 friendly_team 未知）一律白——unknown ≠ enemy。
  const LABEL_TEAM_TEXT = { friendly: '#4ade80', enemy: '#f87171', neutral: '#ffffff' };
  function labelSide(v) {
    const f = DATA.meta.friendly_team, t = v.def.team;
    if (t === 0 || f === 0) return 'neutral';
    return t === f ? 'friendly' : 'enemy';
  }

  // ---------- 标签软遮挡（fast-pass）----------
  // camera → 标签锚点做一次视线检测：先撞地形或静态场景 → 弱化到
  // LABEL_BLOCKED_OPACITY；否则全不透明度。**永不隐藏**（下限 0.35，不是 0）——
  // 标签始终可见，被挡时只是明显变淡。只把地形与静态场景当 blocker，不含其他车辆。
  //
  // 成本控制（不让每个标签每帧都检测）：
  //   · 地形用高度场解析步进（LABEL_OCCL_SAMPLES 次 sampleHeight），不 raycast
  //     512² 地形网格（那是几十万三角形）；
  //   · 场景（建筑/树）才 raycast，且**每 occlStride 帧只检测一辆车**（轮转），
  //     其余帧复用上次结果；
  //   · 单次 raycast 超过 4ms（大图三角形多）自动拉长步长，避免掉帧。
  const LABEL_OPACITY = 1;
  const LABEL_BLOCKED_OPACITY = 0.35;
  const LABEL_OCCL_SAMPLES = 16;
  const LABEL_OCCL_BUDGET_MS = 4;
  let occlCursor = 0, occlTick = 0, occlStride = 1, occlCostMs = 0;
  const _occlDir = new THREE.Vector3();

  // 地形遮挡：沿 camera→anchor 采样高度场（地形高过视线即判遮挡）
  function terrainBlocksAim(cx, cy, cz, ax, ay, az) {
    if (!heightField || !heightMeta) return false;
    for (let i = 1; i < LABEL_OCCL_SAMPLES; i++) {
      const k = i / LABEL_OCCL_SAMPLES;
      const x = cx + (ax - cx) * k, z = cz + (az - cz) * k;
      const y = cy + (ay - cy) * k;
      if (sampleHeight(x, z) > y + 0.5) return true;
    }
    return false;
  }

  // 静态场景遮挡（建筑/树）：raycast，far 收到锚点之前
  function sceneryBlocksAim(anchor) {
    if (!mapScenery || !raycaster) return false;
    _occlDir.copy(anchor).sub(camera.position);
    const dist = _occlDir.length();
    if (dist < 2) return false;
    _occlDir.divideScalar(dist);
    const prevFar = raycaster.far;
    raycaster.far = dist - 1.0;   // 只关心锚点之前的遮挡物
    raycaster.set(camera.position, _occlDir);
    const hit = raycaster.intersectObject(mapScenery, true).length > 0;
    raycaster.far = prevFar;
    return hit;
  }

  function updateLabelOcclusion() {
    const n = V.length;
    if (!n) return;
    occlStride = Math.min(16, occlCostMs > LABEL_OCCL_BUDGET_MS
      ? occlStride + 1 : Math.max(1, occlStride - 1));
    if (++occlTick < occlStride) return;   // 未到检测帧：沿用缓存结果
    occlTick = 0;
    const v = V[occlCursor++ % n];
    if (!v || !v.label || !v.label.visible) return;
    const a = v.label.position;
    let blocked = terrainBlocksAim(camera.position.x, camera.position.y, camera.position.z,
                                   a.x, a.y, a.z);
    if (!blocked) {
      const t0 = performance.now();
      blocked = sceneryBlocksAim(a);
      occlCostMs = performance.now() - t0;
    } else {
      occlCostMs = 0;
    }
    v.labelOccluded = blocked;
  }

  // ---------- 标签：单块屏幕占比恒定覆盖元素（名牌 + 血量条）----------
  // 名牌 = 一行「车型名 · 玩家昵称」；血量条在卡片内、名字下方，**沿用最初版血条的格式**
  //（暗槽 #0a0e13 / #3a4450 描边 + 队色纵向渐变填充 + 浅灰 ghost + 条内白字黑描边）。
  // 卡片与文字的样式对齐 WotbTools 2D 版（.pb-labels）：半透明黑底 + 极淡白边 + 阵营色文字。
  const LABEL_FRAC = 0.0302;        // 卡片高 ≈ 视口高的 3.02%（653px 视口 → 72×19.7 CSS px）
  const LABEL_ASPECT = 512 / 140;   // 512×140：名牌一行 + 血量条 + **实时装填条**（最下一行）
  const LABEL_TEX_BASE_H = 140;     // 设计高度：drawLabel 里的绝对像素都以此为准
  const TEX_SS = 1.5;               // 贴图超采样：略高于 1:1，兼顾清晰与显存

  // 贴图分辨率跟随**实际屏幕尺寸**（修「发糊」）：卡片在屏上恒为视口高的 LABEL_FRAC，贴图只需
  // 覆盖这段像素（×超采样）。旧实现固定 512×128 不随屏幕变——1080p 下卡片只有 ~18 CSS px 高，
  // 贴图被 mipmap 缩小 7 倍，昵称落到屏上约 3.7 px 并被三线性平均成一团糊。绘制布局仍按设计
  // 坐标系写，由 drawLabel 用 ctx.scale(px / LABEL_TEX_BASE_H) 映射。
  function labelTexSize() {
    const pr = Math.min(window.devicePixelRatio || 1, 2);   // 与 labelRenderer 同口径
    const cssH = Math.max(0, container.clientHeight) * LABEL_FRAC;
    const h = Math.max(12, Math.min(LABEL_TEX_BASE_H, Math.round(cssH * pr * TEX_SS)));
    return { h, w: Math.round(h * LABEL_ASPECT) };   // canvas 尺寸必须是整数
  }
  // 视口变化后重算贴图尺寸（屏幕占比恒定 → 贴图像素数必须跟着变，否则又会发糊）
  function resizeLabelCanvases() {
    const { w, h } = labelTexSize();
    for (const v of V) {
      if (!v.labelCanvas || (v.labelCanvas.width === w && v.labelCanvas.height === h)) continue;
      v.labelCanvas.width = w; v.labelCanvas.height = h;
      v.labelDirty = true;   // 尺寸变了必须重绘（内容检测会早退）
      drawLabel(v);
    }
  }

  function updateLabels() {
    updateLabelOcclusion();   // 软遮挡：每 occlStride 帧检测一辆车
    const k = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * LABEL_FRAC;
    for (const v of V) {
      if (!v.label) continue;
      // 标签为覆盖场景根级对象：世界位置 = 车体位置 + 悬浮偏移（不再从父节点继承）
      const d = camera.position.distanceTo(v.group.position);
      // 严格 d·k：屏幕占比对所有车恒定（旧 max(0.3,…) 钳位让近处车的标签明显偏小，
      // 是尺寸不一致的来源）；下限仅防 d→0 退化
      const s = Math.max(0.05, d * k);
      v.label.scale.set(s * LABEL_ASPECT, s, 1);
      // 悬浮高度随距离缩放（近处贴车顶、远处上限 6m）
      v.label.position.copy(v.group.position);
      v.label.position.y += Math.min(6, Math.max(3.25, d * 0.045));
      // 车辆不可见时标签同步隐藏（原先经父子关系继承，现根级需显式管理）
      v.label.visible = v.group.visible && store.labelsOn;
      // 软遮挡：被地形/静态场景挡住时弱化（永不隐藏，下限 LABEL_BLOCKED_OPACITY）
      const target = v.labelOccluded ? LABEL_BLOCKED_OPACITY : LABEL_OPACITY;
      if (v.label.material.opacity !== target) v.label.material.opacity = target;
      // 装填条：按 T 时间归并求值（不累加计时器）→ **逐发状态**（客户端 Full/Active/Inactive）。
      // 重绘门控：聚合比量化成 1% 桶才重绘整张 canvas 并传纹理，否则 14 车会每帧重绘。
      const shells = shellStatesAt(v.reloadEvents, v.reloadFires, T, v.reloadSize);
      v.reloadShells = shells;
      const bucket = Math.round(fillOf(shells) * 100);
      if (bucket !== v.reloadBucket) { v.reloadBucket = bucket; v.labelDirty = true; drawLabel(v); }
    }
  }

  function makeLabel(v) {
    const { w, h } = labelTexSize();
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    v.labelCanvas = cv;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;   // canvas 本身是 sRGB，颜色直出
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, depthTest: false, depthWrite: false,
      // 卡片本体不透明（描边/底色/文字/血条全部 1.0 alpha，见 drawLabel）；这里保留
      // transparent 只为圆角外的透明像素——置 false 会让圆角变成黑方块。
      transparent: true, opacity: LABEL_OPACITY,   // 由软遮挡逐帧驱动（1 / 0.35）
    }));
    sp.renderOrder = 999;   // 最后绘制：水面/半透明层不得覆盖标签；不写深度避免
                            // 透明四边形裁掉后画的相邻标签（14 车聚簇时必现）
    sp.scale.set(10, 2.5, 1); sp.position.y = 6.2;
    v.label = sp; v.labelHp = null; v.labelDead = null;
    drawLabel(v);
    return sp;
  }

  // 圆角矩形路径（卡片/血条/进度条通用）
  function rrPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // #rrggbb → 亮度系数 k 的 css 颜色（最初版血条的纵向渐变用）
  function shadeCss(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const c = (s) => Math.min(255, Math.max(0, Math.round(((n >> s) & 255) * k)));
    return `rgb(${c(16)},${c(8)},${c(0)})`;
  }

  // 名牌 + 血量条（同一张卡片）。卡片与文字样式对齐 WotbTools 2D 版（.pb-labels +
  // data/mapTeamColors.js：ALLY=绿 #4ade80 / ENEMY=红 #f87171，未知阵营白）；
  // 血量条沿用最初版格式（暗槽 + 队色纵向渐变 + 浅灰 ghost + 条内白字黑描边）。
  // 变化检测必须在清空画布之前——先 clear 再早退会得到永久空白标签。
  function drawLabel(v) {
    const hp = hpAt(v, T), dead = deathAt(v, T);
    if (hp === v.labelHp && dead === v.labelDead && !v.labelDirty) return;
    v.labelHp = hp; v.labelDead = dead; v.labelDirty = false;
    const cv = v.labelCanvas, ctx = cv.getContext('2d');
    // 画布像素尺寸随屏幕尺寸变（labelTexSize），布局仍按 512×128 设计坐标系绘制
    const ls = cv.height / LABEL_TEX_BASE_H;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(ls, 0, 0, ls, 0, 0);
    // 最初版血条用的队色（深绿/深红口径，teamColors.js）与阵亡压暗色
    const team = '#' + new THREE.Color(teamColor(v)).getHexString();
    const base = dead ? '#4a525c' : team;
    const teamText = LABEL_TEAM_TEXT[labelSide(v)];
    // —— 卡片（2D .pb-labels）：半透明黑底 + 极淡白描边；无阵营色底/描边/左竖条 ——
    ctx.save();
    // shadowBlur/shadowOffset 不随 CTM 缩放，需按 ls 手动等比（否则小贴图下投影相对过重）
    ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 14 * ls; ctx.shadowOffsetY = 5 * ls;
    rrPath(ctx, 26, 6, 460, 128, 18);
    ctx.fillStyle = 'rgba(0, 0, 0, .55)';   // 2D 同款底色（半透明黑；阴影一次填充落其下）
    ctx.fill();
    ctx.restore();
    // 受击闪（FLASH_MS）：描边瞬亮，弱化而非隐藏
    const flashing = (flashByEid.get(v.def.eid) || 0) > performance.now();
    rrPath(ctx, 26, 6, 460, 128, 18);
    ctx.lineWidth = flashing ? 10 : 6;
    ctx.strokeStyle = flashing ? 'rgba(255,255,255,.5)' : 'rgba(255,255,255,.14)';
    ctx.stroke();
    // —— 一行文字：车型名 · 玩家昵称（阵营色 + 黑色柔光；同款样式，靠分隔点区分）——
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    const name = (dead ? '✝ ' : '') + (v.def.nickname || 'Unknown');
    const tank = v.def.tank_name || (v.def.tank_id ? 'tank_' + v.def.tank_id : '');
    const starW = (v.def.is_author && !dead) ? 40 : 0;
    const rowText = tank ? tank + ' · ' + name : name;
    const rowFont = (px) => `700 ${px}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    let tfs = 42;
    const rowWidth = () => { ctx.font = rowFont(tfs); return starW + ctx.measureText(rowText).width; };
    while (tfs > 24 && rowWidth() > 430) tfs -= 2;   // 超宽自适应缩字号（卡片内宽 460 − 留白）
    ctx.font = rowFont(tfs);
    // 文字：阵营色 + 黑色柔光（2D 里 .pb-label-* 用阵营色、.pb-hp-num 用 text-shadow）；
    // 阵亡只把文字压到 65%（2D §24 同款），卡片本身不变
    ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 10 * ls;
    if (dead) ctx.globalAlpha = 0.65;
    let tx = 256 - rowWidth() / 2;
    if (starW) {
      ctx.fillStyle = '#e8b23c'; ctx.fillText('★', tx, 36);
      tx += starW;
    }
    ctx.fillStyle = teamText;
    ctx.fillText(rowText, tx, 36);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    // —— 血量条（**最初版格式**）：暗槽 + 队色纵向渐变填充 + 浅灰 ghost + 条内白字黑描边 ——
    const frac = v.def.max_hp > 0 ? Math.max(0, Math.min(1, hp / v.def.max_hp)) : 0;
    const bx = 56, by = 60, bw = 400, bh = 44;
    rrPath(ctx, bx, by, bw, bh, 11);
    ctx.fillStyle = '#0a0e13'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#3a4450'; ctx.stroke();
    if (frac > 0 && !dead) {
      const fg = ctx.createLinearGradient(0, by + 3, 0, by + bh - 3);
      fg.addColorStop(0, shadeCss(base, 1.35));
      fg.addColorStop(.5, base);
      fg.addColorStop(1, shadeCss(base, .68));
      rrPath(ctx, bx + 3, by + 3, Math.max(16, (bw - 6) * frac), bh - 6, 8);
      ctx.fillStyle = fg; ctx.fill();
    }
    // lost-HP 幽灵段（GHOST_MS）：最初版为浅灰不透明段（与队色填充区分）
    const ghost = ghostByEid.get(v.def.eid);
    if (ghost && !dead && ghost.toFrac > ghost.fromFrac) {
      const gw = (bw - 6) * (ghost.toFrac - ghost.fromFrac);
      if (gw > 1) {
        rrPath(ctx, bx + 3 + (bw - 6) * ghost.fromFrac, by + 3, gw, bh - 6, 8);
        ctx.fillStyle = '#c8d2de';
        ctx.fill();
      }
    }
    // 血量数字（最初版格式：条上居中、白字 + 黑描边）
    const txt = v.def.max_hp > 0 ? `${hp} / ${v.def.max_hp}` : '—';
    ctx.font = '700 30px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 5; ctx.strokeStyle = '#000000';
    ctx.strokeText(txt, 256, by + bh / 2 + 1);
    ctx.fillStyle = '#fff'; ctx.fillText(txt, 256, by + bh / 2 + 1);
    // —— 实时装填条（血量条下方）：**逐发**绘制，对齐客户端 OTM 标记的 `GunStatus`
    // 客户端：`VehicleUIObjectMarker.yaml` 的 GunNHealthContainer 里、血量条之下的 70×3 细条；
    // 结构 = 一根整条暗底（fill rgba(0,0,0,.565)）+ `ShellBack` 里 N 枚 `ShellItem`（等分父宽），
    // 每枚按状态染色（`GunStatusAtlas.style.yaml`）：loaded 1.0 / used 0.250980 /
    // loading 底图隐去 + `#Reload` 进度 0.815686。
    // 客户端靠弹壳美术自带留白分隔；我们没有美术，改为把分格间隙做够（≈2 屏幕 px）——
    // **满弹时也要能数出发数**（此前 4 设计 px ≈ 0.6 屏幕 px，满条看着就是一整条）。
    // 相位流只覆盖**本方全队**：无相位流的车保持满条（= 已装填），不猜。
    const sx = 56, sy = 112, sw = 400, sh = 16;
    rrPath(ctx, sx, sy, sw, sh, sh / 2);
    ctx.fillStyle = 'rgba(0, 0, 0, .56)'; ctx.fill();              // 与客户端整条暗底 0.565 同档
    const shells = (v.reloadShells && v.reloadShells.length) ? v.reloadShells : [{ state: 'full', progress: 1 }];
    const rn = shells.length;
    const gap = rn > 1 ? 14 : 0;                                   // 固定条宽 ÷ N（客户端同式）+ 可见间隙
    const segW = (sw - gap * (rn - 1)) / rn;
    for (let k = 0; k < rn; k++) {
      const st = shells[k] || { state: 'empty', progress: 0 };
      const x = sx + k * (segW + gap);
      const f = st.state === 'full' ? 1
        : st.state === 'loading' ? Math.max(0, Math.min(1, st.progress)) : 0;
      if (st.state === 'empty') {
        // 客户端 used = 底图 alpha .250980（**仍可见**：用户就是靠它数还剩几发）
        rrPath(ctx, x, sy, segW, sh, sh / 2);
        ctx.fillStyle = 'rgba(244,248,252,.25)'; ctx.fill();
      } else if (f > 0) {
        rrPath(ctx, x, sy, Math.max(2, segW * f), sh, sh / 2);
        ctx.fillStyle = st.state === 'loading' ? 'rgba(244,248,252,.82)' : '#f4f8fc';
        ctx.fill();
      }
    }
    v.label.material.map.needsUpdate = true;
  }


  function buildVehicles() {
    // 低模车体：俯视六边形轮廓（平尾 + 尖首）挤压成棱柱，配合尾部散热格栅——
    // 炮管之外的第二重车头方向提示（GLB 关闭时的代理模型）
    const hullProfile = new THREE.Shape();
    hullProfile.moveTo(-1.6, -3.1);   // 左后
    hullProfile.lineTo(1.6, -3.1);    // 右后（尾部平直）
    hullProfile.lineTo(1.6, 1.15);    // 右舷
    hullProfile.lineTo(0, 3.1);       // 车首尖点（+z = 车头，与炮管同向）
    hullProfile.lineTo(-1.6, 1.15);   // 左舷
    hullProfile.closePath();
    const hullGeo = new THREE.ExtrudeGeometry(hullProfile, { depth: 1.05, bevelEnabled: false });
    hullGeo.rotateX(Math.PI / 2);     // 轮廓 y（车首方向）→ 世界 +z，挤出方向翻向 −y
    hullGeo.translate(0, 1.45, 0);    // 车体占 y ∈ [0.40, 1.45]（顶面接炮塔底）
    const trackGeo = new THREE.BoxGeometry(3.6, 0.75, 6.5);
    const turretGeo = new THREE.BoxGeometry(2.35, 0.85, 3.3);
    const gunGeo = new THREE.CylinderGeometry(0.14, 0.18, 5.4, 8);
    const grilleGeo = new THREE.BoxGeometry(2.0, 0.4, 0.5);
    const trackMat = new THREE.MeshLambertMaterial({ color: 0x333a44 });
    const grilleMat = new THREE.MeshLambertMaterial({ color: 0x272e38 });
    for (const def of DATA.vehicles) {
      const color = teamColor({ def });
      const g = new THREE.Group(); g.userData.eid = def.eid;
      const hull = new THREE.Mesh(hullGeo, new THREE.MeshLambertMaterial({ color }));
      const tracks = new THREE.Mesh(trackGeo, trackMat); tracks.position.y = 0.42;
      const grille = new THREE.Mesh(grilleGeo, grilleMat); grille.position.set(0, 1.62, -2.8);
      const turretG = new THREE.Group(); turretG.position.y = 1.85;
      const turret = new THREE.Mesh(turretGeo, new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(1.15) }));
      turret.position.z = -0.25;
      const gunPivot = new THREE.Group(); gunPivot.position.set(0, 0.05, 1.5);
      const gun = new THREE.Mesh(gunGeo, new THREE.MeshLambertMaterial({ color: 0x59636f }));
      gun.rotation.x = Math.PI / 2; gun.position.z = 2.4;
      gunPivot.add(gun); turretG.add(turret); turretG.add(gunPivot);
      g.add(tracks); g.add(hull); g.add(grille); g.add(turretG);
      if (def.is_author) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(3.6, 4.3, 32),
          new THREE.MeshBasicMaterial({ color: 0xe8b23c, side: THREE.DoubleSide, transparent: true, opacity: .85 }));
        ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06;
        ring.userData.keepWithGlb = true;   // GLB 模式下保留作者标记环
        g.add(ring);
      }
      const v = { def, group: g, turretG, gunPivot, meshHull: hull };
      labelScene.add(makeLabel(v));   // 标签在独立覆盖画布渲染（满 DPR，清晰度与画质档解耦）
      scene.add(g);
      V.push(v);
    }
  }

  // ---------- GLB 真实车模 ----------
  // 姿态处理与装甲查看器 world 模式（poseFromYPR / poseShooterTurretGun）同构：
  // - GLB 内部系 x右/y前/z上（models.pb 原点已按 (x,z,y) 校正到该系）；根位姿 = qYaw·qPitch·qRoll·qFrame，
  //   qFrame = Ry(π)·Rx(−π/2) 的 z-up→y-up 帧变换；yaw 传镜像值（−游戏 yaw），pitch 原值，roll 滤波层恒 0；
  // - 炮塔/炮管 = 烘焙矩阵绕枢轴旋转：炮塔 Rz(−rel)（镜像系）@ tP=track+turret，炮管 Rx(俯仰)@ gP=tP+gun_origin；
  // - 部件数据（model_origins / configs[].gun_origin / initial_turret_rotation）来自 /api/tank/{id}。

  async function loadGlb(tankId) {
    // 捕获当前会话的缓存实例：会话结束后迟到的完成写入旧 Map（已脱离新会话），
    // 模板未渲染即未上传 GPU，随 JS GC 回收——不污染新会话缓存
    const cache = glbCache;
    if (cache.has(tankId)) return cache.get(tankId);
    const p = (async () => {
      try {
        const [loader, sd] = await Promise.all([
          Promise.resolve(GLTFLoader),
          fetch(assetUrl('/api/tank/') + tankId).then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        const model = await new Promise((res) =>
          new loader().load(assetUrl(`/glb/${tankId}/model.glb`), g => res(g.scene), undefined, () => res(null)));
        if (!model) return null;
        model.scale.setScalar(1);
        // hide_elements 拆件全部渲染（与装甲检视器同规则；位于部件子树内，姿态随父节点自动跟随）
        // 缓存模板 + 部件数据（sd）；每车实例化时 clone 并重收集节点引用
        //（同 tank_id 多车共用一个实例会互相抢对象、位姿互覆盖）
        return { template: model, sd };
      } catch { return null; }
    })();
    cache.set(tankId, p);
    return p;
  }

  // 炮塔/炮管驱动部件收集 + 枢轴原点链（track+turret / +gun_origin，models.pb 数据）
  function collectGlbParts(model, sd, sel) {
    // 节点分组（装甲查看器 collectConfigNodes 同式）：gun_XX(+_mask 等) 按编号分组升序、
    // turret_XX 升序——与 build_configs 的 dense 索引序一致
    const byGroup = new Map(); const turrets = [];
    model.traverse(n => {
      const nm = n.name || '';
      const gm = nm.match(/^gun_(\d+)/);
      const tm = nm.match(/^turret_(\d+)$/);
      if (gm) { const g = parseInt(gm[1], 10); if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(n); }
      else if (tm) turrets.push(n);
    });
    const gunGroups = Array.from(byGroup.keys()).sort((a, b) => a - b)
      .map(k => byGroup.get(k).sort((a, b) => ((a.name || '') < (b.name || '') ? -1 : 1)));
    turrets.sort((a, b) => ((a.name.match(/\d+/)?.[0] | 0) - (b.name.match(/\d+/)?.[0] | 0)));
    // 选中变体 = 回放证据推断的 dense 索引（缺省 = 顶级配置），其余隐藏
    const cfgs = (sd && sd.configs && sd.configs.length) ? sd.configs : null;
    const gi = (sel && sel.gun_index != null) ? sel.gun_index
      : (cfgs ? cfgs[cfgs.length - 1].gun_index : 0);
    const ti = (sel && sel.turret_index != null) ? sel.turret_index
      : (cfgs ? cfgs[cfgs.length - 1].turret_index : 0);
    gunGroups.forEach((grp, i) => grp.forEach(n => n.visible = (i === (gi % gunGroups.length))));
    turrets.forEach((n, i) => n.visible = (i === (ti % turrets.length)));
    const turretNode = turrets.length ? turrets[ti % turrets.length] : null;
    // 摆位只取炮管本体+炮盾（精确命名）；组内其余节点（gun_XX_mask_nc 等）是炮盾子树，
    // 直接摆位会与父节点继承叠加成双重旋转（装甲查看器 gunBarrelNodes 同款过滤）
    const grp = gunGroups.length ? gunGroups[gi % gunGroups.length] : [];
    const barrelNodes = grp.filter(n => /^gun_\d+(_mask)?$/.test(n.name || ''));
    const gunNodes = barrelNodes.length ? barrelNodes : grp;
    const mo = sd && sd.model_origins;
    if (!turretNode || !mo || !mo.track || !mo.turret) {
      console.warn('[playback] glb parts incomplete: turret=' + !!turretNode + ' origins=' + !!(mo && mo.track));
      return null;
    }
    const tP = [mo.track[0] + mo.turret[0], mo.track[1] + mo.turret[1], mo.track[2] + mo.turret[2]];
    // 火炮枢轴用选中配置的 gun_origin（非默认顶级）
    const cfg = cfgs ? (cfgs.find(c => c.turret_index === ti && c.gun_index === gi) || cfgs[cfgs.length - 1]) : null;
    const gP = (cfg && cfg.gun_origin)
      ? [tP[0] + cfg.gun_origin[0], tP[1] + cfg.gun_origin[1], tP[2] + cfg.gun_origin[2]]
      : tP.slice();
    return { turretNode, gunNodes, tP, gP, itr: (sd && sd.initial_turret_rotation) || null };
  }

  // GLB 根位姿 = poseFromYPR(−yaw, pitch, 0)（共享 rig，见 scene/glbRig.js）
  function poseGlb(v) {
    v.glb.position.copy(v.group.position);
    v.glb.quaternion.copy(poseFromYPR(-yawAt(v, T), arrAt(v.def.hull_pitch, T), 0));
    const p = v.glbParts;
    if (!p) return;
    const rel = wrapPi(turretAbsAt(v, T) - yawAt(v, T));
    const tr = -rel;                       // 镜像系节点旋转角 = −rel
    const gr = gunPitchAt(v, T);           // glb 系 Rx(θ)：θ>0 = 前向(+Y)抬向 +Z = 仰角
    let turretRot = new THREE.Matrix4().makeRotationZ(tr);
    if (p.itr) {
      turretRot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
        -THREE.MathUtils.degToRad(p.itr.pitch || 0), -THREE.MathUtils.degToRad(p.itr.roll || 0),
        tr - THREE.MathUtils.degToRad(p.itr.yaw || 0), 'XYZ'));
    }
    const mT = new THREE.Matrix4().makeTranslation(p.tP[0], p.tP[1], p.tP[2]).multiply(turretRot)
      .multiply(new THREE.Matrix4().makeTranslation(-p.tP[0], -p.tP[1], -p.tP[2]));
    const mG = mT.clone().multiply(new THREE.Matrix4().makeTranslation(p.gP[0], p.gP[1], p.gP[2]))
      .multiply(new THREE.Matrix4().makeRotationX(gr))
      .multiply(new THREE.Matrix4().makeTranslation(-p.gP[0], -p.gP[1], -p.gP[2]));
    const tn = p.turretNode;
    tn.updateMatrix();
    if (!tn.userData.__bake) { tn.userData.__bake = tn.matrix.clone(); tn.matrixAutoUpdate = false; }
    tn.matrix.copy(mT.clone().multiply(tn.userData.__bake));
    for (const gn of p.gunNodes) {
      gn.updateMatrix();
      if (!gn.userData.__bake) { gn.userData.__bake = gn.matrix.clone(); gn.matrixAutoUpdate = false; }
      gn.matrix.copy(mG.clone().multiply(gn.userData.__bake));
    }
    v.glb.updateMatrixWorld(true);
  }

  async function applyGlbToggle(on) {
    const gen = sessionGen;
    glbOn = on;
    store.glbOn = on;
    if (on) {
      // 并行加载：单个大模型慢解析不阻塞其余车辆；每车 clone 独立实例。
      // generation guard：回放替换后迟到的完成不得挂载到新会话场景
      await Promise.all(V.filter(v => v.def.tank_id > 0).map(async (v) => {
        if (!v.glb) {
          const loaded = await loadGlb(v.def.tank_id);
          if (gen !== sessionGen) return;   // 迟到：模板留在旧缓存对象里随 GC 回收
          if (loaded && glbOn && !v.glb) {
            const inst = loaded.template.clone();
            inst.scale.setScalar(1);
            v.glb = inst;
            v.glbParts = collectGlbParts(inst, loaded.sd,
              { turret_index: v.def.turret_index ?? null, gun_index: v.def.gun_index ?? null });
            v.glb.visible = v.group.visible;
            scene.add(v.glb);
          }
        }
        if (v.glb) setLowPoly(v, false);
      }));
    } else {
      for (const v of V) {
        if (v.glb) { scene.remove(v.glb); v.glb = null; v.glbParts = null; }
        setLowPoly(v, true);
      }
    }
  }
  // 低模显隐（标签与作者标记环除外；GLB 根在 scene 上不经过 group）
  function setLowPoly(v, show) {
    for (const c of v.group.children) {
      if (c === v.label || c.userData.keepWithGlb) continue;
      c.visible = show;
    }
  }

  // ---------- 弹道 ----------
  const TRACER_LEN = 9;
  // 全弹道轨迹线：细 + 半透明、正常 depth test（会被地形/建筑遮挡，不穿山），
  // 按 replay clock 与飞行段同步（基准 t1+2.2s 移除、最后 1.2s 淡出，二者同乘 FX_SCALE）；
  // impact 单独使用 wall-clock transient（见 updateImpacts）
  const TRAJ_OPACITY = 0.35;
  const TRAJ_RADIUS = 0.11;
  const TRACER_RADIUS = 0.22;
  // 战斗反馈显示时长倍率（**只作用于 3D 场景**）：炮线（全弹道轨迹线）、命中特效、
  // 掉血飘字、HP 条幽灵/受击闪、击毁爆散统一乘这个系数——回放里这些反馈需要更长的可读
  // 时间，否则 1x 下弹道/数字一闪即逝。乘在下面 transient 段的基准常量之上，与 WotbTools
  // 侧（那边乘在 2D SSOT 常量之上）逐值一致；1 = 与 2D 逐值一致。
  // 不作用于飞行段（tracers：位置由 t_fire/flight_secs 决定，拉长会让炮弹看起来变慢）。
  const FX_SCALE = 2;
  let trajLines = [];

  // ---------- 战斗反馈 transient（语义与 WotBTools 2D 对齐）----------
  // 关键语义：**壁钟（真实 ms）寿命**，而非回放时钟——任意倍速下可读时长相近
  // （2D battlePlayback.js 同款常量与注释）。因用壁钟，暂停时 transient 自然走完，
  // 无需特殊处理；seek 则清空并重置事件游标（不补播历史动画）。
  // 下面四条是**基准值**（与 2D 同值），3D 侧在各使用点乘 FX_SCALE 放大显示时长。
  const FLOAT_DMG_MS = 1000;   // 伤害飘字
  const GHOST_MS = 600;        // HP 条 lost-HP 幽灵段（2D 同值）
  const FLASH_MS = 280;        // HP 条受击闪（2D 同值）
  const BURST_MS = 700;        // 击毁爆散
  const ghostByEid = new Map();  // eid -> { fromFrac, toFrac, untilMs }
  const flashByEid = new Map();  // eid -> untilMs
  let floatDmgs = [];          // { sp, tex, born, baseY, group }
  let burstFx = [];            // { g, born, rings }
  let dmgEvents = [];          // { t, eid, hpLoss }（回放时钟，升序）
  let burstEvents = [];        // { t, eid }（回放时钟，升序）
  let dmgPtr = 0, burstPtr = 0;

  // 事件源：伤害 = 血量链相邻下降幅值（幅值即丢失血量；无逐段伤害归属时仍可判
  // "谁掉了多少"）；击毁 = kills（死亡终态 × 击杀播报归属增强）。
  function buildTransientSources() {
    dmgEvents = [];
    for (const v of DATA.vehicles || []) {
      const hp = v.hp || [];
      for (let i = 1; i < hp.length; i++) {
        const loss = hp[i - 1][1] - hp[i][1];
        if (loss > 0) dmgEvents.push({ t: hp[i][0], eid: v.eid, hpLoss: loss });
      }
    }
    dmgEvents.sort((a, b) => a.t - b.t);
    burstEvents = (DATA.kills || []).map((k) => ({ t: k.t, eid: k.victim_eid }))
      .sort((a, b) => a.t - b.t);
    dmgPtr = 0; burstPtr = 0;
  }

  function vehicleByEid(eid) { return V.find((x) => x.def.eid === eid); }

  // 伤害飘字：受击车上方浮出 "-<lost>"，上浮 + 淡出（基准 1s × FX_SCALE）
  function spawnFloatDmg(eid, hpLoss) {
    const v = vehicleByEid(eid);
    if (!v || !v.group.visible) return;
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
    const c = cv.getContext('2d');
    // 可读性优先：加粗黑描边 + 外阴影 + 深橙填充（原先浅黄在黑描边偏薄时，
    // 落在亮色地形/白车上对比不足）
    c.font = 'bold 76px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 12; c.strokeStyle = 'rgba(0,0,0,.95)'; c.lineJoin = 'round';
    c.shadowColor = 'rgba(0,0,0,.85)'; c.shadowBlur = 14;
    const text = '-' + hpLoss;
    c.strokeText(text, 128, 64);
    c.shadowBlur = 0;                      // 填充不再叠阴影，保持笔画锐利
    c.fillStyle = '#ff9f1a'; c.fillText(text, 128, 64);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, depthTest: false, depthWrite: false, transparent: true, opacity: 1,
    }));
    sp.renderOrder = 1001;
    sp.scale.set(4, 2, 1);
    sp.position.copy(v.group.position); sp.position.y += 3.2;
    scene.add(sp);
    floatDmgs.push({ sp, tex, born: performance.now(), baseY: sp.position.y, group: v.group });
    // 同源触发 HP 条反馈（2D 三件套：飘字 + 幽灵 + 闪，同一 loss 事件驱动）
    const nowMs = performance.now();
    const maxHp = v.def.max_hp > 0 ? v.def.max_hp : 0;
    if (maxHp > 0) {
      const curHp = Math.max(0, hpAtRaw(v));
      const fromFrac = Math.max(0, Math.min(1, curHp / maxHp));
      const toFrac = Math.max(0, fromFrac + hpLoss / maxHp);   // 损失前比例（幽灵显示刚丢的量）
      ghostByEid.set(eid, { fromFrac, toFrac, untilMs: nowMs + GHOST_MS * FX_SCALE });
    }
    flashByEid.set(eid, nowMs + FLASH_MS * FX_SCALE);
    v.labelDirty = true;   // 标签重绘由反馈触发（否则只在 HP 整数变化时重绘）
  }

  // 供反馈使用的原始 HP（不依赖标签缓存）
  function hpAtRaw(v) { return hpAt(v, T); }

  // 击毁爆散：双层扩散环 + 中心球，基准 700ms × FX_SCALE 内扩张并淡出
  function spawnBurst(eid) {
    const v = vehicleByEid(eid);
    if (!v || !v.group.visible) return;
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffa53a, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const rings = [];
    for (const r0 of [0.8, 1.6]) {
      const mesh = new THREE.Mesh(new THREE.RingGeometry(r0, r0 + 0.45, 28), mat.clone());
      mesh.rotation.x = -Math.PI / 2;
      g.add(mesh); rings.push(mesh);
    }
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 10), mat.clone());
    g.add(ball);
    g.position.copy(v.group.position);
    scene.add(g);
    burstFx.push({ g, born: performance.now(), rings, ball });
  }

  function updateTransients() {
    const now = performance.now();
    // HP 条反馈过期清理（过期后再刷一次标签以擦除残影/闪光）
    for (const [eid, g] of ghostByEid) {
      if (now >= g.untilMs) {
        ghostByEid.delete(eid);
        const v = vehicleByEid(eid); if (v) v.labelDirty = true;
      }
    }
    for (const [eid, until] of flashByEid) {
      if (now >= until) {
        flashByEid.delete(eid);
        const v = vehicleByEid(eid); if (v) v.labelDirty = true;
      }
    }
    for (let i = floatDmgs.length - 1; i >= 0; i--) {
      const f = floatDmgs[i];
      const k = (now - f.born) / (FLOAT_DMG_MS * FX_SCALE);
      if (k >= 1) {
        scene.remove(f.sp); f.sp.material.dispose(); f.tex.dispose(); f.sp.material.map = null;
        floatDmgs.splice(i, 1);
        continue;
      }
      // 跟随车辆水平漂移 + 上浮 + 线性淡出
      f.sp.position.x = f.group.position.x;
      f.sp.position.z = f.group.position.z;
      f.sp.position.y = f.baseY + k * 4.5;
      f.sp.material.opacity = 1 - k;
    }
    for (let i = burstFx.length - 1; i >= 0; i--) {
      const b = burstFx[i];
      const k = (now - b.born) / (BURST_MS * FX_SCALE);
      if (k >= 1) {
        scene.remove(b.g);
        for (const rr of b.rings) { rr.geometry.dispose(); rr.material.dispose(); }
        b.ball.geometry.dispose(); b.ball.material.dispose();
        burstFx.splice(i, 1);
        continue;
      }
      for (let j = 0; j < b.rings.length; j++) {
        b.rings[j].scale.setScalar(1 + k * (2.2 + j * 1.6));
        b.rings[j].material.opacity = 0.85 * (1 - k);
      }
      b.ball.scale.setScalar(1 + k * 1.5);
      b.ball.material.opacity = 0.7 * (1 - k);
    }
  }

  function clearTransients() {
    for (const f of floatDmgs) {
      scene.remove(f.sp); f.sp.material.dispose(); f.tex.dispose();
    }
    floatDmgs.length = 0;
    for (const b of burstFx) {
      scene.remove(b.g);
      for (const rr of b.rings) { rr.geometry.dispose(); rr.material.dispose(); }
      b.ball.geometry.dispose(); b.ball.material.dispose();
    }
    burstFx.length = 0;
    ghostByEid.clear(); flashByEid.clear();   // 2D seek 同语义：清空且不补播
    dmgPtr = 0; burstPtr = 0;   // 游标重置：seek 后不补播历史动画
  }

  // 调试钩子（?debug）：transient 触发计数与在飞数量
  if (DEBUG) window.__transients = () => ({
    dmgTotal: dmgEvents.length, dmgPtr,
    burstTotal: burstEvents.length, burstPtr,
    floatAlive: floatDmgs.length, burstAlive: burstFx.length,
    ghostAlive: ghostByEid.size, flashAlive: flashByEid.size,
  });
  function spawnShot(s) {
    const from = new THREE.Vector3(-s.from[0], s.from[1], s.from[2]);
    const to = new THREE.Vector3(-s.to[0], s.to[1], s.to[2]);
    // 炮线唯一颜色规则 = 射手阵营（绿/红/白）；命中/跳弹/击毁不改炮线颜色
    const color = shotTeamColor(s);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(TRACER_RADIUS, TRACER_RADIUS, TRACER_LEN),
      new THREE.MeshBasicMaterial({ color }));
    scene.add(mesh);
    // WoTB 弹速高、交战近，直飞常 <0.3s——最小显示 0.22s 保证可见性
    const t1 = s.t_fire + Math.max(0.22, s.flight_secs);
    tracers.push({ mesh, from, to, t0: s.t_fire, t1, shot: s, color });
    // 全弹道轨迹线（队伍色：友军蓝/敌军红，与飞行段的命中结果色区分）：
    // 开火即显整条弹道；消失节奏与弹着点特效同步——t1+2.2s 移除、最后 1.2s 淡出
    const traj = new THREE.Mesh(
      new THREE.BoxGeometry(TRAJ_RADIUS, TRAJ_RADIUS, from.distanceTo(to)),
      new THREE.MeshBasicMaterial({
        color: shotTeamColor(s), transparent: true, opacity: TRAJ_OPACITY, depthWrite: false,
      }));
    traj.position.copy(from.clone().add(to).multiplyScalar(0.5));
    traj.lookAt(to);
    scene.add(traj);
    trajLines.push({ mesh: traj, until: t1 + 1.0 * FX_SCALE, fadeEnd: t1 + 2.2 * FX_SCALE, base: TRAJ_OPACITY });
  }
  // 炮线阵营色 = 射手阵营（唯一规则，评审批准）：green / red / white，
  // 调色常量见文件顶部（唯一事实源）。team 必须显式 ∈ {1,2} 才参与判定——
  // team=0 或 friendly_team 未知一律 white（绝不 fallback 到任一方；
  // 与射击复现 consumer 的三态阵营模型同规则）。
  function shotTeamColor(s) {
    const d = DATA.vehicles.find((x) => x.eid === s.shooter_eid);
    const t = d ? d.team : 0;
    const ft = DATA.meta.friendly_team;
    if ((t !== 1 && t !== 2) || (ft !== 1 && ft !== 2)) return COLOR_UNKNOWN;
    return t === ft ? COLOR_FRIENDLY : COLOR_ENEMY;
  }
  // 命中类型 → transient impact（评审批准；全部 transient，无 decal/弹孔）：
  //   pen（击穿）= 白色短闪 + 小环；non-pen = 明显 shock ring；ricochet = 侧向 sparks；
  //   miss（无 target）/未知结果 = 不生成 target impact。
  // 判定与 2D 同源语义：作者看 hit_flags 位，他人按 game_hit_result 降级
  const IMPACT_WHITE = 0xffffff;
  // impactKind 见 ./impactKind.js（纯函数，可单测）：非作者路径的 game_hit_result
  // 枚举里没有"跳弹"取值，只有作者 hit_flags & 0x0008 才是跳弹证据。
  function spawnImpact(tr) {
    const kind = impactKind(tr.shot);
    if (!kind) return; // miss / 结果未知：不生成 impact
    const g = new THREE.Group();
    const geo = new THREE.SphereGeometry(kind === 'nonpen' ? 0.42 : 0.72, 10, 10);
    const ball = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: IMPACT_WHITE, transparent: true }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.15, 20),
      new THREE.MeshBasicMaterial({ color: IMPACT_WHITE, side: THREE.DoubleSide, transparent: true }));
    ring.rotation.x = -Math.PI / 2;
    g.add(ball); g.add(ring);
    // ricochet：侧向 sparks（两段短射线沿弹道法向散开）
    const sparks = [];
    if (kind === 'ricochet') {
      const dir = tr.to.clone().sub(tr.from).normalize();
      const side = new THREE.Vector3(dir.z, 0, -dir.x).normalize();
      for (const sgn of [1, -1]) {
        const sp = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 2.2),
          new THREE.MeshBasicMaterial({ color: IMPACT_WHITE, transparent: true }));
        // 局部偏移：群组已置于 tr.to，子物体不得再叠加一次世界坐标（否则成 2*tr.to + offset）
        sp.position.set(side.x * sgn * 1.1, 0, side.z * sgn * 1.1);
        // 盒体沿 +Z、朝水平 ±side：直接给 yaw，不依赖 lookAt 对父子变换的处理
        sp.rotation.y = Math.atan2(side.x * sgn, side.z * sgn);
        g.add(sp); sparks.push(sp);
      }
    }
    g.position.copy(tr.to);
    scene.add(g);
    // impact 属于 UI feedback transient：寿命按真实壁钟计，而不是 replay clock。
    // 这样 0.5x / 16x 下可读时长一致；暂停时自然淡出；seek 由 clearEffects 直接清空。
    const durationMs = (kind === 'nonpen' ? 650 : kind === 'ricochet' ? 550 : 450) * FX_SCALE;
    impacts.push({ g, bornMs: performance.now(), durationMs, ball, ring, sparks, kind });
  }

  function updateImpacts() {
    const now = performance.now();
    for (let i = impacts.length - 1; i >= 0; i--) {
      const im = impacts[i];
      const k = Math.max(0, Math.min(1, (now - im.bornMs) / im.durationMs));
      if (k >= 1) {
        scene.remove(im.g);
        im.ball.geometry.dispose(); im.ball.material.dispose();
        im.ring.geometry.dispose(); im.ring.material.dispose();
        if (im.sparks) for (const sp of im.sparks) { sp.geometry.dispose(); sp.material.dispose(); }
        impacts.splice(i, 1);
        continue;
      }
      const op = 1 - k;
      im.ball.material.opacity = op;
      im.ring.material.opacity = op * 0.8;
      im.ring.scale.setScalar(1 + k * (im.kind === 'nonpen' ? 2.2 : 1.6));
      if (im.sparks) for (const sp of im.sparks) sp.material.opacity = op * 0.7;
    }
  }

  function updateTracers() {
    for (let i = tracers.length - 1; i >= 0; i--) {
      const tr = tracers[i];
      if (T < tr.t0) continue;
      const f = Math.min(1, (T - tr.t0) / (tr.t1 - tr.t0));
      const head = tr.from.clone().lerp(tr.to, f);
      const tail = tr.from.clone().lerp(tr.to, Math.max(0, f - TRACER_LEN / tr.from.distanceTo(tr.to)));
      tr.mesh.position.copy(head.clone().add(tail).multiplyScalar(0.5));
      tr.mesh.lookAt(head);
      if (f >= 1) {
        // 与 trajLines 同款释放：只 remove 不 dispose 会泄漏 GPU 侧 geometry/material
        // （一场数百发 + 反复拖进度条，显存单调增长）
        scene.remove(tr.mesh);
        tr.mesh.geometry.dispose(); tr.mesh.material.dispose();
        tracers.splice(i, 1);
        spawnImpact(tr);
      }
    }
    // 全弹道轨迹线：命中后延迟停留，再线性淡出并释放
    for (let i = trajLines.length - 1; i >= 0; i--) {
      const tl = trajLines[i];
      if (T >= tl.fadeEnd) {
        scene.remove(tl.mesh); tl.mesh.geometry.dispose(); tl.mesh.material.dispose();
        trajLines.splice(i, 1); continue;
      }
      tl.mesh.material.opacity = T <= tl.until ? tl.base
        : tl.base * Math.max(0, 1 - (T - tl.until) / (tl.fadeEnd - tl.until));
    }
  }

  // ---------- 击杀 feed / 计分 ----------
  function feedEntry(k) {
    const gen = sessionGen;
    const name = (eid) => { const v = V.find((x) => x.def.eid === eid);
      return v ? (v.def.nickname || 'Unknown') : eid === 0 ? '环境' : String(eid); };
    const causeMap = { 0: '', 1: '（火焰）', 2: '（撞击）', 3: '（环境）', 5: '（溺水）' };
    const text = k.killer_eid !== 0
      ? `${name(k.killer_eid)} 击毁 ${name(k.victim_eid)}`
      : `${name(k.victim_eid)}${causeMap[k.cause] || '阵亡'}`;
    const entry = { id: ++kfId, kill: k.killer_eid !== 0, killer: name(k.killer_eid), victim: name(k.victim_eid), text };
    store.killfeed.push(entry);
    setTimeout(() => {
      if (gen !== sessionGen) return;   // 会话已切换：条目已随 teardown 清空，不动新会话
      const i = store.killfeed.findIndex((x) => x.id === entry.id);
      if (i >= 0) store.killfeed.splice(i, 1);
    }, 8000);
  }
  function advanceKills() {
    while (killPtr < DATA.kills.length && DATA.kills[killPtr].t <= T) {
      feedEntry(DATA.kills[killPtr]);
      killPtr++;
    }
  }
  function rebuildFeed() {
    store.killfeed = [];
    const recent = DATA.kills.filter((k) => k.t <= T).slice(-6);
    for (const k of recent) feedEntry(k);
    killPtr = 0;
    while (killPtr < DATA.kills.length && DATA.kills[killPtr].t <= T) killPtr++;
  }
  function updateScore() {
    let s1 = 0, s2 = 0;
    for (const k of DATA.kills) {
      if (k.t > T) continue;
      const victim = V.find((x) => x.def.eid === k.victim_eid);
      if (!victim) continue;
      if (victim.def.team === 1) s2++; else if (victim.def.team === 2) s1++;
    }
    store.score1 = s1; store.score2 = s2;
  }

  // ---------- 名册 ----------
  function buildRoster() {
    store.roster.team1 = [];
    store.roster.team2 = [];
    store.roster.unknown = [];
    for (const v of V) {
      const d = v.def;
      const entry = {
        eid: d.eid,
        dot: '#' + new THREE.Color(teamColor(v)).getHexString(),
        nick: d.is_author ? '★ ' + (d.nickname || 'Unknown') : (d.nickname || 'Unknown'),
        tank: d.tank_name || (d.tank_id ? 'tank_' + d.tank_id : ''),
        frac: 1,
        dead: false,
        followed: false,
      };
      v.rosterEntry = entry;
      // 显式三元分组：未知阵营（team=0，如联表失败的观察者）进中性组，fail-visible
      // 且绝不污染任何一队（旧 `team!==2→team1` 把 Unknown 划给队伍 1）
      if (d.team === 2) store.roster.team2.push(entry);
      else if (d.team === 1) store.roster.team1.push(entry);
      else store.roster.unknown.push(entry);
    }
  }
  function updateRoster() {
    for (const v of V) {
      const e = v.rosterEntry;
      if (!e) continue;
      const hp = hpAt(v, T), dead = deathAt(v, T);
      const frac = v.def.max_hp > 0 ? hp / v.def.max_hp : 0;
      const w = Math.round(100 * frac);
      if (e.frac !== w) e.frac = w;
      if (e.dead !== dead) e.dead = dead;
      if (e.followed !== (FOLLOW_EID === v.def.eid)) e.followed = FOLLOW_EID === v.def.eid;
    }
  }

  // ---------- 主循环 ----------
  const tmpV = new THREE.Vector3();
  let followAnchor = null;             // 跟随模式：上一帧坦克位置（位移增量基准）
  function applyPose(v) {
    const dead = deathAt(v, T);
    // 死亡后模型不消失：coverage 在阵亡处截止，但残骸应留在最后已知位置
    // （posAt 对越界时间钳位到最后采样，即阵亡点），与游戏内残骸留场行为一致
    const vis = visibleAt(v, T) || dead;
    v.group.visible = vis;
    if (v.glb) v.glb.visible = vis;
    if (!vis) { v.wasDead = false; return; }
    posAt(v, T, tmpV);
    v.group.position.copy(tmpV);
    if (v.glb) poseGlb(v);
    // 低模位姿（GLB 显示时保留低模位姿更新，切回低模无跳变）
    v.group.rotation.order = 'YXZ';
    v.group.rotation.y = -yawAt(v, T);
    v.group.rotation.x = arrAt(v.def.hull_pitch, T);
    const rel = wrapPi(turretAbsAt(v, T) - yawAt(v, T));
    v.turretG.rotation.y = -rel;
    v.gunPivot.rotation.x = -gunPitchAt(v, T);
    // 死亡：低模灰化——降饱和 + 亮度下限（旧版直接 ×0.35，队伍色本就偏深，乘完近乎
    // 黑色剪影）。复活语义不存在，回放倒带时恢复原色。
    if (dead !== v.wasDead) {
      v.wasDead = dead;
      v.group.traverse((o) => {
        if (o.isMesh && o.material && o.material.color) {
          if (dead) {
            o.userData.__c = o.material.color.clone();
            const hsl = { h: 0, s: 0, l: 0 };
            o.material.color.getHSL(hsl);
            o.material.color.setHSL(hsl.h, hsl.s * 0.15, Math.max(0.30, hsl.l));
          } else if (o.userData.__c) {
            o.material.color.copy(o.userData.__c);
          }
        }
      });
    }
    drawLabel(v);
  }

  let winnerShown = false;
  function animate() {
    if (destroyed) return;
    rafId = requestAnimationFrame(animate);
    if (!renderer) return;   // 渲染器惰性创建（首次 startPlayback）：数据加载完成前无场景可渲染
    const dt = Math.min(clock.getDelta(), 0.1);
    if (DATA && PLAYING) {
      // 推进 + 钳制合并到纯函数里（NaN/负增量不会污染时钟）；终点是比赛结束 END，不是录像流结束
      T = advancePlaybackTime(T, END, dt * 1000, SPEED);
      if (T >= END) setPlaying(false);
      tick();
    }
    // 相机
    // 跟随模式：相机位置与视点目标按坦克逐帧位移整体平移——用户选好的方位/
    // 距离/俯仰刚性保持，不会被拉回固定机位；旋转/缩放/平移始终自由
    if (DATA && CAM === 'follow' && FOLLOW_EID) {
      const v = V.find((x) => x.def.eid === FOLLOW_EID);
      if (v && v.group.visible) {
        posAt(v, T, tmpV);
        if (!followAnchor) {
          controls.target.copy(tmpV);          // 进入跟随：视点先对准车体
        } else {
          const dx = tmpV.x - followAnchor.x, dy = tmpV.y - followAnchor.y,
                dz = tmpV.z - followAnchor.z;
          camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
          controls.target.x += dx; controls.target.y += dy; controls.target.z += dz;
        }
        followAnchor = (followAnchor || new THREE.Vector3()).copy(tmpV);
      } else followAnchor = null;
    } else followAnchor = null;
    clampCameraTarget();
    controls.update();
    updateBases();
    updateImpacts();      // wall-clock transient：暂停时也继续自然淡出
    updateTransients();
    updateLabels();
    renderer.render(scene, camera);
    // 标签覆盖画布：同一相机，标签恒在主场景之上
    if (labelRenderer) labelRenderer.render(labelScene, camera);
  }

  function tick() {
    // 弹道推进
    const shots = DATA.shots;
    while (shotPtr < shots.length && shots[shotPtr].t_fire <= T) { spawnShot(shots[shotPtr]); shotPtr++; }
    updateTracers();
    advanceKills();
    // 战斗反馈触发（游标单调前进；seek 时由 clearTransients 重置，不补播）
    while (dmgPtr < dmgEvents.length && dmgEvents[dmgPtr].t <= T) {
      const e = dmgEvents[dmgPtr++];
      spawnFloatDmg(e.eid, e.hpLoss);
    }
    while (burstPtr < burstEvents.length && burstEvents[burstPtr].t <= T) {
      spawnBurst(burstEvents[burstPtr++].eid);
    }
    for (const v of V) applyPose(v);
    updateRoster(); updateScore();
    // HUD → store
    store.timer = gameTimerLabel(T);
    // 顶栏：双方队伍血量（按全队 max_hp 汇总的剩余百分比）
    {
      let hf = 0, mf = 0, he = 0, me = 0;
      const ft = DATA.meta.friendly_team;
      const ftKnown = ft === 1 || ft === 2;   // 本方阵营未知 → 谁都不归属（unknown ≠ enemy）
      for (const v of V) {
        const tm = v.def.team;
        if (tm !== 1 && tm !== 2) continue;          // 未知阵营不计入任一方
        if (!ftKnown) continue;                      // 阵营未知：不得把全队算进敌方
        const hp = Math.max(0, hpAt(v, T)), mx = v.def.max_hp || 0;
        if (tm === ft) { hf += hp; mf += mx; } else { he += hp; me += mx; }
      }
      store.hpFriendPct = mf > 0 ? 100 * hf / mf : 0;
      store.hpEnemyPct = me > 0 ? 100 * he / me : 0;
      store.hpFriend = hf; store.hpFriendMax = mf;
      store.hpEnemy = he; store.hpEnemyMax = me;
    }
    // 顶栏：争霸实时点数——**每 tick 确定性重算**（无采样也写 null）：从争霸场切到普通场时
    // supremacy_points 缺失，若只在有采样时才写，上一场的点数会残留在 HUD 上。
    // 阵营映射只认 friendly_team ∈ {1,2}（unknown ≠ enemy，见 pointsAt）。
    {
      const pts = pointsAt(DATA.supremacy_points, T, DATA.meta.friendly_team);
      store.pointsFriend = pts.friend; store.pointsEnemy = pts.enemy;
    }
    // 基地状态（争霸 A–D / 单基地）不再在这里派生：统一由 updateBases 折叠成视图模型
    // 写 store.baseViews（顶部基地状态条与 3D 贴地标记共用同一口径）。
    if (DEBUG) window.__T = T;   // 调试钩子：当前回放时钟
    store.time = T;
    store.startTime = DATA.meta.t_start;
    // 进度条分母是比赛结束 END（非录像流结束），走满即比赛打完——不再等结算画面放完
    store.duration = END;
    if (!winnerShown && T >= END - 1e-3 && DATA.meta.winner_team) {
      winnerShown = true;
      const w = DATA.meta.winner_team, fr = DATA.meta.friendly_team;
      store.banner = {
        text: w === 0 ? '平局' : (w === fr ? '胜利' : '失败'),
        color: w === fr ? TEAM_COLORS_PANEL.ally : TEAM_COLORS_PANEL.enemy,
      };
    }
  }

  // ---------- 控制 ----------
  function setPlaying(p) {
    PLAYING = p;
    store.playing = p;
  }
  function seekTo(t) {
    T = Math.max(DATA.meta.t_start, Math.min(END, t));
    clearEffects();   // 动态层 dispose（与 teardown 同一路径，防 seek 循环累积显存）
    // 游标一律重定到「T 之后第一条」：clearEffects 已把 transient 游标归零，
    // 若不重定，紧随的 tick() 会把 t<=T 的历史飘字/爆散一次性补播（与 2D seek 语义不符）
    shotPtr = firstIndexAfter(DATA.shots, T, (x) => x.t_fire);
    dmgPtr = firstIndexAfter(dmgEvents, T);
    burstPtr = firstIndexAfter(burstEvents, T);
    rebuildFeed();
    winnerShown = false; store.banner = null;
    tick();
  }
  /** 绝对秒 seek（进度条直接给时刻，不再经 0–1000 份额中转） */
  function seekTime(t) { if (DATA) seekTo(Number(t)); }
  /** 相对跳秒：键盘 ←/→ 与传输控件步进用（PLAYBACK_STEP_SECONDS 由调用方给） */
  function seekBy(delta) { if (DATA) seekTo(T + Number(delta || 0)); }
  function setFollow(eid) {
    FOLLOW_EID = (FOLLOW_EID === eid) ? 0 : eid;
    if (FOLLOW_EID) { setCam('follow'); } else { setCam('free'); }
  }
  function setCam(mode) {
    CAM = mode;
    store.cam = mode;
    controls.enabled = true;
    if (mode === 'top') {
      FOLLOW_EID = 0;
      const { cx, cz, ext } = WORLD_CENTER;
      camera.position.set(cx, ext * 1.7, cz + 0.01);
      controls.target.set(cx, 0, cz);
    } else if (mode === 'free') {
      FOLLOW_EID = 0;
    }
  }
  // 只接受档位表内的值：面板按钮与 URL 参数都不该把场景带进"1.37×"这种未定义速度
  function setSpeed(s) { if (!isPlaybackSpeed(s)) return; SPEED = s; store.speed = s; }

  // ---------- 数据加载 ----------
  // 注：hull_yaw/turret_yaw 由后端相位解卷绕（连续域）后落盘，朴素线性插值即物理正确，
  // 前端不再二次去缠绕（旧版前端 unwrapAngleArray 已由后端数据契约取代）。

  // 递归收集 Object3D 子树的 geometry / material / texture 并各自 dispose 一次
  //（Set 去重：clone 共享的模板资源多路径命中只 dispose 一遍；three dispose 幂等，
  // 此处集合化只为省去重复遍历开销）
  function disposeObject3D(root) {
    const geos = new Set(), mats = new Set(), texs = new Set();
    root.traverse((o) => {
      if (o.geometry) geos.add(o.geometry);
      const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of ms) {
        mats.add(m);
        for (const k in m) {
          const val = m[k];
          if (val && val.isTexture) texs.add(val);
        }
      }
    });
    for (const t of texs) t.dispose();
    for (const m of mats) m.dispose();
    for (const g of geos) g.dispose();
  }

  // 动态层（弹道/弹着点/轨迹线）清除：与 seekTo 共用一条 dispose 路径
  function clearEffects() {
    clearTransients();   // 战斗反馈（飘字/爆散）：seek 后不补播
    for (const tr of tracers) {
      scene.remove(tr.mesh);
      tr.mesh.geometry.dispose(); tr.mesh.material.dispose();
    }
    tracers.length = 0;
    for (const im of impacts) {
      scene.remove(im.g);
      im.ball.geometry.dispose(); im.ball.material.dispose();
      im.ring.geometry.dispose(); im.ring.material.dispose();
    }
    impacts.length = 0;
    for (const tl of trajLines) {
      scene.remove(tl.mesh); tl.mesh.geometry.dispose(); tl.mesh.material.dispose();
    }
    trajLines.length = 0;
  }

  // 会话拆除：车辆/标签/GLB 克隆/地图与地表/特效/GLB 模板缓存全部移出场景并
  // dispose 会话拥有的 GPU 资源；异步续体经 sessionGen 递增整体失效。
  // 调用时序：loadData 拿到新数据且代数有效后、startPlayback 之前（load A → dispose
  // A → load B）；destroy 亦走此路径（route/component destroy → dispose currentSession）。
  function teardownSession() {
    sessionGen++;
    clearEffects();
    for (const v of V) {
      if (v.glb) scene.remove(v.glb);          // clone 与模板共享资源：不在此 dispose
      if (v.label) {
        labelScene.remove(v.label);
        if (v.label.material) {
          if (v.label.material.map) v.label.material.map.dispose();
          v.label.material.dispose();
        }
      }
      if (v.group) { scene.remove(v.group); disposeObject3D(v.group); }
    }
    V = [];
    for (const o of [mapPlane, terrainMesh, mapScenery, groundMesh, gridHelper]) {
      if (o) { scene.remove(o); disposeObject3D(o); }
    }
    clearBases();            // 基地（圆环 + 圆盘贴花）随会话释放
    sceneryMatCache.clear();   // 材质已随 mapScenery dispose，缓存须清空（勿复用）
    if (boundaryGroup) {
      const shared = boundaryGroup.userData.sharedMaterial;
      if (shared) shared.dispose();   // disposeObject3D 只清各自 material，共享材质在此释放
      scene.remove(boundaryGroup);
      disposeObject3D(boundaryGroup);
    }
    mapPlane = null; terrainMesh = null; mapScenery = null; groundMesh = null; gridHelper = null;
    boundaryGroup = null;
    if (mapTexture) { mapTexture.dispose(); mapTexture = null; }
    if (groundLayers) { for (const k in groundLayers.texs) groundLayers.texs[k]?.dispose?.(); }
    groundLayers = null;
    heightField = null; heightMeta = null; mapMetaInfo = null;
    // GLB 模板缓存（session-scoped）：unique shared resources dispose 一次并清缓存。
    // 未决的加载 Promise 随旧缓存对象被丢弃——迟到的模板未渲染即未上传 GPU，JS GC 回收
    for (const p of glbCache.values()) {
      p.then((entry) => { if (entry && entry.template) disposeObject3D(entry.template); })
        .catch(() => {});
    }
    glbCache = new Map();
    DATA = null;
    T = 0; END = 0; shotPtr = 0; killPtr = 0;
    winnerShown = false;
    FOLLOW_EID = 0; followAnchor = null;
    store.killfeed = [];
    store.banner = null;
    // HUD 派生字段显式归零（与 tick 的确定性重算互为双保险：会话切换不留上一场残值）
    store.pointsFriend = null; store.pointsEnemy = null;
    store.baseViews = [];
    store.hpFriendPct = 100; store.hpEnemyPct = 100;
    store.hpFriend = 0; store.hpFriendMax = 0; store.hpEnemy = 0; store.hpEnemyMax = 0;
    store.roster.team1 = [];
    store.roster.team2 = [];
    store.roster.unknown = [];
  }

  async function loadData(source) {
    // source = 路径字符串（服务端通道，兼容既有调用）或 { kind:'local', file }（本地 WASM 通道）
    const gen = ++sessionGen;   // 使上一会话的在途异步续体全部失效
    store.err = '';
    store.loading = true;
    try {
      // 数据获取在 teardown 之前：新回放解析失败时当前回放保持完好（替换语义 =
      // 新数据就位才拆旧会话）
      const data = await loadPlaybackData(
        typeof source === 'string' ? { kind: 'server', file: source } : source,
      );
      if (gen !== sessionGen) return;   // 迟到：新数据随旧代数 GC（loading 由新所有者管理）
      teardownSession();   // 内部再递增一代——gen+1 仍属本调用（仍是最新所有者）
      DATA = data;
      startPlayback();
      store.hasData = true;
    } catch (e) {
      if (gen === sessionGen || gen + 1 === sessionGen) store.err = '加载失败: ' + e.message;
    } finally {
      if (gen === sessionGen || gen + 1 === sessionGen) store.loading = false;
    }
  }
  function startPlayback() {
    if (!renderer) initScene();   // 渲染器惰性创建：此时画质档已定型（loader 选择/URL 参数）
    store.mapName = DATA.meta.map_name || ('map_' + DATA.meta.map_id);
    buildWorld();
    // catch 兜底：loadMapImage 内部各段有自己的 try，但裸调用时任何漏网异常
    // 都会变成静默的 unhandled rejection（地图消失且控制台无痕）
    loadMapImage().catch(e => console.warn('地图资产加载失败（回退网格）:', e));
    buildVehicles();
    buildRoster();
    // 实时装填相位（`DATA.reloads`，arena subtype 15/17；**仅本方全队**）→ 按 eid 归到车。
    // 采用**逐发状态**模型（对齐客户端托盘）：开火消耗一发、弹夹内间隔补一发、整夹重装重填
    // 整个弹夹，故还需要本车开火时刻；求值是纯函数（时间归并/二分），seek 与拖动天然正确。
    {
      const reloadByEid = groupByVehicle(DATA.reloads);
      const firesByEid = new Map();
      for (const s of DATA.shots || []) {
        const eid = s.shooter_eid != null ? s.shooter_eid : s.shooter;
        if (eid == null || !Number.isFinite(s.t_fire)) continue;
        let a = firesByEid.get(eid);
        if (!a) { a = []; firesByEid.set(eid, a); }
        a.push(s.t_fire);
      }
      for (const a of firesByEid.values()) a.sort((x, y) => x - y);
      for (const v of V) {
        v.reloadEvents = reloadByEid.get(v.def.eid) || [];
        v.reloadFires = firesByEid.get(v.def.eid) || [];
        v.reloadSize = inferMagazineSize(v.reloadEvents);
        v.reloadShells = null;
        v.reloadBucket = 100;   // 与初值（满夹）一致，避免首帧无谓重绘
      }
    }
    buildTransientSources();   // 战斗反馈事件源（伤害/击毁）
    if (DEBUG) window.__pbData = DATA;   // 调试钩子：检查 contract v2 字段到达情况
    buildBases();
    T = DATA.meta.t_start;
    // 时间轴终点＝比赛结束（进入战后阶段的时刻）；无战后阶段则退回录像流结束。
    // 必须在 buildVehicles 之后、setPlaying 之前定型：tick() 首帧就要写 store.duration。
    END = battleEndTime(DATA);
    shotPtr = 0; killPtr = 0;
    if (DEBUG) window.__pbV = V;   // 调试钩子：控制台可查每车 GLB/位姿状态（仅 ?debug）
    if (glbOn) applyGlbToggle(true);   // 会话切换后按用户偏好恢复 GLB 车模
    setPlaying(true);
    tick();
  }

  // 初始化：动画循环（渲染器惰性创建，画质选择先于首帧定型）。
  // 键盘监听不在这里——全局 keydown 由 composables/usePlaybackTransport.js 在
  // 组件生命周期内单点注册，并带输入框白名单（场景内核无权判断焦点落在哪）。
  animate();
  applyGlbGate();

  return {
    loadData,
    togglePlay: () => setPlaying(!PLAYING),
    setPlaying,
    setSpeed,
    seekTime,
    seekBy,
    setCam,
    setFollow,
    setGlb: (on) => { if (Q.allowGlb || !on) applyGlbToggle(on); },
    setLabels: (on) => { store.labelsOn = on; if (labelScene) labelScene.visible = on; },
    setQuality,
    qualityPresets: QUALITY_PRESETS,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(rafId);   // 显式取消：不等下一帧的 destroyed 自然退出
      teardownSession();             // 会话资源（车辆/地图/特效/GLB 模板）全量 dispose
      removeEventListener('resize', onResize);
      if (DEBUG) {
        delete window.__scene; delete window.__renderer;
        delete window.__pbV; delete window.__gdbg;
      }
      if (controls) { try { controls.dispose(); } catch (_) {} }
      if (renderer) {
        renderer.dispose();
        try { renderer.forceContextLoss(); } catch (_) {}
        renderer.domElement.remove();
      }
      if (labelRenderer) {
        labelRenderer.dispose();
        labelRenderer.domElement.remove();
      }
    },
  };
}
