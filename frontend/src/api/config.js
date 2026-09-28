// 配置 / 用量 / 模型库 API
import { apiGet, apiPost } from './client'

export const configGet = () => apiGet('/api/config')
export const configSet = (body) => apiPost('/api/config', body)
export const usageGet = () => apiGet('/api/usage')
export const modelsStatus = () => apiGet('/api/models/status')
export const modelsDownloadAll = () => fetch('/api/models/download_all', { method: 'POST' })
