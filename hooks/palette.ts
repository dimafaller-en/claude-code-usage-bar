// Colours from whatever theme a mod set with `$.theme.set`: the band has no way to ask for the theme, so it keeps
// the `colors` it saw pass (see the `theme.set` hook) and picks its tones from them by contrast against its ground.
// Every theme made with the design system's `makeColors` carries the same tokens: a gray ramp (`gray-0` … `gray-900`)
// and ramps per role (`role-accent-100` …). A theme without them, or no theme, leaves the band's own colours.
import type { TaskStatus, ThemePalette } from '../types'

type ThemeColorInputs = Record<string, string>

export type HueName = 'blue' | 'orange' | 'green' | 'yellow' | 'gray' | 'alert'

/** What the band draws with: the CSS for its pictures, and single colours for legend squares, glyphs and words. */
export type Look = {
  /** Rules for the band's pills and cards, replacing the built-in ones; null keeps them. */
  css: string | null
  /** Rules for the panel's share bar (`.track`, `.mark`); null keeps them. */
  barCss: string | null
  hue: Record<HueName, string>
  status: Record<TaskStatus, string>
}

type Mode = 'light' | 'dark'

/** The tones of one mode, picked against its ground. */
type Tones = { ground: string; strong: string; label: string; ink: string; head: string; dot: string; alert: string }

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1, 7), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })

  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]

  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const HEX = /^#[0-9a-f]{6}$/i

/** The colours of one ramp: `gray` gives `gray-0` … `gray-900`, `role-accent` gives `role-accent-100` …, steps only. */
function ramp(inputs: ThemeColorInputs, name: string): string[] {
  const step = new RegExp(`^${name}-\\d+$`)

  return Object.entries(inputs)
    .filter(([key, value]) => step.test(key) && HEX.test(value))
    .map(([, value]) => value)
}

/** The colour whose weakest contrast against the grounds comes nearest the target, a shortfall weighing triple. */
function nearest(colors: readonly string[], grounds: readonly string[], target: number): string | undefined {
  let best: string | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (const c of colors) {
    const weakest = Math.min(...grounds.map(g => contrast(c, g)))
    const score = weakest >= target ? weakest - target : (target - weakest) * 3
    if (score < bestScore) {
      best = c
      bestScore = score
    }
  }

  return best
}

function tonesOf(inputs: ThemeColorInputs, mode: Mode): Tones | null {
  const grays = ramp(inputs, 'gray')
  if (grays.length < 5) {
    return null
  }
  const byLight = [...grays].sort((a, b) => luminance(a) - luminance(b))
  const darkest = byLight[0] as string
  const lightest = byLight[byLight.length - 1] as string
  // A card sits a step above the page in dark mode, and is the lightest surface in light mode.
  const ground = mode === 'dark' ? (nearest(grays, [darkest], 1.18) ?? darkest) : lightest
  const on = [ground]
  const ink = nearest(grays, on, 6.5) ?? lightest

  return {
    ground,
    strong: nearest(grays, on, 14) ?? ink,
    label: nearest(grays, on, 11) ?? ink,
    ink,
    head: nearest(grays, on, 4.6) ?? ink,
    dot: nearest(grays, on, 2) ?? ink,
    alert: nearest(ramp(inputs, 'role-warning'), on, 4.6) ?? ink,
  }
}

function rules(t: Tones): string {
  return (
    `.ink{fill:${t.ink}}.strong{fill:${t.strong}}.icon{stroke:${t.head}}.fill{fill:${t.ink}}.mark{stroke:${t.strong};stroke-opacity:.65}.dot{fill:${t.dot}}` +
    `.track{fill:${t.strong};fill-opacity:.13}` +
    `.alert,.head.alert{fill:${t.alert}}.icon-alert{stroke:${t.alert}}.fill-alert{fill:${t.alert}}` +
    `.bar-5h,.bar-7d,.bar-ctx,.bar-in,.bar-out,.bar-cache,.bar-cost,.bar-tasks{fill:${t.ink}}` +
    `.ground{fill:${t.ground}}.head{fill:${t.head}}.label{fill:${t.label}}.value{fill:${t.ink}}`
  )
}

function barRules(t: Tones): string {
  return `.track{fill:${t.strong};fill-opacity:.13}.mark{fill:${t.strong}}`
}

/** Light rules by default and dark ones under the media query; a theme of one mode is that mode everywhere. */
function byMode<T>(tones: Partial<Record<Mode, T>>, write: (t: T) => string): string | null {
  const { light, dark } = tones
  if (light !== undefined && dark !== undefined) {
    return `${write(light)}@media (prefers-color-scheme:dark){${write(dark)}}`
  }
  const only = light ?? dark

  return only === undefined ? null : write(only)
}

// The look the drawing in progress uses: set at the top of each render hook from the kept theme, read by the
// picture builders, which take no engine. Null keeps the band's own colours.
let active: Look | null = null

export function useLook(look: Look | null): void {
  active = look
}

export function currentLook(): Look | null {
  return active
}

/** The look a theme's colours make, or the band's own `fallback` where the theme gives nothing to pick from. */
export function lookOf(colors: ThemePalette | null | undefined, fallback: Look): Look {
  const inputs = colors?.inputs
  if (inputs === undefined) {
    return fallback
  }
  const tones: Partial<Record<Mode, Tones>> = {}
  for (const mode of ['light', 'dark'] as const) {
    const given = inputs[mode]
    const t = given === undefined ? null : tonesOf(given, mode)
    if (t !== null) {
      tones[mode] = t
    }
  }
  const modes = (['light', 'dark'] as const).filter(m => tones[m] !== undefined)
  if (modes.length === 0) {
    return fallback
  }
  // A square, a glyph or a word has one colour for both modes: the role step that reads on every ground the theme has (4.5:1).
  const grounds = modes.map(m => (tones[m] as Tones).ground)
  const role = (name: string, own: string): string => {
    const steps = modes.flatMap(m => ramp(inputs[m] as ThemeColorInputs, `role-${name}`))
    return nearest(steps, grounds, 4.5) ?? own
  }
  const gray = nearest(
    modes.flatMap(m => ramp(inputs[m] as ThemeColorInputs, 'gray')),
    grounds,
    4.5,
  ) ?? fallback.hue.gray
  const hue: Record<HueName, string> = {
    blue: role('pro', fallback.hue.blue),
    orange: role('danger', fallback.hue.orange),
    green: role('success', fallback.hue.green),
    yellow: role('accent', fallback.hue.yellow),
    gray,
    alert: role('warning', fallback.hue.alert),
  }

  const status: Record<TaskStatus, string> = { running: role('accent', fallback.status.running), done: hue.green, failed: role('danger', fallback.status.failed), stopped: gray }
  const css = byMode(tones, rules)
  const statusCss = `.st-running{fill:${status.running}}.st-done{fill:${status.done}}.st-failed{fill:${status.failed}}.st-stopped{fill:${status.stopped}}`

  return {
    css: css === null ? null : css + statusCss,
    barCss: byMode(tones, barRules),
    hue,
    status,
  }
}
