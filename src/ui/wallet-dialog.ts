export type WalletDialogKind = 'import' | 'export-confirm' | 'export-reveal' | 'delete-confirm'

export interface WalletDialog {
  kind: WalletDialogKind
  walletId?: string
  walletIds?: string[]
  walletLabel?: string
  walletAddress?: string
  value?: string
  exportKeys?: string[]
  exportIndex?: number
  copied?: boolean
  error?: string
}

export const EXPORT_CONFIRMATION = 'EXPORT'
export const DELETE_CONFIRMATION = 'DELETE'

export function checkedWalletIds(wallets: readonly { id: string }[], checks: ReadonlySet<number>): string[] {
  return wallets.flatMap((wallet, index) => checks.has(index) ? [wallet.id] : [])
}

export function commaSeparatedKeys(privateKeys: readonly string[]): string {
  return privateKeys.join(',')
}

export function maskPrivateKey(privateKey: string): string {
  return privateKey.startsWith('0x') ? `0x${'•'.repeat(Math.max(0, privateKey.length - 2))}` : '•'.repeat(privateKey.length)
}

export function isWalletDialogConfirmed(kind: WalletDialogKind, value?: string): boolean {
  if (kind === 'export-confirm') return value === EXPORT_CONFIRMATION
  if (kind === 'delete-confirm') return value === DELETE_CONFIRMATION
  return false
}
