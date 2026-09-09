import type { Address } from 'viem'

export enum Phase {
  Open = 0,
  Drawing = 1,
  Resolved = 2,
}

export interface EpochInfo {
  winner: Address
  endTime: number
  entryCount: number
  ticketCount: number
  phase: Phase
  claimed: boolean
  drawRequestedAt: number
  prize: bigint
  vrfRequestId: bigint
}

export interface LotteryState {
  epochId: number
  epoch: EpochInfo
  pot: bigint
  reserved: bigint
  epochDuration: number
  vrfTimeout: number
  feeBps: number
  ticketPrice: bigint
  timestamp: number
  owner: Address
}

export interface WinnerRecord {
  epochId: number
  winner: Address
  prize: bigint
  claimed: boolean
  randomWord?: bigint
}

export interface TicketRecord {
  epochId: number
  player: Address
  firstIndex: number
  count: number
  fee: bigint
  at: number
}

export interface LotteryActions {
  buyTicket: (amountEth: string) => Promise<void>
  requestDraw: () => Promise<void>
  retryDraw: () => Promise<void>
  skipEpoch: () => Promise<void>
  claim: (epochId: number) => Promise<void>
  deposit: (amountEth: string) => Promise<void>
  /** 데모(mock 코디네이터)일 때만: 난수를 직접 주입해 콜백을 실행 */
  mockFulfill?: () => Promise<void>
}

export interface LotteryModel {
  mode: 'demo' | 'live'
  state: LotteryState | null
  winners: WinnerRecord[]
  tickets: TicketRecord[]
  myTickets: number
  account?: Address
  isOwner: boolean
  busy: string | null
  error: string | null
  lastTx?: string
  /** 훅이 진짜 Chainlink 가 아닌 mock 코디네이터를 보고 있음 */
  mockVrf: boolean
  connect: () => void
  disconnect: () => void
  actions: LotteryActions
}
