// What the side panel shows, with no engine in reach: the band's figures and its hover cards, laid out as the
// app's own blocks are (a headline, a bar, a legend of rows) so the panel reads like Environment and Context.
import type { BgTask, TaskStatus } from '../types'
import { count, dollars, runsOutAt, timeLeft, windowsOf } from './draw.ts'
import type { BarData } from './draw.ts'
import { clock } from './tasks.ts'

// The app's own legend colours, the same on either theme.
export const COLORS = { blue: '#4a8fe7', orange: '#d97757', green: '#3fa67a', yellow: '#d6a23a', gray: '#8d8c86', alert: '#e07a3a' } as const
export type Hue = keyof typeof COLORS

export type Segment = { share: number; hue: Hue }

export type PanelRow =
  // A block's first line: the figure in bold at the left, the scale it is read against at the right.
  | { kind: 'headline'; text: string; aside?: string; isAlert?: boolean }
  | { kind: 'bar'; segments: Segment[]; mark: number | null }
  // A legend row: a coloured square or a status glyph, the label, a quiet value and a bold figure at the right.
  | { kind: 'item'; label: string; value?: string; figure?: string; hue?: Hue; status?: TaskStatus; isAlert?: boolean }
  | { kind: 'note'; text: string; aside?: string; isAlert?: boolean }
  | { kind: 'head'; text: string }
  | { kind: 'gap' }

export type PanelSection = { id: 'limits' | 'context' | 'tasks' | 'cost'; rows: PanelRow[] }

const HOUR = 3_600_000
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }
const NAME: Record<string, string> = { five_hour: '5 часов', seven_day: 'Неделя' }
export const GLYPH: Record<TaskStatus, string> = { running: '◐', done: '✓', failed: '✗', stopped: '■' }
export const STATUS_COLOR: Record<TaskStatus, string> = { running: '#4a8fe7', done: '#3fa67a', failed: '#e05555', stopped: '#8d8c86' }

const share = (n: number) => Math.max(0, Math.min(1, n))

function limitsSection({ limits, trails, at }: BarData): PanelSection | null {
  const known = windowsOf(limits)
  if (known.length === 0) {
    return null
  }
  const rows: PanelRow[] = []
  known.forEach((l, i) => {
    const resetsAt = l.resetsAt === undefined ? NaN : Date.parse(l.resetsAt)
    const window = WINDOW_MS[l.kind]
    const out = runsOutAt(l, trails[l.kind], at)
    const isShort = out !== null
    if (i > 0) {
      rows.push({ kind: 'gap' })
    }
    rows.push({ kind: 'headline', text: `${Math.round(l.percentUsed)}%`, aside: NAME[l.kind] ?? l.kind, isAlert: isShort })
    // The mark is how much of the window has passed: a fill ahead of it is going faster than the window.
    const mark = window !== undefined && !Number.isNaN(resetsAt) ? share(1 - (resetsAt - at) / window) : null
    rows.push({ kind: 'bar', segments: [{ share: share(l.percentUsed / 100), hue: isShort ? 'alert' : 'blue' }], mark })
    if (!Number.isNaN(resetsAt)) {
      rows.push({
        kind: 'note',
        text: `сброс через ${timeLeft(resetsAt - at)}`,
        aside: out === null ? 'хватит до сброса' : `хватит на ~${timeLeft(out - at)}`,
        isAlert: isShort,
      })
    }
  })

  return { id: 'limits', rows }
}

// The app shows the fill itself; the panel adds what it does not: how far the compaction point is.
function contextSection({ context }: BarData): PanelSection | null {
  if (context === null || context.tokens === null || context.threshold === null) {
    return null
  }
  const left = context.threshold - context.tokens
  const isNear = left <= context.threshold * 0.2

  return {
    id: 'context',
    rows: [{ kind: 'item', label: 'До автосжатия', figure: left > 0 ? count(left) : 'вот-вот', value: `порог ${count(context.threshold)}`, isAlert: isNear }],
  }
}

