// Cell-buffer terminal renderer — the OpenTUI-style core for hoodl-open.
//
// Instead of assembling ANSI string fragments line-by-line (old term.ts), this
// module paints a GRID OF CELLS (a `Buffer`), then serializes it for the
// terminal, DIFFING against the previous frame so only changed rows are
// re-written. Modal overlays become simple cell fills (scrim + bright block).
//
// Pure TS, no native deps.

export const X = '\u001b'
export const RST = `${X}[0m`

const ansiRe = /\u001b\[[0-9;]*m/g
export function stripAnsi(s: string): string { return s.replace(ansiRe, '') }

// ─── Cell ─────────────────────────────────────────────────────────────────────

export interface Cell {
  ch: string
  fg: number
  bg: number
  bold: boolean
  dim: boolean
}

export function blank(bg: number): Cell {
  return { ch: ' ', fg: bg, bg, bold: false, dim: false }
}

/** Convert a cell into an ANSI segment given the current style (emit only diffs). */
export function cellANSI(c: Cell, cur: { fg: number; bg: number; bold: boolean; dim: boolean }): string {
  let out = ''
  if (c.bg !== cur.bg) out += `${X}[48;5;${c.bg}m`
  if (c.fg !== cur.fg) out += `${X}[38;5;${c.fg}m`
  if (c.bold !== cur.bold) out += c.bold ? `${X}[1m` : `${X}[22m`
  if (c.dim !== cur.dim) out += c.dim ? `${X}[2m` : `${X}[22m`
  return out + c.ch
}

// ─── Buffer ───────────────────────────────────────────────────────────────────

export class Buffer {
  cols: number
  rows: number
  grid: Cell[][]
  private prevRows: string[] = []

  constructor(cols: number, rows: number, defaultBg = 0) {
    this.cols = cols
    this.rows = rows
    this.grid = []
    for (let y = 0; y < rows; y++) {
      const row: Cell[] = []
      for (let x = 0; x < cols; x++) row.push(blank(defaultBg))
      this.grid.push(row)
    }
  }

  set(x: number, y: number, cell: Cell): void {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    this.grid[y][x] = cell
  }

  /** Solid-fill a rectangle with a background (modal scrim / card). */
  fillRect(x: number, y: number, w: number, h: number, bg: number): void {
    const c = blank(bg)
    for (let yy = y; yy < y + h; yy++) {
      if (yy < 0 || yy >= this.rows) continue
      const row = this.grid[yy]
      for (let xx = x; xx < x + w; xx++) {
        if (xx < 0 || xx >= this.cols) continue
        row[xx] = { ...c }
      }
    }
  }

  /** Solid-scrim every row cell's background OPAQUE + keep text dimmed. */
  scrim(bg: number): void {
    for (let y = 0; y < this.rows; y++) {
      const row = this.grid[y]
      for (let x = 0; x < this.cols; x++) {
        const c = row[x]
        if (c.ch !== ' ') row[x] = { ...c, bg, dim: true }   // dim non-space text
        else row[x] = { ...c, bg }                            // pure bg for blanks
      }
    }
  }

  /** Paint ANSI-tagged text at (x,y); returns next x. Handles embedded style codes. */
  text(x: number, y: number, s: string, fg: number, bg: number, opts: { bold?: boolean; dim?: boolean } = {}): number {
    if (y < 0 || y >= this.rows) return x
    const row = this.grid[y]
    const { bold = false, dim = false } = opts
    let cx = x
    for (const ch of s) {
      if (cx < 0) { cx++; continue }
      if (cx >= this.cols) break
      row[cx] = { ch, fg, bg, bold, dim }
      cx++
    }
    return cx
  }

  // ---- serialization ----

  /** Serialize one row to visible-char + style ANSI (run-length via cellANSI). */
  private serializeRow(y: number): string {
    const row = this.grid[y]
    let out = ''
    let cur = { fg: -1, bg: -1, bold: false, dim: false }
    for (const c of row) {
      out += cellANSI(c, cur)
      cur = { fg: c.fg, bg: c.bg, bold: c.bold, dim: c.dim }
    }
    return out
  }

  /** Diff vs last frame → emit only rows that changed, positioned to home. */
  renderDiff(): string {
    const N = '\u001b[?25l'
    let out = `${N}${X}[H`   // hide cursor, home
    for (let y = 0; y < this.rows; y++) {
      const row = this.serializeRow(y)
      if (row !== (this.prevRows[y] ?? '')) {
        out += `${X}[${y + 1};1H${row}`
      }
    }
    this.prevRows = this.grid.map((_, yi) => this.serializeRow(yi))
    return out
  }
}

export interface Region { x: number; y: number; w: number; h: number }

// ─── FlexLayout (a small row/column flex resolver) ───────────────────────────
// Given a parent Region and a list of child configs with flex weights or fixed
// sizes, it resolves each child's rectangle. Enough to replace hand-counted cols.

export interface FlexChild {
  /** 0..1 fraction of remaining space (like flexGrow). */
  flex?: number
  /** fixed width in cells (overrides flex). */
  fixed?: number
}

export function flexRow(parent: Region, children: FlexChild[], gap = 0): Box2[] {
  const fixed = children.reduce((a, c) => a + (c.fixed ?? 0), 0)
  const totalFixedGaps = Math.max(0, children.length - 1) * gap
  const remaining = Math.max(0, parent.w - fixed - totalFixedGaps)
  const flexTotal = children.reduce((a, c) => a + (c.flex ?? 0), 0)
  const boxes: Box2[] = []
  let cx = parent.x
  for (const c of children) {
    const w = c.fixed ?? (flexTotal > 0 ? Math.floor(remaining * (c.flex ?? 0) / flexTotal) : 0)
    boxes.push({ x: cx, y: parent.y, w, h: parent.h })
    cx += w + gap
  }
  return boxes
}
export interface Box2 { x: number; y: number; w: number; h: number }