// Agent 会话 / 聊天 API
import { apiGet, apiPost } from './client'

export const chatSend = (sessionId, message) => apiPost('/api/chat', { session_id: sessionId, message })
export const chatEvents = (sessionId) => apiGet(`/api/chat/events?session_id=${encodeURIComponent(sessionId)}`)
export const chatCancel = (sessionId) =>
  fetch(`/api/chat/cancel?session_id=${encodeURIComponent(sessionId)}`, { method: 'POST' })

export const sessionsList = () => apiGet('/api/sessions')
export const sessionGet = (sessionId) => apiGet(`/api/session?session_id=${encodeURIComponent(sessionId)}`)
export const sessionDelete = (id) => fetch(`/api/session/${encodeURIComponent(id)}`, { method: 'DELETE' })

export async function sessionExportBlob(id) {
  const r = await fetch(`/api/session/${encodeURIComponent(id)}/export`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.blob()
}
