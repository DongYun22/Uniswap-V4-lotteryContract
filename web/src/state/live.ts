/**
 * 라이브 모드: Sepolia 의 LotteryHook 을 wagmi/viem 으로 읽고 쓴다.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from 'wagmi'
import { decodeEventLog, encodeAbiParameters, erc20Abi, formatUnits, parseAbiItem, parseEther, type Address } from 'viem'
import { sendTransaction } from 'wagmi/actions'
import lotteryAbi from '../config/abi/LotteryHook.json'
import { swapRouterAbi } from '../config/abi/swapRouter'
import { mockVrfAbi } from '../config/abi/mockVrf'
import { DEPLOY_BLOCK, HOOK_ADDRESS, SWAP_ROUTER, TOKEN_ADDRESS, VRF_COORDINATOR, poolKey } from '../config/addresses'
import { CHAIN, wagmiConfig } from '../config/wagmi'
import { Phase, type LotteryModel, type LotteryState, type TicketRecord, type TxRecord, type WinnerRecord } from '../lib/types'
import { nowSec } from '../lib/format'

const abi = lotteryAbi as any
const HOOK = HOOK_ADDRESS as Address

const evWinner = parseAbiItem(
  'event WinnerSelected(uint256 indexed epochId, address indexed winner, uint256 prize, uint256 randomWord)',
)
const evClaimed = parseAbiItem('event PrizeClaimed(uint256 indexed epochId, address indexed winner, uint256 prize)')
const evTicket = parseAbiItem(
  'event TicketsMinted(uint256 indexed epochId, address indexed player, uint96 firstIndex, uint96 count, uint256 fee, bytes32 poolId)',
)

type RawState = {
  epochId: bigint
  epoch: {
    winner: Address
    endTime: bigint
    entryCount: number
    phase: number
    claimed: boolean
    drawRequestedAt: bigint
    ticketCount: bigint
    prize: bigint
    vrfRequestId: bigint
  }
  pot: bigint
  reserved: bigint
  epochDuration: bigint
  vrfTimeout: bigint
  feeBps: bigint
  ticketPrice: bigint
  timestamp: bigint
  owner: Address
}

const toState = (r: RawState): LotteryState => ({
  epochId: Number(r.epochId),
  epoch: {
    winner: r.epoch.winner,
    endTime: Number(r.epoch.endTime),
    entryCount: Number(r.epoch.entryCount),
    ticketCount: Number(r.epoch.ticketCount),
    phase: r.epoch.phase as Phase,
    claimed: r.epoch.claimed,
    drawRequestedAt: Number(r.epoch.drawRequestedAt),
    prize: r.epoch.prize,
    vrfRequestId: r.epoch.vrfRequestId,
  },
  pot: r.pot,
  reserved: r.reserved,
  epochDuration: Number(r.epochDuration),
  vrfTimeout: Number(r.vrfTimeout),
  feeBps: Number(r.feeBps),
  ticketPrice: r.ticketPrice,
  timestamp: Number(r.timestamp),
  owner: r.owner,
})

export function useLiveLottery(): LotteryModel {
  const { address } = useAccount()
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()
  const client = usePublicClient({ chainId: CHAIN.id })
  const { writeContractAsync } = useWriteContract()

  const TX_KEY = `lottery.txs.${HOOK}`
  const [txs, setTxs] = useState<TxRecord[]>(() => {
    try {
      const raw = localStorage.getItem(TX_KEY)
      return raw ? (JSON.parse(raw) as TxRecord[]) : []
    } catch {
      return []
    }
  })
  const pushTx = useCallback(
    (rec: TxRecord) =>
      setTxs((prev) => {
        const next = [rec, ...prev.filter((t) => t.hash !== rec.hash || !rec.hash)].slice(0, 20)
        try {
          localStorage.setItem(TX_KEY, JSON.stringify(next))
        } catch {
          /* 사생활 모드 등에서 저장 실패는 무시 */
        }
        return next
      }),
    [TX_KEY],
  )

  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastTx, setLastTx] = useState<string | undefined>()
  const [winners, setWinners] = useState<WinnerRecord[]>([])
  const [tickets, setTickets] = useState<TicketRecord[]>([])

  const stateQ = useReadContract({
    abi,
    address: HOOK,
    functionName: 'getState',
    chainId: CHAIN.id,
    query: { refetchInterval: 4000 },
  })
  const state = useMemo(() => (stateQ.data ? toState(stateQ.data as RawState) : null), [stateQ.data])

  const coordQ = useReadContract({
    abi,
    address: HOOK,
    functionName: 's_vrfCoordinator',
    chainId: CHAIN.id,
    query: { refetchInterval: 15000 },
  })
  const coordinator = coordQ.data as Address | undefined
  const mockVrf = Boolean(coordinator && VRF_COORDINATOR && coordinator.toLowerCase() !== VRF_COORDINATOR.toLowerCase())

  const tokenQ = useReadContract({
    abi: erc20Abi,
    address: TOKEN_ADDRESS,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: CHAIN.id,
    query: { enabled: Boolean(TOKEN_ADDRESS && address), refetchInterval: 8000 },
  })
  const symbolQ = useReadContract({
    abi: erc20Abi,
    address: TOKEN_ADDRESS,
    functionName: 'symbol',
    chainId: CHAIN.id,
    query: { enabled: Boolean(TOKEN_ADDRESS), staleTime: Infinity },
  })
  const decimalsQ = useReadContract({
    abi: erc20Abi,
    address: TOKEN_ADDRESS,
    functionName: 'decimals',
    chainId: CHAIN.id,
    query: { enabled: Boolean(TOKEN_ADDRESS), staleTime: Infinity },
  })

  const myQ = useReadContract({
    abi,
    address: HOOK,
    functionName: 'ticketsOf',
    args: state && address ? [BigInt(state.epochId), address] : undefined,
    chainId: CHAIN.id,
    query: { enabled: Boolean(state && address), refetchInterval: 4000 },
  })

  // 이벤트 로그: 당첨 / 수령 / 최근 티켓
  const loadLogs = useCallback(async () => {
    if (!client) return
    try {
      const [w, c, t] = await Promise.all([
        client.getLogs({ address: HOOK, event: evWinner, fromBlock: DEPLOY_BLOCK, toBlock: 'latest' }),
        client.getLogs({ address: HOOK, event: evClaimed, fromBlock: DEPLOY_BLOCK, toBlock: 'latest' }),
        client.getLogs({ address: HOOK, event: evTicket, fromBlock: DEPLOY_BLOCK, toBlock: 'latest' }),
      ])
      const claimed = new Set(c.map((l) => Number(l.args.epochId)))
      setWinners(
        w
          .map((l) => ({
            epochId: Number(l.args.epochId),
            winner: l.args.winner as Address,
            prize: l.args.prize as bigint,
            randomWord: l.args.randomWord as bigint,
            claimed: claimed.has(Number(l.args.epochId)),
            txHash: l.transactionHash ?? undefined,
            claimTxHash: c.find((x) => Number(x.args.epochId) === Number(l.args.epochId))?.transactionHash ?? undefined,
          }))
          .sort((a, b) => b.epochId - a.epochId),
      )
      setTickets(
        t
          .slice(-40)
          .reverse()
          .map((l) => ({
            epochId: Number(l.args.epochId),
            player: l.args.player as Address,
            firstIndex: Number(l.args.firstIndex),
            count: Number(l.args.count),
            fee: l.args.fee as bigint,
            at: 0,
            txHash: l.transactionHash ?? undefined,
          })),
      )
    } catch (e) {
      console.warn('getLogs failed', e)
    }
  }, [client])

  useEffect(() => {
    loadLogs()
    const id = window.setInterval(loadLogs, 15000)
    return () => window.clearInterval(id)
  }, [loadLogs])

  /** 영수증에서 내가 받은 토큰 수량을 뽑아 tx 기록에 붙인다 */
  const receivedToken = useCallback(
    (logs: readonly { address: string; topics: readonly string[]; data: string }[]) => {
      if (!TOKEN_ADDRESS || !address) return undefined
      for (const l of logs) {
        if (l.address.toLowerCase() !== TOKEN_ADDRESS.toLowerCase()) continue
        try {
          const ev = decodeEventLog({ abi: erc20Abi, topics: l.topics as any, data: l.data as any })
          if (ev.eventName !== 'Transfer') continue
          const { to, value } = ev.args as { to: Address; value: bigint }
          if (to.toLowerCase() !== address.toLowerCase()) continue
          return `+${Number(formatUnits(value, 18)).toLocaleString('en-US', { maximumFractionDigits: 5 })} ${symbolQ.data ?? 'LTT'}`
        } catch {
          /* 다른 이벤트는 무시 */
        }
      }
      return undefined
    },
    [address, symbolQ.data],
  )

  const run = useCallback(
    async (label: string, fn: () => Promise<`0x${string}`>) => {
      setError(null)
      setBusy(label)
      const at = nowSec()
      try {
        const hash = await fn()
        setLastTx(hash)
        pushTx({ hash, label, at, status: 'pending' })
        setBusy('컨펌 대기 중…')
        const receipt = await client?.waitForTransactionReceipt({ hash })
        pushTx({
          hash,
          label,
          at,
          status: receipt?.status === 'reverted' ? 'failed' : 'success',
          detail: receipt ? receivedToken(receipt.logs as any) : undefined,
        })
        await Promise.all([stateQ.refetch(), myQ.refetch(), tokenQ.refetch(), loadLogs()])
      } catch (e: any) {
        setError(e?.shortMessage ?? e?.message ?? String(e))
        throw e
      } finally {
        setBusy(null)
      }
    },
    [client, stateQ, myQ, tokenQ, loadLogs, pushTx, receivedToken],
  )

  const actions = {
    buyTicket: (amountEth: string) =>
      run('스왑 전송 중…', () => {
        if (!address) throw new Error('지갑을 연결하세요')
        const amountIn = parseEther(amountEth)
        return writeContractAsync({
          abi: swapRouterAbi,
          address: SWAP_ROUTER,
          functionName: 'swapExactTokensForTokens',
          args: [
            amountIn,
            0n,
            true,
            poolKey(),
            encodeAbiParameters([{ type: 'address' }], [address]),
            address,
            BigInt(nowSec() + 600),
          ],
          value: amountIn,
          chainId: CHAIN.id,
        })
      }),
    requestDraw: () =>
      run('추첨 요청 중…', () =>
        writeContractAsync({ abi, address: HOOK, functionName: 'requestDraw', chainId: CHAIN.id }),
      ),
    retryDraw: () =>
      run('VRF 재요청 중…', () =>
        writeContractAsync({ abi, address: HOOK, functionName: 'retryDraw', chainId: CHAIN.id }),
      ),
    skipEpoch: () =>
      run('회차 스킵 중…', () =>
        writeContractAsync({ abi, address: HOOK, functionName: 'skipEpoch', chainId: CHAIN.id }),
      ),
    claim: (epochId: number) =>
      run('상금 수령 중…', () =>
        writeContractAsync({ abi, address: HOOK, functionName: 'claim', args: [BigInt(epochId)], chainId: CHAIN.id }),
      ),
    mockFulfill: () =>
      run('난수 주입 중… (mock)', () => {
        if (!state || !coordinator) throw new Error('상태 없음')
        const buf = new Uint8Array(32)
        crypto.getRandomValues(buf)
        const word = BigInt('0x' + Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join(''))
        return writeContractAsync({
          abi: mockVrfAbi,
          address: coordinator,
          functionName: 'fulfill',
          args: [state.epoch.vrfRequestId, word],
          chainId: CHAIN.id,
        })
      }),
    deposit: (amountEth: string) =>
      run('상금 예치 중…', async () => {
        if (!client || !address) throw new Error('지갑을 연결하세요')
        return sendTransaction(wagmiConfig, { to: HOOK, value: parseEther(amountEth), chainId: CHAIN.id })
      }),
  }

  return {
    mode: 'live',
    state,
    winners,
    tickets,
    myTickets: Number(myQ.data ?? 0),
    account: address,
    isOwner: Boolean(state && address && state.owner.toLowerCase() === address.toLowerCase()),
    busy,
    error: error ?? (stateQ.error ? `상태 조회 실패: ${stateQ.error.message}` : null),
    lastTx,
    txs,
    token: {
      address: TOKEN_ADDRESS,
      symbol: (symbolQ.data as string) ?? 'LTT',
      decimals: (decimalsQ.data as number) ?? 18,
      balance: (tokenQ.data as bigint) ?? 0n,
    },
    mockVrf,
    connect: () => connect({ connector: connectors[0] }),
    disconnect: () => disconnect(),
    actions,
  }
}
