<script setup>
// Agent 聊天：三区布局（会话侧栏 / 消息流 / 输入区）。
// 自旧版 index.html chat tab 平移：事件轮询（150ms 增量）、工具调用卡片配对、
// markdown+LaTeX 气泡渲染，语义保持一致。
import { ref, reactive, nextTick, onMounted, onBeforeUnmount } from 'vue'
import {
  chatSend, chatEvents, chatCancel, sessionsList, sessionGet, sessionDelete, sessionExportBlob,
} from '../api/agent.js'
import { renderMarkdown } from '../utils/markdown.js'
import { useToast } from '../composables/useToast.js'

const { toast } = useToast()

const sessions = ref([])
const sessionId = ref('default')
const sessionName = ref('default')
const messages = ref([])
const status = reactive({ text: '', kind: '' })
const isProcessing = ref(false)
const sidebarOpen = ref(false)
const chatInput = ref('')
const chatLogEl = ref(null)
const inputEl = ref(null)

let pollTimer = null
let lastEventCount = 0
let pendingCards = {} // tool_call/tool_result 事件按工具名配对（FIFO）
let uid = 0

function setStatus(text, kind) { status.text = text; status.kind = kind || '' }
function scrollLog() { nextTick(() => { const el = chatLogEl.value; if (el) el.scrollTop = el.scrollHeight }) }

// ===== 消息条目 =====
function addBubble(role, text, isMd) {
  const m = { id: ++uid, kind: 'msg', role, text, md: !!isMd }
  messages.value.push(m)
  scrollLog()
  return m
}
// 工具名 → 中文友好描述（未收录则显示原名）
const TOOL_LABEL = {
  search_player: '搜索玩家',
  get_player_stats: '查询玩家战绩',
  scan_replays: '扫描回放',
  parse_replay: '解析回放',
  compare_replay_vs_api: '回放 vs API 对比',
  view_tank: '查询坦克资料',
  get_tank_armor: '查询坦克装甲',
  simulate_penetration: '模拟击穿判定',
  replay_shot: '3D 复现射击',
  render_heatmap: '渲染热力图截图',
}
const toolLabel = (name) => TOOL_LABEL[name] || name
function argsPreview(args) {
  let obj = args
  if (typeof args === 'string') { try { obj = JSON.parse(args) } catch { return args } }
  const s = JSON.stringify(obj)
  return s.length > 70 ? s.slice(0, 70) + '…' : s
}
function prettyJson(v) {
  try { return JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v, null, 2) }
  catch { return String(v) }
}
function addToolCard(name, args) {
  const entry = {
    id: ++uid, kind: 'tool', name, toolLabel: toolLabel(name),
    argsPreview: argsPreview(args), argsFull: prettyJson(args),
    result: '（执行中…）', state: 'run', open: false,
  }
  messages.value.push(entry)
  ;(pendingCards[name] = pendingCards[name] || []).push(entry)
  scrollLog()
  return entry
}
function setToolCardDone(card, result, forceFail) {
  if (!card) return
  // 后端把工具执行错误也作为 ToolResult 推送，以 "Error: " 前缀区分
  const isErr = forceFail || /^Error[:：]/.test(result || '')
  card.state = isErr ? 'fail' : 'ok'
  card.result = result || '（无返回内容）'
}
function resetStream() {
  lastEventCount = 0; pendingCards = {}
}

