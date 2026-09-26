/**
 * Pure helpers for the Claude Code sessions panel. Kept out of the component
 * so the copy and the "needs you" rule are tested once and read the same in
 * the header count, the row marks, and the mock backend.
 */
import type { ClaudeSession, ClaudeSessionState } from '@shared/types'

/** What each state means to the user, in their terms rather than the hook's. */
export const SESSION_STATE_LABEL: Record<ClaudeSessionState, string> = {
  question: 'Asking a question',
  permission: 'Needs permission',
  done: 'Your turn',
  working: 'Working',
  ready: 'Ready',
}

/** States where the session is blocked on the user. These are what alerts are sent for. */
export function isWaiting(state: ClaudeSessionState): boolean {
  return state === 'question' || state === 'permission' || state === 'done'
}

export function waitingCount(sessions: ClaudeSession[]): number {
  return sessions.filter((s) => isWaiting(s.state)).length
}

/** "1 needs you" / "3 need you" for the section head. */
export function waitingLabel(count: number): string {
  return count === 1 ? '1 needs you' : `${count} need you`
}

/** Mirrors `imessage.normalizeHandle` in the main process. */
export const ALERT_TO_MAX = 254
const PHONE = /^\+?\d{7,15}$/
const EMAIL = /^[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+$/

/**
 * The handle Messages will text, in the form the daemon stores: '' stays ''
 * (unset), a phone number loses its spaces, dashes, dots and parentheses, an
 * email is lowercased. Null when it is neither. The panel compares drafts in
 * this form so a saved "+1 555 123 4567" does not read as unsaved once the
 * backend hands back "+15551234567".
 */
export function normalizeAlertTo(raw: string): string | null {
  const value = raw.trim()
  if (value === '') return ''
  if (value.length > ALERT_TO_MAX) return null
  if (value.includes('@')) return EMAIL.test(value) ? value.toLowerCase() : null
  const digits = value.replace(/[\s\-.()]/g, '')
  return PHONE.test(digits) ? digits : null
}
