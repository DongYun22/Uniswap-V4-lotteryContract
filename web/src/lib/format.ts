import { formatEther } from 'viem'
import { Phase } from './types'

export const fmtEth = (wei: bigint, digits = 4) => {
  const n = Number(formatEther(wei))
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export const short = (addr?: string) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—')

export const phaseLabel: Record<Phase, string> = {
  [Phase.Open]: '티켓 판매 중',
  [Phase.Drawing]: 'VRF 추첨 중',
  [Phase.Resolved]: '승자 확정',
}

export const phaseColor: Record<Phase, string> = {
  [Phase.Open]: '#4ff0e6',
  [Phase.Drawing]: '#ff9a3c',
  [Phase.Resolved]: '#ffd166',
}

export const fmtDuration = (sec: number) => {
  if (sec <= 0) return '00:00'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export const nowSec = () => Math.floor(Date.now() / 1000)
