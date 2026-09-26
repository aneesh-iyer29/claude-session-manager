import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { AppState, NudgeMode, Settings, Strategy, WeeklyGate } from '@shared/types'
import type { Actions } from '../hooks/useActions'
import type { DraftKey, SettingsDraftApi } from '../hooks/useSettingsDraft'
import { formatAgo } from '../lib/format'
import { spring } from '../lib/motion'
import { ALERT_TO_MAX } from '../lib/sessions'
import { Button } from './Button'
import { SettingRow } from './SettingRow'
import { Toggle } from './Toggle'

export type SettingsSection = 'autoswap' | 'limits' | 'claude-code' | 'alerts' | 'general'

const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
  { id: 'autoswap', label: 'Auto-swap' },
  { id: 'limits', label: 'Swap lines' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'alerts', label: 'Session alerts' },
  { id: 'general', label: 'General' },
]

/** A section counts as current once its head scrolls within this many pixels of the top. */
const SPY_OFFSET = 32

interface Props {
  state: AppState
  now: Date
  actions: Actions
  draft: SettingsDraftApi
  /** Section to scroll to on open (from a dashboard "Settings" link), or null for the top. */
  initialSection: SettingsSection | null
  /** Done was pressed with unsaved changes: the save bar asks before leaving. */
  confirming: boolean
  onClose: () => void
}

/**
 * Every setting on one full-window page, grouped the way people think about
 * them, with a section list for jumping around. The dashboard stays about
 * status; nothing here is needed to read it.
 */
export function SettingsView({ state, now, actions, draft, initialSection, confirming, onClose }: Props) {
  const reduced = useReducedMotion()
  const content = useRef<HTMLDivElement>(null)
  const heads = useRef(new Map<SettingsSection, HTMLElement>())
  const [current, setCurrent] = useState<SettingsSection>(initialSection ?? 'autoswap')

  // Land on the requested section (or the top) and move focus into the page.
  useEffect(() => {
    const el = initialSection ? heads.current.get(initialSection) : null
    el?.scrollIntoView({ block: 'start' })
    content.current?.focus({ preventScroll: true })
  }, [initialSection])

  const jump = (id: SettingsSection) => {
    setCurrent(id)
    heads.current.get(id)?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
  }

  const onScroll = () => {
    const box = content.current
    if (!box) return
    const top = box.getBoundingClientRect().top + SPY_OFFSET
    let next: SettingsSection = SECTIONS[0]!.id
    for (const { id } of SECTIONS) {
      const el = heads.current.get(id)
      if (el && el.getBoundingClientRect().top <= top) next = id
    }
    // At the very bottom the last sections may never reach the top; the last one wins.
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) next = SECTIONS[SECTIONS.length - 1]!.id
    setCurrent(next)
  }

  const register = (id: SettingsSection) => (el: HTMLElement | null) => {
    if (el) heads.current.set(id, el)
    else heads.current.delete(id)
  }

  const save = async (close: boolean) => {
    const patch = draft.patch()
    const ok = patch ? await actions.updateSettings(patch, 'Settings saved') : true
    if (ok && close) onClose()
  }

  const props = { state, now, actions, draft }
  return (
    <>
      <nav className="settings__nav" aria-label="Settings sections">
        <span className="eyebrow settings__nav-title">Settings</span>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className="settings__nav-item" aria-current={current === s.id ? 'true' : undefined} onClick={() => jump(s.id)}>
            {s.label}
          </button>
        ))}
      </nav>

      <div className="settings__content" ref={content} tabIndex={-1} onScroll={onScroll} aria-label="Settings">
        <div className="settings__inner">
          <Section id="autoswap" title="Auto-swap" intro="Whether and how Session Manager switches Claude Code between your accounts." register={register}>
            <AutoswapSettings {...props} />
          </Section>
          <Section id="limits" title="Swap lines" intro="When the active account counts as out of room. The dashboard meters draw these lines." register={register}>
            <LimitSettings {...props} />
          </Section>
          <Section
            id="claude-code"
            title="Claude Code"
            intro={
              <>
                Hooks Session Manager can add to Claude Code. Each Install writes one script under <code>~/.claude/hooks</code> and registers it in{' '}
                <code>~/.claude/settings.json</code>; Remove takes exactly that back out. Sessions already open pick hooks up when restarted.
              </>
            }
            register={register}
          >
            <ClaudeCodeSettings {...props} />
          </Section>
          <Section id="alerts" title="Session alerts" intro="A text from your own iMessage when a Claude Code session is waiting on you. Needs the session hooks above." register={register}>
            <AlertSettings {...props} />
          </Section>
          <Section id="general" title="General" register={register}>
            <GeneralSettings {...props} />
          </Section>
        </div>

        <AnimatePresence>
          {draft.dirty ? (
            <motion.div
              className="settings__savebar"
              role="region"
              aria-label="Unsaved changes"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={spring}
            >
              <span className="settings__savebar-text" role={confirming ? 'alert' : undefined}>
                {confirming ? 'Save your changes before closing?' : 'Unsaved changes'}
              </span>
              {confirming ? (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => {
                    draft.revert()
                    onClose()
                  }}
                >
                  Discard
                </Button>
              ) : (
                <Button variant="quiet" size="sm" onClick={draft.revert}>
                  Revert
                </Button>
              )}
              <Button variant="primary" size="sm" disabled={actions.busy.has('settings')} onClick={() => void save(confirming)}>
                {actions.busy.has('settings') ? 'Saving…' : confirming ? 'Save and close' : 'Save'}
              </Button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </>
  )
}

