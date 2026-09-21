import type { Address } from 'viem'
import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem'
import type { PublicClientT } from './chain.js'
import { PONS_V2_FACTORY, WETH } from '../config.js'
import { PONS_V2_FACTORY_ABI } from './abis.js'

const PONS_V2_MEME_HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044' as const
const V4_POOL_KEY = parseAbiParameters('address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks')

export function ponsV4PoolId(token: Address, quote: Address, tickSpacing: number): `0x${string}` {
  const [currency0, currency1] = BigInt(token) < BigInt(quote) ? [token, quote] : [quote, token]
  return keccak256(encodeAbiParameters(V4_POOL_KEY, [currency0, currency1, 0, tickSpacing, PONS_V2_MEME_HOOK]))
}

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

export function hasMarketRouteChanged(previous: DetectedMarket | undefined, next: DetectedMarket): boolean {
  return previous?.kind !== next.kind
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
