import type { Address } from 'viem'

const BPS = 10_000n

function toBps(percent: number): bigint | undefined {
  const rounded = Math.round(percent * 100)
  if (!Number.isSafeInteger(rounded) || rounded <= 0) return undefined
  return BigInt(rounded)
}

export interface TrackedPosition {
  walletId: string
  token: Address
  tokens: bigint
  costEth: bigint
  realizedPnlEth: bigint
  realizedCostEth: bigint
}

export interface TpSlRule {
  walletId: string
  token: Address
  takeProfitPct: number
  stopLossPct: number
  sellPct: number
  triggered?: 'take-profit' | 'stop-loss'
}

export interface PositionAssessment {
  trackedTokens: bigint
  untrackedTokens: bigint
  costEth: bigint
  netEth: bigint
  pnlEth: bigint
  pnlBps?: bigint
}

export function positionKey(walletId: string, token: Address): string {
  return `${walletId}:${token.toLowerCase()}`
}

export function emptyPosition(walletId: string, token: Address): TrackedPosition {
  return { walletId, token, tokens: 0n, costEth: 0n, realizedPnlEth: 0n, realizedCostEth: 0n }
}

export function applyBuy(position: TrackedPosition, costEth: bigint, tokensOut: bigint): TrackedPosition {
  if (costEth <= 0n || tokensOut <= 0n) return position
  return { ...position, tokens: position.tokens + tokensOut, costEth: position.costEth + costEth }
}

/** Apply a sale to the terminal-tracked tranche only; external tokens stay untracked. */
export function applySell(position: TrackedPosition, tokensIn: bigint, ethOut: bigint): TrackedPosition {
  if (position.tokens <= 0n || tokensIn <= 0n || ethOut < 0n) return position
  const soldTracked = tokensIn < position.tokens ? tokensIn : position.tokens
  const soldCost = position.costEth * soldTracked / position.tokens
  const attributableOut = ethOut * soldTracked / tokensIn
  return {
    ...position,
    tokens: position.tokens - soldTracked,
    costEth: position.costEth - soldCost,
    realizedPnlEth: position.realizedPnlEth + attributableOut - soldCost,
    realizedCostEth: position.realizedCostEth + soldCost,
  }
}

/** Carry proportional terminal cost basis when local Sell All consolidates a wallet. */
export function moveTrackedTokens(from: TrackedPosition, to: TrackedPosition, tokens: bigint): { from: TrackedPosition; to: TrackedPosition } {
  if (tokens <= 0n || from.tokens <= 0n) return { from, to }
  const moved = tokens < from.tokens ? tokens : from.tokens
  const cost = from.costEth * moved / from.tokens
  return {
    from: { ...from, tokens: from.tokens - moved, costEth: from.costEth - cost },
    to: { ...to, tokens: to.tokens + moved, costEth: to.costEth + cost },
  }
}

export function reconcilePosition(position: TrackedPosition, liveTokens: bigint): TrackedPosition {
  if (liveTokens >= position.tokens) return position
  if (liveTokens <= 0n) return { ...position, tokens: 0n, costEth: 0n }
  return { ...position, tokens: liveTokens, costEth: position.costEth * liveTokens / position.tokens }
}

export function entryMarketCapEth(costEth: bigint, tokens: bigint, totalSupply: bigint): bigint | undefined {
  if (tokens <= 0n || costEth <= 0n || totalSupply <= 0n) return undefined
  return costEth * totalSupply / tokens
}

export function assessPosition(position: TrackedPosition, liveTokens: bigint, netEth: bigint): PositionAssessment {
  const trackedTokens = position.tokens < liveTokens ? position.tokens : liveTokens
  const costEth = position.tokens === 0n ? 0n : position.costEth * trackedTokens / position.tokens
  const pnlEth = netEth - costEth
  return {
    trackedTokens,
    untrackedTokens: liveTokens > trackedTokens ? liveTokens - trackedTokens : 0n,
    costEth,
    netEth,
    pnlEth,
    pnlBps: costEth > 0n ? pnlEth * BPS / costEth : undefined,
  }
}

export function evaluateTpSl(assessment: PositionAssessment, rule: TpSlRule, automationEnabled = true): 'take-profit' | 'stop-loss' | undefined {
  const takeProfitBps = toBps(rule.takeProfitPct)
  const stopLossBps = toBps(rule.stopLossPct)
  if (!automationEnabled || rule.triggered || assessment.trackedTokens <= 0n || assessment.costEth <= 0n || !takeProfitBps || !stopLossBps) return undefined
  if (assessment.netEth * BPS <= assessment.costEth * (BPS - stopLossBps)) return 'stop-loss'
  if (assessment.netEth * BPS >= assessment.costEth * (BPS + takeProfitBps)) return 'take-profit'
  return undefined
}

export function ruleSellAmount(assessment: PositionAssessment, rule: TpSlRule): bigint {
  const sellBps = toBps(rule.sellPct)
  if (!sellBps || sellBps > BPS) return 0n
  return assessment.trackedTokens * sellBps / BPS
}

export function combinePnl(openPnlEth: bigint, openCostEth: bigint, realizedPnlEth: bigint, realizedCostEth: bigint): { pnlEth: bigint; pnlBps?: bigint } {
  const costEth = openCostEth + realizedCostEth
  const pnlEth = openPnlEth + realizedPnlEth
  return { pnlEth, pnlBps: costEth > 0n ? pnlEth * BPS / costEth : undefined }
}

export function formatPnlPercent(pnlBps: bigint | undefined): string {
  if (pnlBps === undefined) return '--'
  const value = Number(pnlBps) / 100
  const magnitude = Math.abs(value)
  const text = Number.isInteger(magnitude) ? magnitude.toFixed(0) : magnitude.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return `${value >= 0 ? '+' : '-'}${text}%`
}

export function formatPnl(pnlEth: bigint, pnlBps?: bigint): string {
  const sign = pnlEth >= 0n ? '+' : '-'
  const value = pnlEth >= 0n ? pnlEth : -pnlEth
  const whole = value / 10n ** 18n
  const fraction = (value % 10n ** 18n) / 10n ** 12n
  const pctValue = Number(pnlBps ?? 0n) / 100
  const pct = pnlBps === undefined ? '' : ` ${pnlBps >= 0n ? '+' : ''}${Number.isInteger(pctValue) ? pctValue.toFixed(0) : pctValue.toFixed(2)}%`
  return `${sign}${whole}.${fraction.toString().padStart(4, '0').slice(0, 4)} ETH${pct}`
}
