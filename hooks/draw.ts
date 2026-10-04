// What the band shows, with no engine in reach: prices, the pills, the hover cards, all as SVG markup.
import type { BgTask, ContextFill, LimitTrail, SpendBreakdown, TaskStatus, UsageLimit, UsageTotals } from '../types'
import { clock, grouped, human } from './tasks.ts'

export const ZERO: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 }
export const NO_SPEND: SpendBreakdown = { byModel: {}, main: 0, subagents: 0, subagentIds: [], input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }

const HOUR = 3_600_000
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }
const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

// --- prices ------------------------------------------------------------------

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string }

// US dollars per million tokens, from Anthropic's API price list (2026-09-25): input, output, cache read.
// A cache write is billed at 1.25x input (the 5-minute TTL); the usage does not say which TTL.
type Price = { input: number; output: number; cacheRead: number }
const PRICES: readonly (readonly [string, Price])[] = [
  ['fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['fable-5', { input: 10, output: 50, cacheRead: 1 }],
  ['mythos-5', { input: 10, output: 50, cacheRead: 1 }],
  ['opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['opus-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['opus-4', { input: 5, output: 25, cacheRead: 0.5 }],
  ['sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['sonnet-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['sonnet-4', { input: 3, output: 15, cacheRead: 0.3 }],
  ['haiku-4', { input: 1, output: 5, cacheRead: 0.1 }],
]
const FALLBACK_PRICE: Price = { input: 4, output: 20, cacheRead: 0.2 }

// The first entry the model id contains: `claude-opus-5-5[1m]` is Opus 5.5.
export function priceOf(model: string): Price {
  const id = model.toLowerCase()

  return PRICES.find(([key]) => id.includes(key))?.[1] ?? FALLBACK_PRICE
}

type Costs = { input: number; cacheWrite: number; cacheRead: number; output: number }

// One request's dollars by kind of token.
export function costsOf(usage: Usage): Costs {
  const price = priceOf(usage.model)

  return {
    input: (usage.input_tokens * price.input) / 1_000_000,
    cacheWrite: (usage.cache_creation_input_tokens * price.input * 1.25) / 1_000_000,
    cacheRead: (usage.cache_read_input_tokens * price.cacheRead) / 1_000_000,
    output: (usage.output_tokens * price.output) / 1_000_000,
  }
}

export function costOf(usage: Usage): number {
  const c = costsOf(usage)

  return c.input + c.cacheWrite + c.cacheRead + c.output
}

// `claude-opus-5-5[1m]` as `Opus 5.5`, `claude-haiku-4-5-20251001` as `Haiku 4.5`.
export function modelName(id: string): string {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  if (m === null) {
    return id
  }
  const family = (m[1] ?? '').toLowerCase()

  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2]}${m[3] === undefined ? '' : `.${m[3]}`}`
}

export function addTotals(t: UsageTotals, usage: Usage): UsageTotals {
  return {
    input: t.input + usage.input_tokens,
    output: t.output + usage.output_tokens,
    cacheRead: t.cacheRead + usage.cache_read_input_tokens,
    cacheWrite: t.cacheWrite + usage.cache_creation_input_tokens,
    usd: t.usd + costOf(usage),
  }
}

// The breakdown with one more request in it: its model, its loop, its kinds of token.
export function addSpend(s: SpendBreakdown, usage: Usage, agentId: string | undefined): SpendBreakdown {
  const c = costsOf(usage)
  const total = c.input + c.cacheWrite + c.cacheRead + c.output
  const name = modelName(usage.model)
  const isNewAgent = agentId !== undefined && !s.subagentIds.includes(agentId)

  return {
    byModel: { ...s.byModel, [name]: (s.byModel[name] ?? 0) + total },
    main: s.main + (agentId === undefined ? total : 0),
    subagents: s.subagents + (agentId === undefined ? 0 : total),
    subagentIds: isNewAgent ? [...s.subagentIds, agentId].slice(-200) : s.subagentIds,
    input: s.input + c.input,
    cacheWrite: s.cacheWrite + c.cacheWrite,
    cacheRead: s.cacheRead + c.cacheRead,
    output: s.output + c.output,
  }
}

// --- text --------------------------------------------------------------------

// `2h 40m`, `1d 7h`, `45m`: the time until the window resets.
export function timeLeft(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) {
    return `${days}d ${hours}h`
  }

  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`
}

// `850`, `15.6k`, `814k`, `1.25M`: a tenth of a thousand only while it still matters.
export function count(n: number): string {
  if (n < 1000) {
    return String(Math.round(n))
  }
  if (n < 99_950) {
    return `${(n / 1000).toFixed(1)}k`
  }

  return n < 999_500 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(2)}M`
}

export function dollars(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// --- pills -------------------------------------------------------------------

// Drawn in a monospace face, so a run of text is as wide as its characters.
const FONT = 12
const CHAR = 7.2
export const HEIGHT = 24
const PAD = 9
const GAP = 6
const ICON = 14
const BAR = 40
const PILL_GAP = 6

// Lucide icons (ISC), on their 24-unit grid.
const ICONS = {
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  coin: '<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
}

export type Tone = '5h' | '7d' | 'ctx' | 'tasks' | 'in' | 'out' | 'cache' | 'cost'

// `isAlert` draws a part in the warning colour, whatever its pill's tone.
type Part =
  | { kind: 'icon'; icon: keyof typeof ICONS; isAlert?: boolean }
  | { kind: 'text'; text: string; isBold?: boolean; isAlert?: boolean }
  | { kind: 'bar'; share: number; mark: number | null; isAlert?: boolean }
  | { kind: 'divider' }

export type Pill = { tone: Tone; parts: Part[] }

function widthOf(part: Part): number {
  switch (part.kind) {
    case 'icon':
      return ICON
    case 'text':
      return part.text.length * CHAR
    case 'bar':
      return BAR
    case 'divider':
      return 1
  }
}

function drawPart(part: Part, tone: Tone, x: number): string {
  const mid = HEIGHT / 2
  switch (part.kind) {
    case 'icon':
      return `<g class="${part.isAlert ? 'icon-alert' : `icon-${tone}`}" transform="translate(${x} ${mid - ICON / 2}) scale(${ICON / 24})" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[part.icon]}</g>`
    case 'text':
      return `<text class="${part.isAlert ? 'alert' : part.isBold ? 'strong' : `ink-${tone}`}" x="${x}" y="${mid}" dominant-baseline="central"${part.isBold ? ' font-weight="700"' : ''}>${escapeXml(part.text)}</text>`
    case 'bar': {
      const fill = Math.round(Math.max(0, Math.min(1, part.share)) * BAR)
      const track = `<rect class="track" x="${x}" y="${mid - 2.5}" width="${BAR}" height="5" rx="2.5"/>`
      const done = fill > 0 ? `<rect class="${part.isAlert ? 'alert' : 'fill'}" x="${x}" y="${mid - 2.5}" width="${Math.max(fill, 5)}" height="5" rx="2.5"/>` : ''
      const markAt = part.mark === null ? 0 : x + Math.round(part.mark * BAR)
      const mark = part.mark === null ? '' : `<line class="mark" x1="${markAt}" x2="${markAt}" y1="${mid - 6}" y2="${mid + 6}" stroke-width="2" stroke-linecap="round"/>`
      return track + done + mark
    }
    case 'divider':
      return `<line class="divider" x1="${x + 0.5}" x2="${x + 0.5}" y1="${mid - 6}" y2="${mid + 6}" stroke-width="1"/>`
  }
}

// One rounded pill of parts, laid out left to right; its markup and how wide it came out.
function drawPill({ tone, parts }: Pill, x: number): { markup: string; width: number } {
  let at = x + PAD
  const drawn: string[] = []
  parts.forEach((part, i) => {
    drawn.push(drawPart(part, tone, at))
    at += widthOf(part) + (i < parts.length - 1 ? GAP : 0)
  })
  const width = at + PAD - x

  return { markup: `<rect class="bg-${tone}" x="${x}" y="0" width="${width}" height="${HEIGHT}" rx="${HEIGHT / 2}"/>${drawn.join('')}`, width }
}

// Both themes by `prefers-color-scheme`, which a plugin can only hope follows the app's theme. A guess
// that misses still reads: a pill draws its own background, and a card paints its own ground in the
// frame's color, so either is dark on light or light on dark whatever is around it.
// Icon classes set strokes only: a fill there would override `fill="none"`.
const STYLE = `
text{font-family:ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace;font-size:${FONT}px}
.strong{fill:#1f2a26}.track{fill:#000;fill-opacity:.12}.fill{fill:#9dbf86}.mark{stroke:#2b2f2d}.divider{stroke:#000;stroke-opacity:.15}
.bg-5h{fill:#dce9e2}.ink-5h{fill:#4a5a54}.icon-5h{stroke:#5b8a76}.bar-5h{fill:#9dbf86}
.bg-7d{fill:#e4e0f5}.ink-7d{fill:#4d4668}.icon-7d{stroke:#7b5cd6}.bar-7d{fill:#a995e4}
.bg-ctx{fill:#e1ecef}.ink-ctx{fill:#28414a}.icon-ctx{stroke:#3f7f93}.bar-ctx{fill:#8fbccb}
.bg-in{fill:#f4ddd7}.ink-in{fill:#3d2b27}.icon-in{stroke:#c4553f}.bar-in{fill:#e09a8a}
.bg-out{fill:#dcebdf}.ink-out{fill:#26392b}.icon-out{stroke:#4c9a5c}.bar-out{fill:#8cc497}
.bg-cache{fill:#dfe2f6}.ink-cache{fill:#2b3060}.icon-cache{stroke:#5866cf}.bar-cache{fill:#9aa3e6}
.bg-cost{fill:#f0e6cd}.ink-cost{fill:#3b311a}.icon-cost{stroke:#b38a2d}.bar-cost{fill:#d9b45c}
.bg-tasks{fill:#dbeaf3}.ink-tasks{fill:#22394a}.icon-tasks{stroke:#3b82b8}.bar-tasks{fill:#7fb2d8}
.head{fill:#8a8f8c;font-size:11px}.label{fill:#2a2d2b}.value{fill:#4a4f4c}
.alert{fill:#c2531c}.icon-alert{stroke:#c2531c}
.st-running{fill:#3b82b8}.st-done{fill:#2b9a62}.st-failed{fill:#e0484d}.st-stopped{fill:#8b8d98}
.ground{fill:#fff}
@media (prefers-color-scheme:dark){
.strong{fill:#ecebe8}.track{fill:#fff;fill-opacity:.14}.mark{stroke:#e8e6e2}.divider{stroke:#fff;stroke-opacity:.16}
.bg-5h{fill:#27362f}.ink-5h{fill:#b5c7be}.icon-5h{stroke:#80b49d}
.bg-7d{fill:#302a48}.ink-7d{fill:#c8c0e8}.icon-7d{stroke:#a58ef0}
.bg-ctx{fill:#253741}.ink-ctx{fill:#b8d2db}.icon-ctx{stroke:#70b1c5}
.bg-in{fill:#412a25}.ink-in{fill:#e8c5bb}.icon-in{stroke:#e27b64}
.bg-out{fill:#25392c}.ink-out{fill:#bedbc4}.icon-out{stroke:#70c084}
.bg-cache{fill:#2a2f4e}.ink-cache{fill:#c3c8f0}.icon-cache{stroke:#8b97ec}
.bg-cost{fill:#3c331f}.ink-cost{fill:#e6d6ad}.icon-cost{stroke:#d7ab4a}
.bg-tasks{fill:#24394a}.ink-tasks{fill:#b8d4e8}.icon-tasks{stroke:#6ba9d8}
.ground{fill:#20201f}.head{fill:#8f8d89}.label{fill:#d4d2ce}.value{fill:#b3b1ad}
.alert{fill:#e8834f}.icon-alert{stroke:#e8834f}.st-stopped{fill:#9a9894}}`

function svg(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${STYLE}</style>${body}</svg>`
}

// A run of pills as one picture at its natural size: a picture left unsized is stretched to the band.
export function groupSvg(pills: readonly Pill[]): { source: string; width: number; height: number } {
  let x = 0
  const drawn: string[] = []
  pills.forEach((p, i) => {
    const { markup, width } = drawPill(p, x)
    drawn.push(markup)
    x += width + (i < pills.length - 1 ? PILL_GAP : 0)
  })

  return { source: svg(x, HEIGHT, drawn.join('')), width: x, height: HEIGHT }
}

// Nothing to see, one pixel wide and as tall as asked: it makes room in the band for a card laid over it.
export function spacerSvg(height: number): { source: string; width: number; height: number } {
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="${height}" viewBox="0 0 1 ${height}"></svg>`, width: 1, height }
}

// --- hover cards -------------------------------------------------------------

// A card in the band's own style: a title, section heads, and rows of a label, a share bar and a value;
// a row with `detail` has a second line, its bar and those words. The desktop frames the card itself
// (rounded, shadowed, white or #20201f by the app's theme) and narrows a wide one by scaling it down, so a card draws no frame and
// stays within CARD_WIDTH.
export type CardRow =
  | { kind: 'title'; text: string }
  | { kind: 'head'; text: string }
  | { kind: 'item'; label: string; value: string; share: number | null; tone: Tone; status?: TaskStatus; detail?: string }
  | { kind: 'note'; text: string; isAlert?: boolean }

export type Card = { rows: CardRow[] }

const CARD_WIDTH = 320
const CARD_PAD = 4
const ROW = 20
const DETAIL = 16
const INLINE_BAR = 44
const DETAIL_BAR = 96
const SMALL_CHAR = 6.6
const GLYPH: Record<TaskStatus, string> = { running: '◐', done: '✓', failed: '✗', stopped: '■' }

function rowHeight(row: CardRow, i: number): number {
  if (row.kind === 'head' && i > 0) {
    return ROW + 6
  }

  return row.kind === 'item' && row.detail !== undefined ? ROW + DETAIL : ROW
}

function textAt(cls: string, text: string, x: number, mid: number, attrs = ''): string {
  return `<text class="${cls}" x="${x}" y="${mid}" dominant-baseline="central"${attrs}>${escapeXml(text)}</text>`
}

export function cardSvg({ rows }: Card): { source: string; width: number; height: number } {
  const items = rows.filter((r): r is Extract<CardRow, { kind: 'item' }> => r.kind === 'item')
  const glyphW = items.some(r => r.status !== undefined) ? 16 : 0
  const hasInlineBar = items.some(r => r.share !== null && r.detail === undefined)
  const valueW = Math.max(0, ...items.map(r => r.value.length)) * CHAR
  const inner = CARD_WIDTH - CARD_PAD * 2
  // The label gets what the glyph, the bar and the value leave of the card's width.
  const labelRoom = Math.max(10, Math.floor((inner - glyphW - 12 - (hasInlineBar ? INLINE_BAR + 10 : 0) - valueW) / CHAR))
  const labelChars = Math.min(labelRoom, Math.max(0, ...items.map(r => r.label.length)))
  const itemsW = glyphW + labelChars * CHAR + 12 + (hasInlineBar ? INLINE_BAR + 10 : 0) + valueW
  // A detail line is as wide as its bar and its words, under the label.
  const detailW = Math.max(0, ...items.map(r => (r.detail === undefined ? 0 : glyphW + (r.share !== null ? DETAIL_BAR + 8 : 0) + r.detail.length * SMALL_CHAR)))
  const textW = Math.max(detailW, ...rows.map(r => (r.kind === 'title' ? r.text.length * CHAR : r.kind === 'item' ? 0 : r.text.length * SMALL_CHAR)))
  const width = Math.ceil(Math.min(CARD_WIDTH, CARD_PAD * 2 + Math.max(itemsW, textW)))
  const right = width - CARD_PAD
  const height = Math.ceil(CARD_PAD * 2 + rows.reduce((sum, r, i) => sum + rowHeight(r, i), 0) - 2)
  const fits = (text: string, room: number, char: number) => cut(text, Math.max(4, Math.floor(room / char)))

  let y = CARD_PAD
  const drawn: string[] = []
  rows.forEach((row, i) => {
    const mid = y + rowHeight(row, i) - (row.kind === 'item' && row.detail !== undefined ? DETAIL : 0) - ROW / 2 - 1
    if (row.kind === 'title') {
      drawn.push(textAt('strong', fits(row.text, right - CARD_PAD, CHAR), CARD_PAD, mid, ' font-weight="700"'))
    } else if (row.kind === 'head' || row.kind === 'note') {
      drawn.push(textAt(row.kind === 'note' && row.isAlert === true ? 'head alert' : 'head', fits(row.text, right - CARD_PAD, SMALL_CHAR), CARD_PAD, mid))
    } else {
      if (row.status !== undefined) {
        drawn.push(textAt(`st-${row.status}`, GLYPH[row.status], CARD_PAD, mid))
      }
      const labelX = CARD_PAD + glyphW
      drawn.push(textAt('label', cut(row.label, labelChars), labelX, mid))
      if (row.share !== null && row.detail === undefined) {
        const barX = right - valueW - 10 - INLINE_BAR
        drawn.push(bar(barX, mid, INLINE_BAR, row.share, row.tone))
      }
      drawn.push(textAt('value', row.value, right, mid, ' text-anchor="end"'))
      if (row.detail !== undefined) {
        const lineMid = mid + DETAIL
        let x = labelX
        if (row.share !== null) {
          drawn.push(bar(x, lineMid, DETAIL_BAR, row.share, row.tone))
          x += DETAIL_BAR + 8
        }
        drawn.push(textAt('head', fits(row.detail, right - x, SMALL_CHAR), x, lineMid))
      }
    }
    y += rowHeight(row, i)
  })

  return { source: svg(width, height, `<rect class="ground" width="${width}" height="${height}"/>${drawn.join('')}`), width, height }
}

function bar(x: number, mid: number, width: number, share: number, tone: Tone): string {
  const fill = Math.round(Math.max(0, Math.min(1, share)) * width)
  const track = `<rect class="track" x="${x}" y="${mid - 2.5}" width="${width}" height="5" rx="2.5"/>`

  return fill > 0 ? `${track}<rect class="bar-${tone}" x="${x}" y="${mid - 2.5}" width="${Math.max(fill, 5)}" height="5" rx="2.5"/>` : track
}

// The hover over the tasks pill: the running first, with their progress on a second line; then the finished, newest first.
export function tasksCard(list: readonly BgTask[], at: number): Card {
  const running = list.filter(t => t.status === 'running')
  const finished = list.filter(t => t.status !== 'running').reverse()
  const rows: CardRow[] = [{ kind: 'title', text: 'Фоновые задачи' }]
  if (running.length > 0) {
    rows.push({ kind: 'head', text: `Идут · ${running.length}` })
    for (const t of running) {
      const elapsed = at - t.startedAt
      if (t.percent === null) {
        rows.push({ kind: 'item', label: t.title, value: clock(elapsed), share: null, tone: 'tasks', status: 'running' })
        continue
      }
      const detail: string[] = []
      if (t.done !== null && t.total !== null) {
        detail.push(`${grouped(t.done)}/${grouped(t.total)}`)
      }
      detail.push(clock(elapsed))
      if (t.percent >= 0.02 && t.percent < 1) {
        detail.push(`~${human((elapsed * (1 - t.percent)) / t.percent)}`)
      }
      rows.push({ kind: 'item', label: t.title, value: `${Math.floor(t.percent * 100)}%`, share: t.percent, tone: 'tasks', status: 'running', detail: detail.join(' · ') })
    }
  }
  if (finished.length > 0) {
    const verb: Record<Exclude<TaskStatus, 'running'>, string> = { done: 'готово', failed: 'ошибка', stopped: 'стоп' }
    rows.push({ kind: 'head', text: `Завершены · ${finished.length}` })
    for (const t of finished) {
      if (t.status === 'running') {
        continue
      }
      rows.push({ kind: 'item', label: t.title, value: `${verb[t.status]} · ${clock((t.endedAt ?? at) - t.startedAt)}`, share: null, tone: 'tasks', status: t.status })
    }
  }

  return { rows }
}

// The hover over the cost: by model, by who spent, by kind of token, largest first. The pill shows the app's own
// figure where it gives one, for the whole session; the breakdown is the mod's estimate since it loaded.
export function spendCard(s: SpendBreakdown, t: UsageTotals, engine: number | null): Card {
  const total = Math.max(t.usd, 1e-9)
  const items = (pairs: readonly (readonly [string, number, Tone])[]): CardRow[] =>
    [...pairs]
      .filter(([, usd]) => usd >= 0.005)
      .sort((a, b) => b[1] - a[1])
      .map(([label, usd, tone]) => ({ kind: 'item', label, value: dollars(usd), share: usd / total, tone }))
  const rows: CardRow[] = [
    { kind: 'title', text: engine === null ? `Расходы ≈${dollars(t.usd)}` : `Расходы ${dollars(engine)}` },
    { kind: 'note', text: engine === null ? 'по ценам API' : `разбивка: оценка мода ≈${dollars(t.usd)}, с его запуска` },
    { kind: 'note', text: `токены: ↑${count(t.input + t.cacheWrite)} ↓${count(t.output)} кэш ${count(t.cacheRead)}` },
    { kind: 'head', text: 'По моделям' },
    ...items(Object.entries(s.byModel).map(([name, usd]) => [name, usd, 'cost'] as const)),
    { kind: 'head', text: 'Кто тратил' },
    ...items([
      ['основной диалог', s.main, 'cost'],
      [`субагенты · ${s.subagentIds.length}`, s.subagents, 'cost'],
    ]),
    { kind: 'head', text: 'На что' },
    ...items([
      [`ответы · ${count(t.output)}`, s.output, 'out'],
      [`запись в кэш · ${count(t.cacheWrite)}`, s.cacheWrite, 'in'],
      [`чтение кэша · ${count(t.cacheRead)}`, s.cacheRead, 'cache'],
      [`новый ввод · ${count(t.input)}`, s.input, 'in'],
    ]),
  ]

  return { rows }
}

// --- groups ------------------------------------------------------------------

function resetOf(limit: UsageLimit): number {
  return limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
}

// --- pace --------------------------------------------------------------------

const MINUTE = 60_000
// A reading whose reset time moved this far belongs to a new window.
const NEW_WINDOW_MS = 10 * MINUTE
// A pace needs readings at least this far apart.
const MIN_SPAN_MS = 15 * MINUTE
const RECENT_MS = HOUR
const MAX_POINTS = 120

// The trails with this reading added. A window that reset starts a fresh trail; an unchanged figure adds nothing.
export function addReading(trails: Record<string, LimitTrail>, limit: UsageLimit, at: number): Record<string, LimitTrail> {
  const resetsAt = resetOf(limit)
  if (Number.isNaN(resetsAt)) {
    return trails
  }
  const old = trails[limit.kind]
  const isSame = old !== undefined && Math.abs(old.resetsAt - resetsAt) < NEW_WINDOW_MS
  const points = isSame ? old.points : []
  if (isSame && points[points.length - 1]?.percent === limit.percentUsed) {
    return trails
  }

  return { ...trails, [limit.kind]: { resetsAt, points: [...points, { at, percent: limit.percentUsed }].slice(-MAX_POINTS) } }
}

// Percent per millisecond over the last hour of readings: from the last one an hour old or older (else the first) to now.
// Zero when the window has not moved for a long enough span; null when the readings are too close together to say.
function recentRate(trail: LimitTrail | undefined, percent: number, at: number): number | null {
  const points = trail?.points ?? []
  const base = points.filter(p => p.at <= at - RECENT_MS).pop() ?? points[0]
  if (base === undefined || at - base.at < MIN_SPAN_MS) {
    return null
  }

  return Math.max(0, percent - base.percent) / (at - base.at)
}

// Percent per millisecond since the window began.
function averageRate(limit: UsageLimit, resetsAt: number, at: number): number | null {
  const window = WINDOW_MS[limit.kind]
  if (window === undefined) {
    return null
  }
  const elapsed = window - (resetsAt - at)

  return elapsed >= MIN_SPAN_MS ? limit.percentUsed / elapsed : null
}

// When the window runs out at its pace, or null when it lasts until it resets. The five hours go at the pace of the
// last hour; the week, worked in bursts with nights between, at its average since it began.
export function runsOutAt(limit: UsageLimit, trail: LimitTrail | undefined, at: number): number | null {
  const resetsAt = resetOf(limit)
  if (Number.isNaN(resetsAt) || resetsAt <= at) {
    return null
  }
  if (limit.percentUsed >= 100) {
    return at
  }
  const rate = (limit.kind === 'five_hour' ? recentRate(trail, limit.percentUsed, at) : null) ?? averageRate(limit, resetsAt, at)
  if (rate === null || rate <= 0) {
    return null
  }
  const out = at + (100 - limit.percentUsed) / rate

  return out < resetsAt ? out : null
}

// --- limits ------------------------------------------------------------------

const NAME: Record<string, string> = { five_hour: 'Окно 5 часов', seven_day: 'Неделя' }

export function limitPill(limit: UsageLimit, at: number, out: number | null = null): Pill {
  const tone: Tone = limit.kind === 'seven_day' ? '7d' : '5h'
  const window = WINDOW_MS[limit.kind]
  const resetsAt = resetOf(limit)
  const hasReset = !Number.isNaN(resetsAt)
  const mark = window !== undefined && hasReset ? Math.max(0, Math.min(1, 1 - (resetsAt - at) / window)) : null
  const parts: Part[] = [
    { kind: 'icon', icon: tone === '7d' ? 'calendar' : 'gauge' },
    { kind: 'text', text: LABEL[limit.kind] ?? limit.kind },
    { kind: 'bar', share: limit.percentUsed / 100, mark },
    { kind: 'text', text: `${Math.round(limit.percentUsed)}%`, isBold: true },
  ]
  // Runs out before the reset: when, in the warning colour, in the reset's place (the card keeps the reset).
  if (hasReset && out === null) {
    parts.push({ kind: 'divider' }, { kind: 'icon', icon: 'history' }, { kind: 'text', text: timeLeft(resetsAt - at) })
  }
  if (out !== null) {
    parts.push({ kind: 'divider' }, { kind: 'icon', icon: 'alert', isAlert: true }, { kind: 'text', text: `хватит на ~${timeLeft(out - at)}`, isAlert: true })
  }

  return { tone, parts }
}

// The hover over the limits: per window, how much is spent against how much of it has passed, the reset, and the forecast.
export function limitsCard(windows: readonly UsageLimit[], trails: Record<string, LimitTrail>, at: number): Card {
  const rows: CardRow[] = [{ kind: 'title', text: 'Лимиты подписки' }]
  for (const l of windows) {
    const tone: Tone = l.kind === 'seven_day' ? '7d' : '5h'
    const resetsAt = resetOf(l)
    const window = WINDOW_MS[l.kind]
    rows.push({ kind: 'head', text: NAME[l.kind] ?? l.kind })
    rows.push({ kind: 'item', label: 'израсходовано', value: `${Math.round(l.percentUsed)}%`, share: l.percentUsed / 100, tone })
    if (Number.isNaN(resetsAt)) {
      continue
    }
    if (window !== undefined) {
      const passed = Math.max(0, Math.min(1, 1 - (resetsAt - at) / window))
      rows.push({ kind: 'item', label: 'прошло времени', value: `${Math.round(passed * 100)}%`, share: passed, tone })
    }
    rows.push({ kind: 'item', label: 'сброс через', value: timeLeft(resetsAt - at), share: null, tone })
    const out = runsOutAt(l, trails[l.kind], at)
    rows.push(out === null ? { kind: 'note', text: 'при текущем темпе хватит до сброса' } : { kind: 'note', text: `при текущем темпе хватит на ~${timeLeft(out - at)}`, isAlert: true })
  }
  rows.push({ kind: 'note', text: 'темп: 5h — за последний час, 7d — средний' })

  return { rows }
}

// --- context -----------------------------------------------------------------

// Within this share of the compaction point the pill turns to the warning colour.
const NEAR_COMPACT = 0.2

function leftOf(fill: ContextFill): number | null {
  return fill.tokens === null || fill.threshold === null ? null : fill.threshold - fill.tokens
}

function isNearCompact(fill: ContextFill): boolean {
  const left = leftOf(fill)

  return left !== null && fill.threshold !== null && left <= fill.threshold * NEAR_COMPACT
}

// The window's fill, with the compaction point marked on the bar and the tokens left before it; null before the first response.
export function contextPill(fill: ContextFill): Pill | null {
  if (fill.tokens === null || fill.window <= 0) {
    return null
  }
  const left = leftOf(fill)
  const isNear = isNearCompact(fill)
  const mark = fill.threshold === null ? null : Math.max(0, Math.min(1, fill.threshold / fill.window))
  const parts: Part[] = [
    { kind: 'icon', icon: 'book', isAlert: isNear },
    { kind: 'bar', share: fill.tokens / fill.window, mark, isAlert: isNear },
    { kind: 'text', text: `${Math.round((fill.tokens / fill.window) * 100)}%`, isBold: true },
    { kind: 'divider' },
    left === null ? { kind: 'text', text: `${count(fill.tokens)}/${count(fill.window)}` } : { kind: 'text', text: left > 0 ? `до сжатия ${count(left)}` : 'сжатие вот-вот', isAlert: isNear },
  ]

  return { tone: 'ctx', parts }
}

export function contextWords(fill: ContextFill): string {
  const left = leftOf(fill)
  const percent = fill.tokens === null ? 0 : Math.round((fill.tokens / fill.window) * 100)

  return `контекст ${percent}%${left === null ? '' : left > 0 ? ` · до сжатия ${count(left)}` : ' · сжатие вот-вот'}`
}

export function contextCard(fill: ContextFill): Card {
  const tokens = fill.tokens ?? 0
  const rows: CardRow[] = [
    { kind: 'title', text: 'Контекст' },
    { kind: 'item', label: 'занято', value: count(tokens), share: tokens / fill.window, tone: 'ctx' },
    { kind: 'item', label: 'окно модели', value: count(fill.window), share: null, tone: 'ctx' },
  ]
  if (fill.threshold === null) {
    rows.push({ kind: 'note', text: 'автосжатие выключено или ещё не прочитано' })
  } else {
    rows.push(
      { kind: 'item', label: 'порог автосжатия', value: count(fill.threshold), share: fill.threshold / fill.window, tone: 'ctx' },
      { kind: 'item', label: 'осталось до сжатия', value: count(Math.max(0, fill.threshold - tokens)), share: null, tone: 'ctx' },
    )
  }
  rows.push({ kind: 'note', text: 'по данным последнего ответа модели' })

  return { rows }
}

export type BarData = {
  limits: readonly UsageLimit[]
  tasks: readonly BgTask[]
  totals: UsageTotals
  spend: SpendBreakdown
  engineUsd: number | null
  context: ContextFill | null
  trails: Record<string, LimitTrail>
  at: number
}

// The windows the bar knows, the five-hour one first whatever order they were reported in.
function windowsOf(reported: readonly UsageLimit[]): UsageLimit[] {
  return ['five_hour', 'seven_day'].flatMap(kind => reported.filter(l => l.kind === kind))
}

// A run of pills drawn as one picture, what a reader is told of it, and the card its hover shows.
export type Group = { id: 'limits' | 'context' | 'tasks' | 'tokens' | 'cost'; pills: Pill[]; words: string; card?: Card }

export function groupsOf({ limits: windows, tasks: work, totals: t, spend: s, engineUsd: engine, context, trails, at }: BarData): Group[] {
  const usd = engine ?? t.usd
  const known = windowsOf(windows)
  const groups: Group[] = []
  if (known.length > 0) {
    const outs = known.map(l => runsOutAt(l, trails[l.kind], at))
    const words = known.map((l, i) => {
      const resetsAt = resetOf(l)
      const out = outs[i] ?? null
      const reset = Number.isNaN(resetsAt) ? '' : ` · сброс через ${timeLeft(resetsAt - at)}`
      return `${LABEL[l.kind]} ${Math.round(l.percentUsed)}%${reset}${out === null ? '' : ` · хватит на ~${timeLeft(out - at)}`}`
    })
    groups.push({ id: 'limits', pills: known.map((l, i) => limitPill(l, at, outs[i] ?? null)), words: words.join(' │ '), card: limitsCard(known, trails, at) })
  }
  const contextShown = context === null ? null : contextPill(context)
  if (context !== null && contextShown !== null) {
    groups.push({ id: 'context', pills: [contextShown], words: contextWords(context), card: contextCard(context) })
  }
  if (work.length > 0) {
    const running = work.filter(task => task.status === 'running').length
    const finished = work.length - running
    const pill: Pill =
      running > 0
        ? { tone: 'tasks', parts: [{ kind: 'icon', icon: 'activity' }, { kind: 'text', text: String(running) }] }
        : { tone: 'tasks', parts: [{ kind: 'icon', icon: 'check' }, { kind: 'text', text: String(finished) }] }
    groups.push({ id: 'tasks', pills: [pill], words: running > 0 ? `в фоне ${running}` : `в фоне завершено ${finished}`, card: tasksCard(work, at) })
  }
  if (t.input + t.cacheWrite + t.output + t.cacheRead > 0) {
    // The tokens live in the cost's card: the band keeps one row for what is decided on at a glance.
    groups.push({
      id: 'cost',
      pills: [{ tone: 'cost', parts: [{ kind: 'icon', icon: 'coin' }, { kind: 'text', text: dollars(usd) }] }],
      words: `≈${dollars(usd)}`,
      card: spendCard(s, t, engine),
    })
  }

  return groups
}

// The same figures as one line of words: the terminal's line.
export function describe(data: BarData): string {
  return groupsOf(data)
    .map(g => g.words)
    .join(' │ ')
}
