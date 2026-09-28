// 统一 API 访问入口：全部后端端点的 fetch 封装都收口到这里（统一错误语义与未来 base 前缀）。
export class ApiError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`)
    this.status = status
  }
}

export async function apiGet(path) {
  const r = await fetch(path)
  if (!r.ok) throw new ApiError(r.status)
  return r.json()
}

export async function apiPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new ApiError(r.status)
  return r.json()
}
