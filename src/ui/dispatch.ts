// DISPATCH modal — the generic order form that sits ON TOP of the terminal grid.
// Pressing b/s/v/d opens a modal; the user picks params (amount/strategy) in the
// overlay; Enter confirms → the driver dispatches a job via the planners. This
// module is pure UI logic (model + field spec + parse to JobParams) + a pure
// render helper (buildModalLines). No TTY, no chain.

import type { JobParams } from '../engine/executor.js'
import type { ThemeColors } from './term.js'

export type DispatchKind = 'buy' | 'sell' | 'volume'
export type BuyStrategy = 'individual' | 'split-equal' | 'split-prop' | 'ladder'
export type LadderShape = 'arithmetic' | 'geometric' | 'list'

export interface DispatchModal {
  kind: DispatchKind
  /** Buy-side strategy selector / sell pct / daemon cadence. */
  strategy?: BuyStrategy
  amount?: string          // raw input: ETH for buy, token pct / units for sell
  splits?: string          // count of ladder / split parts
  ladderShape?: LadderShape
  step?: string            // ladder arithmetic step
  factor?: string          // ladder geometric factor (≥2)
  list?: string            // ladder by-list comma numbers
  pct?: string             // sell % of held
  cadence?: string         // volume seconds between rounds
  cycles?: string          // volume: 0 = forever
  /** index of the focused field (0 = first row of the modal). */
  cursor: number
  error?: string
}

/** Which user-editable fields exist for a given kind. Ordered. */
export interface Field {
  key: string
  label: string
  kind: 'text' | 'enum' | 'int'
  options?: string[]
  value: string
}

/** Build the editable field list for a modal, preserving the LAST non-empty input. */
export function fieldsFor(m: DispatchModal): Field[] {
  const f: Field[] = []
  switch (m.kind) {
    case 'buy': {
      f.push({ key: 'strategy', label: 'Strategy', kind: 'enum',
        options: ['individual', 'split-equal', 'split-prop', 'ladder'], value: m.strategy ?? 'individual' })
      if (m.strategy === 'ladder') {
        const ladderShape = m.ladderShape ?? 'list'
        f.push({ key: 'amount',     label: 'Base amt (ETH)', kind: 'text', value: m.amount ?? '0.001' })
        f.push({ key: 'shape',      label: 'Ladder shape',   kind: 'enum',
          options: ['arithmetic', 'geometric', 'list'], value: ladderShape })
        if (ladderShape === 'arithmetic') {
          f.push({ key: 'step',   label: 'Step (ETH)', kind: 'text', value: m.step ?? '0.001' })
        } else if (ladderShape === 'geometric') {
          f.push({ key: 'factor', label: 'Multiplier', kind: 'text', value: m.factor ?? '2' })
        } else {
          f.push({ key: 'list',   label: 'Amounts (csv)', kind: 'text', value: m.list ?? '' })
        }
      } else {
        // individual / split-equal / split-prop all need a total amount
        f.push({ key: 'amount', label: m.strategy === 'individual' ? 'Amt/each (ETH)' : 'Total (ETH)',
          kind: 'text', value: m.amount ?? '0.001' })

      }
      break
    }
    case 'sell':
      f.push({ key: 'pct', label: 'Sell % of held', kind: 'text', value: m.pct ?? '50' })
      break
    case 'volume':
      f.push({ key: 'amount',  label: 'ETH/cycle',  kind: 'text', value: m.amount ?? '0.001' })
      f.push({ key: 'cadence', label: 'Cadence (s)', kind: 'text', value: m.cadence ?? '2-5' })
      f.push({ key: 'cycles',  label: 'Cycles (0=∞)', kind: 'int', value: m.cycles ?? '0' })
      break

  }
  return f
}

/** Parse the modal into executor JobParams (the planners consume this). */
export function toParams(m: DispatchModal): JobParams {
  const p: JobParams = {}
  if (m.kind === 'buy') {
    p.strategy = m.strategy ?? 'individual'
    if (('amount' in m) && m.amount) p.amount = toWei(m.amount)
    if (m.strategy === 'ladder') {
      p.ladderShape = m.ladderShape ?? 'list'
      if (p.ladderShape === 'arithmetic' && m.step) p.step = toWei(m.step)
      else if (p.ladderShape === 'geometric' && m.factor) p.factor = BigInt(Math.round(parseFloat(m.factor) * 100))
      else if (p.ladderShape === 'list' && m.list) p.amounts = parseList(m.list)
    }

  } else if (m.kind === 'sell') {
    p.pct = m.pct ? parseFloat(m.pct) : 50
    p.strategy = 'simple-pct'
  } else if (m.kind === 'volume') {
    p.amount = m.amount ? toWei(m.amount) : toWei('0.001')
    p.cadence = parseCadence(m.cadence)
    p.cycles = m.cycles ? parseInt(m.cycles, 10) : 0
    p.strategy = 'atomic'
  }
  return p
}

// stateful preview of what the job will do (for the modal's status line)
export function preview(m: DispatchModal, walletCount: number): string {
  const n = Math.max(1, walletCount)
  if (m.kind === 'buy') {
    const amt = m.amount || '0'
    const base = m.strategy === 'split-equal' ? `${amt}/${n}`
      : m.strategy === 'split-prop' ? `${amt} split prop`
      : m.strategy === 'ladder' ? `ladder ${amt} base`
      : `${amt} each`
    return `${m.strategy ?? 'individual'} · ${base} · on ${n} wallet${n > 1 ? 's' : ''}`
  }
  if (m.kind === 'sell') return `sell ${m.pct ?? 50}% of held · ×${n}`
  if (m.kind === 'volume') return `volbot ${m.amount ?? '0'} ETH/c · ×${n} · ${m.cadence ?? '2-5'}s`
  return `volume ${m.amount ?? '0'} ETH/c · ${m.cadence ?? '2-5'}s`
}

// ── pure helpers ─────────────────────────────────────────────────────────────

export function toWei(amount: string): bigint {
  const s = amount.trim()
  const [i = '', f = ''] = s.split('.')
  const frac = (f ?? '').padEnd(18, '0').slice(0, 18)
  return BigInt(i) * 10n ** 18n + (frac ? BigInt(frac) : 0n)
}

/** "2-5" → [2,5]; bare "5" → [5,5]. */
export function parseCadence(s?: string): [number, number] | undefined {
  if (!s || !s.trim()) return undefined
  const parts = s.trim().split('-').map((x) => parseInt(x, 10))
  const a = parts[0] ?? 0
  const b = parts[1] ?? a
  return [Math.max(0, a), Math.max(0, b)]
}

export function parseList(s: string): bigint[] {
  if (!s) return []
  return s.split(/[\s,]+/).map(toWei).filter(Boolean)
}