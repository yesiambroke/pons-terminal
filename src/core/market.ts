import type { Address } from 'viem'
import type { PublicClientT } from './chain.js'
import { PONS_V2_FACTORY, WETH } from '../config.js'
import { PONS_V2_FACTORY_ABI } from './abis.js'

export interface V2LaunchRecord {
  token: Address
  curve: Address
  deployer: Address
  creatorFeeRecipient: Address
  pairToken: Address
  graduationThreshold: bigint
  poolFee: number
  tickSpacing: number
  creatorTaxBps: number
  buybackEnabled: boolean
  phase: number
  sweptQuote: bigint
  sweptTokens: bigint
  sweptAt: bigint
  exists: boolean
}

export type MarketRoute =
  | { kind: 'v2-curve'; token: Address; curve: Address; pairToken: Address; creatorTaxBps: number }
  | { kind: 'v2-v4'; token: Address; pairToken: Address; tickSpacing: number; creatorTaxBps: number }

export type DetectedMarket =
  | { kind: 'v1'; token: Address; quoteToken: typeof WETH }
  | MarketRoute

export type ExecutionRoute = DetectedMarket['kind']

/** Map a resolved market to the executor key without allowing V2 → V1 fallback. */
export function executionRouteFor(market: DetectedMarket): ExecutionRoute {
  return market.kind
}

export function classifyV2Launch(record: V2LaunchRecord): MarketRoute {
  if (!record.exists) throw new Error('not a V2 launch')
  if (record.phase === 0) return {
    kind: 'v2-curve', token: record.token, curve: record.curve,
    pairToken: record.pairToken, creatorTaxBps: record.creatorTaxBps,
  }
  if (record.phase === 2) return {
    kind: 'v2-v4', token: record.token, pairToken: record.pairToken,
    tickSpacing: record.tickSpacing, creatorTaxBps: record.creatorTaxBps,
  }
  if (record.phase === 1) throw new Error('V2 graduation is pending')
  if (record.phase === 3) throw new Error('V2 launch was rescued')
  throw new Error(`unknown V2 launch phase: ${record.phase}`)
}

/** Resolve a token into the route the HOODL router must execute. */
export async function detectMarket(client: PublicClientT, token: Address): Promise<DetectedMarket> {
  const record = await (client as any).readContract({
    address: PONS_V2_FACTORY,
    abi: PONS_V2_FACTORY_ABI,
    functionName: 'getLaunchedToken',
    args: [token],
  }) as V2LaunchRecord
  return record.exists ? classifyV2Launch(record) : { kind: 'v1', token, quoteToken: WETH }
}
