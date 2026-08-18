// WalletDriver — the seam between the headless job engine/adapters and the live
// chain. The real impl wraps viem (hoodlSwap / balances / cycle). Tests use a
// fake driver so the scheduler + planners run headless with zero RPC.

import type { Wallet } from './executor.js'

export interface SwapOutcome {
  amountOut: bigint
  fee: bigint
  hash: `0x${string}`
}

export interface SwapOpts {
  token: `0x${string}`
  direction: 'buy' | 'sell'
  amount: bigint
}

export interface Holdings {
  eth: bigint
  weth: bigint
  token: bigint
}

/** Lighter volume-cycle spec, holder-resolved by the driver (wallet owns tokens). */
export interface CycleSpec {
  token: string
  mode: 'classic' | 'atomic' | 'auto'
  patternMode: 'bs' | 'custom' | 'random'
  buys: number
  sells: number
  ethPerCycle: bigint
}

export interface CycleOutcome {
  shape: string
  totalBought: bigint
  feePaid: bigint
}

export interface TransferOpts {
  token: `0x${string}`
  to: `0x${string}`
  amount: bigint
}

export interface TransferOutcome {
  hash: `0x${string}`
}

/**
 * The executor calls this for each Leg. A real implementation performs the swap;
 * a fake implementation lets unit tests drive real planner/executor behavior.
 */
export interface WalletDriver {
  /** Swap `amount` (ETH in for buy, tokens in for sell) and return outcome. */
  swap(w: Wallet, opts: SwapOpts): Promise<SwapOutcome>
  /** Snapshot balances for a wallet (used by split-prop + sell-% planning). */
  holdings(w: Wallet): Promise<Holdings>
  /** Run ONE volume cycle (atomic or classic) for this wallet. */
  cycle(w: Wallet, spec: CycleSpec): Promise<CycleOutcome>
  /** Transfer the wallet's own ERC-20 tokens to another wallet. */
  transfer(w: Wallet, opts: TransferOpts): Promise<TransferOutcome>
}