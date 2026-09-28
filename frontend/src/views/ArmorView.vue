<script setup>
// 3D 装甲检视器（/armor_view/view/:tankId）：自 viewer.rs 嵌入页整体切流到 SPA。
// DOM/CSS/JS 原样平移（见 scene/tankViewer.js 头注），本组件只做宿主：
// 从路由参数注入 window.__INITIAL_TANK__ / __INITIAL_SHOOTER__，挂载后初始化场景。
// URL 参数保持旧版契约：?shooter= &config= &shell= &shot= &heatmap=1 &world=1 &view= 等。
import { onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { initTankViewer } from '../scene/tankViewer.js'

const route = useRoute()

onMounted(() => {
    window.__INITIAL_TANK__ = Number(route.params.tankId) || 0
    window.__INITIAL_SHOOTER__ = Number(route.query.shooter) || Number(route.params.tankId) || 0
    initTankViewer()
})
</script>

<template>
<div class="armor-view">
    <!-- 3D 装甲检视器 DOM：自 viewer.rs 嵌入页 <body> 原样平移（JS 按 ID 查找） -->
        <div id="loading">Loading tank model...</div>
        <div id="canvas-container"></div>
        <div id="corner-tl">
            <div id="info-panel" style="display:none;">
                <h1 id="tank-name">Loading...</h1>
                <div class="stat"><span class="label">Tier</span><span class="value" id="tank-tier"></span></div>
                <div class="stat"><span class="label">Type</span><span class="value" id="tank-type"></span></div>
                <div class="stat"><span class="label">Nation</span><span class="value" id="tank-nation"></span></div>
                <div id="armor-section">
                    <h2>Armor (mm)</h2>
                    <div class="armor-row"><span>Front</span><span class="armor-front" id="armor-front"></span></div>
                    <div class="armor-row"><span>Sides</span><span class="armor-sides" id="armor-sides"></span></div>
                    <div class="armor-row"><span>Rear</span><span class="armor-rear" id="armor-rear"></span></div>
                </div>
            </div>
            <div id="tank-selectors">
                <div class="sel-row" id="config-row" style="display:none;"><label id="config-label">Config:</label><select id="config-select"></select></div>
                <div class="sel-row">
                    <label>Equip:</label>
                    <label style="width:auto;display:flex;align-items:center;gap:3px;cursor:pointer;font-size:0.78em;"><input type="checkbox" id="eq-calibrated"> Calib.Shells</label>
                    <label style="width:auto;display:flex;align-items:center;gap:3px;cursor:pointer;font-size:0.78em;"><input type="checkbox" id="eq-enhanced"> Enh.Armor</label>
                </div>
                <div class="sel-row"><label id="shooter-label">Shooter:</label><button class="tank-btn" id="shooter-select">—</button></div>
                <div class="sel-row"><label id="target-label">Target:</label><button class="tank-btn" id="target-select">—</button></div>
            </div>
        </div>
        <div id="corner-tr">
            <div id="shell-selector" style="display:none;">
                <label style="font-size:0.85em;">Shell: </label>
                <select id="shell-select"></select>
            </div>
            <div id="view-toggle">
                <button id="collision-btn">Show Collision</button>
                <button id="penetration-btn">穿透热力图</button>
            </div>
        </div>
        <div id="tank-picker">
            <div id="tp-header">
                <span id="tp-title">Select Tank</span>
                <input type="text" id="tp-search" placeholder="Search tank...">
                <select id="tp-tier"></select>
                <select id="tp-nation"></select>
                <select id="tp-type"></select>
                <span id="tp-count"></span>
                <button id="tp-close" title="Close">×</button>
            </div>
            <div id="tp-grid"></div>
        </div>
            <div id="click-info">
                <h3 id="click-part">—</h3>
                <div class="row"><span>Base armor</span><span id="click-armor">—</span></div>
                <div class="row"><span>Angle</span><span id="click-angle">—</span></div>
                <div class="row"><span>Effective</span><span id="click-effective">—</span></div>
                <div class="row"><span>Penetration</span><span id="click-pen">—</span></div>
                <div class="row"><span>Result</span><span id="click-result">—</span></div>
            </div>
        <div id="corner-br">
            <div id="controls-hint">Drag to rotate · Scroll to zoom · Left-click: armor · Right-drag: turret/gun</div>
        </div>
        <div id="traj-info" style="display:none;position:fixed;z-index:200;pointer-events:none;"></div>
        <div id="turret-controls">
            <div class="ctrl-row"><label>Turret</label><span id="turret-val">0°</span></div>
            <div class="ctrl-row"><label>Gun</label><span id="gun-val">0°</span></div>
        </div>
</div>
</template>

<!-- 样式自旧版 <style> 平移：整体挂在 .armor-view 命名空间下（.tank-card 与 Tankopedia 冲突），
     fixed 定位改 absolute（根容器铺满 main 视口区） -->
<style>
.armor-view {
            --bg:#120f0e; --panel:rgba(27,24,23,0.92); --panel2:rgba(35,31,29,0.92);
            --border:rgba(255,255,255,0.12); --border-hi:rgba(255,138,61,0.45);
            --accent:#ff8a3d; --accent-2:#ffb35c; --accent-3:#ffd29b;
            --green:#5fbf7a; --orange:#ff9800; --red:#ff6b6b; --blue:#5fa8e8; --yellow:#ffcf5c;
            --txt:#f3ede6; --muted:#9c8f7f; --shadow:0 10px 34px rgba(0,0,0,0.5);
            --radius:14px; --radius-sm:9px;
        }
    .armor-view { margin: 0; padding: 0; background: var(--bg); color: var(--txt); font-family: system-ui, sans-serif; overflow: hidden; }
    .armor-view #canvas-container { width: 100%; height: 100%; background: radial-gradient(1100px 600px at 30% -10%, #3a2412 0%, transparent 60%), radial-gradient(1000px 600px at 90% 0%, #2f1a0c 0%, transparent 55%); }
    .armor-view /* 左上角排：信息面板与坦克选择器并排 */
        #corner-tl {
            position: absolute; top: 20px; left: 20px;
            display: flex; gap: 20px; align-items: flex-start;
        }
    .armor-view #info-panel {
            background: var(--panel); padding: 20px; border-radius: var(--radius);
            max-width: 350px; backdrop-filter: blur(12px);
            border: 1px solid var(--border); box-shadow: var(--shadow);
        }
    .armor-view #info-panel h1 { font-size: 1.5em; margin: 0 0 10px 0; color: var(--accent-3); }
    .armor-view #info-panel .stat { display: flex; justify-content: space-between; margin: 4px 0; }
    .armor-view #info-panel .label { color: var(--muted); }
    .armor-view #info-panel .value { font-weight: bold; }
    .armor-view #armor-section { margin-top: 15px; padding-top: 10px; border-top: 1px solid var(--border); }
    .armor-view #armor-section h2 { font-size: 1.1em; margin: 0 0 8px 0; color: var(--accent-2); }
    .armor-view .armor-row { display: flex; justify-content: space-between; margin: 2px 0; font-size: 0.9em; }
    .armor-view .armor-front { color: var(--green); }
    .armor-view .armor-sides { color: var(--orange); }
    .armor-view .armor-rear { color: var(--red); }
    .armor-view #armor-table { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
    .armor-view #armor-table table { width: 100%; font-size: 0.85em; border-collapse: collapse; }
    .armor-view #armor-table th { text-align: left; color: var(--muted); padding: 2px 6px; border-bottom: 1px solid var(--border); }
    .armor-view #armor-table td { padding: 2px 6px; }
    .armor-view .plate-thick { color: var(--green); font-weight: bold; }
    .armor-view .plate-thin { color: var(--red); }
    .armor-view #loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); font-size: 1.2em; color: var(--accent-3); }
    .armor-view /* 右下角栈：调试按钮(JS 动态挂入)与操作提示上下排列，互不遮挡 */
        #corner-br {
            position: absolute; bottom: 20px; right: 20px;
            display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
        }
    .armor-view #controls-hint { font-size: 0.8em; color: var(--muted); }
    .armor-view /* 调试信息窗口：原挂在 3D 场景内的 sprite 文字标签改为在此集中展示，场景只留几何标记（球/线） */
        #debug-info {
            background: var(--panel); padding: 10px 14px; border-radius: var(--radius-sm);
            backdrop-filter: blur(12px); border: 1px solid var(--border); box-shadow: var(--shadow);
            display: none; min-width: 230px; max-width: 380px; max-height: 46vh; overflow-y: auto;
            font-family: Consolas, monospace; font-size: 11px;
        }
    .armor-view #debug-info h4 { margin: 0 0 6px 0; font-size: 11px; font-weight: bold; color: var(--accent-2); font-family: system-ui, sans-serif; }
    .armor-view #debug-info .dbg-row { display: flex; align-items: center; gap: 6px; margin: 3px 0; white-space: nowrap; }
    .armor-view #debug-info .dbg-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
    .armor-view #debug-info .dbg-name { color: var(--muted); flex: none; }
    .armor-view #debug-info .dbg-val { color: var(--txt); }
    .armor-view #turret-controls {
            position: absolute; bottom: 20px; left: 20px;
            background: var(--panel); padding: 12px 16px; border-radius: var(--radius);
            backdrop-filter: blur(12px); border: 1px solid var(--border); box-shadow: var(--shadow);
            display: none; min-width: 280px; max-width: min(520px, 44vw);
        }
    .armor-view .ctrl-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 0.85em; }
    .armor-view .ctrl-row label { width: 50px; color: var(--muted); }
    .armor-view .ctrl-row span { color: var(--accent); font-weight: bold; }
    .armor-view #click-info {
            position: absolute;
            background: var(--panel); padding: 12px 16px; border-radius: var(--radius-sm);
            backdrop-filter: blur(12px); border: 1px solid var(--border-hi); box-shadow: var(--shadow);
            display: none; min-width: 200px; pointer-events: none; z-index: 100;
        }
    .armor-view #click-info h3 { margin: 0 0 8px 0; font-size: 1em; color: var(--accent-3); }
    .armor-view #click-info .row { display: flex; justify-content: space-between; margin: 3px 0; font-size: 0.9em; }
    .armor-view #click-info .pen { color: var(--green); font-weight: bold; }
    .armor-view #click-info .bounce { color: var(--red); font-weight: bold; }
    .armor-view #click-info .ricochet { color: var(--orange); font-weight: bold; }
    .armor-view /* 右上角栈：弹种选择器 + 视图切换按钮 */
        #corner-tr {
            position: absolute; top: 20px; right: 20px;
            display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
        }
    .armor-view #shell-selector {
            background: var(--panel); padding: 10px 15px; border-radius: var(--radius-sm);
            backdrop-filter: blur(12px); border: 1px solid var(--border); box-shadow: var(--shadow);
        }
    .armor-view #shell-selector select { background: #2c2724; color: var(--txt); border: 1px solid var(--border-hi); border-radius: var(--radius-sm); padding: 4px 9px; }
    .armor-view #tank-selectors {
            background: var(--panel); padding: 12px 16px; border-radius: var(--radius);
            backdrop-filter: blur(12px); border: 1px solid var(--border); box-shadow: var(--shadow);
            z-index: 20; width: 270px;
        }
    .armor-view #tank-selectors .sel-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 0.85em; }
    .armor-view #tank-selectors label { width: 58px; color: var(--muted); font-size: 0.8em; }
    .armor-view #tank-selectors .tank-btn {
            background: #2c2724; color: var(--txt); border: 1px solid var(--border); border-radius: var(--radius-sm);
            padding: 5px 10px; max-width: 176px; cursor: pointer; font-size: 0.85em;
            text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: all .12s ease;
        }
    .armor-view #tank-selectors .tank-btn:hover { border-color: var(--accent); background: #35302c; }
    .armor-view #shooter-label { color: var(--accent-2); }
    .armor-view #target-label { color: var(--green); }
    .armor-view #tank-picker {
            position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
            width: min(1060px, 94vw); height: min(700px, 88vh);
            background: var(--panel); border: 1px solid var(--border-hi);
            border-radius: var(--radius); z-index: 1000; display: none; flex-direction: column;
            box-shadow: 0 16px 70px rgba(0,0,0,0.7); backdrop-filter: blur(14px);
        }
    .armor-view #tank-picker.open { display: flex; }
    .armor-view #tp-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
    .armor-view #tp-title { font-size: 1em; font-weight: bold; color: var(--accent-3); }
    .armor-view #tp-search { flex: 1; min-width: 140px; background: #2c2724; color: var(--txt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 5px 10px; font-size: 0.85em; }
    .armor-view #tp-header select { background: #2c2724; color: var(--txt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 4px 8px; font-size: 0.82em; }
    .armor-view #tp-count { color: var(--accent); font-size: 0.8em; }
    .armor-view #tp-close { background: none; border: none; color: var(--muted); font-size: 1.4em; cursor: pointer; line-height: 1; }
    .armor-view #tp-close:hover { color: #fff; }
    .armor-view #tp-grid { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 12px; align-content: flex-start; }
    .armor-view .tank-card {
            flex: 0 0 196px; max-width: 196px;
            background: linear-gradient(180deg,#251f1c,#1b1715); border: 1px solid var(--border); border-radius: var(--radius-sm);
            overflow: hidden; cursor: pointer; transition: transform 0.08s, border-color 0.08s, box-shadow 0.08s;
        }
    .armor-view .tank-card:hover { transform: translateY(-2px); border-color: var(--accent); box-shadow: var(--shadow); }
    .armor-view .tank-card.sel { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(255,138,61,0.4); }
    .armor-view .tank-card .tc-img { width: 100%; height: 132px; object-fit: contain; background: linear-gradient(180deg,#211b17,#171310); display: block; padding: 4px; }
    .armor-view .tank-card .tc-body { padding: 6px 8px; }
    .armor-view .tank-card .tc-name { font-size: 0.84em; color: var(--txt); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .armor-view .tank-card .tc-meta { display: flex; justify-content: space-between; align-items: center; gap: 4px; margin-top: 4px; font-size: 0.74em; }
    .armor-view .tank-card .tc-tier { color: var(--yellow); font-weight: bold; }
    .armor-view .tank-card .tc-type { color: var(--muted); }
    .armor-view .tank-card .tc-nation { color: var(--green); }
    .armor-view #view-toggle {
            background: var(--panel); padding: 8px 14px; border-radius: var(--radius-sm);
            backdrop-filter: blur(12px); border: 1px solid var(--border); box-shadow: var(--shadow);
            display: flex; gap: 8px; flex-wrap: wrap;
        }
    .armor-view #view-toggle button { background: #35302c; color: var(--txt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 4px 12px; cursor: pointer; font-size: 0.85em; transition: all .12s ease; }
    .armor-view #view-toggle button:hover { border-color: var(--accent); }
    .armor-view #view-toggle button.active { background: linear-gradient(135deg,var(--accent),var(--accent-2)); color: #1a1208; border-color: transparent; }

.armor-view {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
}
</style>
