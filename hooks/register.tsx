import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, Timer } from 'claude-code'

import type { BgTask, SpendBreakdown, TaskKind, TaskStatus, UsageLimit, UsageTotals } from '../types'
import { addReading, addSpend, addTotals, cardSvg, describe, groupSvg, groupsOf, NO_SPEND, spacerSvg, timeLeft, ZERO } from './draw.ts'
import type { BarData, Group } from './draw.ts'
import { commandTitle, cut, KEEP_FINISHED_MS, lines, notified, outputPathOf, progressOf } from './tasks.ts'

const limits = atom({ plugin: 'usage-bar', key: 'limits' } as const, [])
const now = atom({ plugin: 'usage-bar', key: 'now' } as const, 0)
const totals = atom({ plugin: 'usage-bar', key: 'totals' } as const, ZERO)
const spend = atom({ plugin: 'usage-bar', key: 'spend' } as const, NO_SPEND)
const engineUsd = atom({ plugin: 'usage-bar', key: 'engineUsd' } as const, null)
const tasks = atom({ plugin: 'usage-bar', key: 'tasks' } as const, [])
const context = atom({ plugin: 'usage-bar', key: 'context' } as const, null)
const trails = atom({ plugin: 'usage-bar', key: 'trails' } as const, {})

type Dollar = EngineInterface

let timer: Timer | null = null
let poller: Timer | null = null
let thresholdReadAt = 0

// Sessions whose sums are kept across restarts of the app.
const KEPT_SESSIONS = 30
const MAX_OUTPUT = 3 * 1024 * 1024

// --- state -------------------------------------------------------------------

async function tickNow($: Dollar) {
  const at = await $.clock.now()
  await update($, now, () => at)
}

async function remember($: Dollar, reported: readonly UsageLimit[]) {
  await update($, limits, () => reported.map(({ kind, percentUsed, resetsAt }) => (resetsAt === undefined ? { kind, percentUsed } : { kind, percentUsed, resetsAt })))
  const at = await $.clock.now()
  await update($, trails, all => reported.reduce((acc, l) => addReading(acc, l, at), all))
  await warn($, reported, at)
}

// --- limit warnings ----------------------------------------------------------

// Each window warns once at 80% and once at 95%, in whichever open session reads it first: the store is shared.
const LEVELS = [95, 80]
const KEPT_WARNINGS = 40
const NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

async function warn($: Dollar, reported: readonly UsageLimit[], at: number) {
  const value = await $.store.get('warned')
  const seen = Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string') : []
  const fresh: string[] = []
  for (const l of reported) {
    const level = LEVELS.find(n => l.percentUsed >= n)
    if (level === undefined) {
      continue
    }
    const resetsAt = l.resetsAt === undefined ? NaN : Date.parse(l.resetsAt)
    // The window by the hour it resets in: a reset time that wobbles by seconds is still the same window.
    const key = `${l.kind}@${Number.isNaN(resetsAt) ? '' : Math.round(resetsAt / 3_600_000)}@${level}`
    if (seen.includes(key)) {
      continue
    }
    fresh.push(key)
    const reset = Number.isNaN(resetsAt) ? '' : `, сброс через ${timeLeft(resetsAt - at)}`
    $.ui.toast(`Лимит ${NAMES[l.kind] ?? l.kind}: ${Math.round(l.percentUsed)}%${reset}`, { timeoutMs: 10_000 })
  }
  if (fresh.length > 0) {
    await $.store.set('warned', [...seen, ...fresh].slice(-KEPT_WARNINGS))
  }
}

// --- context -----------------------------------------------------------------

const THRESHOLD_EVERY_MS = 10 * 60_000

// The fill and the compaction point. The point comes from the window's breakdown, estimated locally: no request is sent.
async function readContext($: Dollar) {
  thresholdReadAt = await $.clock.now()
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const b = usage.context.breakdown
    const threshold = b === undefined || !b.isAutoCompactEnabled ? null : (b.autoCompactThreshold ?? null)
    await update($, context, () => ({ tokens: usage.context.tokens ?? null, window: usage.context.window, threshold }))
  } catch {
    // No session bound yet: the fill alone comes with the next measurement.
  }
}

// A new fill keeps the point it had. The point is read again after a compaction (the fill drops), every ten minutes,
// and each minute while it is not known.
async function measureContext($: Dollar, live: SessionContextUsage) {
  const before = await read($, context)
  const tokens = live.tokens ?? null
  await update($, context, c => ({ tokens, window: live.window, threshold: c?.threshold ?? null }))
  const at = await $.clock.now()
  const isDrop = before !== null && before.tokens !== null && tokens !== null && tokens < before.tokens * 0.7
  const isDue = at - thresholdReadAt > (before?.threshold == null ? 60_000 : THRESHOLD_EVERY_MS)
  if (isDrop || isDue) {
    await readContext($)
  }
}

// A session's sums as kept; older entries kept the totals alone.
type KeptEntry = { totals: UsageTotals; spend?: SpendBreakdown }
type Kept = Record<string, KeptEntry | UsageTotals>

