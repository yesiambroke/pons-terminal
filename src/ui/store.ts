import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Tiny persisted UI prefs: the selected token CA survives restarts so it's set once.

export interface Prefs {
  token: string
  theme?: string
  defaultBuyAmount?: string
  defaultSellPct?: string
  tpSlAutomationEnabled?: boolean
}

const ROOT = dirname(fileURLToPath(import.meta.url))
const PATH = join(ROOT, '..', '..', 'data', 'ui-prefs.json')

export function loadPrefs(): Prefs {
  if (!existsSync(PATH)) return { token: '' }
  try { return JSON.parse(readFileSync(PATH, 'utf8')) } catch { return { token: '' } }
}

export function savePrefs(p: Partial<Prefs>) {
  mkdirSync(dirname(PATH), { recursive: true })
  const cur = loadPrefs()
  writeFileSync(PATH, JSON.stringify({ ...cur, ...p }, null, 2), { mode: 0o600 })
}