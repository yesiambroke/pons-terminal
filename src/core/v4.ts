import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from 'viem'
import type { PublicClientT } from './chain.js'
import { FEE_BPS, V4_QUOTER } from '../config.js'

export const NATIVE_ETH = '0x0000000000000000000000000000000000000000' as const
export const PONS_V2_MEME_HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044' as const
export const V4_QUOTER_ABI = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'poolKey', type: 'tuple', components: [
      { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
    ] },
    { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
  ] }], outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
}] as const

const BPS = 10000n
const MAX_UINT128 = (1n << 128n) - 1n
const NESTED_PLAN = parseAbiParameters('bytes actions, bytes[] params')
const EXACT_INPUT_SINGLE = parseAbiParameters(
  '((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)',
)
const SETTLE_ALL = parseAbiParameters('address currency, uint256 amount')
const TAKE_ALL = parseAbiParameters('address currency, uint256 minAmount')

export interface V4QuoteParams {
  token: Address
  tokenIn: Address
  tokenOut: Address
  grossAmountIn: bigint
  tickSpacing: number
  hook?: Address
}

/** Build a read-only call to Uniswap's V4Quoter for the exact Pons single-hop route. */
export function buildV4QuoteCall(p: V4QuoteParams) {
  if (p.tokenIn !== NATIVE_ETH && p.tokenOut !== NATIVE_ETH) {
    throw new Error('V2 custom quote pairs are not supported yet; native ETH pairs only')
  }
  if (p.grossAmountIn <= 0n) throw new Error('V4 amount must be > 0')
  const exactAmount = p.tokenIn === NATIVE_ETH ? p.grossAmountIn - p.grossAmountIn * FEE_BPS / BPS : p.grossAmountIn
  if (exactAmount > MAX_UINT128) throw new Error('V4 amount exceeds uint128')
  const [currency0, currency1] = addressOrder(p.tokenIn, p.tokenOut)
  return {
    abi: V4_QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{
      poolKey: { currency0, currency1, fee: 0, tickSpacing: p.tickSpacing, hooks: p.hook ?? PONS_V2_MEME_HOOK },
      zeroForOne: p.tokenIn === currency0,
      exactAmount,
      hookData: '0x',
    }] as const,
  }
}

export async function quoteV4ExactInput(client: PublicClientT, p: V4QuoteParams): Promise<bigint> {
  const call = buildV4QuoteCall(p)
  const result = await (client as any).readContract({ address: V4_QUOTER, ...call }) as readonly [bigint, bigint]
  if (result[0] <= 0n) throw new Error('V4 quote returned zero output')
  return result[0]
}

export interface V4ExactInputParams {
  token: Address
  tokenIn: Address
  tokenOut: Address
  grossAmountIn: bigint
  minGrossOut: bigint
  tickSpacing: number
  hook?: Address
}

export interface V4ExactInputRoute {
  commands: Hex
  inputs: readonly [Hex]
  routeAmountIn: bigint
  fee: bigint
  tokenIn: Address
  tokenOut: Address
}

function addressOrder(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a]
}

/**
 * Build the only V4 plan accepted by TradeRouterV2:
 * Universal Router V4_SWAP -> exact-in single, settle all, take all.
 */
export function buildV4ExactInput(p: V4ExactInputParams): V4ExactInputRoute {
  if (p.tokenIn !== NATIVE_ETH && p.tokenOut !== NATIVE_ETH) {
    throw new Error('V2 custom quote pairs are not supported yet; native ETH pairs only')
  }
  if (p.tokenIn === p.tokenOut) throw new Error('V4 input and output must differ')
  if (p.grossAmountIn <= 0n) throw new Error('V4 amount must be > 0')

  const fee = p.tokenIn === NATIVE_ETH ? p.grossAmountIn * FEE_BPS / BPS : 0n
  const routeAmountIn = p.grossAmountIn - fee
  if (routeAmountIn > MAX_UINT128 || p.minGrossOut > MAX_UINT128) throw new Error('V4 amount exceeds uint128')

  const [currency0, currency1] = addressOrder(p.tokenIn, p.tokenOut)
  const zeroForOne = p.tokenIn === currency0
  const hook = p.hook ?? PONS_V2_MEME_HOOK
  const swapParam = encodeAbiParameters(EXACT_INPUT_SINGLE, [{
    poolKey: { currency0, currency1, fee: 0, tickSpacing: p.tickSpacing, hooks: hook },
    zeroForOne,
    amountIn: routeAmountIn,
    amountOutMinimum: p.minGrossOut,
    minHopPriceX36: 0n,
    hookData: '0x',
  }])
  const settleParam = encodeAbiParameters(SETTLE_ALL, [p.tokenIn, routeAmountIn])
  const takeParam = encodeAbiParameters(TAKE_ALL, [p.tokenOut, p.minGrossOut])
  const nestedPlan = encodeAbiParameters(NESTED_PLAN, ['0x060c0f', [swapParam, settleParam, takeParam]])

  return {
    commands: '0x10',
    inputs: [nestedPlan],
    routeAmountIn,
    fee,
    tokenIn: p.tokenIn,
    tokenOut: p.tokenOut,
  }
}
