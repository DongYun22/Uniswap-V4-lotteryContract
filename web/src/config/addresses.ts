import type { Address } from 'viem'

const env = import.meta.env

const asAddress = (v: string | undefined): Address | undefined =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined

export const HOOK_ADDRESS = asAddress(env.VITE_HOOK_ADDRESS)
export const TOKEN_ADDRESS = asAddress(env.VITE_TOKEN_ADDRESS)
export const SWAP_ROUTER =
  asAddress(env.VITE_SWAP_ROUTER) ?? ('0xf13D190e9117920c703d79B5F33732e10049b115' as Address)
export const POOL_FEE = Number(env.VITE_POOL_FEE ?? 3000)
export const POOL_TICK_SPACING = Number(env.VITE_POOL_TICK_SPACING ?? 60)
export const DEPLOY_BLOCK = BigInt(env.VITE_DEPLOY_BLOCK ?? 0)
export const RPC_URL = env.VITE_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'

/** 훅 주소가 없으면 데모 모드 */
export const IS_LIVE = Boolean(HOOK_ADDRESS && TOKEN_ADDRESS)

export const NATIVE: Address = '0x0000000000000000000000000000000000000000'

/** currency0 = ETH(0x0) 가 항상 정렬상 앞이므로 ETH→토큰 스왑은 zeroForOne=true */
export const poolKey = () => ({
  currency0: NATIVE,
  currency1: TOKEN_ADDRESS ?? NATIVE,
  fee: POOL_FEE,
  tickSpacing: POOL_TICK_SPACING,
  hooks: HOOK_ADDRESS ?? NATIVE,
})

export const EXPLORER = 'https://sepolia.etherscan.io'
export const POOL_ID = env.VITE_POOL_ID as string | undefined

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`
export const addrUrl = (addr: string) => `${EXPLORER}/address/${addr}`
export const tokenUrl = (token: string, holder?: string) =>
  holder ? `${EXPLORER}/token/${token}?a=${holder}` : `${EXPLORER}/token/${token}`
export const VRF_SUB_ID = env.VITE_VRF_SUB_ID as string | undefined
/** 진짜 Chainlink 코디네이터. 훅의 s_vrfCoordinator 가 이 값과 다르면 데모용 mock 으로 간주 */
export const VRF_COORDINATOR = asAddress(env.VITE_VRF_COORDINATOR)
export const VRF_SUB_URL = VRF_SUB_ID ? `https://vrf.chain.link/sepolia/${VRF_SUB_ID}` : 'https://vrf.chain.link'
