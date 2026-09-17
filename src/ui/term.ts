// Pure, deterministic terminal renderer.  renderFrame(UIRecord, TermSize?) → ANSI.
// Paints into a cell Buffer (buffer.ts) and returns a diff-vs-previous frame so
// the terminal only re-writes changed rows (smooth updates; modal = cell fills).
// The driver (bin.ts) owns stdin/TTY/keys — this file is render-only.

import { Buffer, blank } from './buffer.js'
import type { Cell } from './buffer.js'
import type { DispatchModal } from './dispatch.js'
import { fieldsFor } from './dispatch.js'
import type { WalletDialog } from './wallet-dialog.js'
import { maskPrivateKey } from './wallet-dialog.js'

export interface Row {
  label: string
  name?: string
  address?: string
  eth?: string
  token?: string
  /** Live open-position PnL percentage for this wallet's tracked token tranche. */
  pnl?: string
  reserved?: boolean
  status?: 'sel' | 'check' | 'err' | 'ok' | 'busy' | 'dim'
}

export interface VolumeWalletView {
  name: string
  address: string
  eth: string
  token: string
}

export interface ActionChip {
  key: string
  label: string
}

/** A job row shown in the JOBS panel (bottom-right). Mirrors the executor's Job. */
export interface JobView {
  id: string
  type: string
  wallets: number
  progress: { done: number; failed: number; total: number }
  state: 'queued' | 'running' | 'paused' | 'stopped' | 'done' | 'failed'
  daemon?: boolean
  note?: string
}

export type PanelFocus = 'wallets' | 'token' | 'actions' | 'jobs'

export interface UIRecord {
  title: string
  token: string
  tokenName?: string
  tokenSymbol?: string
  rows: Row[]
  cursor: number
  checks: Set<number>
  status: string
  actions: ActionChip[]
  feedback: string[]
  logScroll?: number
  input: { value: string; cursor: number; prompt: string }
  focus?: PanelFocus
  actionCursor?: number
  settingsCursor?: number
  gasMode?: string
  theme?: string
  defaultBuyAmount?: string
  defaultSellPct?: string
  tpSlAutomationEnabled?: boolean
  jobs?: JobView[]
  volumeWallets?: VolumeWalletView[]
  /** Index into `jobs` of the focused job (JOBS panel highlight). */
  jobCursor?: number
  /** Explicit WALLETS scroll offset (wheel-driven). Omit → cursor-anchored. */
  walletScroll?: number
  /** Field index being inline-edited in the modal (shows a blink cursor). */
  modalEdit?: number
  /** Toggles while editing → the field's cursor blinks. */
  modalBlink?: boolean
  modal?: DispatchModal
  walletDialog?: WalletDialog
  /** Toggles while a wallet dialog accepts typed input. */
  walletDialogBlink?: boolean
  routeLabel?: string
  routeDetail?: string
  routeMarket?: string
  routeBlocked?: string
  /** Aggregate current-token sell estimate across local vault wallets. */
  holdingValue?: string
  /** Current net PnL across all open terminal-tracked wallet positions. */
  pnlSummary?: string
  /** Market cap implied by the weighted open terminal entry basis. */
  entryMarketCap?: string
  /** Estimated fully diluted market cap in ETH from the active route quote. */
  marketCap?: string
}

export interface TermSize { cols: number; rows: number }

/** Physical SETTINGS lines that are actual controls, not read-only route status. */
export const SETTINGS_INTERACTIVE_ROWS = [0, 6, 7, 8, 9, 10] as const

export function settingsRowForCursor(cursor: number): number {
  return SETTINGS_INTERACTIVE_ROWS[Math.max(0, Math.min(cursor, SETTINGS_INTERACTIVE_ROWS.length - 1))]!
}

export function settingsCursorForRow(row: number): number | undefined {
  const cursor = SETTINGS_INTERACTIVE_ROWS.indexOf(row as typeof SETTINGS_INTERACTIVE_ROWS[number])
  return cursor === -1 ? undefined : cursor
}

// ─── Color Themes ─────────────────────────────────────────────────────────────
export interface ThemeColors {
  CW: number; CLG: number; CDM: number; CCY: number; CBL: number; CGR: number
  CYL: number; COR: number; BGS: number; BGH: number; BGP: number; BGF: number; BGSL: number
}

