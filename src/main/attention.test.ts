import { describe, expect, it } from 'vitest'

import { NEEDS_YOU, alertMessage, episodeKey, planAlerts, testMessage, type AlertSession } from './attention'

const NOW = new Date('2026-09-26T12:00:00Z')
const AWAY = { alertOnlyWhenAway: true, alertAfterMinutes: 2 }
const ANYWAY = { alertOnlyWhenAway: false, alertAfterMinutes: 2 }
const NONE = new Set<string>()

/** ISO time `minutes` before NOW. */
function ago(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString()
}

function session(over: Partial<AlertSession> = {}): AlertSession {
  return { id: 's1', project: 'session-manager', state: 'done', since: ago(5), detail: null, ...over }
}

describe('NEEDS_YOU and episodeKey', () => {
  it('covers exactly the waiting states', () => {
    expect([...NEEDS_YOU].sort()).toEqual(['done', 'permission', 'question'])
  })

  it('keys an episode by session, state and start', () => {
    expect(episodeKey({ id: 'a', state: 'question', since: '2026-09-26T11:00:00.000Z' })).toBe(
      'a|question|2026-09-26T11:00:00.000Z',
    )
  })
})

describe('planAlerts', () => {
  it('marks a session due once it has waited alertAfterMinutes', () => {
    const s = session({ since: ago(2) })
    expect(planAlerts([s], AWAY, NOW, null, NONE)).toEqual({ due: [s], nextCheckAt: null })
  })

  it('holds a session that has not waited long enough and says when to look again', () => {
    const plan = planAlerts([session({ since: ago(0.5) })], AWAY, NOW, null, NONE)
    expect(plan.due).toEqual([])
    expect(plan.nextCheckAt).toEqual(new Date(NOW.getTime() + 90_000))
  })

  it('reports the soonest pending session as nextCheckAt', () => {
    const plan = planAlerts(
      [session({ id: 'a', since: ago(0.2) }), session({ id: 'b', since: ago(1.5) }), session({ id: 'c', since: ago(1) })],
      AWAY,
      NOW,
      null,
      NONE,
    )
    expect(plan.due).toEqual([])
    expect(plan.nextCheckAt).toEqual(new Date(NOW.getTime() + 30_000))
  })

  it('sorts due sessions oldest wait first', () => {
    const a = session({ id: 'a', since: ago(3) })
    const b = session({ id: 'b', since: ago(10) })
    const c = session({ id: 'c', since: ago(5) })
    expect(planAlerts([a, b, c], AWAY, NOW, null, NONE).due.map((s) => s.id)).toEqual(['b', 'c', 'a'])
  })

  it('skips episodes already texted, but not a later episode of the same session', () => {
    const old = session({ since: ago(30), state: 'question' })
    const again = session({ since: ago(5), state: 'question' })
    const alerted = new Set([episodeKey(old)])
    expect(planAlerts([old], AWAY, NOW, null, alerted).due).toEqual([])
    expect(planAlerts([again], AWAY, NOW, null, alerted).due).toEqual([again])
  })

  it('ignores sessions that do not need the user', () => {
    const plan = planAlerts(
      [session({ state: 'working', since: ago(30) }), session({ id: 's2', state: 'ready', since: ago(0.5) })],
      AWAY,
      NOW,
      null,
      NONE,
    )
    expect(plan).toEqual({ due: [], nextCheckAt: null })
  })

  it('skips a session whose since does not parse', () => {
    expect(planAlerts([session({ since: 'not a date' })], AWAY, NOW, null, NONE)).toEqual({ due: [], nextCheckAt: null })
  })

  it('texts every waiting state', () => {
    const states = ['done', 'question', 'permission'] as const
    const due = planAlerts(states.map((state, i) => session({ id: `s${i}`, state })), AWAY, NOW, null, NONE).due
    expect(due.map((s) => s.state).sort()).toEqual(['done', 'permission', 'question'])
  })

  describe('only when away', () => {
    it('drops an episode for good when the user touched the Mac after it began waiting', () => {
      const lastInput = new Date(NOW.getTime() - 60_000)
      expect(planAlerts([session({ since: ago(5) })], AWAY, NOW, lastInput, NONE)).toEqual({ due: [], nextCheckAt: null })
      // Still pending by time, but the user was around: it contributes no next check either.
      expect(planAlerts([session({ since: ago(1.5) })], AWAY, NOW, lastInput, NONE)).toEqual({ due: [], nextCheckAt: null })
    })

    it('texts when the last input came before the wait began', () => {
      const s = session({ since: ago(5) })
      expect(planAlerts([s], AWAY, NOW, new Date(NOW.getTime() - 10 * 60_000), NONE).due).toEqual([s])
    })

    it('treats input exactly at the start of the wait as away', () => {
      const s = session({ since: ago(5) })
      expect(planAlerts([s], AWAY, NOW, new Date(s.since), NONE).due).toEqual([s])
    })

    it('treats an unknown last input as away', () => {
      const s = session({ since: ago(5) })
      expect(planAlerts([s], AWAY, NOW, null, NONE).due).toEqual([s])
    })

    it('ignores input entirely when the setting is off', () => {
      const s = session({ since: ago(5) })
      expect(planAlerts([s], ANYWAY, NOW, new Date(NOW.getTime() - 1000), NONE).due).toEqual([s])
    })
  })

  describe('alertAfterMinutes', () => {
    it('clamps below 1 minute up to 1', () => {
      const plan = planAlerts([session({ since: ago(0.5) })], { alertOnlyWhenAway: true, alertAfterMinutes: 0 }, NOW, null, NONE)
      expect(plan.due).toEqual([])
      expect(plan.nextCheckAt).toEqual(new Date(NOW.getTime() + 30_000))
    })

    it('clamps above 60 minutes down to 60', () => {
      const s = session({ since: ago(60) })
      expect(planAlerts([s], { alertOnlyWhenAway: true, alertAfterMinutes: 600 }, NOW, null, NONE).due).toEqual([s])
      const plan = planAlerts([session({ since: ago(59) })], { alertOnlyWhenAway: true, alertAfterMinutes: 600 }, NOW, null, NONE)
      expect(plan.nextCheckAt).toEqual(new Date(NOW.getTime() + 60_000))
    })

    it('falls back to the default for a non-number', () => {
      const plan = planAlerts([session({ since: ago(1) })], { alertOnlyWhenAway: true, alertAfterMinutes: Number.NaN }, NOW, null, NONE)
      expect(plan.nextCheckAt).toEqual(new Date(NOW.getTime() + 60_000))
    })
  })
})