function Section({
  id,
  title,
  intro,
  register,
  children,
}: {
  id: SettingsSection
  title: string
  intro?: ReactNode
  register: (id: SettingsSection) => (el: HTMLElement | null) => void
  children: ReactNode
}) {
  return (
    <section className="section settings__section" aria-labelledby={`settings-${id}`} ref={register(id)}>
      <div className="section__head">
        <h2 className="eyebrow settings__title" id={`settings-${id}`}>
          {title}
        </h2>
      </div>
      {intro ? <p className="settings__intro">{intro}</p> : null}
      <div className="card">
        <div className="toggle-list">{children}</div>
      </div>
    </section>
  )
}

interface SectionProps {
  state: AppState
  now: Date
  actions: Actions
  draft: SettingsDraftApi
}

/** A number field bound to a draft key; an emptied field falls back to the saved value rather than NaN. */
function NumberInput({ id, k, min, max, step, draft, saved }: { id: string; k: DraftKey; min: number; max?: number; step: number; draft: SettingsDraftApi; saved: Settings }) {
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.valueAsNumber
    draft.set(k, (Number.isNaN(v) ? saved[k] : v) as never)
  }
  return <input id={id} className="field__input field__input--num" type="number" min={min} max={max} step={step} value={draft.draft[k] as number} onChange={onChange} />
}

function AutoswapSettings({ state, actions, draft }: SectionProps) {
  const s = state.settings
  const saving = actions.busy.has('settings')
  const quick = (patch: Partial<Settings>, message: string) => void actions.updateSettings(patch, message)
  return (
    <>
      <Toggle
        label="Auto-swap"
        hint={s.autoswapEnabled ? 'Switches accounts on its own' : 'Off. Usage is still watched.'}
        checked={s.autoswapEnabled}
        disabled={saving}
        onChange={(v) => quick({ autoswapEnabled: v }, v ? 'Auto-swap armed' : 'Auto-swap off')}
      />
      <Toggle label="Dry run" hint="Log decisions without switching" checked={s.dryRun} disabled={saving} onChange={(v) => quick({ dryRun: v }, v ? 'Dry run on' : 'Dry run off')} />
      <Toggle
        label="Notifications"
        hint="A macOS notification on each automatic switch"
        checked={s.notify}
        disabled={saving}
        onChange={(v) => quick({ notify: v }, v ? 'Notifications on' : 'Notifications off')}
      />
      <SettingRow id="set-strategy" label="Strategy" hint="Best headroom switches only near a line; consume first spends the week that resets soonest">
        <select id="set-strategy" className="field__input field__input--wide" value={draft.draft.strategy} onChange={(e) => draft.set('strategy', e.target.value as Strategy)}>
          <option value="best">Best headroom</option>
          <option value="consume_first">Consume soonest reset first</option>
        </select>
      </SettingRow>
      <SettingRow id="set-cooldown" label="Cooldown (s)" hint="Minimum gap between automatic switches">
        <NumberInput id="set-cooldown" k="cooldownSeconds" min={0} step={30} draft={draft} saved={s} />
      </SettingRow>
      <SettingRow id="set-poll" label="Poll every (s)" hint="How often usage is checked; each account is fetched at most every 5 minutes">
        <NumberInput id="set-poll" k="pollIntervalSeconds" min={15} step={15} draft={draft} saved={s} />
      </SettingRow>
    </>
  )
}

