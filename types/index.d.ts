/** One rate-limit window as the last response reported it. */
export type UsageLimit = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  percentUsed: number
  /** ISO 8601; absent when the window did not say. */
  resetsAt?: string
}

/** What the session's model requests used, summed over every loop, subagents included. */
export type UsageTotals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** The API-price estimate of those tokens, in US dollars. */
  usd: number
}

/** Where the estimated dollars went, three ways: by model, by loop, by kind of token. */
export type SpendBreakdown = {
  /** By the model's display name (`Opus 5.5`). */
  byModel: Record<string, number>
  main: number
  subagents: number
  /** The subagent loops seen, by id, to count them. */
  subagentIds: string[]
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

export type TaskKind = 'shell' | 'agent' | 'workflow'
export type TaskStatus = 'running' | 'done' | 'failed' | 'stopped'

/** The live context window: the last response's input side against the model's window, and where auto-compaction runs. */
export type ContextFill = {
  /** Input tokens the last response was answered over; null before the live window's first response. */
  tokens: number | null
  window: number
  /** The token count auto-compaction runs at; null when it is off or not read yet. */
  threshold: number | null
}

/** One reading of a window's use, to tell how fast it is going. */
export type LimitSample = { at: number; percent: number }

/** A window's readings since it last reset. */
export type LimitTrail = { resetsAt: number; points: LimitSample[] }

/** One piece of background work: a shell command, a subagent, or a workflow run. */
export type BgTask = {
  /** The background task id, the agent id, or the workflow's task id. */
  id: string
  kind: TaskKind
  title: string
  startedAt: number
  endedAt: number | null
  status: TaskStatus
  /** A shell's output file and the size it had when last read. */
  outputFile: string | null
  outputSize: number
  /** 0..1 when the output says how far along it is; `done` of `total` when it counts. */
  percent: number | null
  done: number | null
  total: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': {
      tasks: BgTask[]
      limits: UsageLimit[]
      /** The clock the band last drew at, moved each minute so the time left counts down. */
      now: number
      totals: UsageTotals
      spend: SpendBreakdown
      /** The engine's own cost of the session, where the host keeps one; preferred over the estimate. */
      engineUsd: number | null
      context: ContextFill | null
      /** Each window's readings since its reset, by kind. */
      trails: Record<string, LimitTrail>
    }
  }
}
