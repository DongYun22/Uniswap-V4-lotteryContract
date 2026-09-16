/**
 * 데모 모드: 컨트랙트와 같은 규칙으로 브라우저 안에서 회차를 시뮬레이션한다.
 * 배포 전에도 화면과 3D 씬을 확인할 수 있게 하는 용도.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseEther, type Address } from 'viem'
import { Phase, type LotteryModel, type LotteryState, type TicketRecord, type TxRecord, type WinnerRecord } from '../lib/types'
import { nowSec } from '../lib/format'

const DEMO_ME: Address = '0xd311000000000000000000000000000000000a1e' as Address
const OWNER: Address = DEMO_ME
const EPOCH_SEC = 90
const VRF_DELAY_MS = 5000
const FEE_BPS = 500
const TICKET_PRICE = parseEther('0.001')

const randAddr = (): Address => {
  const hex = Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
  return `0x${hex}` as Address
}

interface Demo {
  state: LotteryState
  tickets: TicketRecord[]
  entries: { player: Address; cumulative: number }[] // 현재 회차 누적 구간
  winners: WinnerRecord[]
}

const openEpoch = (id: number, pot: bigint, reserved: bigint, prev?: Demo): Demo => ({
  state: {
    epochId: id,
    epoch: {
      winner: '0x0000000000000000000000000000000000000000',
      endTime: nowSec() + EPOCH_SEC,
      entryCount: 0,
      ticketCount: 0,
      phase: Phase.Open,
      claimed: false,
      drawRequestedAt: 0,
      prize: 0n,
      vrfRequestId: 0n,
    },
    pot,
    reserved,
    epochDuration: EPOCH_SEC,
    vrfTimeout: 86400,
    feeBps: FEE_BPS,
    ticketPrice: TICKET_PRICE,
    timestamp: nowSec(),
    owner: OWNER,
  },
  tickets: prev?.tickets ?? [],
  entries: [],
  winners: prev?.winners ?? [],
})

const ownerOf = (entries: { player: Address; cumulative: number }[], index: number): Address => {
  let lo = 0
  let hi = entries.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (entries[mid].cumulative > index) hi = mid
    else lo = mid + 1
  }
  return entries[lo].player
}

export function useDemoLottery(): LotteryModel {
  const [demo, setDemo] = useState<Demo>(() => openEpoch(1, parseEther('0.5'), 0n))
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [txs, setTxs] = useState<TxRecord[]>([])
  const [tokenBalance, setTokenBalance] = useState(0n)
  const timer = useRef<number | null>(null)

  /** 컨트랙트와 같은 규칙: count = amount / ticketPrice, fee = amount * feeBps / 10000 → pot */
  const swap = useCallback((player: Address, amountWei: bigint) => {
    setDemo((d) => {
      if (d.state.epoch.phase !== Phase.Open) return d
      const count = Number(amountWei / TICKET_PRICE)
      if (count === 0) return d
      const fee = (amountWei * BigInt(FEE_BPS)) / 10000n
      const first = d.state.epoch.ticketCount
      const cumulative = first + count
      return {
        ...d,
        state: {
          ...d.state,
          pot: d.state.pot + fee,
          epoch: { ...d.state.epoch, ticketCount: cumulative, entryCount: d.state.epoch.entryCount + 1 },
        },
        entries: [...d.entries, { player, cumulative }],
        tickets: [{ epochId: d.state.epochId, player, firstIndex: first, count, fee, at: nowSec() }, ...d.tickets].slice(0, 40),
      }
    })
  }, [])

  // 다른 플레이어들이 랜덤하게 스왑
  useEffect(() => {
    const id = window.setInterval(() => {
      if (Math.random() < 0.55) {
        const amt = [0.001, 0.002, 0.005, 0.01, 0.02][Math.floor(Math.random() * 5)]
        swap(randAddr(), parseEther(String(amt)))
      }
    }, 2500)
    return () => window.clearInterval(id)
  }, [swap])

  // 시계
  useEffect(() => {
    const id = window.setInterval(() => setDemo((d) => ({ ...d, state: { ...d.state, timestamp: nowSec() } })), 1000)
    return () => window.clearInterval(id)
  }, [])

  const requestDraw = useCallback(async () => {
    setDemo((d) => {
      const e = d.state.epoch
      if (e.phase !== Phase.Open || e.ticketCount === 0 || d.state.pot === 0n) return d
      const prize = d.state.pot
      return {
        ...d,
        state: {
          ...d.state,
          pot: 0n,
          reserved: d.state.reserved + prize,
          epoch: { ...e, phase: Phase.Drawing, prize, drawRequestedAt: nowSec(), vrfRequestId: BigInt(d.state.epochId) },
        },
      }
    })
    setBusy('VRF 요청 전송됨 · 콜백 대기')
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setDemo((d) => {
        const e = d.state.epoch
        if (e.phase !== Phase.Drawing) return d
        const word = BigInt(Math.floor(Math.random() * 1e12))
        const idx = Number(word % BigInt(e.ticketCount))
        const winner = ownerOf(d.entries, idx)
        const resolved: WinnerRecord = { epochId: d.state.epochId, winner, prize: e.prize, claimed: false, randomWord: word }
        // 콜백이 승자 확정 후 다음 회차를 연다. 확정 회차는 winners 에 보관.
        const next = openEpoch(d.state.epochId + 1, 0n, d.state.reserved, d)
        next.winners = [resolved, ...d.winners]
        // 결과를 잠깐 보여주기 위해 이전 epoch 정보를 lastResolved 로 유지
        return { ...next, tickets: d.tickets }
      })
      setBusy(null)
    }, VRF_DELAY_MS)
  }, [])

  const claim = useCallback(async (epochId: number) => {
    setDemo((d) => {
      const w = d.winners.find((x) => x.epochId === epochId)
      if (!w || w.claimed || w.winner !== DEMO_ME) return d
      return {
        ...d,
        state: { ...d.state, reserved: d.state.reserved - w.prize },
        winners: d.winners.map((x) => (x.epochId === epochId ? { ...x, claimed: true } : x)),
      }
    })
  }, [])

  const skipEpoch = useCallback(async () => {
    setDemo((d) => {
      const e = d.state.epoch
      if (e.phase !== Phase.Open || (e.ticketCount > 0 && d.state.pot > 0n)) return d
      return openEpoch(d.state.epochId + 1, d.state.pot, d.state.reserved, d)
    })
  }, [])

  const deposit = useCallback(async (amountEth: string) => {
    const wei = parseEther(amountEth || '0')
    setDemo((d) => ({ ...d, state: { ...d.state, pot: d.state.pot + wei } }))
  }, [])

  const buyTicket = useCallback(
    async (amountEth: string) => {
      if (!connected) throw new Error('지갑을 먼저 연결하세요 (데모)')
      setBusy('스왑 전송 중…')
      await new Promise((r) => setTimeout(r, 900))
      const wei = parseEther(amountEth || '0')
      swap(DEMO_ME, wei)
      // 데모에서는 1:1 가격 가정, 수수료 5% 제외분만 교환
      const got = (wei * 9500n) / 10000n
      setTokenBalance((b) => b + got)
      setTxs((t) => [{ label: `스왑 ${amountEth} ETH`, at: nowSec(), status: 'success' as const, detail: `+${(Number(got) / 1e18).toFixed(5)} LTT` }, ...t].slice(0, 20))
      setBusy(null)
    },
    [connected, swap],
  )

  const myTickets = useMemo(() => {
    let prev = 0
    let n = 0
    for (const e of demo.entries) {
      if (e.player === DEMO_ME) n += e.cumulative - prev
      prev = e.cumulative
    }
    return n
  }, [demo.entries])

  return {
    mode: 'demo',
    state: demo.state,
    winners: demo.winners,
    tickets: demo.tickets,
    myTickets,
    account: connected ? DEMO_ME : undefined,
    isOwner: connected,
    busy,
    error: null,
    txs,
    token: { symbol: 'LTT', decimals: 18, balance: tokenBalance },
    mockVrf: false,
    connect: () => setConnected(true),
    disconnect: () => setConnected(false),
    actions: { buyTicket, requestDraw, retryDraw: requestDraw, skipEpoch, claim, deposit },
  }
}