function LimitSettings({ state, draft }: SectionProps) {
  const s = state.settings
  const model = draft.draft.model.trim()
  return (
    <>
      <SettingRow id="set-five" label="5-hour swap at (%)" hint="Swap when the active account’s 5-hour session reaches this">
        <NumberInput id="set-five" k="fiveHourThreshold" min={50} max={100} step={1} draft={draft} saved={s} />
      </SettingRow>
      <SettingRow id="set-weekly" label="Weekly swap at (%)" hint="Swap when the weekly limit that counts reaches this">
        <NumberInput id="set-weekly" k="threshold" min={50} max={100} step={1} draft={draft} saved={s} />
      </SettingRow>
      <SettingRow id="set-gate" label="Weekly limit" hint="Which weekly window counts toward swapping">
        <select id="set-gate" className="field__input field__input--wide" value={draft.draft.weeklyGate} onChange={(e) => draft.set('weeklyGate', e.target.value as WeeklyGate)}>
          <option value="all">All models</option>
          <option value="model">{model ? `${model} only` : 'Model only'}</option>
          <option value="both">Whichever is tighter</option>
        </select>
      </SettingRow>
      <SettingRow id="set-model" label="Gating model window" hint="Name of the per-model weekly window, as Anthropic reports it">
        <input id="set-model" className="field__input field__input--wide" type="text" value={draft.draft.model} maxLength={40} onChange={(e) => draft.set('model', e.target.value)} />
      </SettingRow>
      <SettingRow id="set-margin" label="Margin (%)" hint="A target must have at least this much more headroom than the active account">
        <NumberInput id="set-margin" k="margin" min={0} max={50} step={1} draft={draft} saved={s} />
      </SettingRow>
      <SettingRow id="set-warn" label="Warn at (%)" hint="From here the compact nudge is raised, and a weekly window can take over the gauge">
        <NumberInput id="set-warn" k="warnPct" min={50} max={100} step={1} draft={draft} saved={s} />
      </SettingRow>
    </>
  )
}

/** One Claude Code integration: what it does or how it is doing, and Install / Remove. */
function IntegrationRow({ label, hint, installed, busy, onInstall, onRemove }: { label: string; hint: string; installed: boolean; busy: boolean; onInstall: () => void; onRemove: () => void }) {
  return (
    <div className="toggle-row setting-row">
      <div className="setting-row__text">
        <span className="toggle-row__label">{label}</span>
        <span className="toggle-row__hint">{hint}</span>
      </div>
      <div className="setting-row__control">
        <Button size="sm" variant={installed ? 'default' : 'primary'} disabled={busy} onClick={installed ? onRemove : onInstall} aria-label={`${installed ? 'Remove' : 'Install'} ${label}`}>
          {busy ? 'Working…' : installed ? 'Remove' : 'Install'}
        </Button>
      </div>
    </div>
  )
}

function ClaudeCodeSettings({ state, now, actions, draft }: SectionProps) {
  const feed = state.liveFeed
  const nudge = state.nudge
  return (
    <>
      <IntegrationRow
        label="Status line feed"
        hint={
          feed.installed
            ? feed.lastAt
              ? `Live from Claude Code · last update ${formatAgo(feed.lastAt, now)}`
              : 'Installed. Updates once Claude Code sends its first message.'
            : 'Reads the active account’s 5-hour and weekly usage from Claude Code itself, no polling. An existing status line keeps running.'
        }
        installed={feed.installed}
        busy={actions.busy.has('feed')}
        onInstall={() => void actions.installFeed()}
        onRemove={() => void actions.uninstallFeed()}
      />
      <IntegrationRow
        label="Compact nudge"
        hint={
          nudge.hookInstalled
            ? nudge.pending
              ? `Active: ${nudge.pending.label} at ${nudge.pending.pct}% of ${nudge.pending.window}`
              : `Installed. Fires when the active account reaches ${state.settings.warnPct}%.`
            : 'Asks you to /compact in Claude Code before an auto-swap, so the conversation isn’t re-cached on the next account.'
        }
        installed={nudge.hookInstalled}
        busy={actions.busy.has('hook')}
        onInstall={() => void actions.installHook()}
        onRemove={() => void actions.uninstallHook()}
      />
      <SettingRow id="set-nudge" label="Nudge" hint="What the compact nudge does when a swap is near">
        <select id="set-nudge" className="field__input field__input--wide" value={draft.draft.nudgeMode} onChange={(e) => draft.set('nudgeMode', e.target.value as NudgeMode)}>
          <option value="block">Block the next prompt once</option>
          <option value="context">Only tell Claude</option>
        </select>
      </SettingRow>
      <IntegrationRow
        label="Session hooks"
        hint={
          state.sessions.hooksInstalled
            ? 'Installed. Sessions report to the dashboard as they change.'
            : 'Lets Session Manager see which sessions are working and which are waiting on you. Records only the session, its folder and the question asked.'
        }
        installed={state.sessions.hooksInstalled}
        busy={actions.busy.has('sessions-hook')}
        onInstall={() => void actions.installSessionHooks()}
        onRemove={() => void actions.uninstallSessionHooks()}
      />
    </>
  )
}