export const THEMES: Record<string, ThemeColors> = {
  'dark':          { CW: 255, CLG: 252, CDM: 248, CCY: 81,  CBL: 117, CGR: 84,  CYL: 221, COR: 208, BGS: 233, BGH: 236, BGP: 235, BGF: 238, BGSL: 241 },
  'tokyo-night':   { CW: 255, CLG: 189, CDM: 147, CCY: 117, CBL: 141, CGR: 120, CYL: 221, COR: 215, BGS: 17,  BGH: 19,  BGP: 18,  BGF: 24,  BGSL: 60 },
  'obsidian-gold': { CW: 255, CLG: 252, CDM: 220, CCY: 214, CBL: 208, CGR: 178, CYL: 221, COR: 214, BGS: 233, BGH: 236, BGP: 234, BGF: 237, BGSL: 240 },
  'sunset-synth':  { CW: 255, CLG: 224, CDM: 216, CCY: 207, CBL: 205, CGR: 120, CYL: 220, COR: 208, BGS: 53,  BGH: 54,  BGP: 88,  BGF: 89,  BGSL: 125 },
  'cyberpunk':     { CW: 255, CLG: 253, CDM: 219, CCY: 201, CBL: 51,  CGR: 48,  CYL: 226, COR: 208, BGS: 54,  BGH: 89,  BGP: 53,  BGF: 90,  BGSL: 127 },
  'dracula':       { CW: 231, CLG: 250, CDM: 189, CCY: 117, CBL: 141, CGR: 84,  CYL: 228, COR: 215, BGS: 234, BGH: 60,  BGP: 236, BGF: 61,  BGSL: 62 },
  'matrix':        { CW: 255, CLG: 157, CDM: 120, CCY: 46,  CBL: 82,  CGR: 46,  CYL: 190, COR: 70,  BGS: 22,  BGH: 28,  BGP: 23,  BGF: 29,  BGSL: 35 },
  'nord':          { CW: 255, CLG: 252, CDM: 152, CCY: 110, CBL: 111, CGR: 150, CYL: 222, COR: 209, BGS: 23,  BGH: 24,  BGP: 31,  BGF: 32,  BGSL: 67 },
}

export const W = 110

const X = '\u001b'
const RST = `${X}[0m`
const BLD = `${X}[1m`
const DMS = `${X}[2m`
const UBLD = `${X}[22m`

const ansiRe = /\u001b\[[0-9;]*m/g
function strip(s: string): string { return s.replace(ansiRe, '') }

function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address
}

function clipText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text
}

function cell(ch: string, fg: number, bg: number, bold: boolean, dim: boolean): Cell {
  return { ch, fg, bg, bold, dim }
}

/** Paint a styled ANSI string into the buffer starting at (x,y). Assumes each
 * `\u001b[...m` sequence and plain chars; styles apply as they're encountered. */
