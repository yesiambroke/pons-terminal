// Planner / split math — pure functions. Given inputs + a balance snapshot,
// returns the per-wallet quantities for a job's legs. No I/O, no state.
//
// Where currency is ETH or token units matters to callers; here these helpers
// are unit-agnostic and always return BigInt values. Decimals are carried as an
// explicit `dec` param (per token / for ETH).

export interface Balances {
  [walletId: string]: bigint // available balance for this wallet
}

/** Equal split: total divided across up to `n` wallets. */
export function splitEqual(total: bigint, n: number): bigint[] {
  if (n < 1) throw new Error('n must be >= 1')
  if (n === 1) return [total]
  const each = total / BigInt(n)
  const parts: bigint[] = []
  let sum = 0n
  for (let i = 0; i < n - 1; i++) { parts.push(each); sum += each }
  parts.push(total - sum)
  return parts
}

/** Ladder: arithmetic progression base, base+step, base+2step… */
export function ladderArith(base: bigint, step: bigint, n: number): bigint[] {
  if (n < 1) throw new Error('n must be >= 1')
  if (step < 0n) throw new Error('step must be non-negative')
  const out: bigint[] = []
  for (let i = 0; i < n; i++) out.push(base + step * BigInt(i))
  return out
}

/** Ladder: geometric progression base * factor^i (i = 0..n-1). */
export function ladderGeom(base: bigint, factor: bigint, n: number): bigint[] {
  if (n < 1) throw new Error('n must be >= 1')
  if (factor < 2n) throw new Error('factor must be >= 2 (base*1 is degenerate)')
  const out: bigint[] = []
  let cur = base
  for (let i = 0; i < n; i++) { out.push(cur); cur = cur * factor }
  return out
}

/** Ladder: explicit per-wallet list (user provided sequence). */
export function ladderList(amounts: bigint[]): bigint[] {
  if (amounts.length === 0) throw new Error('list is empty')
  return [...amounts]
}

/**
 * Split a total proportional to each wallet's available balance.
 * total=1e18, balances 0.4/0.6/0.5 → ~0.267/0.40/0.333 (user's example).
 * Uses fixed-point 1e6 weights to keep it deterministic & integer.
 */
export function splitProp(total: bigint, balances: bigint[]): bigint[] {
  const n = balances.length
  if (n === 0) throw new Error('no balances')
  const SUM = 1000000n // 1e6 fixed point
  const sumBal = balances.reduce((a, b) => a + b, 0n)
  if (sumBal === 0n) throw new Error('all balances zero — cannot split proportional')
  const parts: bigint[] = []
  let allocated = 0n
  for (let i = 0; i < n; i++) {
    const share = (total * balances[i] * SUM) / (sumBal * SUM) // exact: total * (bal/sumBal)
    const amt = i < n - 1 ? share : total - allocated
    parts.push(amt)
    allocated += amt
  }
  return parts
}

/**
 * SELL amount: what each wallet sells so that *all wallets together* sell
 * `pct`% of the total supply they collectively hold, split proportionally to
 * each wallet's own holding. Example: holds [15M,5M,10M]=30M, pct=30 → each
 * sells 30% of its hold → [4.5M,1.5M,3M].
 * Returns per-wallet token units to sell.
 */
export function sellPctShares(pct: number, held: bigint[]): bigint[] {
  if (pct < 0 || pct > 100) throw new Error('pct must be 0..100')
  return held.map((h) => (h * BigInt(Math.round(pct * 100))) / 10000n)
}

/** Convert a human decimal string ("0.1", "15.5") to a BigInt at `decimals`. */
export function toWei(amount: string, decimals = 18): bigint {
  const s = amount.trim()
  if (!/^\d*\.?\d*$/.test(s)) throw new Error(`invalid amount: ${amount}`)
  const [int = '', frac = ''] = s.split('.')
  if (frac.length > decimals) throw new Error(`too many decimals (max ${decimals})`)
  const padList = frac.padEnd(decimals, '0')
  return BigInt(int) * 10n ** BigInt(decimals) + (padList ? BigInt(padList) : 0n)
}