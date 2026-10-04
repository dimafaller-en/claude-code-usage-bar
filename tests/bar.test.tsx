import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { costOf, count, dollars, modelName, timeLeft } from '../hooks/draw.ts'
import { progressOf } from '../hooks/tasks.ts'

const BAND = {
  plugin: 'usage-bar',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 140, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

const OPUS = { input_tokens: 600, output_tokens: 3000, cache_read_input_tokens: 954_200, cache_creation_input_tokens: 15_000, model: 'claude-opus-5-5' }
const SONNET = { ...OPUS, model: 'claude-sonnet-5-5' }

// What the engine beneath the plugins does: echo the measurement, draw nothing in the band,
// answer a model request on Opus for the main loop and on Sonnet for a subagent.
function engine(on: On, clock: { advance: (ms: number) => Promise<void> }) {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box' as const, children: [] }))
  on('session.id', () => ({ value: 'sess-1' }) as never)
  on('turn.step', async function* (_, e) {
    const usage = e.agentId === undefined ? OPUS : SONNET
    await clock.advance(10)
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
}

type TestEngine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

async function step($: TestEngine, agentId?: string) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })
  let item = await stream.next()
  while (item.done !== true) {
    item = await stream.next()
  }

  return item.value
}

// Every picture the band drew, pills and hover cards alike, as one string to search.
async function pictures($: TestEngine): Promise<{ count: number; source: string }> {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svgs = await ui.findAll({ type: 'Svg' })
  await ui.unmount()

  return { count: svgs.length, source: svgs.map(svg => String((svg as { props?: { source?: unknown } }).props?.source ?? '')).join('\n') }
}

const cents = (usd: number) => Math.round(usd * 100)

test('numbers, money, model names and the time left read as the pills show them', () => {
  expect(timeLeft(160 * 60_000)).toBe('2h 40m')
  expect(timeLeft((31 * 60 + 2) * 60_000)).toBe('1d 7h')
  expect(timeLeft(45 * 60_000)).toBe('45m')
  expect(count(850)).toBe('850')
  expect(count(15_600)).toBe('15.6k')
  expect(count(954_200)).toBe('954k')
  expect(count(99_960)).toBe('100k')
  expect(count(999_600)).toBe('1.00M')
  expect(count(1_250_000)).toBe('1.25M')
  expect(dollars(4.321)).toBe('$4.32')
  expect(dollars(123.4)).toBe('$123')
  expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelName('claude-sonnet-4-20250514')).toBe('Sonnet 4')
})

test('the cost is priced per model: input, cache write at 1.25x, cache read, output', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }
  expect(cents(costOf({ ...usage, model: 'claude-opus-5-5' }))).toBe(cents(4 + 5 + 0.2 + 20))
  expect(cents(costOf({ ...usage, model: 'claude-sonnet-5-5' }))).toBe(cents(2 + 2.5 + 0.2 + 10))
  expect(cents(costOf({ ...usage, model: 'claude-fable-5-1' }))).toBe(cents(10 + 12.5 + 0.25 + 50))
  expect(cents(costOf({ ...usage, model: 'claude-haiku-4-5' }))).toBe(cents(1 + 1.25 + 0.1 + 5))
})

test('both windows, the session tokens of every loop and the cost, with where the money went on hover', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  engine(on, clock)

  expect((await pictures($)).count).toBe(0)

  const at = clock.now()
  await $.session.measure({
    context: { window: 1_000_000 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 58, resetsAt: new Date(at + 31 * 3_600_000).toISOString() },
      { kind: 'five_hour', percentUsed: 20, resetsAt: new Date(at + 160 * 60_000).toISOString() },
    ],
    changed: ['rateLimits'],
  })
  await step($)
  await step($, 'agent-7')

  // Two groups of pills, and the limits' and the cost's cards, each with its spacer; the tokens are in the cost's card.
  const { count: drawn, source } = await pictures($)
  expect(drawn).toBe(6)
  expect(source).toContain('>Лимиты подписки<')
  expect(source).toContain('>Окно 5 часов<')
  expect(source).toContain('>при текущем темпе хватит до сброса<')
  // 5h before 7d whatever order the windows came in.
  expect(source.indexOf('>5h<')).toBeLessThan(source.indexOf('>7d<'))
  for (const text of ['>20%<', '>2h 40m<', '>58%<', '>1d 7h<', '>токены: ↑31.2k ↓6.0k кэш 1.91M<']) {
    expect(source).toContain(text)
  }
  const total = costOf(OPUS) + costOf(SONNET)
  expect(source).toContain(`>${dollars(total)}<`)
  expect(source).toContain(`>Opus 5.5<`)
  expect(source).toContain(`>${dollars(costOf(OPUS))}<`)
  expect(source).toContain(`>Sonnet 5.5<`)
  expect(source).toContain('>основной диалог<')
  expect(source).toContain('>субагенты · 1<')
  expect(source).toContain('>ответы · 6.0k<')
  expect(source).toContain(`>Расходы ≈${dollars(total)}<`)

  const text = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await text.find({ type: 'Text', text: /^5h 20% · сброс через 2h 40m │ 7d 58% · сброс через 1d 7h │ ≈\$/ })).toBeDefined()
  await text.unmount()
})

test('the app cost, where the host keeps one, is the pill and the card title; the breakdown is the mod estimate', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  engine(on, clock)

  await step($)
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 7.5 }, changed: ['cost'] })

  const { source } = await pictures($)
  expect(source).toContain('>$7.50<')
  expect(source).toContain('>Расходы $7.50<')
  expect(source).toContain(`>разбивка: оценка мода ≈${dollars(costOf(OPUS))}, с его запуска<`)
})

