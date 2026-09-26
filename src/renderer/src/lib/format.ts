/**
 * Pure formatting helpers for the dashboard. They live apart from React so
 * they can be unit-tested without a DOM and so every component renders numbers
 * and countdowns the same way (the brief demands consistent "runway" copy).
 */
import type { Account, Settings, Usage, UsageWindow } from '@shared/types'

export type Bucket = 'ok' | 'warn' | 'danger' | 'unknown'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "2h 14m" / "3d 4h" / "14m" / "now". Two units at most so the string width is
 * predictable and the layout never shifts when the clock ticks.
 */
export function formatCountdown(resetsAt: string | null, now: Date): string {
  if (!resetsAt) return '—'
  const ms = new Date(resetsAt).getTime() - now.getTime()
  if (Number.isNaN(ms)) return '—'
  if (ms <= 0) return 'now'
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  const minutes = Math.floor((ms % HOUR) / MINUTE)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${pad(minutes)}m`
  if (minutes > 0) return `${minutes}m`
  return '<1m'
}

/** "12 s ago", "3 min ago", "2 h ago", "just now"; null → "never". */
export function formatAgo(at: string | null, now: Date): string {
  if (!at) return 'never'
  const ms = now.getTime() - new Date(at).getTime()
  if (Number.isNaN(ms)) return 'never'
  if (ms < 2_000) return 'just now'
  return `${elapsed(ms)} ago`
}

/**
 * How long something has been in its state: "12 s", "4 min", "2 h", "3 d".
 * The same unit ladder as `formatAgo`, without the suffix, so a session row's
 * timer reads like the rest of the app. Future or unparseable times → "—".
 */
export function formatElapsed(since: string | null, now: Date): string {
  if (!since) return '—'
  const ms = now.getTime() - new Date(since).getTime()
  if (Number.isNaN(ms)) return '—'
  return elapsed(Math.max(0, ms))
}

function elapsed(ms: number): string {
  if (ms < MINUTE) return `${Math.floor(ms / 1000)} s`
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h`
  return `${Math.floor(ms / DAY)} d`
}

/** Whole percent with the sign, clamped to 0-100 so bad data cannot break meters. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  return `${Math.round(clampPct(value))}%`
}

export function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/**
 * Colour bucket for a headroom value. Thresholds come from the design brief:
 * ok ≥ 30, warn 11-29, danger ≤ 10. `atThreshold` forces danger because an
 * account at the autoswap threshold is about to be swapped regardless of colour.
 */
export function headroomBucket(headroom: number | null, atThreshold = false): Bucket {
  if (headroom == null || Number.isNaN(headroom)) return 'unknown'
  if (atThreshold || headroom <= 10) return 'danger'
  if (headroom < 30) return 'warn'
  return 'ok'
}

/** "18:42" in the user's locale, 24-hour so log lines align. */
export function formatClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "Sep 4" — a short date for the day boundary in the activity list. */
export function formatDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function localPart(email: string): string {
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

/** The alias if set, else the email's local part — what the tray shows, too. */
export function displayName(account: Pick<Account, 'alias' | 'email'>): string {
  const alias = account.alias.trim()
  return alias.length > 0 ? alias : localPart(account.email)
}

/**
 * The swap line for a window: the 5-hour session has its own, the weekly
 * windows share `threshold`. Mirrors `autoswap.swapLineFor` in the main process.
 */
export function swapLineFor(key: string, settings: Pick<Settings, 'fiveHourThreshold' | 'threshold'>): number {
  return key === 'five_hour' ? settings.fiveHourThreshold : settings.threshold
}

type GateSettings = Pick<Settings, 'model' | 'weeklyGate'>

/** The usage key of the per-model weekly window, e.g. `model:fable`. Mirrors the main process. */
export function modelWindowKey(model: string): string {
  return `model:${model.toLowerCase()}`
}

/**
 * The window keys that count toward headroom and the swap lines under the
 * current `weeklyGate`. The 5-hour session always gates. `all` adds the
 * all-models week; `model` adds the per-model week, falling back to the
 * all-models week for an account that reports no model window (so it is never
 * left ungated); `both` adds both. Mirrors `autoswap.gatingWindows`.
 */
export function gatingKeys(usage: Usage | null, settings: GateSettings): Set<string> {
  const model = modelWindowKey(settings.model)
  const hasModel = usage?.windows.some((w) => w.key === model) ?? false
  const keys = new Set(['five_hour'])
  if (settings.weeklyGate !== 'model' || !hasModel) keys.add('seven_day')
  if (settings.weeklyGate !== 'all') keys.add(model)
  return keys
}

export function isGatingWindow(key: string, usage: Usage | null, settings: GateSettings): boolean {
  return gatingKeys(usage, settings).has(key)
}

/**
 * The swap line to draw for a window, or undefined when the window does not
 * gate: a meter must never read "at threshold" for a week that cannot trigger
 * a swap.
 */
export function gatingSwapLine(
  key: string,
  usage: Usage | null,
  settings: GateSettings & Pick<Settings, 'fiveHourThreshold' | 'threshold'>,
): number | undefined {
  return isGatingWindow(key, usage, settings) ? swapLineFor(key, settings) : undefined
}

/**
 * Which weekly window counts, in words for the auto-swap summary:
 * "all models", "Fable", "all models and Fable" (both count, so the tighter one binds).
 */
export function weeklyGateLabel(settings: GateSettings): string {
  const model = settings.model.trim() || 'model'
  if (settings.weeklyGate === 'all') return 'all models'
  if (settings.weeklyGate === 'model') return model
  return `all models and ${model}`
}

/** Resolve the account's binding window from its usage, or null when unknown. */
export function bindingWindowOf(account: Pick<Account, 'bindingWindow' | 'usage'>): UsageWindow | null {
  if (!account.bindingWindow || !account.usage) return null
  return account.usage.windows.find((w) => w.key === account.bindingWindow) ?? null
}

/** Every gating window except the binding one, in a stable display order. */
export function secondaryWindows(usage: Usage | null, bindingKey: string | null): UsageWindow[] {
  if (!usage) return []
  return [...usage.windows].filter((w) => w.key !== bindingKey).sort(byWindowOrder)
}

const ORDER = ['five_hour', 'seven_day']
function byWindowOrder(a: UsageWindow, b: UsageWindow): number {
  const ia = ORDER.indexOf(a.key)
  const ib = ORDER.indexOf(b.key)
  return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib)
}

/** "Max" / "Pro" / "Team"; unknown plans stay lowercase as reported. */
export function formatPlan(plan: string | null): string {
  if (!plan) return ''
  const known: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', free: 'Free', enterprise: 'Enterprise', plus: 'Plus' }
  return known[plan.toLowerCase()] ?? plan
}

/** Seconds → "5 min", "90 s", "2 h" for the compact auto-swap summary line. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${Math.round((seconds / 3600) * 10) / 10} h`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
