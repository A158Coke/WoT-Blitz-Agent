// 玩家 / 回放扫描 / 射击复现 / 阵容分析 API
import { apiGet, apiPost } from './client'

export const playerSearch = (nickname) => apiGet(`/api/player/${encodeURIComponent(nickname)}`)
export const scanReplays = (body) => apiPost('/api/scan', body)
export const replayShots = (file) => apiPost('/api/replay/shots', { file })
export const prematchAnalyze = (names) => apiPost('/api/prematch', { names })