// ===== 会话侧栏 =====
async function loadSessions() {
  try {
    const d = await sessionsList()
    sessions.value = d.sessions || []
    if (!sessions.value.includes(sessionId.value)) sessions.value.push(sessionId.value)
    // default 置顶，其余按名称排序
    sessions.value.sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)))
  } catch (e) { console.warn('loadSessions:', e) }
}
async function switchSession(id) {
  const prev = sessionId.value
  if (prev !== id && isProcessing.value) {
    // 离开执行中的会话：停止本地轮询；该轮对话在后台继续执行并落盘
    finishProcessing()
    setStatus(`已切离会话 "${prev}"，该轮对话仍在后台执行`, 'busy')
  } else {
    setStatus('', '')
  }
  sessionId.value = id
  sidebarOpen.value = false
  await loadSessionHistory(id)
}
async function loadSessionHistory(sid) {
  resetStream()
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  messages.value = []
  sessionName.value = sid
  try {
    const d = await sessionGet(sid)
    renderHistory(d.messages || [])
  } catch (e) { console.warn('loadSessionHistory:', e) }
}
// 历史还原：assistant.tool_calls 生成卡片，role=tool 按 tool_call_id 回填结果
function renderHistory(list) {
  const cardById = {}
  const filled = new Set()
  ;(list || []).forEach((m) => {
    if (m.role === 'user') {
      addBubble('user', m.content)
    } else if (m.role === 'assistant') {
      if (m.content) addBubble('assistant', m.content, true)
      ;(m.tool_calls || []).forEach((tc) => {
        const card = addToolCard(tc.function.name, tc.function.arguments)
        cardById[tc.id] = card
      })
    } else if (m.role === 'tool') {
      const card = m.tool_call_id ? cardById[m.tool_call_id] : null
      if (card) { setToolCardDone(card, m.content); filled.add(card) }
    }
  })
  // 没等到结果回填的卡片 = 中断的轮次
  Object.values(cardById).forEach((c) => { if (!filled.has(c)) setToolCardDone(c, '', true) })
  scrollLog()
}
async function newSession() {
  const name = prompt('新会话名称（字母/数字/_/-，≤64字符）：', 'session_' + Date.now())
  if (!name) return
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) { toast('名称只能包含字母/数字/_/-，≤64字符'); return }
  sessionId.value = name
  if (!sessions.value.includes(name)) sessions.value.push(name)
  await loadSessionHistory(name)
  sidebarOpen.value = false
  toast('已切换到新会话: ' + name)
}
async function deleteSession(id) {
  if (id === 'default') { toast('默认会话不可删除'); return }
  if (!confirm(`确定删除会话 "${id}"？`)) return
  const r = await sessionDelete(id)
  if (!r.ok) { toast('删除失败: HTTP ' + r.status); return }
  if (sessionId.value === id) {
    sessionId.value = 'default'
    await loadSessionHistory('default')
  }
  await loadSessions()
  toast('会话已删除')
}
async function exportSession(id) {
  try {
    const blob = await sessionExportBlob(id)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = id + '.md'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast('已导出 ' + id + '.md')
  } catch (e) { toast('导出失败: ' + e) }
}

// ===== 发送 + 轮询渲染 =====
function autoGrow() { const el = inputEl.value; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px' }

async function sendChat() {
  if (isProcessing.value) return
  const text = chatInput.value
  if (!text.trim()) return
  chatInput.value = ''
  autoGrow()
  addBubble('user', text)
  resetStream()
  setProcessingUI(true)
  setStatus('思考中…', 'busy')
  try {
    await chatSend(sessionId.value, text)
  } catch (e) {
    if (e.status === 409) { setProcessingUI(false); setStatus('会话正忙，请稍候', 'err'); return }
    setProcessingUI(false); setStatus('请求失败: ' + (e.message || e), 'err'); return
  }
  startPolling()
}
function startPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(async () => {
    try {
      const d = await chatEvents(sessionId.value)
      const evts = d.events || []
      for (let i = lastEventCount; i < evts.length; i++) {
        const e = evts[i]
        if (e.type === 'step_start') setStatus(`思考中 · 步骤 ${e.step}/${e.max}`, 'busy')
        else if (e.type === 'tool_call') addToolCard(e.name, e.args)
        else if (e.type === 'tool_result') setToolCardDone((pendingCards[e.name] || []).pop(), e.result)
        else if (e.type === 'interrupted') { finishProcessing(); setStatus('已中断', 'err') }
        else if (e.type === 'error') { finishProcessing(); setStatus(e.message, 'err') }
        else if (e.type === 'done') {
          addBubble('assistant', e.content, true)
          finishProcessing(); setStatus('', '')
        }
      }
      lastEventCount = evts.length
    } catch (err) { finishProcessing(); setStatus('轮询失败: ' + err, 'err') }
  }, 150)
}
function setProcessingUI(on) { isProcessing.value = on }
function finishProcessing() {
  clearInterval(pollTimer); pollTimer = null
  setProcessingUI(false)
}
async function cancelChat() {
  // 保持轮询，等 interrupted 事件到达后统一收尾（中断在当前 LLM 调用返回后才生效）
  await chatCancel(sessionId.value)
  setStatus('正在中断…', 'busy')
}

