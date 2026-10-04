// The words of background tasks, with no engine in reach: titles and progress read from output.
import type { TaskStatus } from '../types'

// Finished tasks stay in the list this long, so the hover still answers "did it pass?".
export const KEEP_FINISHED_MS = 15 * 60_000

// --- text --------------------------------------------------------------------

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')

  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${Math.floor(s / 60)}:${ss}`
}

export function human(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) {
    return `${s} с`
  }
  const m = Math.round(s / 60)

  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`
}

// 9000 as `9 000`.
export function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// The command that does the work: past `cd`, env and runner prefixes, without redirects.
export function commandTitle(command: string): string {
  const parts = command
    .split(/\s*(?:&&|\|\||;|\r?\n)\s*/)
    .map(part => part.split(/\s\|\s*|\|\s/)[0] ?? '')
    .filter(part => part !== '' && !/^(?:cd|pushd|set|export|Set-Location)\b/i.test(part))
  const main = (parts[0] ?? command)
    .replace(/^(?:\w+=\S*\s+|(?:sudo|time|npx|bunx|exec)\s+|["'&(]\s*)+/i, '')
    .replace(/^"?(?:[A-Za-z]:)?(?:[^\s"]*[\\/])+/, '')
    .replace(/^([\w.-]+?)(?:\.exe|\.cmd|\.bat)?["']?(?=\s|$)/i, '$1')
    .replace(/\s+\d?>>?&?\s*\S+/g, '')
    .trim()

  return cut(main.replace(/\s+/g, ' '), 48)
}

// --- output ------------------------------------------------------------------

export function lines(tail: string): string[] {
  return tail
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map(line => (line.split('\r').pop() ?? '').trim())
    .filter(line => line !== '')
}

// A count may group its thousands with a space, `,` or `_`: `4 500 из 9 000`, `4,500/9,000`.
const NUMBER = String.raw`(\d{1,3}(?:[ ,_  ]\d{3})+|\d+)`
const COUNT = new RegExp(String.raw`(?:^|[\s[(|:])${NUMBER}\s*(?:\/|of|из)\s*${NUMBER}(?=[\s\])|,:;]|$)`, 'gi')

function numberOf(text: string): number {
  return Number(text.replace(/[ ,_  ]/g, ''))
}

export type Progress = { percent: number; done: number | null; total: number | null }

// How far along the output says it is: `4500/9000`, `[12/40]`, `12 из 40`, `45%`; the newest line that says wins.
export function progressOf(recent: readonly string[]): Progress | null {
  for (const line of [...recent].reverse()) {
    const counted = [...line.matchAll(COUNT)]
      .map(m => ({ done: numberOf(m[1] ?? ''), total: numberOf(m[2] ?? '') }))
      .filter(c => c.total >= 2 && c.done <= c.total)
      .pop()
    if (counted !== undefined) {
      return { percent: counted.done / counted.total, ...counted }
    }
    const percents = [...line.matchAll(/(\d{1,3}(?:[.,]\d+)?)\s?%/g)].map(m => parseFloat((m[1] ?? '').replace(',', '.')))
    const percent = percents.filter(p => p >= 0 && p <= 100).pop()
    if (percent !== undefined) {
      return { percent: percent / 100, done: null, total: null }
    }
  }

  return null
}

export function outputPathOf(text: string): string | null {
  const path = /written to:?\s*([^\s"']+)/i.exec(text)?.[1] ?? /([^\s"']+\.output)\b/.exec(text)?.[1]

  return path === undefined ? null : path.replace(/[.,;]+$/, '')
}

// The notification a background task sends when it ends.
export function notified(text: string, id: string): Exclude<TaskStatus, 'running'> | null {
  const at = text.indexOf(id)
  const near = text.slice(Math.max(0, at - 400), at + 1200)
  const status = /<status>\s*(\w+)\s*<\/status>/i.exec(near)?.[1]?.toLowerCase()
  if (status === undefined || status === 'running' || status === 'pending') {
    return null
  }
  if (status === 'killed' || status === 'stopped' || status === 'cancelled') {
    return 'stopped'
  }
  if (status === 'failed' || status === 'error') {
    return 'failed'
  }
  const code = /exit code[:\s]+(-?\d+)/i.exec(near)?.[1]

  return code !== undefined && code !== '0' ? 'failed' : 'done'
}
