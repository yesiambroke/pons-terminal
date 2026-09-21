import type { Address } from 'viem'
import type { PublicClientT, WalletClientT } from './chain.js'
import { detectMarket, type DetectedMarket } from './market.js'
import { hoodlSwap, hoodlCurveSwap, hoodlV4Swap, type SwapResult } from './router.js'
import { NATIVE_ETH, quoteV4ExactInput } from './v4.js'

export interface DispatchTradeParams {
  token: Address
  direction: 'buy' | 'sell'
  amount: bigint
  recipient: Address
  /** Optional trusted V4 gross-output quote override; otherwise the SDK obtains a live quote. */
  v4MinGrossOut?: bigint
  /** Optional venue min-out slippage in bps. Omitted legs keep the 2% default. */
  slippageBps?: bigint
}

export interface RoutedSwapResult extends SwapResult {
  route: DetectedMarket['kind']
}

export interface DispatchDependencies {
  detect: (client: PublicClientT, token: Address) => Promise<DetectedMarket>
  v1: (wallet: WalletClientT, client: PublicClientT, p: DispatchTradeParams) => Promise<SwapResult>
  curve: (wallet: WalletClientT, client: PublicClientT, p: { curve: Address } & DispatchTradeParams) => Promise<SwapResult>
  quoteV4: (client: PublicClientT, p: { token: Address; tokenIn: Address; tokenOut: Address; grossAmountIn: bigint; tickSpacing: number }) => Promise<bigint>
  v4: (wallet: WalletClientT, client: PublicClientT, p: { tickSpacing: number } & DispatchTradeParams) => Promise<SwapResult>
}

const liveDependencies: DispatchDependencies = {
  detect: detectMarket,
  v1: (wallet, client, p) => hoodlSwap(wallet, client, p),
  curve: (wallet, client, p) => hoodlCurveSwap(wallet, client, { ...p, amount: p.amount }),
  quoteV4: (client, p) => quoteV4ExactInput(client, p),
  v4: (wallet, client, p) => hoodlV4Swap(wallet, client, {
    token: p.token,
    tokenIn: p.direction === 'buy' ? NATIVE_ETH : p.token,
    tokenOut: p.direction === 'buy' ? p.token : NATIVE_ETH,
    grossAmountIn: p.amount,
    minGrossOut: p.v4MinGrossOut!,
    recipient: p.recipient,
    tickSpacing: p.tickSpacing,
    slippageBps: p.slippageBps,
  }),
}

/** Detect a token's venue and execute only through its matching HOODL router path. */
export async function dispatchTrade(
  wallet: WalletClientT,
  client: PublicClientT,
  p: DispatchTradeParams,
  injected: DispatchDependencies = liveDependencies,
): Promise<RoutedSwapResult> {
  const market = await injected.detect(client, p.token)
  const trade = p.direction === 'buy' ? p : { ...p, slippageBps: undefined }
  if (market.kind === 'v1') return { ...(await injected.v1(wallet, client, trade)), route: market.kind }
  if (market.kind === 'v2-curve') {
    return { ...(await injected.curve(wallet, client, { ...trade, curve: market.curve })), route: market.kind }
  }
  const tokenIn = p.direction === 'buy' ? NATIVE_ETH : p.token
  const tokenOut = p.direction === 'buy' ? p.token : NATIVE_ETH
  const v4MinGrossOut = trade.v4MinGrossOut ?? await injected.quoteV4(client, {
    token: p.token, tokenIn, tokenOut, grossAmountIn: p.amount, tickSpacing: market.tickSpacing,
  })
  if (v4MinGrossOut <= 0n) throw new Error('V4 quote returned zero output')
  return { ...(await injected.v4(wallet, client, { ...trade, v4MinGrossOut, tickSpacing: market.tickSpacing })), route: market.kind }
}
