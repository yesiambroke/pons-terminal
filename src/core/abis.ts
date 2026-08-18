// Contract ABIs for the Robinhood Chain DEX (Uniswap V3 style) + HOODL TradeRouter.
export const ERC20_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'string' }] },
  { name: 'name', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const

export const QUOTER_ABI = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'view',
  inputs: [{
    components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'fee', type: 'uint24' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ], type: 'tuple',
  }],
  outputs: [
    { name: 'amountOut', type: 'uint256' },
    { name: 'sqrtPriceX96After', type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32' },
    { name: 'gasEstimate', type: 'uint256' },
  ],
}] as const

export const WETH_ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
] as const

export const VOLUME_ROUTER_ABI = [
  { name: 'swap', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'poolFee', type: 'uint24' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }] },
  { name: 'roundTrip', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'quote', type: 'address' },
      { name: 'poolFee', type: 'uint24' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minOutBuy', type: 'uint256' },
      { name: 'minOutSell', type: 'uint256' },
    ],
    outputs: [{ name: 'quoteOut', type: 'uint256' }] },
] as const

export const PONS_V2_FACTORY_ABI = [{
  name: 'getLaunchedToken', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'token', type: 'address' }],
  outputs: [{ name: '', type: 'tuple', components: [
    { name: 'token', type: 'address' }, { name: 'curve', type: 'address' },
    { name: 'deployer', type: 'address' }, { name: 'creatorFeeRecipient', type: 'address' },
    { name: 'pairToken', type: 'address' }, { name: 'graduationThreshold', type: 'uint256' },
    { name: 'poolFee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' },
    { name: 'creatorTaxBps', type: 'uint16' }, { name: 'buybackEnabled', type: 'bool' },
    { name: 'phase', type: 'uint8' }, { name: 'sweptQuote', type: 'uint256' },
    { name: 'sweptTokens', type: 'uint256' }, { name: 'sweptAt', type: 'uint256' },
    { name: 'exists', type: 'bool' },
  ] }],
}] as const

export const PONS_V2_CURVE_ABI = [
  { name: 'getReserves', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: 'quoteReserve', type: 'uint256' }, { name: 'tokenReserve', type: 'uint256' }] },
  { name: 'sellableTokens', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'realQuoteReserve', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'feeBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'creatorTaxBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'currentSnipeTaxBps', type: 'function', stateMutability: 'view', inputs: [{ name: 'recipient', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'readyToGraduate', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { name: 'graduated', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { name: 'pairToken', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'isNativeQuote', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
] as const

export const TRADE_ROUTER_V2_ABI = [
  { name: 'buyCurve', type: 'function', stateMutability: 'payable', inputs: [
    { name: 'curve', type: 'address' }, { name: 'quoteIn', type: 'uint256' },
    { name: 'minTokensOut', type: 'uint256' }, { name: 'recipient', type: 'address' },
  ], outputs: [{ name: 'tokensOut', type: 'uint256' }] },
  { name: 'sellCurve', type: 'function', stateMutability: 'nonpayable', inputs: [
    { name: 'curve', type: 'address' }, { name: 'token', type: 'address' },
    { name: 'tokensIn', type: 'uint256' }, { name: 'minQuoteOut', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ], outputs: [{ name: 'quoteOut', type: 'uint256' }] },
  { name: 'executeV4', type: 'function', stateMutability: 'payable', inputs: [
    { name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' },
    { name: 'deadline', type: 'uint256' }, { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' },
    { name: 'minOut', type: 'uint256' }, { name: 'recipient', type: 'address' },
  ], outputs: [{ name: 'amountOut', type: 'uint256' }] },
  { name: 'V4Executed', type: 'event', anonymous: false, inputs: [
    { name: 'caller', type: 'address', indexed: true }, { name: 'tokenIn', type: 'address', indexed: true },
    { name: 'tokenOut', type: 'address', indexed: true }, { name: 'amountIn', type: 'uint256', indexed: false },
    { name: 'amountOut', type: 'uint256', indexed: false }, { name: 'fee', type: 'uint256', indexed: false },
  ] },
] as const