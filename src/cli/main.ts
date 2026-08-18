#!/usr/bin/env tsx
// hoodl — a composable trading CLI for Robinhood Chain.
// Every trade routes through the HOODL router (contract fees support the project).
import { formatEther, parseEther } from 'viem'
import { makePublicClient, makeWalletClient } from '../core/chain.js'
import { accountFromPk, requireConfig } from '../config.js'

const [, , cmd, ...args] = process.argv

function get(key: string): string | undefined {
  const i = args.indexOf(`--${key}`)
  return i >= 0 ? args[i + 1] : undefined
}
function has(key: string): boolean {
  return args.includes(`--${key}`)
}
function rangeOf(key: string, def: [number, number] = [0, 0]): [number, number] {
  const v = get(key)
  if (!v) return def
  const [a, b] = v.split('-').map(Number)
  return [a || def[0], b ?? a ?? def[1]]
}

function help() {
  console.log(`hoodl — trading kit for Robinhood Chain

Usage: hoodl <command> [options]

Commands:
  balance  --token <CA>          Show ETH/WETH/token balances
  swap     --token <CA> --in <ETH> [--side buy|sell] [--out <ETH>]
                                  One-shot swap through the router
  volume   --token <CA> --amount <ETH> --cycles <N> [options]
                                  Run N buy/sell cycles (0 = forever)

  snipe    --token <CA> --max <ETH> [--amount <ETH>]
                                  Buy as soon as a pool exists / at max speed
  bootstrap                        Generate a fresh trading wallet
  balance                        Alias for swap --balance

Volume options:
  --mode classic|atomic   classic (default) = discrete buy/sell legs
  --pattern bs|custom|random   default bs
  --buys N --sells N     for custom pattern (one of buys or sells must be 1)
  --cadence a-b          seconds between cycles (default 0-0)
  --leg-delay a-b        seconds between legs (default 0-0)

Env: PRIVATE_KEY, RPC_URL (see .env.example)
  Routers are embedded in the app — you do not set ROUTER_ADDRESS.
`)
}

async function balance(token?: string) {
  const client = makePublicClient()
  const account = accountFromPk(process.env.PRIVATE_KEY!)
  const { getBalances } = await import('../core/router.js')
  const tok = token ?? get('--token')
  const bal = await getBalances(client, account.address, (tok ?? account.address) as `0x${string}`)
  console.log(`Address: ${account.address}`)
  console.log(`ETH:   ${formatEther(bal.eth)}`)
  console.log(`WETH:  ${formatEther(bal.weth)}`)
  if (tok) console.log(`TOKEN: ${formatEther(bal.token)}`)
}

async function swap() {
  const client = makePublicClient()
  const account = accountFromPk(process.env.PRIVATE_KEY!)
  const wallet = makeWalletClient(account)
  const token = get('--token') as `0x${string}` | undefined
  if (!token) throw new Error('swap requires --token')
  const side = get('--side') === 'sell' || !!get('--out')
  const { hoodlSwap } = await import('../core/router.js')

  if (side) {
    const tokensIn = parseEther(get('--out')!)
    const r = await hoodlSwap(wallet, client, { token, direction: 'sell', amount: tokensIn, recipient: account.address })
    console.log(`Sold ${formatEther(tokensIn)} tokens → got ${formatEther(r.amountOut)} WETH  (fee ${formatEther(r.fee)})`)
    console.log(`Tx: ${r.hash}`)
  } else {
    const amount = parseEther(get('--in')!)
    const r = await hoodlSwap(wallet, client, { token, direction: 'buy', amount, recipient: account.address })
    console.log(`Bought ${formatEther(r.amountOut)} tokens for ${formatEther(amount)} ETH (fee ${formatEther(r.fee)})`)
    console.log(`Tx: ${r.hash}`)
  }
}

async function volume() {
  const client = makePublicClient()
  const account = accountFromPk(process.env.PRIVATE_KEY!)
  const wallet = makeWalletClient(account)
  const token = get('--token') as `0x${string}` | undefined
  if (!token) throw new Error('volume requires --token')
  const amount = parseEther(get('--amount') ?? '0')
  const cycles = parseInt(get('--cycles') ?? '0', 10)
  const mode = get('--mode') === 'atomic' ? ('atomic' as const) : ('classic' as const)
  const patternMode = (get('--pattern') === 'random' ? 'random' : get('--pattern') === 'bs' ? 'bs' : 'custom') as 'bs' | 'custom' | 'random'
  const { runVolume } = await import('../engine/cycle.js')
  await runVolume(wallet, client, {
    token, mode, patternMode,
    buys: parseInt(get('--buys') ?? '1', 10),
    sells: parseInt(get('--sells') ?? '1', 10),
    ethPerCycle: amount,
    legDelay: rangeOf('--leg-delay'),
    holder: account.address,
    targetCycles: cycles,
  }, rangeOf('--cadence', [0, 0]), (r, i) => {
    console.log(`\nCycle ${i}: ${r.shape} — bought ${formatEther(r.totalBought)} tokens, fee ${formatEther(r.feePaid)} ETH`)
    for (const leg of r.results) {
      console.log(`  ${leg.dir === 'buy' ? 'BUY ' : 'SELL'} ${formatEther(leg.amount)} · fee ${formatEther(leg.fee)} · ${leg.hash}`)
    }
  })
}


async function snipe() {
  const client = makePublicClient()
  const account = accountFromPk(process.env.PRIVATE_KEY!)
  const wallet = makeWalletClient(account)
  const token = get('--token') as `0x${string}` | undefined
  if (!token) throw new Error('snipe requires --token')
  const max = parseEther(get('--max') ?? '1')
  const amount = parseEther(get('--amount') ?? '0')
  const { snipeBuy } = await import('../engine/snipe.js')
  await snipeBuy(
    { token, maxWei: max, amountWei: amount > 0n ? amount : max },
    wallet, client, account.address,
  )
}

async function main() {
  if (['--help', '-h', 'help'].includes(cmd)) { help(); return }
  if (cmd === 'bootstrap') {
    const { derive } = await import('./commands/derive.js')
    derive()
    return
  }
  requireConfig()
  if (cmd === 'balance') return balance(get('--token'))
  if (cmd === 'swap') return swap()
  if (cmd === 'volume') return volume()

  if (cmd === 'snipe') return snipe()
  console.error(`unknown command: ${cmd ?? '(none)'}`)
  help()
}

main().catch((err) => {
  console.error(`hoodl: ${err.message}`)
  process.exit(1)
})