function entryOf(value: KeptEntry | UsageTotals | undefined): KeptEntry | undefined {
  return value === undefined ? undefined : 'totals' in value ? value : { totals: value }
}

async function keptSums($: Dollar): Promise<Kept> {
  const value = await $.store.get('totals')

  return value !== null && typeof value === 'object' ? { ...(value as Kept) } : {}
}

// Sums outlive a restart of the app under the session's id; the oldest sessions fall out.
async function keep($: Dollar, sum: UsageTotals, breakdown: SpendBreakdown) {
  const id = await $.session.id()
  const kept = await keptSums($)
  delete kept[id]
  kept[id] = { totals: sum, spend: breakdown }
  const ids = Object.keys(kept)
  ids.slice(0, Math.max(0, ids.length - KEPT_SESSIONS)).forEach(stale => delete kept[stale])
  await $.store.set('totals', kept)
}

// --- background tasks -------------------------------------------------------

async function trackTask($: Dollar, id: string, kind: TaskKind, title: string, startedAt: number, outputFile: string | null) {
  const task: BgTask = { id, kind, title, startedAt, endedAt: null, status: 'running', outputFile, outputSize: 0, percent: null, done: null, total: null }
  await update($, tasks, all => [...all.filter(t => t.id !== id), task].slice(-30))
}

async function finishTask($: Dollar, id: string, status: Exclude<TaskStatus, 'running'>) {
  const at = await $.clock.now()
  await update($, tasks, all => all.map(t => (t.id === id && t.status === 'running' ? { ...t, status, endedAt: at } : t)))
}

async function pollOutput($: Dollar, t: BgTask) {
  if (t.outputFile === null) {
    return
  }
  try {
    const stat = await $.fs.stat(t.outputFile)
    if (stat.kind !== 'file' || stat.size === t.outputSize || stat.size > MAX_OUTPUT) {
      return
    }
    const text = await $.fs.read(t.outputFile)
    const progress = progressOf(lines(String(text).slice(-8192)).slice(-6))
    await update($, tasks, all => all.map(one => (one.id === t.id ? { ...one, outputSize: stat.size, ...(progress ?? {}) } : one)))
  } catch {
    // The file is not there yet, or went away with its task.
  }
}

// Every two seconds: read the running shells' outputs and move the clock; finished tasks age out of the list.
async function pulse($: Dollar) {
  const list = await read($, tasks)
  const at = await $.clock.now()
  if (list.some(t => t.endedAt !== null && at - t.endedAt > KEEP_FINISHED_MS)) {
    await update($, tasks, all => all.filter(t => t.endedAt === null || at - t.endedAt <= KEEP_FINISHED_MS))
  }
  for (const t of list) {
    if (t.status === 'running' && t.kind === 'shell') {
      await pollOutput($, t)
    }
  }
  // The card's elapsed and remaining times move with the tasks, not once a minute.
  if (list.some(t => t.status === 'running')) {
    await tickNow($)
  }
}

// --- drawing -----------------------------------------------------------------

// A card opens over the band from its pill's side: the last group's toward the left, the others' toward the right.
function sideOf(group: Group, groups: readonly Group[]): 'left' | 'right' {
  return groups.indexOf(group) === groups.length - 1 && groups.length > 1 ? 'right' : 'left'
}

