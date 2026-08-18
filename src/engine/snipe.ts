import { formatEther, type Address } from 'viem'
import type { PublicClientT, WalletClientT } from '../core/chain.js'
import { hoodlSwap } from '../core/router.js'

export interface SnipeConfig {
  token: Address
  /** budget cap so a runaway buy can't blow the wallet */
  maxWei: bigint
  amountWei: bigint
}

/**
 * Snipe a token: place an early swap for maximum fill speed.
 * `maxWei` caps total spend so a runaway buy can't drain the wallet.
 */
export async function snipeBuy(
  cfg: SnipeConfig,
  walletClient: WalletClientT,
  publicClient: PublicClientT,
  holder: Address,
): Promise<{ hash: Address; tokensOut: bigint; fee: bigint }> {
  const spend = cfg.amountWei > cfg.maxWei ? cfg.maxWei : cfg.amountWei
  if (spend <= 0n) throw new Error('snipe amount must be > 0 (and <= --max)')
  const r = await hoodlSwap(walletClient, publicClient, { token: cfg.token, direction: 'buy', amount: spend, recipient: holder })
  console.log(`Sniped ${formatEther(r.amountOut)} tokens for ${formatEther(spend)} ETH (fee ${formatEther(r.fee)} ETH)`)
  return { hash: r.hash, tokensOut: r.amountOut, fee: r.fee }
}