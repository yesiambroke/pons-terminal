export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

/** Gas budget for one full buy/sell cycle (wrap + approve + legs). */
export const GAS_PER_CYCLE = 1_500_000n

export async function gasRequired(client: {
  getGasPrice(): Promise<bigint>
}): Promise<bigint> {
  const gasPrice = await client.getGasPrice()
  return (gasPrice * GAS_PER_CYCLE * 3n) / 2n
}