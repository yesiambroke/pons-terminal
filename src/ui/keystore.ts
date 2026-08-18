import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// On-disk multi-wallet vault. Keys AES-256-GCM encrypted with WALLET_ENC_KEY.
let encKey: Buffer

export function ensureEncKey(): void {
  if (encKey) return
  const hex = process.env.WALLET_ENC_KEY
  if (!hex) throw new Error('WALLET_ENC_KEY missing — set it in .env (64 hex chars)')
  const buf = Buffer.from(hex, 'hex')
  if (buf.length !== 32) throw new Error('WALLET_ENC_KEY must be exactly 32 bytes (64 hex chars)')
  encKey = buf
}

function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${ct.toString('hex')}`
}

function decrypt(payload: string, key: Buffer): string {
  const [ivHex, tagHex, ctHex] = payload.split(':')
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
  d.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([d.update(Buffer.from(ctHex, 'hex')), d.final()]).toString('utf8')
}

export interface VaultWallet {
  id: string
  label: string
  address: string
  privEnc: string
}

interface VaultFile { wallets: VaultWallet[] }

const ROOT = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(ROOT, '..', '..', 'data')
const VAULT_PATH = join(DATA_DIR, 'wallets.vault.json')

function normalizePrivateKey(privateKey: string): `0x${string}` {
  const bare = privateKey.trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) throw new Error('private key must be 64 hex characters')
  return `0x${bare.toLowerCase()}` as `0x${string}`
}

/**
 * An encrypted vault bound to an explicit path/key. Exported for isolated tests;
 * production wrappers below always bind it to the local 0600 vault file.
 */
export function createVaultStore(path: string, key: Buffer) {
  if (key.length !== 32) throw new Error('vault key must be exactly 32 bytes')
  const loadFile = (): VaultFile => {
    if (!existsSync(path)) return { wallets: [] }
    try { return JSON.parse(readFileSync(path, 'utf8')) as VaultFile } catch { return { wallets: [] } }
  }
  const saveFile = (v: VaultFile) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(v, null, 2), { mode: 0o600 })
  }
  const getById = (id: string) => loadFile().wallets.find((w) => w.id === id)

  return {
    load: (): VaultWallet[] => loadFile().wallets,
    add: (label: string, privateKey: string): VaultWallet => {
      const cleanLabel = label.trim()
      if (!cleanLabel) throw new Error('wallet label is required')
      const normalized = normalizePrivateKey(privateKey)
      const account = privateKeyToAccount(normalized)
      const v = loadFile()
      if (v.wallets.some((w) => w.address.toLowerCase() === account.address.toLowerCase())) {
        throw new Error('wallet already in vault')
      }
      const w: VaultWallet = {
        id: randomBytes(8).toString('hex'),
        label: cleanLabel,
        address: account.address,
        privEnc: encrypt(normalized, key),
      }
      v.wallets.push(w)
      saveFile(v)
      return w
    },
    remove: (id: string): VaultWallet => {
      const v = loadFile()
      const wallet = v.wallets.find((w) => w.id === id)
      if (!wallet) throw new Error('wallet not found')
      v.wallets = v.wallets.filter((w) => w.id !== id)
      saveFile(v)
      return wallet
    },
    getById,
    exportPrivateKey: (id: string): string => {
      const wallet = getById(id)
      if (!wallet) throw new Error('wallet not found')
      return decrypt(wallet.privEnc, key)
    },
  }
}

function vaultStore() {
  ensureEncKey()
  return createVaultStore(VAULT_PATH, encKey)
}

export function vaultLoad(): VaultWallet[] { return vaultStore().load() }

export function vaultAdd(label: string, privateKey: string): VaultWallet {
  return vaultStore().add(label, privateKey)
}

export function vaultGenerate(label: string): { privateKey: string; address: string } {
  const privateKey = generatePrivateKey()
  const wallet = vaultAdd(label, privateKey)
  return { privateKey, address: wallet.address }
}

export function vaultRemove(id: string): VaultWallet { return vaultStore().remove(id) }

export function vaultGetById(id: string): VaultWallet | undefined { return vaultStore().getById(id) }

export function vaultExportPrivateKey(id: string): string { return vaultStore().exportPrivateKey(id) }

export function vaultDecrypt(w: VaultWallet): string {
  ensureEncKey()
  return decrypt(w.privEnc, encKey)
}