import { apiGet } from './client'

export const fetchTankDetail = (id) => apiGet(`/api/tank_detail/${id}`)
export const fetchTanks = () => apiGet('/api/tanks')
