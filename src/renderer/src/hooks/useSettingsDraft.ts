/**
 * The Settings view's typed fields (numbers, text, selects) as one draft with
 * one Save. A half-typed threshold or phone number must never reach the
 * daemon, so these only apply on Save; switches are complete decisions and
 * save the moment they flip, outside this draft.
 */
import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { normalizeAlertTo } from '../lib/sessions'

export const DRAFT_KEYS = [
  'strategy',
  'cooldownSeconds',
  'pollIntervalSeconds',
  'fiveHourThreshold',
  'threshold',
  'weeklyGate',
  'model',
  'margin',
  'warnPct',
  'nudgeMode',
  'alertTo',
  'alertAfterMinutes',
] as const satisfies readonly (keyof Settings)[]

export type DraftKey = (typeof DRAFT_KEYS)[number]
export type SettingsDraft = Pick<Settings, DraftKey>

export interface SettingsDraftApi {
  draft: SettingsDraft
  set: <K extends DraftKey>(key: K, value: SettingsDraft[K]) => void
  dirty: boolean
  revert: () => void
  /** The changed fields as a settings patch, or null when nothing changed. */
  patch: () => Partial<Settings> | null
}

export function pickDraft(s: Settings): SettingsDraft {
  const out = {} as Record<DraftKey, unknown>
  for (const key of DRAFT_KEYS) out[key] = s[key]
  return out as SettingsDraft
}

/** A handle compares in the form the daemon stores, so "+1 555 123 4567" equals the saved "+15551234567". */
function sameValue(key: DraftKey, a: unknown, b: unknown): boolean {
  if (key === 'alertTo' && typeof a === 'string' && typeof b === 'string') {
    return (normalizeAlertTo(a) ?? a) === (normalizeAlertTo(b) ?? b)
  }
  return a === b
}

export function changedKeys(draft: SettingsDraft, saved: SettingsDraft): DraftKey[] {
  return DRAFT_KEYS.filter((key) => !sameValue(key, draft[key], saved[key]))
}

/**
 * Only the fields that changed, so saving the swap lines never re-sends (and
 * re-validates) an untouched phone number. Clearing the handle while alerts
 * are on turns them off in the same patch: the daemon refuses alerts with
 * nowhere to send them.
 */
export function draftPatch(draft: SettingsDraft, settings: Settings): Partial<Settings> | null {
  const keys = changedKeys(draft, pickDraft(settings))
  if (keys.length === 0) return null
  const patch: Partial<Settings> = {}
  for (const key of keys) (patch as Record<string, unknown>)[key] = draft[key]
  if (keys.includes('alertTo') && draft.alertTo.trim() === '' && settings.alertsEnabled) patch.alertsEnabled = false
  return patch
}

export function useSettingsDraft(settings: Settings): SettingsDraftApi {
  const [draft, setDraft] = useState<SettingsDraft>(() => pickDraft(settings))

  // Adopt backend changes (another window, a save coming back normalized)
  // field by field, leaving alone whatever the user is mid-way through editing.
  const [seen, setSeen] = useState(settings)
  useEffect(() => {
    if (seen === settings) return
    const before = pickDraft(seen)
    const after = pickDraft(settings)
    setSeen(settings)
    setDraft((d) => {
      const next = { ...d } as Record<DraftKey, unknown>
      for (const key of DRAFT_KEYS) if (sameValue(key, d[key], before[key]) || sameValue(key, d[key], after[key])) next[key] = after[key]
      return next as SettingsDraft
    })
  }, [settings, seen])

  return {
    draft,
    set: (key, value) => setDraft((d) => ({ ...d, [key]: value })),
    dirty: changedKeys(draft, pickDraft(settings)).length > 0,
    revert: () => setDraft(pickDraft(settings)),
    patch: () => draftPatch(draft, settings),
  }
}
