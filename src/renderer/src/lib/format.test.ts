import { describe, expect, it } from 'vitest'
import {
  resetEffect,
  spendableReset,
  bindingWindowOf,
  displayName,
  formatAgo,
  formatCountdown,
  formatDuration,
  formatElapsed,
  formatPercent,
  formatPlan,
  gatingKeys,
  gatingSwapLine,
  headroomBucket,
  isGatingWindow,
  localPart,
  secondaryWindows,
  weeklyGateLabel,
} from './format'

const now = new Date('2026-09-04T18:00:00Z')
const plus = (ms: number) => new Date(now.getTime() + ms).toISOString()

describe('formatCountdown', () => {
  it('renders hours and minutes under a day', () => {
    expect(formatCountdown(plus(2 * 3600_000 + 14 * 60_000), now)).toBe('2h 14m')
  })
  it('pads minutes so the width is stable', () => {
    expect(formatCountdown(plus(2 * 3600_000 + 5 * 60_000), now)).toBe('2h 05m')
  })
  it('renders days and hours over a day', () => {
    expect(formatCountdown(plus(3 * 86_400_000 + 4 * 3600_000 + 59 * 60_000), now)).toBe('3d 4h')
  })
  it('renders minutes only under an hour', () => {
    expect(formatCountdown(plus(14 * 60_000 + 30_000), now)).toBe('14m')
  })
  it('handles the edges', () => {
    expect(formatCountdown(plus(20_000), now)).toBe('<1m')
    expect(formatCountdown(plus(-1), now)).toBe('now')
    expect(formatCountdown(null, now)).toBe('—')
    expect(formatCountdown('garbage', now)).toBe('—')
  })
})

describe('formatAgo', () => {
  it('scales units', () => {
    expect(formatAgo(plus(-12_000), now)).toBe('12 s ago')
    expect(formatAgo(plus(-3 * 60_000), now)).toBe('3 min ago')
    expect(formatAgo(plus(-2 * 3600_000), now)).toBe('2 h ago')
    expect(formatAgo(plus(-500), now)).toBe('just now')
    expect(formatAgo(null, now)).toBe('never')
  })
})

describe('formatElapsed', () => {
  it('uses the same ladder as formatAgo without the suffix', () => {
    expect(formatElapsed(plus(-12_000), now)).toBe('12 s')
    expect(formatElapsed(plus(-4 * 60_000 - 30_000), now)).toBe('4 min')
    expect(formatElapsed(plus(-2 * 3600_000), now)).toBe('2 h')
    expect(formatElapsed(plus(-3 * 86_400_000), now)).toBe('3 d')
  })
  it('clamps clock skew to zero and handles bad input', () => {
    expect(formatElapsed(plus(5_000), now)).toBe('0 s')
    expect(formatElapsed(null, now)).toBe('—')
    expect(formatElapsed('garbage', now)).toBe('—')
  })
})

describe('formatPercent', () => {
  it('rounds and clamps', () => {
    expect(formatPercent(63.2)).toBe('63%')
    expect(formatPercent(140)).toBe('100%')
    expect(formatPercent(-3)).toBe('0%')
    expect(formatPercent(null)).toBe('—')
  })
})

describe('headroomBucket', () => {
  it('uses the brief thresholds', () => {
    expect(headroomBucket(30)).toBe('ok')
    expect(headroomBucket(29)).toBe('warn')
    expect(headroomBucket(11)).toBe('warn')
    expect(headroomBucket(10)).toBe('danger')
    expect(headroomBucket(0)).toBe('danger')
    expect(headroomBucket(null)).toBe('unknown')
  })
  it('forces danger at the autoswap threshold', () => {
    expect(headroomBucket(80, true)).toBe('danger')
  })
})

describe('names', () => {
  it('prefers the alias, else the local part', () => {
    expect(displayName({ alias: 'work', email: 'me@acme.com' })).toBe('work')
    expect(displayName({ alias: '  ', email: 'me@acme.com' })).toBe('me')
    expect(localPart('nobody')).toBe('nobody')
  })
  it('maps plans to display form', () => {
    expect(formatPlan('max')).toBe('Max')
    expect(formatPlan(null)).toBe('')
    expect(formatPlan('weird')).toBe('weird')
  })
  it('formats durations compactly', () => {
    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(300)).toBe('5 min')
    expect(formatDuration(5400)).toBe('1.5 h')
  })
})

describe('windows', () => {
  const usage = {
    fetchedAt: now.toISOString(),
    ok: true,
    error: null,
    plan: 'max',
    windows: [
      { key: 'model:fable', label: 'Fable weekly', pct: 63, resetsAt: null },
      { key: 'seven_day', label: 'Weekly', pct: 51, resetsAt: null },
      { key: 'five_hour', label: '5-hour', pct: 21, resetsAt: null },
    ],
  }
  it('resolves the binding window and orders the rest', () => {
    expect(bindingWindowOf({ bindingWindow: 'model:fable', usage })?.pct).toBe(63)
    expect(bindingWindowOf({ bindingWindow: null, usage })).toBeNull()
    expect(secondaryWindows(usage, 'model:fable').map((w) => w.key)).toEqual(['five_hour', 'seven_day'])
    expect(secondaryWindows(null, null)).toEqual([])
  })
})

