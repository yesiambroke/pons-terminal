export type LegDir = 'B' | 'S'

export interface ResolvedPattern {
  buys: number
  sells: number
  legs: LegDir[]
  atomic: boolean
  shape: string
}

export const RANDOM_SHAPES = ['BS', 'BBS', 'BBBS', 'BBBBS', 'BSS', 'BSSS', 'BSSSS'] as const

export function randomPattern(): string {
  return RANDOM_SHAPES[Math.floor(Math.random() * RANDOM_SHAPES.length)]
}

function shapeOf(shape: string): { buys: number; sells: number } {
  const buys = shape.split('').filter((c) => c === 'B').length
  const sells = shape.split('').filter((c) => c === 'S').length
  return { buys, sells }
}

export function resolvePattern(
  mode: 'classic' | 'atomic',
  patternMode: 'bs' | 'custom' | 'random',
  buys: number | null,
  sells: number | null,
): ResolvedPattern {
  let shape: string
  let atomic = false

  if (mode === 'atomic') {
    atomic = true
    shape = 'BS'
  } else if (patternMode === 'bs') {
    shape = 'BS'
  } else if (patternMode === 'custom') {
    const b = buys ?? 0
    const s = sells ?? 0
    shape = 'B'.repeat(b) + 'S'.repeat(s)
  } else if (patternMode === 'random') {
    shape = randomPattern()
  } else {
    throw new Error('unknown pattern mode')
  }

  const { buys: b, sells: s } = shapeOf(shape)
  if (b < 1 || s < 1) throw new Error('buys and sells must be >= 1')
  if (b !== 1 && s !== 1) throw new Error('pattern must have exactly one buy OR one sell')

  return {
    buys: b,
    sells: s,
    legs: [...Array(b).fill('B' as const), ...Array(s).fill('S' as const)],
    atomic,
    shape,
  }
}

export function buyAmounts(cycleAmountWei: bigint, buys: number): bigint[] {
  if (buys < 1) throw new Error('buys must be >= 1')
  if (buys === 1) return [cycleAmountWei]
  const each = cycleAmountWei / BigInt(buys)
  const parts: bigint[] = []
  let sum = 0n
  for (let i = 0; i < buys - 1; i++) {
    parts.push(each)
    sum += each
  }
  parts.push(cycleAmountWei - sum)
  return parts
}