import { maxUint256, parseEther, parseEventLogs, type Address } from 'viem'
import { FEE_BPS, POOL_FEE, POST_FEE, QUOTER, ROUTER, SLIPPAGE, V2_HOODL_ROUTER, WETH } from '../config.js'
import { ERC20_ABI, QUOTER_ABI, TRADE_ROUTER_V2_ABI, VOLUME_ROUTER_ABI, WETH_ABI } from './abis.js'
import { quoteCurveBuy, quoteCurveSell, readCurveState, type CurveState } from './curve.js'
import { buildV4ExactInput, NATIVE_ETH } from './v4.js'
import type { PublicClientT, WalletClientT } from './chain.js'
import { sleep } from './util.js'

// ── helpers ───────────────────────────────────────

export async function approveIfNeeded(
  walletClient: WalletClientT,
  publicClient: PublicClientT,
  token: Address,
  spender: Address,
  amount: bigint,
) {
  const owner = walletClient.account!.address
  const current = (await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  })) as bigint
  if (current < amount) {
    const hash = await walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, maxUint256],
    })
    await publicClient.waitForTransactionReceipt({ hash })
  }
}

export async function wrapIfShort(walletClient: WalletClientT, publicClient: PublicClientT, wethIn: bigint) {
  const bal = (await publicClient.readContract({
    address: WETH,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [walletClient.account!.address],
  })) as bigint
  if (bal >= wethIn) return
  const hash = await walletClient.writeContract({
    address: WETH,
    abi: WETH_ABI,
    functionName: 'deposit',
    value: wethIn - bal,
  })
  await publicClient.waitForTransactionReceipt({ hash })
}

/** Unwrap signer WETH to native ETH. No-ops when the requested amount is 0. */
export async function unwrapWeth(
  walletClient: WalletClientT,
  publicClient: PublicClientT,
  amount?: bigint,
): Promise<Address | undefined> {
  const owner = walletClient.account!.address
  const bal = (await publicClient.readContract({
    address: WETH,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [owner],
  })) as bigint
  const toUnwrap = amount === undefined ? bal : amount
  if (toUnwrap <= 0n) return undefined
  const hash = (await walletClient.writeContract({
    address: WETH,
    abi: WETH_ABI,
    functionName: 'withdraw',
    args: [toUnwrap],
  })) as Address
  await waitTx(publicClient, hash)
  return hash
}

export async function quoteOut(
  publicClient: PublicClientT,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<bigint> {
  if (amountIn <= 0n) throw new Error('quote amount must be > 0')
  const [out] = (await publicClient.readContract({
    address: QUOTER,
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn, tokenOut, amountIn, fee: POOL_FEE, sqrtPriceLimitX96: 0n }],
  })) as [bigint, bigint, number, bigint]
  return out
}

export async function waitTx(publicClient: PublicClientT, hash: Address) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`tx ${hash} reverted`)
}

export async function getBalances(
  client: PublicClientT,
  address: Address,
  token: Address,
): Promise<{ eth: bigint; weth: bigint; token: bigint }> {
  const [eth, weth, tok] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
  ])
  return { eth, weth: weth as bigint, token: tok as bigint }
}

/**
 * Fetch eth + weth + token balances for MANY wallets, all in PARALLEL.
 * (RH Chain has no Multicall3, so multicall batching is unavailable — the
 * fastest safe option is Promise.all over per-wallet reads.)
 * Returns a Map keyed by wallet id → balances (missing = fetch failed).
 */
export async function getBalancesBatch(
  client: PublicClientT,
  wallets: { id: string; address: Address }[],
  token: Address,
): Promise<Map<string, { eth: bigint; weth: bigint; token: bigint }>> {
  const out = new Map<string, { eth: bigint; weth: bigint; token: bigint }>()
  if (!wallets.length) return out
  const results = await Promise.allSettled(
    wallets.map((w) => getBalances(client, w.address, token)),
  )
  wallets.forEach((w, i) => {
    const r = results[i]
    if (r && r.status === 'fulfilled') out.set(w.id, r.value)
  })
  return out
}

// ── legs ──────────────────────────────────────────

export interface LegResult {
  dir: 'buy' | 'sell'
  amount: bigint
  hash: Address
  fee: bigint
  volume: bigint
}

