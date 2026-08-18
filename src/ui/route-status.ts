import type { DetectedMarket } from '../core/market.js'

export interface RouteStatusCurve {
  creatorTaxBps: bigint
  snipeTaxBps: bigint
  realQuoteReserve: bigint
  sellableTokens: bigint
  readyToGraduate: boolean
  graduated: boolean
  isNativeQuote: boolean
}

export interface RouteStatusInput {
  market?: DetectedMarket
  curve?: RouteStatusCurve
  error?: string
  v2RouterConfigured: boolean
}

export interface RouteStatus {
  label: string
  detail?: string
  market?: string
  blocked?: string
}

function percent(bps: bigint): string {
  return `${(Number(bps) / 100).toFixed(2)}%`
}

function compactAmount(amount: bigint, decimals: number, suffix = ''): string {
  const scale = 10n ** BigInt(decimals)
  const whole = Number(amount / scale)
  if (whole >= 1_000_000) return `${(whole / 1_000_000).toFixed(2)}M${suffix}`
  if (whole >= 1_000) return `${(whole / 1_000).toFixed(2)}K${suffix}`
  const fraction = Number((amount % scale) * 100n / scale)
  return `${whole}.${fraction.toString().padStart(2, '0')}${suffix}`
}

/** Convert detected market state to compact, non-actionable terminal status text. */
export function formatRouteStatus(input: RouteStatusInput): RouteStatus {
  if (input.error) return { label: 'UNAVAILABLE', blocked: input.error }
  if (!input.market) return { label: 'DETECTING' }
  if (input.market.kind === 'v1') return { label: 'V1 / V3', detail: 'native WETH route' }
  if (input.market.kind === 'v2-v4') {
    return {
      label: 'V2 / V4',
      detail: `tick ${input.market.tickSpacing}`,
      blocked: input.v2RouterConfigured ? undefined : 'TradeRouterV2 not deployed', 
    }
  }

  const curve = input.curve
  if (!curve) return { label: 'V2 / CURVE', detail: 'loading curve state' }
  const state = curve.graduated ? 'graduated' : curve.readyToGraduate ? 'graduating' : 'live'
  return {
    label: 'V2 / CURVE',
    detail: `tax ${percent(curve.creatorTaxBps)} · snipe ${percent(curve.snipeTaxBps)} · ${state}`,
    market: `${compactAmount(curve.realQuoteReserve, 18, ' ETH')} · ${compactAmount(curve.sellableTokens, 18)}`,
    blocked: !curve.isNativeQuote
      ? 'custom quote asset is unsupported'
      : !input.v2RouterConfigured
        ? 'TradeRouterV2 not deployed'
        : curve.graduated || curve.readyToGraduate
          ? 'curve is unavailable for trading'
          : undefined,
  }
}