function put(b: Buffer, x: number, y: number, s: string, bg: number, T: ThemeColors): void {
  if (y < 0 || y >= b.rows) return
  let cx = x
  let fg = T.CW, bold = false, dim = false
  const escapeRe = /\u001b\[([0-9;]*)m/g
  const plain = s
  let i = 0
  while (i < plain.length) {
    if (plain[i] === '\u001b') {
      escapeRe.lastIndex = i
      const m = escapeRe.exec(plain)
      if (m) {
        const body = m[1]
        // handle 38;5;<n> (256-color fg) and plain N (styles)
        if (body.includes('38;5')) {
          const mm = body.match(/38;5;(\d+)/)
          if (mm) fg = parseInt(mm[1], 10)
        } else {
          for (const c of body.split(';').map(Number)) {
            if (c === 0) { fg = T.CW; bold = false; dim = false }
            else if (c === 1) bold = true
            else if (c === 2) dim = true
            else if (c === 22 || c === 21) { bold = false; dim = false }
          }
        }
        i += m[0].length
        continue
      }
      i++; continue
    }
    if (cx >= b.cols) break
    b.set(cx, y, { ch: plain[i], fg, bg, bold, dim })
    cx++; i++
  }
}

// ─── renderFrame ──────────────────────────────────────────────────────────────

/** Layout numbers — faithfully ported from the pre-buffer term.ts so the panel
 * ratios + separation (BGS gutters between every panel) stay identical. */
interface LOut {
  tw: number
  pw: number           // inner panel width (tw - 2)
  ci1: number; ci2: number; ci3: number   // inner content widths (top row)
  view: number; act: number               // rows top/bottom
  ca1: number; ca2: number                 // total painted widths (bottom)
  cia1: number; cia2: number               // inner content widths (bottom)
}
function computeLayout(tw: number, th: number): LOut {
  const pw = Math.max(70, tw - 2)
  const ci2 = Math.max(22, Math.min(34, Math.floor(pw * 0.26)))
  const ci3 = 22
  const ci1 = pw - 4 - (ci2 + 2) - (ci3 + 2)   // -4 → 1-col blank gap at the right edge (ACTIONS)
  const ca2 = Math.max(26, Math.min(34, Math.floor(pw * 0.3))) + 2
  const ca1 = pw - 1 - ca2
  const chrome = 8
  const flex = Math.max(5, th - chrome)
  const view = Math.max(4, Math.floor(flex * 0.55))
  const act = Math.max(2, flex - view)
  return { tw, pw, ci1, ci2, ci3, view, act, ca1, ca2, cia1: ca1 - 2, cia2: ca2 - 2 }
}

export function renderFrame(s: UIRecord, size?: TermSize): string {
  const tw = size?.cols ?? W
  const th = size?.rows ?? 30
  const L = computeLayout(tw, th)
  const themeName = (s.theme && THEMES[s.theme]) ? s.theme : 'dark'
  const T = THEMES[themeName]!

  const b = new Buffer(tw, th, T.BGS)
  const focus = s.focus ?? 'wallets'
  const fW = focus === 'wallets', fT = focus === 'token', fA = focus === 'actions', fJ = focus === 'jobs'
  const bg1 = fW ? T.BGF : T.BGP
  const bg2 = fT ? T.BGF : T.BGP
  const bg3 = fA ? T.BGF : T.BGP

  // ── header bar (row 0) ────────────────────────────────────────────────────
  b.fillRect(0, 0, tw, 1, T.BGH)
  const tokenLabel = s.token
    ? `${s.tokenName ?? 'Unknown token'}${s.tokenSymbol ? ` (${s.tokenSymbol})` : ''} · ${shortAddress(s.token)}`
    : 'no token'
  const left = `${BLD}${s.title}${RST}   ${tokenLabel}`
  put(b, 2, 0, left, T.BGH, T)
  const right = `[${({ wallets: 'wallets', token: 'settings', actions: 'actions', jobs: 'jobs' } as Record<string, string>)[focus] ?? focus}]  ${s.status}`
  put(b, tw - strip(right).length - 2, 0, right, T.BGH, T)

  // ── panel title band (BGH) at row 2 (row 1 = BGS spacer) ──────────────────
  const titleRow = (x1: string, x2: string, x3: string, cw1: number, cw2: number, cw3: number): void => {
    let x = 1
    paintCell(b, x, 2, cw1, x1, T.BGH, T); x += cw1 + 1
    paintCell(b, x, 2, cw2, x2, T.BGH, T); x += cw2 + 1
    paintCell(b, x, 2, cw3, x3, T.BGH, T)
  }
  // WALLETS headers and rows share an explicit column model. Numeric headings
  // use the same right edge as their changing values to avoid visual drift.
  const walletColumns = L.ci1 >= 115
    ? { name: 8, address: 42, eth: 12, token: 10, pnl: 7 }
    : L.ci1 >= 70
      ? { name: 8, address: 17, eth: 12, token: 10, pnl: 7 }
      : { name: 5, address: 17, token: 7, pnl: 7 }
  const fitLeft = (value: string, width: number): string => clipText(value, width).padEnd(width)
  const fitRight = (value: string, width: number): string => clipText(value, width).padStart(width)
  const walletValue = (value: string, unit: string): string => value.endsWith(` ${unit}`) ? value.slice(0, -unit.length - 1) : value
  const wHeader = 'eth' in walletColumns
    ? `  [v]  #  ${fitLeft('NAME', walletColumns.name)}  ${fitLeft('ADDRESS', walletColumns.address)}  ${fitRight('ETH', walletColumns.eth!)}  ${fitRight('TOKEN', walletColumns.token)} ${fitRight('PNL', walletColumns.pnl)}`
    : `  [v]  #  ${fitLeft('NAME', walletColumns.name)}  ${fitLeft('ADDRESS', walletColumns.address)} ${fitRight('TOKEN', walletColumns.token)} ${fitRight('PNL', walletColumns.pnl)}`
  titleRow(wHeader, '  SETTINGS', '  ACTIONS', L.ci1 + 2, L.ci2 + 2, L.ci3 + 2)

  // ── body: 3 top panels, view-1 rows, BGS gutters between every panel ──────
  const len = s.rows.length
  const cursor = len === 0 ? 0 : Math.min(s.cursor, len - 1)
  // explicit wallet scroll offset (set by wheel) — falls back to cursor-anchored
  const maxStart = Math.max(0, len - (L.view - 1))
  const start = s.walletScroll !== undefined
    ? Math.min(s.walletScroll, maxStart)
    : Math.max(0, Math.min(cursor - Math.floor((L.view - 1) / 3), maxStart))

  // pre-build wallet rows using the same fixed columns as the header.
  const walletLines: string[] = []
  const walletLine = (r: Row, index: number, selected: boolean, checked: boolean): string => {
    const mark = selected ? '▸' : ' '
    const badge = r.reserved ? '[VOL]' : (checked ? '[✓] ' : '[ ] ')
    if (!r.address) return `${mark} ${badge} ${r.label}`
    if (r.reserved) return `${mark} ${badge} ${r.name ?? 'wallet'}  dedicated · see VOLUME WALLETS`
    const address = L.ci1 >= 115 ? r.address : shortAddress(r.address)
    const number = `${index + 1}`.padStart(2)
    const prefix = `${mark} ${badge} ${number} `
    const name = fitLeft(r.name ?? '', walletColumns.name)
    const addressCell = fitLeft(address, walletColumns.address)
    const pnl = fitRight(r.pnl ?? '--', walletColumns.pnl)
    if (!('eth' in walletColumns)) {
      const token = fitRight(walletValue(r.token ?? '–', 'TOK'), walletColumns.token)
      return `${prefix}${name}  ${addressCell} ${token} ${pnl}`
    }
    const eth = fitRight(walletValue(r.eth ?? '–', 'ETH'), walletColumns.eth!)
    const token = fitRight(walletValue(r.token ?? '–', 'TOK'), walletColumns.token)
    return `${prefix}${name}  ${addressCell}  ${eth}  ${token} ${pnl}`
  }
  for (let bi = 0; bi < L.view - 1; bi++) {
    const idx = start + bi
    const r = s.rows[idx]
    if (!r) {
      if (bi === 0 && len === 0) walletLines.push(`  no wallets — press g`)
      else if (bi === L.view - 3) walletLines.push(`${s.checks.size} of ${len} checked for trade`)
      else walletLines.push('')
      continue
    }
    walletLines.push(walletLine(r, idx, idx === cursor, s.checks.has(idx)))
  }

  // settings content
  const setLines: string[] = []
  const isEditing = s.input.prompt !== 'cmd'
  if (isEditing) {
    const editTitle = s.input.prompt === 'token CA'
      ? 'TOKEN CONTRACT ADDRESS'
      : s.input.prompt === 'default buy ETH'
        ? 'DEFAULT BUY AMOUNT (ETH)'
        : 'DEFAULT SELL PERCENTAGE'
    setLines.push(`  ▍ ${editTitle}`, `  ${s.input.value || ' '}`, '', `  ⏎ Save   Esc Cancel`)
  } else {
    const contract = s.token ? shortAddress(s.token) : 'Set Token CA'
    const LBL = (l: string) => `  ${l.padEnd(5)}  `
    setLines.push(
      `${LBL('CA')}${contract}`,
      `${LBL('Route')}${s.routeLabel?.replaceAll(' / ', '/') ?? 'detecting…'}${s.routeDetail ? ` · ${s.routeDetail.match(/\d+\.\d+%/)?.[0] ?? ''}` : ''}`,
      `${LBL('PnL')}${s.pnlSummary ?? 'untracked'}`,
      `${LBL('Entry MC')}${s.entryMarketCap ?? 'untracked'}`,
      `${LBL('Value')}${s.holdingValue ?? (s.routeBlocked ? 'unavailable' : '—')}`,
      `${LBL('MCap')}${s.marketCap ?? (s.routeBlocked ? 'unavailable' : '—')}`,
      `${LBL('Buy')}${s.defaultBuyAmount ?? '0.001'} ETH`,
      `${LBL('Sell')}${s.defaultSellPct ?? '50'}%`,
      `${LBL('Gas')}${s.gasMode ?? 'fast'}`,
      `${LBL('TP/SL')}${s.tpSlAutomationEnabled ? 'on' : 'off'}`,
      `${LBL('Theme')}${themeName}`,
    )
  }

  // actions content
  const actLines: string[] = []
  for (let ai = 0; ai < s.actions.length; ai++) {
    const a = s.actions[ai]
    const hl = fA && ai === (s.actionCursor ?? 0)
    actLines.push(`${hl ? '▸' : ' '} [${a.key}] ${a.label}`)
  }

  // paint the three body columns, one row at a time (body starts row 3)
  const wScr = s.rows.length > L.view - 1       // wallets overflow → reserve last col
  const wW = wScr ? L.ci1 + 1 : L.ci1 + 2        // text width (scrollbar takes last col)
  for (let bi = 0; bi < L.view - 1; bi++) {
    const y = 3 + bi
    const rBg1 = (s.rows[start + bi] && start + bi === cursor && fW) ? T.BGSL : bg1
    let x = 1
    paintCell(b, x, y, wW, (walletLines[bi] ?? ''), rBg1, T); x += L.ci1 + 2 + 1
    paintCell(b, x, y, L.ci2 + 2, (setLines[bi] ?? ''), (fT && !isEditing && bi === settingsRowForCursor(s.settingsCursor ?? 0)) ? T.BGSL : bg2, T); x += L.ci2 + 2 + 1
    paintCell(b, x, y, L.ci3 + 2, (actLines[bi] ?? ''), bg3, T)
  }

  // ── WALLETS scrollbar — INSIDE the panel's last column (x=wW+1) ─────────────
  const wTotal = s.rows.length
  const wVis = L.view - 1
  if (wTotal > wVis) {
    const thumbH = Math.max(1, Math.round((wVis * wVis) / wTotal))
    const trackH = wVis - thumbH
    const off = Math.min(1, start / Math.max(1, wTotal - wVis))
    const thumbY = 3 + Math.round(trackH * off)
    for (let yy = 3; yy < 3 + wVis; yy++) {
      const inThumb = yy >= thumbY && yy < thumbY + thumbH
      b.set(1 + wW, yy, inThumb
        ? { ch: '█', fg: T.CCY, bg: T.CCY, bold: false, dim: false }
        : { ch: '│', fg: T.CDM, bg: bg1, bold: false, dim: true })
    }
  }

  // ── bottom: ACTIVITY (left) + JOBS (right), separated by a BGS gutter ─────
  // spacer row after top body, then titles, then body
  const btY = 3 + (L.view - 1) + 1          // row after a 1-row gap
  const byY = btY + 1                       // body starts next row
  // titles
  let x = 1
  paintCell(b, x, btY, L.ca1, '  ACTIVITY', T.BGH, T); x += L.ca1 + 1
  paintCell(b, x, btY, L.ca2, '  VOLUME WALLETS · JOBS', T.BGH, T)

  // JOBS content
  const jobs = s.jobs ?? []
  // VOLUME WALLETS stay visible here while reserved from normal trade selection.
  const volumeWallets = s.volumeWallets ?? []
  const jobLines: string[] = volumeWallets.map((wallet) =>
    ` ∞ ${wallet.name.slice(0, 7).padEnd(7)} ${wallet.eth.padStart(11)} ${wallet.token.padStart(9)}`,
  )
  if (volumeWallets.length) jobLines.push('  ─ active jobs ─')
  if (jobs.length === 0 && !volumeWallets.length) {
    jobLines.push('', `  no volume wallets or jobs`, `  select wallets, then [v]olume`)
  } else {
    const jc = s.jobCursor ?? -1
    const visible = jobs.slice(0, Math.max(0, L.act - 1 - jobLines.length))
    for (let ji = 0; ji < visible.length; ji++) {
      const j = visible[ji]
      const mark = j.daemon ? '∞' : '◦'
      let st = '●'
      if (j.state === 'running') st = '▸'
      else if (j.state === 'queued') st = '○'
      else if (j.state === 'done') st = '✓'
      const prog = j.progress.total > 0 ? `${j.progress.done}/${j.progress.total}` : ''
      const cur = (s.focus === 'jobs' && ji === jc) ? '▸' : ' '
      jobLines.push(` ${cur}${mark} ${j.id} ${j.type} ${prog} ${st}${j.note ? ' ' + j.note : ''}`)
    }
  }

  // ACTIVITY content (scrollable log)
  const fe = s.feedback ?? []
  const back = s.logScroll ? Math.abs(s.logScroll) : 0
  const tail = fe.length
  const startIdx = Math.max(0, tail - L.act - back)
  const actBody: string[] = []
  if (fe.length === 0) actBody.push(`♨  idle — select wallets, then [b]uy / [s]ell / [v]olume`)
  for (let i = 0; i < L.act; i++) {
    const li = startIdx + i
    if (fe[li]) actBody.push(fe[li])
    else actBody.push('')
  }

  const aScr = fe.length > L.act                // activity overflow → reserve last col
  const aW = aScr ? L.ca1 - 1 : L.ca1            // text width (scrollbar takes last col)
  for (let ri = 0; ri < L.act; ri++) {
    const y = byY + ri
    let x = 1
    const jobBg = fJ ? T.BGF : T.BGP
    // last row of the JOBS panel = control tips (not a job row)
    if (ri === L.act - 1) {
      paintCell(b, x, y, aW, (actBody[ri] ?? ''), T.BGP, T); x += L.ca1 + 1
      paintCell(b, x, y, L.ca2, ' p pause · r resume · x stop', T.BGH, T)
      continue
    }
    paintCell(b, x, y, aW, (actBody[ri] ?? ''), T.BGP, T); x += L.ca1 + 1
    const jrowBg = (fJ && jobs[ri] && ri === (s.jobCursor ?? 0)) ? T.BGSL : jobBg
    paintCell(b, x, y, L.ca2, (jobLines[ri] ?? ''), jrowBg, T)
  }

  // ── ACTIVITY scrollbar — INSIDE the panel's last column (x=aW+1) ────────────
  if (aScr) {
    const thumbH = Math.max(1, Math.round((L.act * L.act) / fe.length))
    const trackH = L.act - thumbH
    const off = Math.min(1, back / Math.max(1, fe.length - L.act))
    // newest (back=0) → thumb at the BOTTOM; scrolling back → thumb moves UP
    const thumbY = byY + Math.round(trackH * (1 - off))
    for (let yy = byY; yy < byY + L.act; yy++) {
      const inThumb = yy >= thumbY && yy < thumbY + thumbH
      b.set(1 + aW, yy, inThumb
        ? { ch: '█', fg: T.CCY, bg: T.CCY, bold: false, dim: false }
        : { ch: '│', fg: T.CDM, bg: T.BGP, bold: false, dim: true })
    }
  }

  // ── JOBS overflow marker (more jobs than the panel shows) ───────────────────
  const jobsTotal = jobs.length
  const jobsVis = L.act - 1
  if (jobsTotal > jobsVis) {
    b.set(L.ca1 + 2 + L.ca2 - 2, byY + L.act - 2, { ch: '▾', fg: T.CDM, bg: T.BGP, bold: false, dim: true })
  }

  // ── help bar ──────────────────────────────────────────────────────────────
  const keys: [string, string][] = tw >= 150
    ? [
      ['↑↓', 'navigate'], ['space', 'select'], ['a', 'all'], ['g', 'gen'], ['t', 'token'],
      ['b', 'buy'], ['s', 'sell'], ['[', 'preset buy'], [']', 'preset sell'], ['n', 'Sell All'], ['k', 'TP/SL'], ['v', 'vol'], ['tab', 'focus'], ['q', 'quit'],
    ]
    : [
      ['↑↓', 'nav'], ['space', 'select'], ['b', 'buy'], ['s', 'sell'], ['[', 'buy'], [']', 'sell'], ['n', 'Sell All'], ['k', 'TP/SL'], ['v', 'vol'], ['q', 'quit'],
    ]
  const helpStr = keys.map(([k, v]) => `${k} ${v}`).join('  ·  ')
  const hy = byY + L.act + 1            // spacer row after bottom body, then help
  b.fillRect(0, hy, tw, 1, T.BGH)
  put(b, 2, hy, helpStr, T.BGH, T)

  // ── footer (last row, right after help + 1 spacer) ────────────────────────
  b.fillRect(0, th - 1, tw, 1, T.BGH)
  put(b, 2, th - 1, `PONS TERMINAL`, T.BGH, T)
  put(b, Math.max(2, tw - 15), th - 1, `By a-trade.fun`, T.BGH, T)

  // ── modal overlay ─────────────────────────────────────────────────────────
  if (s.modal || s.walletDialog) {
    b.scrim(T.BGS)
    if (s.modal) drawModal(b, s.modal, s.rows.length, T, s.modalEdit, s.modalBlink)
    else if (s.walletDialog) drawWalletDialog(b, s.walletDialog, T, s.walletDialogBlink)
  }

  return b.renderDiff()
}

/** Paint one panel cell: 1-space pad + content, over `bg`. (Mirrors old cell().) */
function paintCell(b: Buffer, x: number, y: number, w: number, content: string, bg: number, T: ThemeColors): void {
  if (y < 0 || y >= b.rows) return
  b.fillRect(x, y, w, 1, bg)
  const inner = Math.max(0, w - 2)
  const c = strip(content)
  put(b, x + 1, y, c.length > inner ? c.slice(0, inner - 1) + '…' : c, bg, T)
}

// ─── modal ────────────────────────────────────────────────────────────────────

function drawModal(b: Buffer, modal: DispatchModal, n: number, T: ThemeColors,
  modalEdit?: number, modalBlink?: boolean): void {
  const fields = fieldsFor(modal)
  const body: { label: string; value: string; sel: boolean; isEnum: boolean }[] = []
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    body.push({
      label: f.label,
      value: f.kind === 'enum' ? f.value : (f.value || '—'),
      sel: i === (modal.cursor % Math.max(1, fields.length)),
      isEnum: f.kind === 'enum',
    })
  }
  // blink cursor: shows on the field currently being edited (text/int only)
  const blinkOn = modalEdit != null && (modalBlink ?? false)
  const edited = modalEdit != null ? modalEdit % Math.max(1, fields.length) : -1
  const editingText = edited >= 0 && fields[edited]?.kind !== 'enum'
  // measure the widest label to align values
  const labelW = Math.max(...body.map((f) => f.label.length), 4)

  // window-chrome: title lives ON the top border, hints ON the bottom border
  const titleLine = ` ${modal.kind.toUpperCase()} DISPATCH `
  const hintLine = editingText
    ? ` ✏ typing…   ⏎ done   esc cancel   ⌫ backspace `
    : ` ⏎ confirm   esc cancel   ◄► edit `

  // interior rows: blank bar + fields + blank bar (title & hints are on borders)
  const lines: string[] = ['']
  for (const f of body) {
    const arrow = f.sel ? '▸' : ' '
    const label = ` ${f.label}${' '.repeat(Math.max(0, labelW - f.label.length))}`
    const value = f.isEnum ? `[${f.value}]` : f.value
    // editing the current field → append a blinking block cursor after the value
    const cursor = (editingText && f.sel) ? (blinkOn ? '▉' : ' ') : ''
    lines.push(`${arrow}${label} ${value}${cursor}${f.isEnum ? ' ▸◂' : ''}`)
  }
  lines.push('')

  // width: widest interior line, the hint line, or the title — with breathing room
  const contentW = Math.max(...lines.map((l) => strip(l).length), 0)
  const bw = Math.max(contentW + 10, strip(hintLine).length + 6, strip(titleLine).length + 10, 40)
  const bh = lines.length + 2          // +2 for the border (top/bottom)
  const cx = Math.max(1, Math.floor((b.cols - bw) / 2))
  const cy = Math.max(1, Math.floor((b.rows - bh) / 2))
  const B = T.BGH                        // border color = panel title band
  // solid border frame (flat BGH blocks — no line chars)
  b.fillRect(cx, cy, bw, 1, B)                    // top
  b.fillRect(cx, cy + bh - 1, bw, 1, B)           // bottom
  b.fillRect(cx, cy + 1, 1, bh - 2, B)            // left
  b.fillRect(cx + bw - 1, cy + 1, 1, bh - 2, B)   // right
  b.fillRect(cx + 1, cy + 1, bw - 2, bh - 2, T.BGF)
  // title ON the top border, hints ON the bottom border
  put(b, cx + 2, cy, titleLine, B, T)
  put(b, cx + 2, cy + bh - 1, hintLine, B, T)
  for (let i = 0; i < lines.length; i++) {
    const yy = cy + 1 + i
    if (i === 0 || i === lines.length - 1) { put(b, cx + 2, yy, lines[i], T.BGF, T); continue }
    // field rows: highlight the cursor field across the INTERIOR only
    // (borders at cx and cx+bw-1 stay solid BGH — highlight never touches them)
    const bodyIdx = (i - 1)
    const f = body[bodyIdx]
    const rowBg = f?.sel ? T.BGSL : T.BGF
    b.fillRect(cx + 1, yy, bw - 2, 1, rowBg)
    put(b, cx + 2, yy, lines[i], rowBg, T)
  }
}