export interface SwapParams {
  token: Address
  /** 'buy' = WETH → token (spend WETH); 'sell' = token → WETH (spend token) */
  direction: 'buy' | 'sell'
  /** amount of the INPUT token to spend */
  amount: bigint
  /** wallet that receives the swapped output */
  recipient: Address
  /** Optional min-out slippage in bps. Defaults to the global 2% SLIPPAGE. */
  slippageBps?: bigint
}

export interface SwapResult {
  hash: Address
  /** received amount in the OUTPUT token (WETH on sell, token on buy) */
  amountOut: bigint
  /** router fee skimmed, denominated in WETH */
  fee: bigint
}

/**
 * One bidirectional swap through the HOODL router. `direction: 'buy'` fills a
 * spend of WETH for token; `'sell'` spends the token for WETH. Handles WETH
 * wrap/unwrap, approvals, quote-with-slippage and the per-side fee skimming
 * (buy fee comes off the WETH input, sell fee comes off the WETH output).
 */
export async function hoodlSwap(
  walletClient: WalletClientT,
  publicClient: PublicClientT,
  p: SwapParams,
): Promise<SwapResult> {
  if (p.amount <= 0n) throw new Error({ buy: 'buy amount must be > 0', sell: 'no tokens to sell' }[p.direction])

  if (p.direction === 'buy') {
    const fee = (p.amount * FEE_BPS) / 10000n
    const swapAmt = p.amount - fee
    const rawOut = await quoteOut(publicClient, WETH, p.token, swapAmt)
    if (rawOut === 0n) throw new Error('buy returned 0 — amount too small')
    const slippageBps = p.slippageBps ?? SLIPPAGE
    const minOut = rawOut - (rawOut * slippageBps) / 10000n

    await wrapIfShort(walletClient, publicClient, p.amount)
    await approveIfNeeded(walletClient, publicClient, WETH, ROUTER!, p.amount)

    const hash = (await walletClient.writeContract({
      address: ROUTER!,
      abi: VOLUME_ROUTER_ABI,
      functionName: 'swap',
      args: [WETH, p.token, POOL_FEE, p.amount, minOut, p.recipient],
    })) as Address
    await waitTx(publicClient, hash)

    const amountOut = (await publicClient.readContract({
      address: p.token,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [p.recipient],
    })) as bigint
    return { hash, amountOut, fee }
  }

  // sell: fee is skimmed from the WETH OUTPUT — quote the full token input.
  const rawOut = await quoteOut(publicClient, p.token, WETH, p.amount)
  const netExpected = (rawOut * POST_FEE) / 10000n
  const minOut = netExpected - (netExpected * SLIPPAGE) / 10000n
  const fee = (rawOut * FEE_BPS) / 10000n // WETH units

  await approveIfNeeded(walletClient, publicClient, p.token, ROUTER!, p.amount)

  const wethBefore = (await publicClient.readContract({
    address: WETH,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [p.recipient],
  })) as bigint

  const hash = await walletClient.writeContract({
    address: ROUTER!,
    abi: VOLUME_ROUTER_ABI,
    functionName: 'swap',
    args: [p.token, WETH, POOL_FEE, p.amount, minOut, p.recipient],
  })
  await waitTx(publicClient, hash)

  const wethOut = ((await publicClient.readContract({
    address: WETH,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [p.recipient],
  })) as bigint) - wethBefore

  if (wethOut > 0n && p.recipient.toLowerCase() === walletClient.account!.address.toLowerCase()) {
    await unwrapWeth(walletClient, publicClient, wethOut)
  }

  return { hash, amountOut: wethOut, fee }
}

// ── atomic round trip (1 tx) ──────────────────────