onMounted(() => {
  loadSessions()
  loadSessionHistory(sessionId.value)
})
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })
</script>

<template>
  <div class="chat-view">
    <div id="agent-layout">
      <aside id="agent-sidebar" :class="{ open: sidebarOpen }">
        <div class="sb-head">
          <span class="sb-title">会话</span>
          <button class="btn btn-primary btn-sm" title="新建会话" @click="newSession">＋新会话</button>
        </div>
        <div id="session-list">
          <div v-for="id in sessions" :key="id" class="sess-item" :class="{ active: id === sessionId }" @click="id !== sessionId && switchSession(id)">
            <span class="sess-name" :title="id">{{ id }}</span>
            <span class="sess-actions">
              <button class="icon-btn" title="导出 Markdown" @click.stop="exportSession(id)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/></svg>
              </button>
              <button v-if="id !== 'default'" class="icon-btn danger" title="删除会话" @click.stop="deleteSession(id)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </span>
          </div>
        </div>
      </aside>
      <div id="sidebar-scrim" :class="{ show: sidebarOpen }" @click="sidebarOpen = false"></div>

      <div id="agent-main">
        <header id="agent-header">
          <button class="icon-btn" id="btn-sidebar-toggle" title="会话列表" @click="sidebarOpen = !sidebarOpen">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
          </button>
          <div class="ah-title">
            <h2 id="ah-session-name">{{ sessionName }}</h2>
            <span class="ah-sub">分析回放与战绩，翻译建议</span>
          </div>
          <span v-if="status.text" id="ah-status" class="ah-status-pill" :class="status.kind" :title="status.text">
            <span v-if="status.kind === 'busy'" class="spinner"></span>{{ status.text }}
          </span>
        </header>

        <div id="chat-log" ref="chatLogEl">
          <template v-for="m in messages" :key="m.id">
            <div v-if="m.kind === 'msg'" class="msg" :class="m.role">
              <div class="bubble" :class="{ md: m.md }">
                <template v-if="m.md"><span class="md-body" v-html="renderMarkdown(m.text)"></span></template>
                <template v-else>{{ m.text }}</template>
              </div>
            </div>
            <div v-else class="tool-call" :class="{ open: m.open, error: m.state === 'fail' }">
              <button class="tc-head" type="button" @click="m.open = !m.open">
                <span class="tc-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>
                </span>
                <span class="tc-name">{{ m.toolLabel }}</span>
                <span class="tc-args">{{ m.argsPreview }}</span>
                <span class="tc-state" :class="m.state">
                  <span v-if="m.state === 'run'" class="spinner"></span>
                  <svg v-else-if="m.state === 'ok'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>
                  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
                </span>
              </button>
              <div class="tc-body">
                <div class="tc-sec">参数</div><pre class="tc-args-full">{{ m.argsFull }}</pre>
                <div class="tc-sec">结果</div><pre class="tc-result">{{ m.result }}</pre>
              </div>
            </div>
          </template>
        </div>

        <div id="composer">
          <textarea
            id="chat-input" ref="inputEl" rows="1" v-model="chatInput"
            placeholder="询问回放 / 战绩 / 装甲分析…（Enter 发送，Shift+Enter 换行）"
            @input="autoGrow"
            @keydown.enter.exact.prevent="!isProcessing && sendChat()"
          ></textarea>
          <button class="btn btn-primary" :disabled="isProcessing" @click="sendChat">发送</button>
          <button v-show="isProcessing" class="btn btn-danger" @click="cancelChat">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" style="vertical-align:-1px;margin-right:3px;"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>停止
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/* 自旧版全局样式平移（v-html 内容无法命中 scoped，保持全局；类名与旧版一致避免遗漏） */
.chat-view { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; width: 100%; }
#agent-layout { flex: 1; min-height: 0; display: flex; }
#agent-sidebar {
  flex: none; width: 252px; display: flex; flex-direction: column; min-height: 0;
  background: linear-gradient(180deg, var(--panel), var(--panel2)); border-right: 1px solid var(--border);
}
.sb-head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 14px 10px; }
.sb-title { font-size: 0.76em; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
#session-list { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 8px 12px; }
.sess-item {
  display: flex; align-items: center; gap: 6px; margin-bottom: 2px; padding: 8px 10px;
  border: 1px solid transparent; border-radius: var(--radius-sm); cursor: pointer; font-size: 0.88em;
}
.sess-item:hover { background: rgba(255, 255, 255, 0.05); }
.sess-item.active { background: rgba(255, 138, 61, 0.13); border-color: rgba(255, 138, 61, 0.35); }
.sess-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sess-actions { display: none; gap: 2px; flex: none; }
.sess-item:hover .sess-actions { display: flex; }
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center; line-height: 0;
  background: transparent; border: none; color: var(--muted); cursor: pointer; padding: 5px; border-radius: 6px;
}
.icon-btn:hover { color: var(--txt); background: rgba(255, 255, 255, 0.08); }
.icon-btn.danger:hover { color: var(--red); background: rgba(255, 107, 107, 0.12); }
.icon-btn svg { width: 14px; height: 14px; }
#agent-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
#agent-header {
  flex: none; display: flex; align-items: center; gap: 12px; padding: 10px 18px;
  background: rgba(27, 24, 23, 0.75); backdrop-filter: blur(10px); border-bottom: 1px solid var(--border);
}
#btn-sidebar-toggle { display: none; }
.ah-title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 10px; }
#ah-session-name { margin: 0; font-size: 1em; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-sub { color: var(--muted); font-size: 0.78em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-status-pill {
  flex: none; display: inline-flex; align-items: center; gap: 6px; max-width: 46%;
  padding: 3px 11px; border-radius: 20px; font-size: 0.78em; font-weight: 600; color: var(--muted);
  background: rgba(255, 255, 255, 0.05); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ah-status-pill.busy { color: var(--accent-2); background: rgba(255, 138, 61, 0.12); }