function drawWalletDialog(b: Buffer, dialog: WalletDialog, T: ThemeColors, blinkOn = true): void {
  const label = dialog.walletLabel ?? 'selected wallet'
  const address = dialog.walletAddress ?? ''
  const input = dialog.value ?? ''
  let title = ' WALLET '
  let hint = ' esc cancel '
  let lines: string[]
  let inputLineIndex: number | undefined

  if (dialog.kind === 'import') {
    title = ' IMPORT WALLET '
    hint = ' ✏ typing…   ⏎ import   esc cancel   ⌫ backspace '
    lines = [
      ' Paste private key (stored AES-256-GCM encrypted)',
      ` ${input ? maskPrivateKey(input) : '0x'}${blinkOn ? '▉' : ' '}`,
      dialog.error ? ` ✗ ${dialog.error}` : ' Label is assigned automatically.',
    ]
    inputLineIndex = 1
  } else if (dialog.kind === 'export-confirm') {
    const count = dialog.walletIds?.length ?? 1
    title = ' EXPORT WALLET '
    hint = ' ✏ typing…   ⏎ reveal   esc cancel   ⌫ backspace '
    lines = [
      ` ${count} checked wallet${count === 1 ? '' : 's'} will be exported.`,
      ' Type EXPORT to reveal their comma-separated private keys.',
      ` ${input}${blinkOn ? '▉' : ' '}`,
      dialog.error ? ` ✗ ${dialog.error}` : ' Do not share or screenshot the key.'
    ]
    inputLineIndex = 2
  } else if (dialog.kind === 'export-reveal') {
    const keys = dialog.exportKeys ?? (input ? [input] : [])
    const count = keys.length
    const index = Math.min(Math.max(0, dialog.exportIndex ?? 0), Math.max(0, count - 1))
    title = ' EXPORT WALLET '
    hint = dialog.copied ? ' ✓ copied all   ←→ browse   any key hides ' : ' c copy all   ←→ browse   any key hides '
    lines = [
      ` KEY ${index + 1} / ${count}   ·   ${count} selected`,
      ' ←→ browse full keys · c copies all as comma-separated',
      ` ${keys[index] ?? ''}`,
    ]
  } else {
    const count = dialog.walletIds?.length ?? 1
    title = ' DELETE WALLET '
    hint = ' ✏ typing…   ⏎ delete   esc cancel   ⌫ backspace '
    lines = [
      ` ${count} checked wallet${count === 1 ? '' : 's'} will be removed.`,
      ' Type DELETE to permanently remove them from this local vault.',
      ` ${input}${blinkOn ? '▉' : ' '}`,
      dialog.error ? ` ✗ ${dialog.error}` : ' Export and sweep funds first. This cannot be undone.',
    ]
    inputLineIndex = 2
  }

  const contentW = Math.max(...lines.map((line) => strip(line).length), strip(title).length, strip(hint).length)
  const bw = Math.min(b.cols - 2, Math.max(44, contentW + 6))
  const bh = lines.length + 4
  const cx = Math.max(1, Math.floor((b.cols - bw) / 2))
  const cy = Math.max(1, Math.floor((b.rows - bh) / 2))
  const B = T.BGH
  b.fillRect(cx, cy, bw, 1, B)
  b.fillRect(cx, cy + bh - 1, bw, 1, B)
  b.fillRect(cx, cy + 1, 1, bh - 2, B)
  b.fillRect(cx + bw - 1, cy + 1, 1, bh - 2, B)
  b.fillRect(cx + 1, cy + 1, bw - 2, bh - 2, T.BGF)
  put(b, cx + 2, cy, title, B, T)
  put(b, cx + 2, cy + bh - 1, hint, B, T)
  for (let i = 0; i < lines.length; i++) {
    const rowBg = i === inputLineIndex ? T.BGSL : T.BGF
    if (i === inputLineIndex) b.fillRect(cx + 1, cy + 2 + i, bw - 2, 1, rowBg)
    put(b, cx + 2, cy + 2 + i, lines[i]!, rowBg, T)
  }
}

// small helpers
function shortify(a: string): string { return a.slice(0, 10) + '…' + a.slice(-6) }
function shorty(a: string): string { return a.slice(0, 6) + '…' }
function clipto(s: string, n: number): string { return strip(s).length > n ? strip(s).slice(0, n - 1) + '…' : s }
const TST = ''