function costSection({ totals: t, spend: s, engineUsd }: BarData): PanelSection | null {
  if (t.input + t.cacheWrite + t.output + t.cacheRead === 0) {
    return null
  }
  const usd = engineUsd ?? t.usd
  const total = Math.max(t.usd, 1e-9)
  const kinds: { label: string; tokens: number; usd: number; hue: Hue }[] = [
    { label: 'Ответы', tokens: t.output, usd: s.output, hue: 'blue' },
    { label: 'Запись в кэш', tokens: t.cacheWrite, usd: s.cacheWrite, hue: 'orange' },
    { label: 'Чтение кэша', tokens: t.cacheRead, usd: s.cacheRead, hue: 'green' },
    { label: 'Новый ввод', tokens: t.input, usd: s.input, hue: 'yellow' },
  ]
  const rows: PanelRow[] = [
    { kind: 'headline', text: engineUsd === null ? `≈${dollars(usd)}` : dollars(usd), aside: 'расходы сессии' },
    { kind: 'bar', segments: kinds.map(k => ({ share: k.usd / total, hue: k.hue })), mark: null },
    ...kinds.map((k): PanelRow => ({ kind: 'item', label: k.label, value: count(k.tokens), figure: dollars(k.usd), hue: k.hue })),
  ]
  const models = Object.entries(s.byModel)
    .filter(([, v]) => v >= 0.005)
    .sort((a, b) => b[1] - a[1])
  if (models.length > 0) {
    rows.push({ kind: 'head', text: 'По моделям' }, ...models.map(([name, v]): PanelRow => ({ kind: 'item', label: name, figure: dollars(v) })))
  }
  if (s.subagents >= 0.005) {
    rows.push({ kind: 'item', label: `Субагенты · ${s.subagentIds.length}`, figure: dollars(s.subagents) })
  }

  return { id: 'cost', rows }
}

function taskRow(t: BgTask, at: number): PanelRow {
  if (t.status === 'running') {
    const elapsed = clock(at - t.startedAt)
    return t.percent === null
      ? { kind: 'item', label: t.title, figure: elapsed, status: 'running' }
      : { kind: 'item', label: t.title, value: elapsed, figure: `${Math.floor(t.percent * 100)}%`, status: 'running' }
  }
  const verb: Record<Exclude<TaskStatus, 'running'>, string> = { done: 'готово', failed: 'ошибка', stopped: 'стоп' }

  return { kind: 'item', label: t.title, value: verb[t.status], figure: clock((t.endedAt ?? at) - t.startedAt), status: t.status }
}

function tasksSection({ tasks, at }: BarData): PanelSection | null {
  if (tasks.length === 0) {
    return null
  }
  const running = tasks.filter(t => t.status === 'running')
  const finished = tasks.filter(t => t.status !== 'running').reverse()

  return {
    id: 'tasks',
    rows: [
      { kind: 'headline', text: running.length > 0 ? `${running.length} в работе` : 'всё завершено', aside: 'фоновые задачи' },
      ...[...running, ...finished].map(t => taskRow(t, at)),
    ],
  }
}

// The sections with something to show, in the band's order.
export function panelOf(data: BarData): PanelSection[] {
  return [limitsSection(data), contextSection(data), tasksSection(data), costSection(data)].filter((s): s is PanelSection => s !== null)
}

// A bar as wide as the panel: segments laid end to end with hairline gaps on a quiet track, and the time mark.
// Drawn on a wide grid squeezed to the panel's width, so only the track's ends are rounded (by a clip).
const W = 1000
const H = 6

export function barSvg(segments: readonly Segment[], mark: number | null): string {
  const drawn: string[] = []
  let x = 0
  for (const seg of segments) {
    const w = Math.round(share(seg.share) * W)
    if (w <= 0) {
      continue
    }
    drawn.push(`<rect x="${x}" y="0" width="${Math.max(w - 3, 3)}" height="${H}" fill="${COLORS[seg.hue]}"/>`)
    x += w
  }
  const markAt = mark === null ? null : Math.round(share(mark) * W)
  const markLine = markAt === null ? '' : `<rect class="mark" x="${Math.min(W - 8, Math.max(0, markAt - 4))}" y="0" width="8" height="${H}"/>`
  const style = `.track{fill:#1f1e1d;fill-opacity:.1}.mark{fill:#3d3d3a}@media (prefers-color-scheme:dark){.track{fill:#fff;fill-opacity:.12}.mark{fill:#e9e7e2}}`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><style>${style}</style>` +
    `<rect class="track" width="${W}" height="${H}"/>${drawn.join('')}${markLine}</svg>`
  )
}

export const BAR_HEIGHT = H
