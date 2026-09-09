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
  connect: () => void
  disconnect: () => void
  actions: LotteryActions
}
