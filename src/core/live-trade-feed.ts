import type { Address, Hex } from 'viem'
import { createPublicClient, http, parseAbi, webSocket } from 'viem'
import type { DetectedMarket } from './market.js'
import { ponsV4PoolId } from './market.js'
import type { PublicClientT } from './chain.js'
import { robinhoodChain } from './chain.js'
import { CURVE_TRADE_ABI, V3_SWAP_ABI, V4_SWAP_ABI, decodeCurveTrade, decodeV3Trade, decodeV4Trade, type LiveTrade } from './live-trades.js'

const V3_FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' as const
const V4_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as const
const V3_FACTORY_ABI = parseAbi(['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)'])
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

export type LiveTradeSource =
  | { kind: 'curve'; address: Address }
  | { kind: 'v3'; address: Address; token: Address; currency0: Address }
  | { kind: 'v4'; address: typeof V4_POOL_MANAGER; poolId: Hex; token: Address; currency0: Address }

export async function resolveLiveTradeSource(client: PublicClientT, market: DetectedMarket): Promise<LiveTradeSource> {
  if (market.kind === 'v2-curve') return { kind: 'curve', address: market.curve }
  if (market.kind === 'v1') {
    const pool = await (client as any).readContract({
      address: V3_FACTORY,
      abi: V3_FACTORY_ABI,
      functionName: 'getPool',
      args: [market.token, market.quoteToken, 10000],
    }) as Address
    if (pool.toLowerCase() === ZERO_ADDRESS) throw new Error('V1 pool unavailable')
    const currency0 = BigInt(market.token) < BigInt(market.quoteToken) ? market.token : market.quoteToken
    return { kind: 'v3', address: pool, token: market.token, currency0 }
  }
  if (market.pairToken.toLowerCase() !== ZERO_ADDRESS) throw new Error('live feed supports native ETH V4 pairs only')
  const currency0 = BigInt(market.token) < BigInt(ZERO_ADDRESS) ? market.token : ZERO_ADDRESS
  return {
    kind: 'v4',
    address: V4_POOL_MANAGER,
    poolId: ponsV4PoolId(market.token, ZERO_ADDRESS, market.tickSpacing),
    token: market.token,
    currency0,
  }
}

export interface LiveTradeFeed {
  stop(): void
}

export function startLiveTradeFeed(
  url: string | undefined,
  source: LiveTradeSource,
  onTrade: (trade: LiveTrade) => void,
  onError?: (error: Error) => void,
): LiveTradeFeed {
  if (!url) return { stop() {} }
  const client = createPublicClient({ chain: robinhoodChain, transport: webSocket(url, { reconnect: true, retryDelay: 1_000 }) })
  const emit = (trade: LiveTrade) => {
    if (trade.wallet || !trade.tx) { onTrade(trade); return }
    void client.getTransaction({ hash: trade.tx }).then((tx) => onTrade({ ...trade, wallet: tx.from })).catch(() => onTrade(trade))
  }
  const onLogs = (logs: readonly unknown[]) => {
    for (const log of logs) {
      const trade = source.kind === 'curve'
        ? decodeCurveTrade(log as never)
        : source.kind === 'v3'
          ? decodeV3Trade(log as never, source.token, source.currency0)
          : decodeV4Trade(log as never, source.token, source.currency0)
      if (trade) emit(trade)
    }
  }
  const onWatchError = (error: Error) => onError?.(error)
  const stop = source.kind === 'curve'
    ? client.watchContractEvent({ address: source.address, abi: CURVE_TRADE_ABI, onLogs, onError: onWatchError })
    : source.kind === 'v3'
      ? client.watchContractEvent({ address: source.address, abi: V3_SWAP_ABI, eventName: 'Swap', onLogs, onError: onWatchError })
      : client.watchContractEvent({ address: source.address, abi: V4_SWAP_ABI, eventName: 'Swap', args: { id: source.poolId }, onLogs, onError: onWatchError })
  return { stop }
}
