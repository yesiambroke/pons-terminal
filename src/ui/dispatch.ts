// DISPATCH modal — the generic order form that sits ON TOP of the terminal grid.
// Pressing b/s/v/d opens a modal; the user picks params (amount/strategy) in the
// overlay; Enter confirms → the driver dispatches a job via the planners. This
// module is pure UI logic (model + field spec + parse to JobParams) + a pure
// render helper (buildModalLines). No TTY, no chain.

import type { JobParams } from '../engine/executor.js'
import type { ThemeColors } from './term.js'

export type DispatchKind = 'buy' | 'sell' | 'volume' | 'tpsl'
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
  takeProfit?: string      // TP gain threshold in percent
  stopLoss?: string        // SL drawdown threshold in percent
  sellPct?: string         // TP/SL sell percentage of tracked tokens
  /** index of the focused field (0 = first row of the modal). */
  cursor: number
  error?: string
}

export type TpSlSeed = 'last' | 'preset'

export const TPSL_PRESET = { takeProfit: '25', stopLoss: '10', sellPct: '100' } as const

export interface DispatchDefaults {
  defaultBuyAmount?: string
  defaultSellPct?: string
  tpSlSeed?: TpSlSeed
  defaultTakeProfit?: string
  defaultStopLoss?: string
  defaultTpSlSellPct?: string
}

export function createDispatchModal(kind: DispatchKind, defaults: DispatchDefaults = {}): DispatchModal {
  if (kind === 'buy') return { kind, strategy: 'individual', amount: defaults.defaultBuyAmount ?? '0.001', cursor: 0 }
  if (kind === 'sell') return { kind, pct: defaults.defaultSellPct ?? '50', cursor: 0 }
  if (kind === 'tpsl') {
    const usePreset = defaults.tpSlSeed === 'preset'
    return {
      kind,
      takeProfit: usePreset ? TPSL_PRESET.takeProfit : (defaults.defaultTakeProfit ?? TPSL_PRESET.takeProfit),
      stopLoss: usePreset ? TPSL_PRESET.stopLoss : (defaults.defaultStopLoss ?? TPSL_PRESET.stopLoss),
      sellPct: usePreset ? TPSL_PRESET.sellPct : (defaults.defaultTpSlSellPct ?? TPSL_PRESET.sellPct),
      cursor: 0,
    }
  }
  return { kind, amount: '0.001', cadence: '2-5', cycles: '0', cursor: 0 }
}

/** Direct-order parameters derived from the persisted Settings presets. */
export function presetOrderParams(kind: 'buy' | 'sell', defaults: DispatchDefaults = {}): JobParams {
  if (kind === 'buy') {
    return { strategy: 'individual', amount: toWei(normalizeBuyAmount(defaults.defaultBuyAmount ?? '0.001')) }
  }
  return { strategy: 'simple-pct', pct: Number(normalizeSellPct(defaults.defaultSellPct ?? '50')) }
}

export function normalizeBuyAmount(value: string): string {
  const amount = value.trim()
  if (!/^\d+(?:\.\d+)?$/.test(amount) || toWei(amount) <= 0n) throw new Error('buy amount must be > 0')
  return amount
}

export function normalizeSellPct(value: string): string {
  const pct = value.trim()
  if (!/^\d+(?:\.\d+)?$/.test(pct) || Number(pct) < 0 || Number(pct) > 100) throw new Error('sell percentage must be 0..100')
  return pct
}

export function normalizeBuySlippage(value: string): string {
  const pct = value.trim()
  if (!/^\d+(?:\.\d+)?$/.test(pct)) throw new Error('buy slippage must be 0.1..50')
  const n = Number(pct)
  if (!(n >= 0.1 && n <= 50)) throw new Error('buy slippage must be 0.1..50')
  return pct
}

export function toSlippageBps(value: string): bigint {
  return BigInt(Math.round(Number(normalizeBuySlippage(value)) * 100))
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
    case 'tpsl':
      f.push({ key: 'takeProfit', label: 'Take profit %', kind: 'text', value: m.takeProfit ?? '25' })
      f.push({ key: 'stopLoss', label: 'Stop loss %', kind: 'text', value: m.stopLoss ?? '10' })
      f.push({ key: 'sellPct', label: 'Sell % tracked', kind: 'text', value: m.sellPct ?? '100' })
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
    p.amount = toWei(m.amount ?? '0.001')
    if (m.strategy === 'ladder') {
      p.ladderShape = m.ladderShape ?? 'list'
      if (p.ladderShape === 'arithmetic' && m.step) p.step = toWei(m.step)
      else if (p.ladderShape === 'geometric' && m.factor) p.factor = BigInt(Math.round(parseFloat(m.factor) * 100))
      else if (p.ladderShape === 'list' && m.list) p.amounts = parseList(m.list)
    }

  } else if (m.kind === 'sell') {
    p.pct = m.pct ? parseFloat(m.pct) : 50
    p.strategy = 'simple-pct'
  } else if (m.kind === 'tpsl') {
    p.takeProfitPct = parsePositivePercent(m.takeProfit, 'take profit')
    p.stopLossPct = parsePercent(m.stopLoss, 'stop loss')
    p.sellPct = parsePercent(m.sellPct, 'sell percentage')
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
  if (m.kind === 'tpsl') return `TP +${m.takeProfit ?? 25}% / SL -${m.stopLoss ?? 10}% · sell ${m.sellPct ?? 100}% tracked`
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

export function parsePositivePercent(value: string | undefined, label: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be > 0`)
  return parsed
}

export function parsePercent(value: string | undefined, label: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) throw new Error(`${label} must be > 0 and <= 100`)
  return parsed
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