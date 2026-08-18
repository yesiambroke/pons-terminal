import { spawnSync } from 'node:child_process'

export type ClipboardWriter = (text: string) => void

function writeMacClipboard(text: string): void {
  const result = spawnSync('pbcopy', [], { input: text, encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error('clipboard copy failed')
}

export function copyText(text: string, writer: ClipboardWriter = writeMacClipboard): void {
  writer(text)
}