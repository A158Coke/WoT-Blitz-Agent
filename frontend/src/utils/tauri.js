// Tauri 移动端兼容层：桌面浏览器为 no-op。
// - Android WebView 自定义协议拦截拿不到 POST body → POST 全部改道 IPC 直达 Rust 路由
// - Android WebView 不支持多窗口 → 同源 window.open 改为当前页跳转
// - 导入回放走系统文件对话框（import_replay 命令）

const T = () => (typeof window !== 'undefined' ? window.__TAURI__ : undefined)

export const isTauri = () => !!(T() && T().core)

export async function tauriDialogOpen(options) {
  const t = T()
  return t.dialog.open(options)
}

export async function tauriInvoke(cmd, args) {
  return T().core.invoke(cmd, args)
}

// 浏览器原生文件 → 上传到 /api/replay/upload，返回落盘路径
export async function uploadReplay(file) {
  const buf = await file.arrayBuffer()
  const r = await fetch('/api/replay/upload?name=' + encodeURIComponent(file.name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
  })
  if (!r.ok) throw new Error((await r.text()).slice(0, 160))
  return r.json()
}

// 安装全局 shim（main.js 启动时调用一次；必须在任何视图发请求之前）
export function installTauriShims() {
  if (!isTauri()) return
  const t = T()
  const __origFetch = window.fetch.bind(window)
  window.fetch = async function (input, init) {
    init = init || {}
    const method = (init.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase()
    if (method === 'POST' && typeof init.body === 'string') {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href)
      const r = await t.core.invoke('bridge_post', { path: url.pathname + url.search, body: init.body })
      const bin = atob(r.body)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const headers = { 'Content-Type': r.contentType || 'application/json' }
      if (r.contentEncoding) headers['Content-Encoding'] = r.contentEncoding
      return new Response(bytes, { status: r.status, headers })
    }
    return __origFetch(input, init)
  }

  const __open = window.open.bind(window)
  window.open = function (url, target, features) {
    try {
      const u = new URL(url, location.href)
      if (u.origin === location.origin) { location.href = u.href; return null }
    } catch { /* 忽略解析失败，走原生 */ }
    return __open(url, target, features)
  }
}

// 移动端 UA 判定（画质档默认值用；Tauri 环境一律视为移动端）
export function isMobileLike() {
  return isTauri() || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
}
