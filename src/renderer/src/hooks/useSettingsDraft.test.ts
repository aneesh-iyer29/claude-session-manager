import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { changedKeys, draftPatch, pickDraft } from './useSettingsDraft'

const saved: Settings = { ...DEFAULT_SETTINGS, alertTo: '+15551234567', alertsEnabled: true }

describe('settings draft', () => {
  it('sends only the fields that changed', () => {
    expect(draftPatch(pickDraft(saved), saved)).toBeNull()
    const draft = { ...pickDraft(saved), threshold: 95, weeklyGate: 'all' as const }
    expect(draftPatch(draft, saved)).toEqual({ threshold: 95, weeklyGate: 'all' })
  })

  it('treats a reformatted phone number as unchanged', () => {
    const draft = { ...pickDraft(saved), alertTo: '+1 (555) 123-4567' }
    expect(changedKeys(draft, pickDraft(saved))).toEqual([])
    expect(draftPatch(draft, saved)).toBeNull()
  })

  it('turns alerts off in the same save that clears the number', () => {
    const draft = { ...pickDraft(saved), alertTo: '  ' }
    expect(draftPatch(draft, saved)).toEqual({ alertTo: '  ', alertsEnabled: false })
    expect(draftPatch(draft, { ...saved, alertsEnabled: false })).toEqual({ alertTo: '  ' })
  })
})