.ah-status-pill.err { color: var(--red); background: rgba(255, 107, 107, 0.12); }
#chat-log { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 22px; }
#chat-log:empty::before {
  content: '向 Agent 提问开始分析，例如「帮我分析最近的回放」';
  display: block; margin-top: min(32vh, 240px); text-align: center; color: var(--muted); font-size: 0.9em; opacity: .75;
}
.msg { margin: 10px 0; display: flex; flex-direction: column; }
.msg.user { align-items: flex-end; }
.msg.assistant { align-items: flex-start; }
.msg .bubble { max-width: 85%; padding: 10px 15px; border-radius: 14px; white-space: pre-wrap; font-size: 0.95em; line-height: 1.5; box-shadow: var(--shadow); }
.msg.user .bubble { background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #1a1208; border-bottom-right-radius: 4px; }
.msg.assistant .bubble { background: var(--panel2); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
.bubble img { max-width: 100%; border-radius: 8px; margin: 4px 0; display: block; }
/* Markdown 渲染内容样式 */
.bubble.md { white-space: normal; }
.bubble.md .md-body > * { margin: 0.4em 0; }
.bubble.md .md-body > :first-child { margin-top: 0; }
.bubble.md .md-body > :last-child { margin-bottom: 0; }
.bubble.md pre {
  background: #120f0e; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
  overflow-x: auto; font-size: 0.86em; line-height: 1.45;
}
.bubble.md code {
  font-family: ui-monospace, Monaco, Consolas, monospace;
  background: rgba(255, 255, 255, 0.08); padding: 1px 5px; border-radius: 4px; font-size: 0.9em;
}
.bubble.md pre code { background: none; padding: 0; }
.bubble.md table { border-collapse: collapse; margin: 0.6em 0; font-size: 0.88em; }
.bubble.md th, .bubble.md td { border: 1px solid var(--border); padding: 4px 9px; }
.bubble.md th { background: var(--panel3); }
.bubble.md a { color: var(--accent-3); }
.bubble.md h1, .bubble.md h2, .bubble.md h3, .bubble.md h4 { margin: 0.7em 0 0.3em; line-height: 1.3; }
.bubble.md h1 { font-size: 1.25em; }
.bubble.md h2 { font-size: 1.15em; }
.bubble.md h3 { font-size: 1.05em; }
.bubble.md ul, .bubble.md ol { padding-left: 1.4em; }
.bubble.md blockquote { border-left: 3px solid var(--accent-2); margin: 0.5em 0; padding: 2px 12px; color: var(--muted); }
.bubble.md .katex { font-size: 1.05em; }
/* 工具调用卡片：头部可点开折叠体 */
.tool-call {
  max-width: 86%; margin: 6px 0 6px 12px; font-size: 0.84em; overflow: hidden;
  border: 1px solid var(--border); border-left: 3px solid var(--accent-2); border-radius: var(--radius-sm);
  background: rgba(255, 179, 92, 0.05);
}
.tool-call.error { border-left-color: var(--red); }
.tc-head {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 11px; text-align: left;
  background: transparent; border: none; border-radius: 0; color: var(--txt); cursor: pointer; font-family: inherit; font-size: 1em;
}
.tc-head:hover { background: rgba(255, 255, 255, 0.04); }
.tc-icon { flex: none; display: inline-flex; line-height: 0; color: var(--accent-2); }
.tc-icon svg { width: 13px; height: 13px; }
.tool-call .tc-name { flex: none; font-weight: 700; color: var(--accent-2); }
.tc-args { flex: 1; min-width: 0; color: var(--muted); font-family: ui-monospace, monospace; font-size: 0.92em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tc-state { flex: none; display: inline-flex; align-items: center; color: var(--muted); line-height: 0; }
.tc-state svg { width: 13px; height: 13px; }
.tc-state.ok { color: var(--green); }
.tc-state.fail { color: var(--red); }
.tool-call .tc-body { display: none; border-top: 1px dashed var(--border); padding: 8px 12px; }
.tool-call.open .tc-body { display: block; }
.tc-sec { color: var(--muted); font-size: 0.88em; text-transform: uppercase; letter-spacing: .4px; margin: 6px 0 3px; }
.tc-sec:first-child { margin-top: 0; }
.tc-body pre {
  margin: 0; padding: 0; background: none; border: none; border-radius: 0; color: var(--muted);
  font-family: ui-monospace, monospace; font-size: 0.95em; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow-y: auto;
}
#composer {
  flex: none; display: flex; gap: 10px; align-items: flex-end; padding: 12px 18px;
  background: rgba(27, 24, 23, 0.6); border-top: 1px solid var(--border);
}
#chat-input { flex: 1; min-height: 44px; max-height: 160px; resize: none; overflow-y: auto; }
.btn-danger { background: linear-gradient(135deg, var(--red), #d95b4f); border-color: transparent; color: #fff; font-weight: 700; }
.btn:disabled { opacity: 0.45; cursor: not-allowed; filter: none; }
#sidebar-scrim { display: none; }
/* 窄屏：侧栏抽屉化 */
@media (max-width: 900px) {
  #agent-sidebar {
    position: fixed; top: 0; left: 0; bottom: 0; z-index: 120; width: min(300px, 82vw);
    transform: translateX(-102%); transition: transform .18s ease; box-shadow: var(--shadow);
  }
  #agent-sidebar.open { transform: translateX(0); }
  #sidebar-scrim { position: fixed; inset: 0; z-index: 110; background: rgba(0, 0, 0, 0.55); }
  #sidebar-scrim.show { display: block; }
  #btn-sidebar-toggle { display: inline-flex; }
  .ah-sub { display: none; }
}
/* 更窄：收紧输入区与气泡宽度 */
@media (max-width: 600px) {
  #agent-header { padding: 8px 12px; }
  #chat-log { padding: 12px; }
  #composer { padding: 10px 12px; gap: 8px; }
  .msg .bubble { max-width: 94%; }
  .tool-call { max-width: 97%; }
}
</style>