export async function atomicRoundTrip(
  walletClient: WalletClientT,
  publicClient: PublicClientT,
  token: Address,
  amountIn: bigint,
  recipient: Address,
): Promise<{ hash: Address; quoteOut: bigint; fee: bigint }> {
  const swapAmt = amountIn - (amountIn * FEE_BPS) / 10000n

  const wethBefore = (await publicClient.readContract({
    address: WETH,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [recipient],
  })) as bigint

  const buyOut = await quoteOut(publicClient, WETH, token, swapAmt)
  if (buyOut === 0n) throw new Error('buy returned 0 tokens — raise the per-cycle amount')
  const minBuy = buyOut - (buyOut * SLIPPAGE) / 10000n
  // TradeRouter: sell side quotes the FULL buyOut, fee applied to the WETH output.
  const sellOut = await quoteOut(publicClient, token, WETH, buyOut)
  const netSell = (sellOut * POST_FEE) / 10000n
  const minSell = netSell - (netSell * SLIPPAGE) / 10000n
  const fee = (amountIn * FEE_BPS) / 10000n + (sellOut * FEE_BPS) / 10000n // buy + sell, both WETH

  await wrapIfShort(walletClient, publicClient, amountIn)
  await approveIfNeeded(walletClient, publicClient, WETH, ROUTER!, amountIn)

  const hash = (await walletClient.writeContract({
    address: ROUTER!,
    abi: VOLUME_ROUTER_ABI,
    functionName: 'roundTrip',
    args: [token, WETH, POOL_FEE, amountIn, minBuy, minSell],
  })) as Address
  await waitTx(publicClient, hash)

  const wethDelta = ((await publicClient.readContract({
    address: WETH,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [recipient],
  })) as bigint) - wethBefore

  return { hash, quoteOut: wethDelta, fee }
}

// ── retry ─────────────────────────────────────────

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, backoffMs = 5000): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) await sleep(backoffMs)
    }
  }
  throw lastErr
}

export interface CurveRouterCall {
  address: Address
  abi: typeof TRADE_ROUTER_V2_ABI
  functionName: 'buyCurve' | 'sellCurve'
  args: readonly [Address, bigint, bigint, Address] | readonly [Address, Address, bigint, bigint, Address]
  value?: bigint
  fee: bigint
}

function assertNativeCurve(state: CurveState) {
  if (!state.isNativeQuote) throw new Error('V2 custom quote pairs are not supported yet; native ETH pairs only')
}

/** Build the HOODL-router curve buy; curve pricing receives gross ETH minus the 0.5% HOODL fee. */
export function buildCurveBuyCall(
  router: Address,
  state: CurveState,
  grossQuoteIn: bigint,
  recipient: Address,
  slippageBps = SLIPPAGE,
): CurveRouterCall {
  assertNativeCurve(state)
  const fee = grossQuoteIn * FEE_BPS / 10000n
  const curveQuote = quoteCurveBuy(state, grossQuoteIn - fee)
  const minTokensOut = curveQuote.tokensOut - curveQuote.tokensOut * slippageBps / 10000n
  return {
    address: router,
    abi: TRADE_ROUTER_V2_ABI,
    functionName: 'buyCurve',
    args: [state.curve, grossQuoteIn, minTokensOut, recipient],
    value: grossQuoteIn,
    fee,
  }
}

/** Build the HOODL-router curve sell; min-out protects post-curve and post-HOODL-fee ETH. */
export function buildCurveSellCall(
  router: Address,
  state: CurveState,
  token: Address,
  tokensIn: bigint,
  recipient: Address,
  slippageBps = SLIPPAGE,
): CurveRouterCall {
  assertNativeCurve(state)
  const curveQuote = quoteCurveSell(state, tokensIn)
  const fee = curveQuote.quoteOut * FEE_BPS / 10000n
  const expectedOut = curveQuote.quoteOut - fee
  const minQuoteOut = expectedOut - expectedOut * slippageBps / 10000n
  return {
    address: router,
    abi: TRADE_ROUTER_V2_ABI,
    functionName: 'sellCurve',
    args: [state.curve, token, tokensIn, minQuoteOut, recipient],
    fee,
  }
}

function requireV2Router(): Address {
  if (!V2_HOODL_ROUTER) throw new Error('V2_ROUTER_ADDRESS missing — deploy TradeRouterV2 before executing V2 trades')
  return V2_HOODL_ROUTER
}

export interface CurveSwapParams {
  curve: Address
  token: Address
  direction: 'buy' | 'sell'
  amount: bigint
  recipient: Address
  slippageBps?: bigint
}