function AlertSettings({ state, now, actions, draft }: SectionProps) {
  const s = state.settings
  const saving = actions.busy.has('settings')
  const handle = s.alertTo
  const hooks = state.sessions.hooksInstalled
  const handleDirty = draft.dirty && (draft.patch() ?? {}).alertTo !== undefined
  const testBlocker = !handle ? 'Save a number or email first' : handleDirty ? 'Save the new number first' : undefined
  const alertsHint = !handle ? 'Set the number or email above first' : !hooks && !s.alertsEnabled ? 'Install the session hooks first' : `iMessage to ${handle}`
  return (
    <>
      <SettingRow id="set-alert-to" label="Send texts to" hint="Phone number or Apple ID email. Texts come from the iMessage account on this Mac.">
        <input
          id="set-alert-to"
          className="field__input field__input--wide"
          type="text"
          value={draft.draft.alertTo}
          maxLength={ALERT_TO_MAX}
          placeholder="+1 555 123 4567 or you@icloud.com"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => draft.set('alertTo', e.target.value)}
        />
      </SettingRow>
      <SettingRow id="set-alert-after" label="Text after (min)" hint="How long a session waits on you before the text goes out">
        <NumberInput id="set-alert-after" k="alertAfterMinutes" min={1} max={60} step={1} draft={draft} saved={s} />
      </SettingRow>
      <div className="toggle-row setting-row">
        <div className="setting-row__text">
          <span className="toggle-row__label">Test message</span>
          <span className="toggle-row__hint">
            {state.sessions.lastAlertAt
              ? `Last text ${formatAgo(state.sessions.lastAlertAt, now)}.`
              : 'Sends one text to the saved number. The first time, macOS asks to let Session Manager control Messages.'}
          </span>
        </div>
        <div className="setting-row__control">
          <Button size="sm" disabled={actions.busy.has('test-alert') || testBlocker != null} title={testBlocker} onClick={() => void actions.sendTestAlert()}>
            {actions.busy.has('test-alert') ? 'Sending…' : 'Send test'}
          </Button>
        </div>
      </div>
      <Toggle
        label="Text me when a session needs me"
        hint={alertsHint}
        checked={s.alertsEnabled}
        disabled={saving || (!s.alertsEnabled && (!handle || !hooks))}
        onChange={(v) => void actions.updateSettings({ alertsEnabled: v }, v ? 'Session alerts on' : 'Session alerts off')}
      />
      <Toggle
        label="Only when I’m away"
        hint="Only if the Mac has had no keyboard or mouse input since the session started waiting"
        checked={s.alertOnlyWhenAway}
        disabled={saving}
        onChange={(v) => void actions.updateSettings({ alertOnlyWhenAway: v }, v ? 'Texts only when you’re away' : 'Texts whether or not you’re away')}
      />
    </>
  )
}

function GeneralSettings({ state, actions }: SectionProps) {
  const s = state.settings
  const saving = actions.busy.has('settings')
  const quick = (patch: Partial<Settings>, message: string) => void actions.updateSettings(patch, message)
  return (
    <>
      <Toggle
        label="Codex panel"
        hint="The Codex CLI’s quota on the dashboard"
        checked={s.codexEnabled}
        disabled={saving}
        onChange={(v) => quick({ codexEnabled: v }, v ? 'Codex shown' : 'Codex hidden')}
      />
      <Toggle label="Launch at login" checked={s.launchAtLogin} disabled={saving} onChange={(v) => quick({ launchAtLogin: v }, v ? 'Will launch at login' : "Won't launch at login")} />
      <Toggle
        label="Show in Dock"
        hint={s.showInDock ? 'Also in the menu bar' : 'Menu bar only'}
        checked={s.showInDock}
        disabled={saving}
        onChange={(v) => quick({ showInDock: v }, v ? 'Shown in Dock' : 'Hidden from Dock')}
      />
      <div className="toggle-row setting-row">
        <div className="setting-row__text">
          <span className="toggle-row__label">Data folder</span>
          <span className="toggle-row__hint">Settings, accounts, usage and the activity log · version {state.version}</span>
        </div>
        <div className="setting-row__control">
          <Button size="sm" onClick={() => void actions.openDataFolder()}>
            Open
          </Button>
        </div>
      </div>
    </>
  )
}
