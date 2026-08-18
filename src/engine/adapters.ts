// Job adapters — turn JobParams + wallet balances into Executor Leg[]s that call
// the WalletDriver. One planner per job type. Deterministic and testable with a
// fake driver. NOTE: adapters only ever see Wallet.id/label — the driver resolves
// the real signer/address, protecting keys and keeping the engine chain-agnostic.

import type { Wallet, Leg, JobParams } from './executor.js'
import type { WalletDriver, SwapOutcome } from './driver.js'
import {
  splitEqual, splitProp, sellPctShares, ladderArith, ladderGeom, ladderList,
} from './planner.js'

function toHex(s: string): `0x${string}` { return s as `0x${string}` }

function fixed(amount: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals)
  const whole = amount / unit
  const fraction = (amount % unit).toString().padStart(decimals, '0')
  return `${whole}.${fraction}`
}

function compact(amount: bigint, decimals = 18, precision = 2): string {
  const value = Number(fixed(amount, decimals))
  if (!Number.isFinite(value)) return '–'
  for (const [divisor, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (Math.abs(value) >= divisor) return `${(value / divisor).toFixed(precision)}${suffix}`
  }
  return value.toFixed(precision)
}

function eth(amount: bigint): string { return fixed(amount, 18).slice(0, 8) }

export function formatTradeLabel(walletId: string, direction: 'buy' | 'sell', amountIn: bigint, amountOut: bigint): string {
  return direction === 'buy'
    ? `${walletId}: buy ${eth(amountIn)} ETH → ${compact(amountOut)} TOK`
    : `${walletId}: sell ${compact(amountIn)} TOK → ${eth(amountOut)} ETH`
}

export function formatTransferLabel(fromId: string, toId: string, amount: bigint): string {
  return `${fromId}: send ${compact(amount)} TOK → ${toId}`
}

function shortErr(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('insufficient')) return 'insufficient gas'
  if (message.includes('revert')) return 'tx reverted'
  return message.split(/[\n:.]/)[0]!.slice(0, 45) || 'transfer failed'
}

/** Best-effort token consolidate to one sink, then sell the sink's live bag. */
export function nukePlanner(
  driver: WalletDriver,
  token: string,
  onTransferSettled?: () => void,
): { type: 'nuke'; plan: (wallets: Wallet[], params: JobParams) => Promise<Leg[]> } {
  return {
    type: 'nuke',
    plan: async (wallets, params) => {
      const holders = (await Promise.all(wallets.map(async (wallet) => ({ wallet, holdings: await driver.holdings(wallet) }))))
        .filter(({ holdings }) => holdings.token > 0n)
        .map(({ wallet }) => wallet)
      if (!holders.length) throw new Error('nuke: no token holdings in selection')
      if (holders.some((wallet) => !wallet.address)) throw new Error('nuke: missing wallet address')

      const sink = holders.find((wallet) => wallet.id === params.sinkId)
        ?? holders[Math.floor(Math.random() * holders.length)]!
      const donors = holders.filter((wallet) => wallet.id !== sink.id)
      let remaining = donors.length
      let release = () => {}
      const settled = donors.length === 0 ? Promise.resolve() : new Promise<void>((resolve) => { release = resolve })

      const transfers: Leg[] = donors.map((donor) => ({
        wallet: donor,
        run: async () => {
          try {
            const live = await driver.holdings(donor)
            if (live.token <= 0n) return { ok: true, label: `${donor.id}: skip 0 TOK` }
            await driver.transfer(donor, { token: toHex(params.token ?? token), to: sink.address!, amount: live.token })
            return { ok: true, label: formatTransferLabel(donor.id, sink.id, live.token) }
          } catch (error) {
            return { ok: false, label: `${donor.id}: send ✗ ${shortErr(error)}` }
          } finally {
            onTransferSettled?.()
            remaining -= 1
            if (remaining <= 0) release()
          }
        },
      }))

      const sell: Leg = {
        wallet: sink,
        run: async () => {
          await settled
          const live = await driver.holdings(sink)
          if (live.token <= 0n) return { ok: false, label: `${sink.id}: nuke sell ✗ nothing to sell` }
          const out = await driver.swap(sink, { token: toHex(params.token ?? token), direction: 'sell', amount: live.token })
          return { ok: true, label: formatTradeLabel(sink.id, 'sell', live.token, out.amountOut) }
        },
      }
      return [...transfers, sell]
    },
  }
}

