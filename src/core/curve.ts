import type { Address } from 'viem'
import type { PublicClientT } from './chain.js'
import { PONS_V2_CURVE_ABI } from './abis.js'

export interface CurveState {
  curve: Address
  quoteReserve: bigint
  tokenReserve: bigint
  realQuoteReserve: bigint
  sellableTokens: bigint
  feeBps: bigint
  creatorTaxBps: bigint
  snipeTaxBps: bigint
  readyToGraduate: boolean
  graduated: boolean
  pairToken: Address
  isNativeQuote: boolean
}

/** Read all mutable Pons V2 curve inputs needed for a quote or route decision. */
export async function readCurveState(
  client: PublicClientT,
  curve: Address,
  recipient: Address,
): Promise<CurveState> {
  const read = (functionName: string, args: readonly unknown[] = []) => (client as any).readContract({
    address: curve,
    abi: PONS_V2_CURVE_ABI,
    functionName,
    args,
  })
  const [reserves, sellableTokens, realQuoteReserve, feeBps, creatorTaxBps, snipeTaxBps,
    readyToGraduate, graduated, pairToken, isNativeQuote] = await Promise.all([
    read('getReserves'),
    read('sellableTokens'),
    read('realQuoteReserve'),
    read('feeBps'),
    read('creatorTaxBps'),
    read('currentSnipeTaxBps', [recipient]),
    read('readyToGraduate'),
    read('graduated'),
    read('pairToken'),
    read('isNativeQuote'),
  ])
  const [quoteReserve, tokenReserve] = reserves as readonly [bigint, bigint]
  return {
    curve,
    quoteReserve,
    tokenReserve,
    realQuoteReserve: realQuoteReserve as bigint,
    sellableTokens: sellableTokens as bigint,
    feeBps: feeBps as bigint,
    creatorTaxBps: creatorTaxBps as bigint,
    snipeTaxBps: snipeTaxBps as bigint,
    readyToGraduate: readyToGraduate as boolean,
    graduated: graduated as boolean,
    pairToken: pairToken as Address,
    isNativeQuote: isNativeQuote as boolean,
  }
}

export interface CurveBuyQuote {
  tokensOut: bigint
  quoteUsed: bigint
  quoteRefund: bigint
  netQuoteIn: bigint
  feeBps: bigint
}

export interface CurveSellQuote {
  grossQuoteOut: bigint
  quoteOut: bigint
  feeBps: bigint
}

const BPS = 10000n

function ceilDiv(numerator: bigint, denominator: bigint) {
  return (numerator + denominator - 1n) / denominator
}

/** Quote the curve's buy path using the protocol's integer operation order. */
export function quoteCurveBuy(state: CurveState, quoteIn: bigint): CurveBuyQuote {
  if (quoteIn <= 0n) throw new Error('buy amount must be > 0')
  if (state.sellableTokens === 0n || state.graduated) throw new Error('curve graduated')
  const feeBps = state.feeBps + state.creatorTaxBps + state.snipeTaxBps
  if (feeBps >= BPS) throw new Error('curve fees exhaust buy input')

  let quoteUsed = quoteIn
  let netQuoteIn = quoteIn * (BPS - feeBps) / BPS
  let tokensOut = state.tokenReserve * netQuoteIn / (state.quoteReserve + netQuoteIn)

  if (tokensOut > state.sellableTokens) {
    tokensOut = state.sellableTokens
    // Invert tokenOut = tokenReserve * netQuote / (quoteReserve + netQuote).
    netQuoteIn = ceilDiv(state.quoteReserve * tokensOut, state.tokenReserve - tokensOut)
    quoteUsed = ceilDiv(netQuoteIn * BPS, BPS - feeBps)
  }

  return {
    tokensOut,
    quoteUsed,
    quoteRefund: quoteIn - quoteUsed,
    netQuoteIn,
    feeBps,
  }
}

/** Quote the curve's sell path: price first, then deduct quote-side fees. */
export function quoteCurveSell(state: CurveState, tokensIn: bigint): CurveSellQuote {
  if (tokensIn <= 0n) throw new Error('sell amount must be > 0')
  if (state.readyToGraduate || state.graduated) throw new Error('curve graduated')
  const feeBps = state.feeBps + state.creatorTaxBps
  const grossQuoteOut = state.quoteReserve * tokensIn / (state.tokenReserve + tokensIn)
  const quoteOut = grossQuoteOut - grossQuoteOut * feeBps / BPS
  return { grossQuoteOut, quoteOut, feeBps }
}
