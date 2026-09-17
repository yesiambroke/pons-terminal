import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TrackedPosition, TpSlRule } from '../core/positions.js'

export interface PositionState {
  positions: TrackedPosition[]
  rules: TpSlRule[]
}

type DiskPosition = Omit<TrackedPosition, 'tokens' | 'costEth' | 'realizedPnlEth' | 'realizedCostEth'> & {
  tokens: string
  costEth: string
  realizedPnlEth: string
  realizedCostEth?: string
}

type DiskRule = TpSlRule & { enabled?: boolean }

interface DiskState {
  positions: DiskPosition[]
  rules: DiskRule[]
}

const ROOT = dirname(fileURLToPath(import.meta.url))
const PATH = join(ROOT, '..', '..', 'data', 'positions.json')
const EMPTY: PositionState = { positions: [], rules: [] }

function decode(state: DiskState): PositionState {
  return {
    positions: state.positions.map((position) => ({
      ...position,
      tokens: BigInt(position.tokens),
      costEth: BigInt(position.costEth),
      realizedPnlEth: BigInt(position.realizedPnlEth),
      realizedCostEth: BigInt(position.realizedCostEth ?? '0'),
    })),
    rules: state.rules.map(({ enabled: _enabled, ...rule }) => rule),
  }
}

function encode(state: PositionState): DiskState {
  return {
    positions: state.positions.map((position) => ({
      ...position,
      tokens: position.tokens.toString(),
      costEth: position.costEth.toString(),
      realizedPnlEth: position.realizedPnlEth.toString(),
      realizedCostEth: position.realizedCostEth.toString(),
    })),
    rules: state.rules,
  }
}

export function loadPositionState(path = PATH): PositionState {
  if (!existsSync(path)) return { ...EMPTY }
  try { return decode(JSON.parse(readFileSync(path, 'utf8')) as DiskState) } catch { return { ...EMPTY } }
}

export function savePositionState(state: PositionState, path = PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(encode(state), null, 2), { mode: 0o600 })
}
