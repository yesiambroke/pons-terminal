// Volume-bot daemon — a planner that self-schedules ONE volume cycle per call.
// Paired with Executor.startDaemon, each `plan()` returns the cycle's legs for
// the targeted wallets; the executor runs them, waits cadence, then re-plans.
// This is what makes a volume bot "always on" in the background. Chain work goes
// through the WalletDriver, so it's fully testable headless.

import type { Wallet, DaemonPlanner, Leg } from './executor.js'
import type { WalletDriver, CycleSpec } from './driver.js'

function fixed(amount: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals)
  const whole = amount / unit
  const fraction = (amount % unit).toString().padStart(decimals, '0')
  return `${whole}.${fraction}`
}

function compact(amount: bigint): string {
  const value = Number(fixed(amount, 18))
  if (!Number.isFinite(value)) return '–'
  for (const [divisor, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (Math.abs(value) >= divisor) return `${(value / divisor).toFixed(2)}${suffix}`
  }
  return value.toFixed(2)
}

function eth(amount: bigint): string { return fixed(amount, 18).slice(0, 8) }

export function formatVolumeLabel(walletId: string, shape: string, totalBought: bigint, feePaid: bigint): string {
  const order = shape === 'BS' ? 'buy → sell' : shape
  return `${walletId}: ${order} · bought ${compact(totalBought)} TOK · fee ${eth(feePaid)} ETH`
}

export interface VolumeBotConfig {
  /** ERC-20 the volume bot cycles. */
  token: string
  /** 'auto' uses V1 atomic rounds and V2 classic route-aware legs. */
  mode: 'classic' | 'atomic' | 'auto'
  /** 'bs' | 'custom' | 'random' (classic only) */
  patternMode: 'bs' | 'custom' | 'random'
  /** buy leg count (classic custom only) */
  buys: number
  /** sell leg count (classic custom only) */
  sells: number
  /** ETH spent per cycle (sum of all buy legs) */
  ethPerCycle: bigint
}

/**
 * Build the daemon planner for a volume bot. One `plan()` round = one volume
 * cycle across every targeted wallet. Cadence + cycles (0=forever) are supplied
 * to the executor via `params`, so nothing is hard-coded here. The actual swap
 * work + holder resolution happen in the WalletDriver.cycle.
 */
export function volumeDaemon(driver: WalletDriver, base: VolumeBotConfig): {
  type: 'volumeBot'
  plan: DaemonPlanner['plan']
} {
  return {
    type: 'volumeBot',
    plan: async (wallets: Wallet[]): Promise<Leg[]> =>
      wallets.map((w): Leg => makeCycleLeg(driver, w, base)),
  }
}

export function makeCycleLeg(driver: WalletDriver, w: Wallet, base: VolumeBotConfig): Leg {
  return {
    wallet: w,
    run: async () => {
      const spec: CycleSpec = {
        token: base.token,
        mode: base.mode,
        patternMode: base.patternMode,
        buys: base.buys,
        sells: base.sells,
        ethPerCycle: base.ethPerCycle,
      }
      const r = await driver.cycle(w, spec)
      return {
        ok: true,
        label: formatVolumeLabel(w.label ?? w.id, r.shape, r.totalBought, r.feePaid),
      }
    },
  }
}