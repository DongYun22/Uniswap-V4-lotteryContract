// deployments/sepolia.json → web/.env
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../../deployments/sepolia.json')
const dst = resolve(here, '../.env')

const d = JSON.parse(readFileSync(src, 'utf8'))
const env = [
  `VITE_HOOK_ADDRESS=${d.hook}`,
  `VITE_TOKEN_ADDRESS=${d.token}`,
  `VITE_POOL_FEE=${d.fee}`,
  `VITE_POOL_TICK_SPACING=${d.tickSpacing}`,
  `VITE_SWAP_ROUTER=${d.swapRouter}`,
  `VITE_DEPLOY_BLOCK=${d.deployBlock}`,
  `VITE_VRF_SUB_ID=${d.subscriptionId}`,
  `VITE_VRF_COORDINATOR=${d.vrfCoordinator}`,
  `VITE_POOL_ID=${d.poolId}`,
  `VITE_RPC_URL=${process.env.VITE_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'}`,
  '',
].join('\n')
writeFileSync(dst, env)
console.log(`wrote ${dst}\n${env}`)
