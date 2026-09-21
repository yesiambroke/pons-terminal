export type MarketCapQuoteSource = 'token' | 'swap' | 'poll'

export function shouldQuoteMarketCap(input: {
  source: MarketCapQuoteSource
  liveFeedActive: boolean
}): boolean {
  if (input.source === 'token' || input.source === 'swap') return true
  return !input.liveFeedActive
}