// --- hooks -------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    await remember($, usage.rateLimits)
    await update($, engineUsd, () => usage.cost?.usd ?? null)
    const kept = entryOf((await keptSums($))[await $.session.id()])
    const current = await read($, totals)
    if (kept !== undefined && kept.totals.input + kept.totals.output > current.input + current.output) {
      await update($, totals, () => kept.totals)
      await update($, spend, () => kept.spend ?? NO_SPEND)
    }
    await readContext($)
    await tickNow($)
    timer?.cancel()
    timer = $.clock.every(60_000, () => {
      void tickNow($)
    })
    poller?.cancel()
    poller = $.clock.every(2000, () => {
      void pulse($)
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, totals, () => ZERO)
      await update($, spend, () => NO_SPEND)
      await update($, engineUsd, () => null)
      await update($, tasks, () => [])
      await update($, context, () => null)
    }

    return next(e)
  })

  // Turning auto-compaction on or off moves the compaction point.
  on('config.set', { key: 'autoCompact' }, async ($, e, next) => {
    const done = await next(e)
    await readContext($)

    return done
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await remember($, e.rateLimits)
    }
    if (e.changed.includes('context')) {
      await measureContext($, e.context)
    }
    if (e.cost !== undefined) {
      const usd = e.cost.usd
      await update($, engineUsd, () => usd)
    }
    await tickNow($)

    return next(e)
  })

  // Every model request of the session, the main loop's and each subagent's.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    let item = await stream.next()
    while (item.done !== true) {
      yield item.value
      item = await stream.next()
    }
    const result = item.value
    const usage = result?.usage ?? null
    if (usage !== null) {
      const sum = await update($, totals, t => addTotals(t, usage))
      const breakdown = await update($, spend, s => addSpend(s, usage, e.agentId))
      await keep($, sum, breakdown)
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    const tool: string = e.tool
    const args = e as unknown as Record<string, unknown>
    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) {
      return ran
    }
    const result = (ran.result ?? {}) as Record<string, unknown>

    if ((tool === 'Bash' || tool === 'PowerShell') && typeof result.backgroundTaskId === 'string') {
      const command = String(args.command ?? '')
      const title = commandTitle(command) || String(args.description ?? 'команда')
      await trackTask($, result.backgroundTaskId, 'shell', title, startedAt, outputPathOf(ran.text ?? ''))
    } else if (tool === 'Agent' && result.status === 'async_launched' && typeof result.agentId === 'string') {
      await trackTask($, result.agentId, 'agent', cut(String(result.description ?? args.description ?? 'агент'), 48), startedAt, null)
    } else if (tool === 'Workflow' && result.status === 'async_launched' && typeof result.taskId === 'string') {
      await trackTask($, result.taskId, 'workflow', `workflow ${String(result.workflowName ?? '')}`.trim(), startedAt, null)
    } else if (tool === 'TaskStop' || tool === 'KillShell') {
      await finishTask($, String(args.task_id ?? args.shell_id ?? ''), 'stopped')
    }

    return ran
  })

  // A background subagent's run ends with its turn.
  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined && (await read($, tasks)).some(t => t.id === agentId && t.status === 'running')) {
      await finishTask($, agentId, e.isAborted ? 'stopped' : 'done')
    }

    return next(e)
  })

  // Background shells and workflows end in a notification row that names the task.
  on('session.append', async ($, e, next) => {
    const ran = await next(e)
    const running = (await read($, tasks)).filter(t => t.status === 'running')
    if (running.length === 0) {
      return ran
    }
    const text = JSON.stringify(e.message.content)
    if (!text.includes('<status>')) {
      return ran
    }
    for (const t of running) {
      const status = text.includes(t.id) ? notified(text, t.id) : null
      if (status !== null) {
        await finishTask($, t.id, status)
      }
    }

    return ran
  })

  // The engine's own list of work in flight, when the main turn stops: what is gone from it has ended.
  on('classic.Stop', async ($, e, next) => {
    const inFlight = e.background_tasks
    const running = (await read($, tasks)).filter(t => t.status === 'running')
    if (inFlight !== undefined && running.length > 0) {
      const ids = new Set(inFlight.map(t => t.id))
      // Only trust absence once the list is seen to name tasks the way we do.
      const isComparable = inFlight.length === 0 || running.some(t => ids.has(t.id))
      for (const t of running) {
        if (isComparable && !ids.has(t.id)) {
          await finishTask($, t.id, 'done')
        }
      }
    }

    return next(e)
  })

  // Drawn on top of whatever the plugins beneath put in the band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) {
      return below
    }
    const [windows, work, at, t, s, engine, fill, trail] = await Promise.all([
      read($, limits),
      read($, tasks),
      read($, now),
      read($, totals),
      read($, spend),
      read($, engineUsd),
      read($, context),
      read($, trails),
    ])
    const data: BarData = { limits: windows, tasks: work, totals: t, spend: s, engineUsd: engine, context: fill, trails: trail, at }
    const groups = groupsOf(data)
    if (groups.length === 0) {
      return below
    }

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text dimColor wrap="truncate">
            {describe(data)}
          </Text>
          {below}
        </Box>
      )
    }
    const { Box, Svg } = $.ui.resolve(e)

    // The pills: limits at the left edge, the cost at the right, the rest between, bottoms in line; a narrow band wraps a group.
    // A pill with a card sits in a keyed Box with two hidden parts the pointer on it reveals: a spacer one pixel wide
    // and as tall as the card, which raises the band by the card without moving anything sideways, and the card,
    // laid over the room the spacer made. (A hover group, `scope`, reveals nothing on the desktop; a keyed Box does.)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end" flexWrap="wrap" columnGap={2}>
          {groups.map(g => {
            const pills = groupSvg(g.pills)
            const picture = <Svg source={pills.source} alt={g.words} width={pills.width} height={pills.height} />
            if (g.card === undefined) {
              return picture
            }
            const card = cardSvg(g.card)
            const spacer = spacerSvg(card.height)
            const overlay = <Svg source={card.source} alt={g.words} width={card.width} height={card.height} />
            return (
              <Box key={`usage-bar-${g.id}`} flexDirection="column" alignItems={sideOf(g, groups) === 'right' ? 'flex-end' : 'flex-start'}>
                <Box display="none" hover={{ display: 'flex' }}>
                  <Svg source={spacer.source} alt="" width={spacer.width} height={spacer.height} />
                </Box>
                {sideOf(g, groups) === 'right' ? (
                  <Box position="absolute" top={0} right={0} display="none" hover={{ display: 'flex' }}>
                    {overlay}
                  </Box>
                ) : (
                  <Box position="absolute" top={0} left={0} display="none" hover={{ display: 'flex' }}>
                    {overlay}
                  </Box>
                )}
                {picture}
              </Box>
            )
          })}
        </Box>
        {below}
      </Box>
    )
  })
}