/**
 * Canonical per-wallet BUY amounts from strategy + params. Async because
 * split-prop reads wallet ETH balances via the driver.
 */
async function buyAmounts(
  wallets: Wallet[], params: JobParams, driver: WalletDriver,
): Promise<bigint[]> {
  const n = wallets.length
  const strategy = params.strategy ?? 'individual'
  switch (strategy) {
    case 'individual':
      return wallets.map(() => params.amount ?? 0n)
    case 'split-equal':
      return splitEqual(params.amount ?? 0n, n)
    case 'split-prop': {
      const bal = await Promise.all(wallets.map((w) => driver.holdings(w).then((h) => h.eth)))
      return splitProp(params.amount ?? 0n, bal)
    }
    case 'ladder':
      return ladderAmounts(params, n)
    default:
      throw new Error(`planner: unknown buy strategy ${strategy}`)
  }
}

function ladderAmounts(params: JobParams, walletCount: number): bigint[] {
  const shape = params.ladderShape ?? 'arithmetic'
  const n = params.splits ?? walletCount
  switch (shape) {
    case 'arithmetic': return ladderArith(params.amount ?? 0n, params.step ?? 0n, n)
    case 'geometric': return ladderGeom(params.amount ?? 0n, params.factor ?? 2n, n)
    case 'list': {
      const amounts = ladderList(params.amounts ?? [params.amount ?? 0n])
      if (amounts.length === 1) return Array.from({ length: walletCount }, () => amounts[0]!)
      if (amounts.length !== walletCount) {
        throw new Error(`list must contain 1 amount or ${walletCount} amounts`)
      }
      return amounts
    }
    default: throw new Error(`ladder: unknown shape ${shape}`)
  }
}

/** Planner for a BUY job across target wallets (ladder / individual / split). */
export function buyPlanner(driver: WalletDriver, token: string): {
  type: 'ladderBuy'
  plan: (w: Wallet[], p: JobParams) => Promise<Leg[]>
} {
  return {
    type: 'ladderBuy',
    plan: async (wallets, params) => {
      const tok = toHex(params.token ?? token)
      const amounts = await buyAmounts(wallets, params, driver)
      return wallets.map((w, i) => ({
        wallet: w,
        run: async (): Promise<{ ok: boolean; label: string }> => {
          const out: SwapOutcome = await driver.swap(w, { token: tok, direction: 'buy', amount: amounts[i] })
          return { ok: true, label: formatTradeLabel(w.id, 'buy', amounts[i]!, out.amountOut) }
        },
      }))
    },
  }
}

/** Planner for a SELL of `pct`% of each wallet's held tokens. */
export function sellPctPlanner(driver: WalletDriver, token: string): {
  type: 'sellPct'
  plan: (w: Wallet[], p: JobParams) => Promise<Leg[]>
} {
  return {
    type: 'sellPct',
    plan: async (wallets, params) => {
      const tok = toHex(params.token ?? token)
      const pct = params.pct ?? 0
      return wallets.map((w) => ({
        wallet: w,
        run: async () => {
          const h = await driver.holdings(w)
          const amt = (h.token * BigInt(Math.round(pct * 100))) / 10000n
          const out: SwapOutcome = await driver.swap(w, { token: tok, direction: 'sell', amount: amt })
          return { ok: true, label: formatTradeLabel(w.id, 'sell', amt, out.amountOut) }
        },
      }))
    },
  }
}

/** Re-export so the sell-pct math stays discoverable next to the planner. */
export { sellPctShares } from './planner.js'