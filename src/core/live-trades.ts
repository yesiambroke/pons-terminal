import type { Address, Hex, Log } from 'viem'
import { decodeEventLog, parseAbi } from 'viem'

export type LiveTrade = {
  side: 'buy' | 'sell'
  eth: bigint
  tokens: bigint
  wallet?: Address
  tx?: Hex
}

export const CURVE_TRADE_ABI = parseAbi([
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
])

export const V3_SWAP_ABI = parseAbi([
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
])

export const V4_SWAP_ABI = parseAbi([
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
])

export function decodeCurveTrade(log: Log): LiveTrade | undefined {
  try {
    const event = decodeEventLog({ abi: CURVE_TRADE_ABI, data: log.data, topics: log.topics })
    if (event.eventName === 'CurveBuy') {
      return { side: 'buy', eth: event.args.quoteIn!, tokens: event.args.tokensOut!, wallet: event.args.buyer, tx: log.transactionHash ?? undefined }
    }
    return { side: 'sell', eth: event.args.quoteOut!, tokens: event.args.tokensIn!, wallet: event.args.seller, tx: log.transactionHash ?? undefined }
  } catch {
    return undefined
  }
}

function decodeV3PoolSwap(log: Log, token: Address, currency0: Address): LiveTrade | undefined {
  try {
    const event = decodeEventLog({ abi: V3_SWAP_ABI, data: log.data, topics: log.topics })
    const args = event.args as { amount0?: bigint; amount1?: bigint }
    const tokenDelta = token.toLowerCase() === currency0.toLowerCase() ? args.amount0 : args.amount1
    const quoteDelta = token.toLowerCase() === currency0.toLowerCase() ? args.amount1 : args.amount0
    if (tokenDelta === undefined || quoteDelta === undefined || tokenDelta === 0n || quoteDelta === 0n) return undefined
    const side = tokenDelta < 0n ? 'buy' : 'sell'
    return {
      side,
      eth: quoteDelta < 0n ? -quoteDelta : quoteDelta,
      tokens: tokenDelta < 0n ? -tokenDelta : tokenDelta,
      tx: log.transactionHash ?? undefined,
    }
  } catch {
    return undefined
  }
}

function decodeV4PoolSwap(log: Log, token: Address, currency0: Address): LiveTrade | undefined {
  try {
    const event = decodeEventLog({ abi: V4_SWAP_ABI, data: log.data, topics: log.topics })
    const args = event.args as { amount0?: bigint; amount1?: bigint }
    const tokenDelta = token.toLowerCase() === currency0.toLowerCase() ? args.amount0 : args.amount1
    const quoteDelta = token.toLowerCase() === currency0.toLowerCase() ? args.amount1 : args.amount0
    if (tokenDelta === undefined || quoteDelta === undefined || tokenDelta === 0n || quoteDelta === 0n) return undefined
    // V4 Swap reports the caller's BalanceDelta: negative token means caller paid token in.
    const side = tokenDelta < 0n ? 'sell' : 'buy'
    return {
      side,
      eth: quoteDelta < 0n ? -quoteDelta : quoteDelta,
      tokens: tokenDelta < 0n ? -tokenDelta : tokenDelta,
      tx: log.transactionHash ?? undefined,
    }
  } catch {
    return undefined
  }
}

export function decodeV3Trade(log: Log, token: Address, currency0: Address): LiveTrade | undefined {
  return decodeV3PoolSwap(log, token, currency0)
}

export function decodeV4Trade(log: Log, token: Address, currency0: Address): LiveTrade | undefined {
  return decodeV4PoolSwap(log, token, currency0)
}
