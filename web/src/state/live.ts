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
import { encodeAbiParameters, parseAbiItem, parseEther, type Address } from 'viem'
import { sendTransaction } from 'wagmi/actions'
import lotteryAbi from '../config/abi/LotteryHook.json'
import { swapRouterAbi } from '../config/abi/swapRouter'
import { DEPLOY_BLOCK, HOOK_ADDRESS, SWAP_ROUTER, poolKey } from '../config/addresses'
import { CHAIN, wagmiConfig } from '../config/wagmi'
import { Phase, type LotteryModel, type LotteryState, type TicketRecord, type WinnerRecord } from '../lib/types'
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

  const run = useCallback(
    async (label: string, fn: () => Promise<`0x${string}`>) => {
      setError(null)
      setBusy(label)
      try {
        const hash = await fn()
        setLastTx(hash)
        setBusy('컨펌 대기 중…')
        await client?.waitForTransactionReceipt({ hash })
        await Promise.all([stateQ.refetch(), myQ.refetch(), loadLogs()])
      } catch (e: any) {
        setError(e?.shortMessage ?? e?.message ?? String(e))
        throw e
      } finally {
        setBusy(null)
      }
    },
    [client, stateQ, myQ, loadLogs],
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
    connect: () => connect({ connector: connectors[0] }),
    disconnect: () => disconnect(),
    actions,
  }
}
