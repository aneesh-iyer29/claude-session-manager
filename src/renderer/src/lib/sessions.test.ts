import { describe, expect, it } from 'vitest'
import type { ClaudeSession, ClaudeSessionState } from '@shared/types'
import { isWaiting, normalizeAlertTo, waitingCount, waitingLabel } from './sessions'

const session = (state: ClaudeSessionState): ClaudeSession => ({
  id: state,
  project: 'api',
  cwd: '/tmp/api',
  state,
  since: '2026-09-04T18:00:00Z',
  detail: null,
  alertedAt: null,
})

describe('waiting', () => {
  it('counts the states that block on the user', () => {
    expect(isWaiting('question')).toBe(true)
    expect(isWaiting('permission')).toBe(true)
    expect(isWaiting('done')).toBe(true)
    expect(isWaiting('working')).toBe(false)
    expect(isWaiting('ready')).toBe(false)
    expect(waitingCount(['question', 'working', 'done', 'ready'].map((s) => session(s as ClaudeSessionState)))).toBe(2)
  })
  it('agrees in number', () => {
    expect(waitingLabel(1)).toBe('1 needs you')
    expect(waitingLabel(3)).toBe('3 need you')
  })
})

describe('normalizeAlertTo', () => {
  it('keeps empty as unset', () => {
    expect(normalizeAlertTo('')).toBe('')
    expect(normalizeAlertTo('   ')).toBe('')
  })
  it('strips phone punctuation', () => {
    expect(normalizeAlertTo(' +1 (555) 123-4567 ')).toBe('+15551234567')
    expect(normalizeAlertTo('555.123.4567')).toBe('5551234567')
  })
  it('lowercases emails', () => {
    expect(normalizeAlertTo('You@iCloud.com')).toBe('you@icloud.com')
  })
  it('rejects anything Messages cannot text', () => {
    expect(normalizeAlertTo('12345')).toBeNull()
    expect(normalizeAlertTo('+1234567890123456')).toBeNull()
    expect(normalizeAlertTo('call me')).toBeNull()
    expect(normalizeAlertTo('you@icloud')).toBeNull()
    expect(normalizeAlertTo('-you@icloud.com')).toBeNull()
    expect(normalizeAlertTo(`${'a'.repeat(250)}@x.com`)).toBeNull()
  })
})
