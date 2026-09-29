// 回放数据源双通道（架构契约第 6 节）：本地 WASM 解析（文件不出本机）/ 服务端接口。
// 两通道产出同一 PlaybackData JSON 形状 → playbackScene 渲染层无感切换。
//
// WASM 产物由 scripts/build-wasm.ps1 构建到 frontend/public/wasm/（--target web），
// 经动态 import 惰性加载；产物缺失时本地通道拒绝并提示，服务端通道不受影响。

let wasmPromise = null

async function loadWasm() {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      // 运行时 URL：@vite-ignore 阻止构建期解析（产物由 scripts/build-wasm.ps1 生成到 public/wasm/）
      const spec = '/wasm/wotb_replay_wasm.js'
      const mod = await import(/* @vite-ignore */ spec)
      if (mod.default) await mod.default() // target web：初始化 .wasm 实例
      return mod
    })()
  }
  return wasmPromise
}

/** 服务端通道：POST /api/playback/data {file}（与既有行为逐字一致） */
export async function loadFromServer(file) {
  const resp = await fetch('/api/playback/data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  })
  if (!resp.ok) throw new Error(await resp.text())
  return resp.json()
}

/** 本地通道：File/Blob → 浏览器文件接口 → WASM 解析 → 回放切面（契约 §6 纯客户端） */
export async function loadFromLocalFile(fileObject) {
  const mod = await loadWasm()
  const bytes = new Uint8Array(await fileObject.arrayBuffer())
  const envelope = JSON.parse(mod.parseReplayFacets(bytes))
  return envelope.playback
}

/**
 * 统一入口（playbackScene.loadData 委托至此）：
 * source = { kind: 'server', file } | { kind: 'local', file: File/Blob }
 */
export async function loadPlaybackData(source) {
  return source.kind === 'local'
    ? loadFromLocalFile(source.file)
    : loadFromServer(source.file)
}