describe('weekly gate', () => {
  const win = (key: string, pct: number) => ({ key, label: key, pct, resetsAt: null })
  const withModel = {
    fetchedAt: now.toISOString(),
    ok: true,
    error: null,
    plan: 'max',
    windows: [win('five_hour', 21), win('seven_day', 92), win('model:fable', 63)],
  }
  const noModel = { ...withModel, windows: [win('five_hour', 21), win('seven_day', 92)] }
  const lines = { fiveHourThreshold: 85, threshold: 90 }
  const sorted = (keys: Set<string>) => [...keys].sort()

  it('always gates the 5-hour session', () => {
    for (const weeklyGate of ['all', 'model', 'both'] as const) {
      expect(isGatingWindow('five_hour', withModel, { model: 'Fable', weeklyGate })).toBe(true)
      expect(isGatingWindow('five_hour', null, { model: 'Fable', weeklyGate })).toBe(true)
    }
  })
  it('all: only the all-models week', () => {
    expect(sorted(gatingKeys(withModel, { model: 'Fable', weeklyGate: 'all' }))).toEqual(['five_hour', 'seven_day'])
  })
  it('model: the model week, or the all-models week when the account reports none', () => {
    expect(sorted(gatingKeys(withModel, { model: 'Fable', weeklyGate: 'model' }))).toEqual(['five_hour', 'model:fable'])
    expect(isGatingWindow('seven_day', noModel, { model: 'Fable', weeklyGate: 'model' })).toBe(true)
    expect(isGatingWindow('seven_day', null, { model: 'Fable', weeklyGate: 'model' })).toBe(true)
  })
  it('model: matches the model name case-insensitively', () => {
    expect(isGatingWindow('model:fable', withModel, { model: 'FABLE', weeklyGate: 'model' })).toBe(true)
    expect(isGatingWindow('seven_day', withModel, { model: 'FABLE', weeklyGate: 'model' })).toBe(false)
  })
  it('model: a window for another model does not count', () => {
    expect(isGatingWindow('model:fable', withModel, { model: 'Opus', weeklyGate: 'model' })).toBe(false)
    expect(isGatingWindow('seven_day', withModel, { model: 'Opus', weeklyGate: 'model' })).toBe(true)
  })
  it('both: every window', () => {
    expect(sorted(gatingKeys(withModel, { model: 'Fable', weeklyGate: 'both' }))).toEqual(['five_hour', 'model:fable', 'seven_day'])
  })
  it('draws a swap line only for gating windows', () => {
    const all = { ...lines, model: 'Fable', weeklyGate: 'all' as const }
    const model = { ...lines, model: 'Fable', weeklyGate: 'model' as const }
    expect(gatingSwapLine('five_hour', withModel, all)).toBe(85)
    expect(gatingSwapLine('seven_day', withModel, all)).toBe(90)
    expect(gatingSwapLine('model:fable', withModel, all)).toBeUndefined()
    expect(gatingSwapLine('seven_day', withModel, model)).toBeUndefined()
    expect(gatingSwapLine('model:fable', withModel, model)).toBe(90)
  })
  it('names the counting window for the summary line', () => {
    expect(weeklyGateLabel({ model: 'Fable', weeklyGate: 'all' })).toBe('all models')
    expect(weeklyGateLabel({ model: 'Fable', weeklyGate: 'model' })).toBe('Fable')
    expect(weeklyGateLabel({ model: 'Fable', weeklyGate: 'both' })).toBe('all models and Fable')
    expect(weeklyGateLabel({ model: ' ', weeklyGate: 'model' })).toBe('model')
  })
})

describe('limit resets', () => {
  it('describes what a reset clears', () => {
    expect(resetEffect(['five_hour', 'seven_day', 'seven_day_overage_included'])).toBe('The 5-hour and weekly limits go back to full right away.')
    expect(resetEffect(['seven_day'])).toBe('The weekly limit goes back to full right away.')
    expect(resetEffect([])).toBe('The usage limits go back to full right away.')
    expect(resetEffect(['something_new'])).toBe('The usage limits go back to full right away.')
  })

  it('picks the first credit the provider would spend', () => {
    const credit = (id: string | null) => ({ id, title: null, count: 1, expiresAt: null, clears: [] })
    expect(spendableReset({ available: 2, cooldownUntil: null, credits: [credit(null), credit('b')] })?.id).toBe('b')
    expect(spendableReset({ available: 1, cooldownUntil: null, credits: [credit(null)] })).toBeNull()
    expect(spendableReset(null)).toBeNull()
    expect(spendableReset(undefined)).toBeNull()
  })
})