describe('alertMessage', () => {
  it('words a finished session and ends it with a period', () => {
    expect(alertMessage([session()])).toBe(
      'Claude Code needs you. “session-manager” finished and is waiting for your next message.',
    )
  })

  it('words a question with and without its detail', () => {
    expect(alertMessage([session({ state: 'question', detail: 'Which database should I use?' })])).toBe(
      'Claude Code needs you. “session-manager” is asking you a question: Which database should I use?',
    )
    expect(alertMessage([session({ state: 'question' })])).toBe(
      'Claude Code needs you. “session-manager” is asking you a question.',
    )
  })

  it('words a permission prompt with and without its detail', () => {
    expect(alertMessage([session({ state: 'permission', detail: 'Permission to use Bash' })])).toBe(
      'Claude Code needs you. “session-manager” is waiting for your permission (Permission to use Bash).',
    )
    expect(alertMessage([session({ state: 'permission' })])).toBe(
      'Claude Code needs you. “session-manager” is waiting for your permission.',
    )
  })

  it('does not double up final punctuation', () => {
    expect(alertMessage([session({ state: 'question', detail: 'Ship it!' })])).toMatch(/Ship it!$/)
    expect(alertMessage([session({ state: 'question', detail: 'Pick one.' })])).toMatch(/Pick one\.$/)
  })

  it('lists several sessions one per line', () => {
    const msg = alertMessage([
      session({ id: 'a', project: 'api', state: 'question', detail: 'Keep the old route?' }),
      session({ id: 'b', project: 'web', state: 'permission', detail: 'Permission to use Bash' }),
      session({ id: 'c', project: 'docs' }),
    ])
    expect(msg).toBe(
      [
        'Claude Code needs you in 3 sessions:',
        '• “api” is asking you a question: Keep the old route?',
        '• “web” is waiting for your permission (Permission to use Bash)',
        '• “docs” finished and is waiting for your next message',
      ].join('\n'),
    )
  })

  it('truncates a long detail to 140 characters with an ellipsis', () => {
    const detail = 'x'.repeat(300)
    const msg = alertMessage([session({ state: 'question', detail })])
    const shown = msg.split(': ')[1]!
    expect(shown).toHaveLength(140)
    expect(shown.endsWith('…')).toBe(true)
    expect(msg.endsWith('….')).toBe(false)
  })

  it('keeps a detail on one line', () => {
    expect(alertMessage([session({ state: 'question', detail: 'Which one?\n\n  A or B?' })])).toMatch(/: Which one\? A or B\?$/)
  })

  it('caps the whole message at 1000 characters', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      session({ id: `s${i}`, project: `project-${i}`, state: 'question', detail: 'q'.repeat(200) }),
    )
    const msg = alertMessage(many)
    expect(msg.length).toBeLessThanOrEqual(1000)
    expect(msg.length).toBeGreaterThan(990)
    expect(msg.endsWith('…')).toBe(true)
    expect(msg.startsWith('Claude Code needs you in 20 sessions:\n• “project-0”')).toBe(true)
  })
})

describe('testMessage', () => {
  it('explains what the text is', () => {
    expect(testMessage()).toBe("Session Manager test: this is how you'll hear when a Claude Code session needs you.")
  })
})
