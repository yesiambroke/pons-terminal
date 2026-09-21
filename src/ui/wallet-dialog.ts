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

/** Buy/sell targets: checked wallets if any, otherwise the focused row. */
export function tradeWalletTargets<T>(wallets: readonly T[], checks: ReadonlySet<number>, cursor: number): T[] {
  if (checks.size > 0) return wallets.filter((_, index) => checks.has(index))
  const focused = wallets[cursor]
  return focused ? [focused] : []
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
