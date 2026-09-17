import type { Address } from 'viem'
import { FEE_BPS, WETH } from '../config.js'
import type { PublicClientT } from './chain.js'
import { quoteCurveSell, readCurveState, type CurveState } from './curve.js'
import type { DetectedMarket } from './market.js'
import { quoteOut } from './router.js'
import { NATIVE_ETH, quoteV4ExactInput } from './v4.js'

const BPS = 10_000n

export interface HoldingValueQuote {
  netEth: bigint
  curve?: CurveState
}

export interface MarketCapQuote {
  netEth: bigint
  marketCapEth: bigint
}

export interface HoldingValueDependencies {
  v1: (client: PublicClientT, token: Address, amount: bigint) => Promise<bigint>
  curveState: (client: PublicClientT, curve: Address, holder: Address) => Promise<CurveState>
  v4: (client: PublicClientT, p: { token: Address; amount: bigint; tickSpacing: number }) => Promise<bigint>
}

const liveDependencies: HoldingValueDependencies = {
  v1: (client, token, amount) => quoteOut(client, token, WETH, amount),
  curveState: (client, curve, holder) => readCurveState(client, curve, holder),
  v4: (client, p) => quoteV4ExactInput(client, {
    token: p.token,
    tokenIn: p.token,
    tokenOut: NATIVE_ETH,
    grossAmountIn: p.amount,
    tickSpacing: p.tickSpacing,
  }),
}

function afterRouterFee(grossEth: bigint): bigint {
  return grossEth - grossEth * FEE_BPS / BPS
}

/** Read-only estimate of the net ETH returned by selling a complete token holding now. */
export async function quoteHoldingValue(
  client: PublicClientT,
  market: DetectedMarket,
  tokensIn: bigint,
  holder: Address,
  injected: HoldingValueDependencies = liveDependencies,
): Promise<HoldingValueQuote> {
  if (tokensIn <= 0n) return { netEth: 0n }

  if (market.kind === 'v1') {
    return { netEth: afterRouterFee(await injected.v1(client, market.token, tokensIn)) }
  }

  if (market.kind === 'v2-curve') {
    const curve = await injected.curveState(client, market.curve, holder)
    const curveNet = quoteCurveSell(curve, tokensIn).quoteOut
    return { netEth: afterRouterFee(curveNet), curve }
  }

  return {
    netEth: afterRouterFee(await injected.v4(client, {
      token: market.token,
      amount: tokensIn,
      tickSpacing: market.tickSpacing,
    })),
  }
}

function compactNumber(value: number): string {
  for (const [divisor, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (Math.abs(value) >= divisor) return `${(value / divisor).toFixed(2)}${suffix}`
  }
  return value.toFixed(2)
}

export function formatMarketCap(marketCapEth: bigint, ethUsd?: number): string {
  const eth = Number(marketCapEth) / 1e18
  if (!Number.isFinite(eth)) return 'unavailable'
  const ethText = `~ ${compactNumber(eth)} ETH`
  if (ethUsd === undefined || !Number.isFinite(ethUsd) || ethUsd <= 0) return ethText
  return `${ethText} · $${compactNumber(eth * ethUsd)}`
}

/**
 * Read-only fully diluted ETH estimate from the current net sale price of one
 * whole token unit. It is an estimate, not the output of a sale of total supply.
 */
export async function quoteMarketCap(
  client: PublicClientT,
  market: DetectedMarket,
  totalSupply: bigint,
  holder: Address,
  injected: HoldingValueDependencies = liveDependencies,
): Promise<MarketCapQuote> {
  if (totalSupply <= 0n) return { netEth: 0n, marketCapEth: 0n }
  const oneToken = 10n ** 18n
  const quote = await quoteHoldingValue(client, market, oneToken, holder, injected)
  return { netEth: quote.netEth, marketCapEth: quote.netEth * totalSupply / oneToken }
}
