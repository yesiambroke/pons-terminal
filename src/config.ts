import { existsSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import dotenv from 'dotenv'
import { privateKeyToAccount } from 'viem/accounts'

// ── HOODL routers (embedded — not user config) ───────────────────────────────
// Every trade must go through these contracts so protocol fees fund the project.
// Do not expose them as free-form .env knobs; changing them breaks routing.
/** V1 TradeRouter (immutable). */
export const ROUTER = '0x0102E02037EE0aE13257F9f825777878f967E31B' as const
/** V2 TradeRouter (curve + migrated V4 path). */
export const V2_HOODL_ROUTER = '0x6dfC9897a9f9f4CAbbF9F2cB76AE0ef16E4C0750' as const

// Ensure a .env exists before dotenv loads. On first run a fresh WALLET_ENC_KEY
// (32-byte/64-hex, AES vault master key) and sane defaults are auto-generated so
// a clone can go straight to `npm install && npm run ui`. Never overwrites an
// existing .env, never logs the generated key.
function ensureEnvFile() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const path = join(root, '.env')
  if (existsSync(path)) return
  const encKey = randomBytes(32).toString('hex')
  const body = [
    '# Auto-generated on first run — edit freely.',
    '# Optional CLI private key. Prefer the terminal vault (npm run terminal) for multi-wallet.',
    'PRIVATE_KEY=',
    '',
    '# Robinhood Chain RPC',
    'RPC_URL=https://rpc.arrowrpc.com',
    '',
    '# Master encryption key for the multi-wallet vault (AES-256-GCM).',
    `WALLET_ENC_KEY=${encKey}`,
    '',
  ].join('\n')
  writeFileSync(path, body, { mode: 0o600 })
  process.env.WALLET_ENC_KEY ??= encKey
}

ensureEnvFile()
dotenv.config()

export const PONS_V2_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e' as const
export const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as const // canonical RH Chain WETH
export const QUOTER = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7' as const
// Official Uniswap V4Quoter deployment for Robinhood Chain (chain 4663).
export const V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as const
export const POOL_FEE = 10000 // 1% — the Pons V1 Uniswap-pool fee tier
export const FEE_BPS = 50n // 0.5% per leg (skimmed by the TradeRouter)
export const POST_FEE = 10000n - FEE_BPS // 9950 — share of input actually swapped
export const SLIPPAGE = 200n // 2% slip tolerance on quotes

/** CLI-only checks. Terminal uses the encrypted vault and does not need PRIVATE_KEY. */
export function requireConfig() {
  if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY missing — set it in .env (never in shell history)')
  if (!process.env.RPC_URL) throw new Error('RPC_URL missing — set it in .env')
}

export function accountFromPk(pk: string) {
  return privateKeyToAccount(pk as `0x${string}`)
}
