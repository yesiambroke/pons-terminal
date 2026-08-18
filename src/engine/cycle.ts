import type { Address } from 'viem'
import { ERC20_ABI } from '../core/abis.js'
import type { PublicClientT, WalletClientT } from '../core/chain.js'
import { atomicRoundTrip, withRetry, type LegResult } from '../core/router.js'
import { dispatchTrade } from '../core/dispatch.js'
import { detectMarket } from '../core/market.js'
import { gasRequired, randInt, sleep } from '../core/util.js'
import { buyAmounts, resolvePattern, type ResolvedPattern } from './patterns.js'

export interface CycleConfig {
  token: Address
  /** 'auto' chooses V1 atomic or V2 classic; classic always uses discrete legs. */
  mode: 'classic' | 'atomic' | 'auto'
  /** 'bs' | 'custom' | 'random' (classic only) */
  patternMode: 'bs' | 'custom' | 'random'
  /** buy leg count (classic custom only) */
  buys: number
  /** sell leg count (classic custom only) */
  sells: number
  /** ETH spent per cycle (sum of all buy legs) */
  ethPerCycle: bigint
  /** [min, max] seconds between legs */
  legDelay: [number, number]
  /** wallet that receives bought tokens and sells them */
  holder: Address
  /** 0 = run forever; otherwise stop after this many cycles */
  targetCycles: number
}

export interface CycleResult {
  results: LegResult[]
  totalBought: bigint
  feePaid: bigint
  shape: string
}

/** Injectable chain operations keep route-aware cycle behavior regression-testable. */
export interface CycleDependencies {
  gasRequired: typeof gasRequired
  detectMarket: typeof detectMarket
  dispatchTrade: typeof dispatchTrade
  atomicRoundTrip: typeof atomicRoundTrip
  tokenBalance: (client: PublicClientT, token: Address, holder: Address) => Promise<bigint>
  sleep: typeof sleep
  randInt: typeof randInt
}

const liveDependencies: CycleDependencies = {
  gasRequired,
  detectMarket,
  dispatchTrade,
  atomicRoundTrip,
  tokenBalance: async (client, token, holder) => (client as any).readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [holder],
  }) as Promise<bigint>,
  sleep,
  randInt,
}

/** Run ONE full cycle. Throws new-l `LOW_GAS` when the signer lacks funds. */
export async function runCycle(
  walletClient: WalletClientT,
  publicClient: PublicClientT,
  cfg: CycleConfig,
  injected: CycleDependencies = liveDependencies,
): Promise<CycleResult> {
  const market = cfg.mode === 'classic'
    ? undefined
    : await injected.detectMarket(publicClient, cfg.token)
  const mode = cfg.mode === 'auto'
    ? (market!.kind === 'v1' ? 'atomic' : 'classic')
    : cfg.mode
  const pattern: ResolvedPattern = mode === 'atomic'
    ? resolvePattern('atomic', 'bs', 1, 1)
    : resolvePattern('classic', cfg.patternMode, cfg.buys, cfg.sells)

  const eth = await publicClient.getBalance({ address: walletClient.account!.address })
  if (eth < cfg.ethPerCycle + (await injected.gasRequired(publicClient))) throw new Error('LOW_GAS')

  if (mode === 'atomic') {
    if (!market || market.kind !== 'v1') throw new Error('atomic volume is V1-only; V2 uses classic volume')
    return atomicCycle(walletClient, publicClient, cfg, pattern, injected)
  }

  // ── classic: discrete buy/sell legs through the router ──
  const buyParts = buyAmounts(cfg.ethPerCycle, pattern.buys)
  const results: LegResult[] = []
  let totalBought = 0n
  let legsDone = 0
  const delay = () => injected.sleep(injected.randInt(cfg.legDelay[0], cfg.legDelay[1]) * 1000)

  for (const part of buyParts) {
    if (legsDone > 0) await delay()
    const r = await withRetry(() => injected.dispatchTrade(walletClient, publicClient, {
      token: cfg.token, direction: 'buy', amount: part, recipient: cfg.holder,
    }))
    totalBought += r.amountOut
    legsDone++
    results.push({ dir: 'buy', amount: part, hash: r.hash, fee: r.fee, volume: part })
  }

  for (let i = 0; i < pattern.sells; i++) {
    if (legsDone > 0) await delay()
    let tokensIn: bigint
    if (i === pattern.sells - 1) {
      tokensIn = await injected.tokenBalance(publicClient, cfg.token, cfg.holder)
    } else {
      tokensIn = totalBought / BigInt(pattern.sells)
    }
    if (tokensIn <= 0n) throw new Error('volume buy returned zero tokens')
    const r = await withRetry(() => injected.dispatchTrade(walletClient, publicClient, {
      token: cfg.token, direction: 'sell', amount: tokensIn, recipient: cfg.holder,
    }))
    legsDone++
    results.push({ dir: 'sell', amount: tokensIn, hash: r.hash, fee: r.fee, volume: r.amountOut })
  }

  const feePaid = results.reduce((a, r) => a + r.fee, 0n)
  return { results, totalBought, feePaid, shape: pattern.shape }
}

/** Atomic single-tx round trip via the TradeRouter `roundTrip`. */
async function atomicCycle(
  walletClient: WalletClientT,
  publicClient: PublicClientT,
  cfg: CycleConfig,
  pattern: ResolvedPattern,
  injected: CycleDependencies,
): Promise<CycleResult> {
  const r = await injected.atomicRoundTrip(walletClient, publicClient, cfg.token, cfg.ethPerCycle, cfg.holder as Address)
  return {
    results: [{
      dir: 'buy',
      amount: cfg.ethPerCycle,
      hash: r.hash,
      fee: r.fee,
      volume: cfg.ethPerCycle,
    }],
    totalBought: r.quoteOut,
    feePaid: r.fee,
    shape: pattern.shape,
  }
}

/** Loop cycles with a cadence between them until targetCycles is hit. */
export async function runVolume(
  walletClient: WalletClientT,
  publicClient: PublicClientT,
  cfg: CycleConfig,
  cadenceRange: [number, number],
  onCycle?: (result: CycleResult, cycleNum: number) => void,
): Promise<void> {
  let done = 0
  while (cfg.targetCycles === 0 || done < cfg.targetCycles) {
    const result = await runCycle(walletClient, publicClient, cfg)
    done++
    onCycle?.(result, done)
    if (cfg.targetCycles === 0 || done < cfg.targetCycles) {
      await sleep(randInt(cadenceRange[0], cadenceRange[1]) * 1000)
    }
  }
}

export * from './patterns.js'