/** Execute a native Pons V2 curve trade solely through the deployed HOODL V2 router. */
export async function hoodlCurveSwap(
  walletClient: WalletClientT,
  publicClient: PublicClientT,
  p: CurveSwapParams,
): Promise<SwapResult> {
  const router = requireV2Router()
  const state = await readCurveState(publicClient, p.curve, p.recipient)
  const slippageBps = p.slippageBps ?? SLIPPAGE

  if (p.direction === 'buy') {
    const call = buildCurveBuyCall(router, state, p.amount, p.recipient, slippageBps)
    const before = (await publicClient.readContract({
      address: p.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [p.recipient],
    })) as bigint
    const hash = await (walletClient as any).writeContract(call)
    await waitTx(publicClient, hash)
    const after = (await publicClient.readContract({
      address: p.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [p.recipient],
    })) as bigint
    return { hash, amountOut: after - before, fee: call.fee }
  }

  const call = buildCurveSellCall(router, state, p.token, p.amount, p.recipient, slippageBps)
  await approveIfNeeded(walletClient, publicClient, p.token, router, p.amount)
  const hash = await (walletClient as any).writeContract(call)
  await waitTx(publicClient, hash)
  // Native recipient balance deltas include gas. This is the deterministic net
  // settlement guarded on-chain by the router's minQuoteOut check.
  const expected = quoteCurveSell(state, p.amount).quoteOut
  return { hash, amountOut: expected - call.fee, fee: call.fee }
}

/** Build the writeContract args for TradeRouterV2.executeV4 without sending. */
export function buildV4ExecuteCall(
  router: Address,
  p: { token: Address; tokenIn: Address; tokenOut: Address; grossAmountIn: bigint; minGrossOut: bigint; recipient: Address; tickSpacing: number; hook?: Address },
  slippageBps: bigint = SLIPPAGE,
) {
  const grossMinOut = p.minGrossOut - p.minGrossOut * slippageBps / 10000n
  const route = buildV4ExactInput({ ...p, minGrossOut: grossMinOut })
  const nativeIn = p.tokenIn === NATIVE_ETH
  const minOut = route.tokenOut === NATIVE_ETH
    ? grossMinOut - grossMinOut * FEE_BPS / 10000n
    : grossMinOut
  return {
    address: router,
    abi: TRADE_ROUTER_V2_ABI,
    functionName: 'executeV4',
    args: [route.commands, route.inputs, MAX_DEADLINE, p.tokenIn, p.tokenOut, p.grossAmountIn, minOut, p.recipient] as const,
    value: nativeIn ? p.grossAmountIn : 0n,
    fee: route.fee,
  }
}

const MAX_DEADLINE = 2n ** 256n - 1n

export function parseV4ExecutedLog(router: Address, logs: readonly unknown[]): { amountOut: bigint; fee: bigint } {
  const events = parseEventLogs({
    abi: TRADE_ROUTER_V2_ABI,
    eventName: 'V4Executed',
    logs: logs as any,
    strict: false,
  })
  const event = events.find((entry) => entry.address.toLowerCase() === router.toLowerCase())
  if (!event?.args.amountOut || event.args.fee === undefined) throw new Error('missing TradeRouterV2 V4Executed event')
  return { amountOut: event.args.amountOut, fee: event.args.fee }
}

export interface V4SwapParams {
  token: Address
  tokenIn: Address
  tokenOut: Address
  grossAmountIn: bigint
  minGrossOut: bigint
  recipient: Address
  tickSpacing: number
  hook?: Address
  slippageBps?: bigint
}

/** Execute a migrated V2 V4 swap solely through the deployed HOODL V2 router. */
export async function hoodlV4Swap(
  walletClient: WalletClientT,
  publicClient: PublicClientT,
  p: V4SwapParams,
): Promise<SwapResult> {
  const router = requireV2Router()
  const slippageBps = p.slippageBps ?? SLIPPAGE
  const call = buildV4ExecuteCall(router, p, slippageBps)

  if (p.tokenIn !== NATIVE_ETH) {
    await approveIfNeeded(walletClient, publicClient, p.tokenIn, router, p.grossAmountIn)
  }
  const hash = await (walletClient as any).writeContract(call)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`tx ${hash} reverted`)
  const settled = parseV4ExecutedLog(router, receipt.logs)
  return { hash, amountOut: settled.amountOut, fee: settled.fee }
}