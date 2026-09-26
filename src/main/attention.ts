/**
 * When to text the user about a Claude Code session that is waiting on them:
 * pure functions over session states, no I/O.
 *
 * The daemon hands in the sessions, the Mac's last keyboard / mouse input, and
 * the waiting spells (episodes) it has already texted, and gets back what to
 * send now plus when to look again. Keeping the policy here means the daemon
 * only chains a `setTimeout` to `nextCheckAt` instead of polling, and every
 * rule below is testable with a fake clock.
 *
 * Rules: only a session that needs the user (`NEEDS_YOU`) counts; each episode
 * is texted at most once; a session must have waited `alertAfterMinutes`
 * first, so a quick glance back at the terminal beats the phone buzzing; and
 * with "only when away" on, any input after the wait began means the user was
 * there to see it, so that episode is dropped for good.
 */
import type { ClaudeSession, ClaudeSessionState, Settings } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

/** States in which the session cannot move on without the user. */
export const NEEDS_YOU: ReadonlySet<ClaudeSessionState> = new Set<ClaudeSessionState>(['done', 'question', 'permission'])

/** The slice of a session the alert policy and wording read. */
export type AlertSession = Pick<ClaudeSession, 'id' | 'project' | 'state' | 'since' | 'detail'>

/** Identity of one waiting spell: the same session waiting again later is a new episode. */
export function episodeKey(s: Pick<ClaudeSession, 'id' | 'state' | 'since'>): string {
  return `${s.id}|${s.state}|${s.since}`
}

export interface AlertPlan {
  /** Sessions to text about now, the longest-waiting first. */
  due: AlertSession[]
  /** When the soonest still-pending session becomes due, or null when none is pending. */
  nextCheckAt: Date | null
}

const MINUTE_MS = 60_000
const DETAIL_MAX = 140
/** A phone shows a long text as a wall; the lock screen only needs enough to decide whether to walk back. */
const MESSAGE_MAX = 1000

/** The wait before texting, clamped to the settings range so a bad value can neither spam nor mute. */
function delayMs(minutes: number): number {
  const m = Number.isFinite(minutes) ? minutes : DEFAULT_SETTINGS.alertAfterMinutes
  return Math.min(60, Math.max(1, m)) * MINUTE_MS
}

function parseMs(iso: string): number | null {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Whether the user touched the Mac after the wait began, i.e. was around to see
 * it. Unknown input time (`null`) counts as away: a missed text costs more than
 * a redundant one.
 */
function userWasAround(sinceMs: number, onlyWhenAway: boolean, lastInputAt: Date | null): boolean {
  return onlyWhenAway && lastInputAt !== null && lastInputAt.getTime() > sinceMs
}

/** Which waiting sessions to text now, and when the next one becomes due. */
export function planAlerts(
  sessions: readonly AlertSession[],
  settings: Pick<Settings, 'alertOnlyWhenAway' | 'alertAfterMinutes'>,
  now: Date,
  lastInputAt: Date | null,
  alerted: ReadonlySet<string>,
): AlertPlan {
  const afterMs = delayMs(settings.alertAfterMinutes)
  const due: Array<{ session: AlertSession; since: number }> = []
  let next: number | null = null
  for (const session of sessions) {
    if (!NEEDS_YOU.has(session.state) || alerted.has(episodeKey(session))) continue
    const since = parseMs(session.since)
    if (since === null || userWasAround(since, settings.alertOnlyWhenAway, lastInputAt)) continue
    const dueAt = since + afterMs
    if (now.getTime() >= dueAt) due.push({ session, since })
    else if (next === null || dueAt < next) next = dueAt
  }
  due.sort((a, b) => a.since - b.since || compareIds(a.session.id, b.session.id))
  return { due: due.map((d) => d.session), nextCheckAt: next === null ? null : new Date(next) }
}

/** Deterministic tie-break so two sessions that started waiting together always list in the same order. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Shorten to `max` characters, marking the cut with an ellipsis. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…'
}

/** A detail or project with a newline in it would break the one-line-per-session layout. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function sessionName(s: AlertSession): string {
  const project = oneLine(s.project ?? '')
  return project ? `“${project}”` : 'A session'
}

/** What one session is waiting on, as a sentence fragment without final punctuation. */
function sessionLine(s: AlertSession): string {
  const name = sessionName(s)
  const detail = s.detail ? clip(oneLine(s.detail), DETAIL_MAX) : ''
  switch (s.state) {
    case 'question':
      return `${name} is asking you a question${detail ? `: ${detail}` : ''}`
    case 'permission':
      return `${name} is waiting for your permission${detail ? ` (${detail})` : ''}`
    default:
      return `${name} finished and is waiting for your next message`
  }
}

/** Already ends a sentence; a clipped detail's ellipsis counts, since "…." reads as a typo. */
const ENDS_SENTENCE = /[.?!…]$/

/** The iMessage text for the sessions due now. Plain text: it lands on a phone lock screen. */
export function alertMessage(due: readonly AlertSession[]): string {
  const lines = due.map(sessionLine)
  const [only] = lines
  if (only === undefined) return 'Claude Code needs you.'
  if (lines.length === 1) {
    return clip(`Claude Code needs you. ${only}${ENDS_SENTENCE.test(only) ? '' : '.'}`, MESSAGE_MAX)
  }
  const body = [`Claude Code needs you in ${lines.length} sessions:`, ...lines.map((l) => `• ${l}`)]
  return clip(body.join('\n'), MESSAGE_MAX)
}

/** Sent by the settings "Send test" button, so the user sees exactly where alerts will land. */
export function testMessage(): string {
  return "Session Manager test: this is how you'll hear when a Claude Code session needs you."
}