test('the context pill shows the fill and the tokens left before compaction, and turns to the warning colour near it', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  engine(on, clock)
  const live = { tokens: 120_000 }
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: live.tokens, window: 200_000, breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: 160_000 } }, rateLimits: [] },
  }) as never)

  await $.session.start({ source: 'startup', cwd: 'C:/x', surface: 'desktop', isInteractive: true } as never)
  let shown = await pictures($)
  expect(shown.source).toContain('>60%<')
  expect(shown.source).toContain('>до сжатия 40.0k<')
  expect(shown.source).toContain('>Контекст<')
  expect(shown.source).toContain('>порог автосжатия<')
  expect(shown.source).toContain('>160k<')
  expect(shown.source).not.toContain('class="alert"')

  live.tokens = 150_000
  await $.session.measure({ context: { tokens: 150_000, window: 200_000, percent: 75 }, rateLimits: [], changed: ['context'] })
  shown = await pictures($)
  expect(shown.source).toContain('>до сжатия 10.0k<')
  expect(shown.source).toContain('class="alert"')

  const text = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await text.find({ type: 'Text', text: /контекст 75% · до сжатия 10\.0k/ })).toBeDefined()
  await text.unmount()
})

test('a window that runs out before its reset says when, and each window warns once at 80% and once at 95%', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  engine(on, clock)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
  })
  const start = clock.now()
  const resetsAt = new Date(start + 4 * 3_600_000).toISOString()
  const reading = (percentUsed: number) => $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt }], changed: ['rateLimits'] })

  // An hour into the window at 40%: the window's own pace ends it in an hour and a half, before the reset in four.
  await reading(40)
  let shown = await pictures($)
  expect(shown.source).toContain('>хватит на ~1h 30m<')
  expect(shown.source).toContain('>при текущем темпе хватит на ~1h 30m<')
  expect(toasts).toEqual([])

  // Half an hour later at 85%: the last half hour's pace, 45 points, leaves ten minutes; one warning at 80%.
  await clock.advance(30 * 60_000)
  await reading(85)
  shown = await pictures($)
  expect(shown.source).toContain('>хватит на ~10m<')
  expect(toasts).toEqual(['Лимит 5h: 85%, сброс через 3h 30m'])

  await reading(86)
  expect(toasts).toHaveLength(1)
  await reading(96)
  expect(toasts).toHaveLength(2)
  expect(toasts[1]).toBe('Лимит 5h: 96%, сброс через 3h 30m')
})

test('the tasks progress is read from counts, grouped counts, Russian, tqdm and percents', () => {
  expect(progressOf(['прогон 4500/9000'])).toEqual({ percent: 0.5, done: 4500, total: 9000 })
  expect(progressOf(['[4,500/9,000] ok'])).toEqual({ percent: 0.5, done: 4500, total: 9000 })
  expect(progressOf(['Сделано 4 500 из 9 000'])).toEqual({ percent: 0.5, done: 4500, total: 9000 })
  expect(progressOf([' 50%|█████     | 4500/9000 [00:45<00:45, 100it/s]'])).toEqual({ percent: 0.5, done: 4500, total: 9000 })
  expect(progressOf(['Building… 45%'])).toEqual({ percent: 0.45, done: null, total: null })
  expect(progressOf(['report for 10/03'])).toBeNull()
})

test('a background run is a pill with its count, and its hover card lists the run and its progress', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  engine(on, clock)
  const output = { text: '' }
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }) as never)
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: output.text.length, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: output.text }))
  on('classic.Stop', () => ({}) as never)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b42' },
    text: 'Command running in background with ID: b42. Output is being written to: C:/tmp/b42.output',
  }))

  await $.session.start({ source: 'startup', cwd: 'C:/x', surface: 'desktop', isInteractive: true } as never)
  await $.tool.call({ tool: 'Bash', command: 'cd /x && python sweep.py 2>&1', run_in_background: true })
  output.text = 'start\nпрогон 4500/9000\n'
  await clock.advance(2000)

  let shown = await pictures($)
  // The tasks pill, and its card with its spacer.
  expect(shown.count).toBe(3)
  expect(shown.source).toContain('>1<')
  expect(shown.source).toContain('>Идут · 1<')
  expect(shown.source).toContain('>python sweep.py<')
  expect(shown.source).toContain('>50%<')
  expect(shown.source).toContain('>4\u00a0500/9\u00a0000 · 0:02 · ~2 с<')

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  shown = await pictures($)
  expect(shown.source).toContain('>Завершены · 1<')
  expect(shown.source).toContain('>готово · 0:02<')
})

test('the card is hidden in the keyed box of its pill until the pointer is on it', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  engine(on, clock)
  await step($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // The test sees props, not the hover styles: two hidden parts, the spacer and the card laid over it,
  // both inside the cost pill's keyed box, the hover scope the desktop honours.
  const keyed = await ui.find({ type: 'Box', key: 'usage-bar-cost' })
  expect(keyed).toBeDefined()
  const hidden = (await ui.findAll({ type: 'Box' })).filter(box => box.props.display === 'none')
  expect(hidden).toHaveLength(2)
  expect(hidden.map(box => box.props.position ?? 'static')).toEqual(['static', 'absolute'])
  expect(JSON.stringify(hidden[1]?.children)).toContain('Расходы')
  expect(JSON.stringify(keyed?.children)).toContain('Расходы')
  await ui.unmount()
})
