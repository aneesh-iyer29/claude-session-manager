import { useEffect, useState, type ChangeEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { AppState, ClaudeSession, Settings } from '@shared/types'
import type { Actions } from '../hooks/useActions'
import { formatAgo, formatClock, formatElapsed } from '../lib/format'
import { spring } from '../lib/motion'
import { ALERT_TO_MAX, SESSION_STATE_LABEL, normalizeAlertTo, waitingCount, waitingLabel } from '../lib/sessions'
import { Button } from './Button'
import { Toggle } from './Toggle'

interface Props {
  state: AppState
  now: Date
  actions: Actions
}

/**
 * Every Claude Code session the hooks have reported, and the iMessage alert
 * for when one is blocked on the user. Without the hooks the app sees
 * nothing, so until they are installed the panel is just the offer to
 * install them.
 */
export function SessionsPanel({ state, now, actions }: Props) {
  const { hooksInstalled, sessions } = state.sessions
  const waiting = waitingCount(sessions)
  return (
    <section className="section panel" aria-label="Claude Code sessions">
      <div className="section__head">
        <span className="eyebrow">Claude Code sessions</span>
        {waiting > 0 ? <span className="badge badge--warn">{waitingLabel(waiting)}</span> : null}
      </div>

      {hooksInstalled ? null : (
        <div className="card panel">
          <HooksRow installed={false} actions={actions} />
        </div>
      )}
      {hooksInstalled || sessions.length > 0 ? <SessionList sessions={sessions} now={now} /> : null}
      {hooksInstalled ? <AlertsCard state={state} now={now} actions={actions} /> : null}
    </section>
  )
}

/**
 * Rows fade in and out and slide into place when a session's state change
 * moves it to the top. `layout="position"` keeps a row whose detail line
 * appears from being scaled mid-animation; under reduced motion MotionConfig
 * drops the slide and only the fade remains.
 */
function SessionList({ sessions, now }: { sessions: ClaudeSession[]; now: Date }) {
  return (
    <div className="card">
      {sessions.length === 0 ? <p className="sessions__empty">No sessions yet. Open Claude Code and they show up here.</p> : null}
      <ol className="sessions" aria-label="Sessions">
        <AnimatePresence initial={false} mode="popLayout">
          {sessions.map((s) => (
            <motion.li
              key={s.id}
              layout="position"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={spring}
              className={`session session--${s.state}`}
            >
              <SessionRow session={s} now={now} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </div>
  )
}

/** Project, what it is doing, for how long, and what it is waiting on. */
function SessionRow({ session: s, now }: { session: ClaudeSession; now: Date }) {
  return (
    <>
      <span className="session__mark" aria-hidden />
      <span className="session__project" title={s.cwd}>
        {s.project}
      </span>
      <span className="session__status">
        <span className="session__state">{SESSION_STATE_LABEL[s.state]}</span>
        {s.alertedAt ? (
          <span className="session__texted" title={`Texted at ${formatClock(s.alertedAt)}`}>
            Texted
          </span>
        ) : null}
      </span>
      <span className="session__time" title={`Since ${formatClock(s.since)}`}>
        <span className="sr-only">for </span>
        {formatElapsed(s.since, now)}
      </span>
      {s.detail ? (
        <p className="session__detail" title={s.detail}>
          {s.detail}
        </p>
      ) : null}
    </>
  )
}

type Draft = Pick<Settings, 'alertTo' | 'alertAfterMinutes'>

const pick = (s: Settings): Draft => ({ alertTo: s.alertTo, alertAfterMinutes: s.alertAfterMinutes })

/** Compare handles in the stored form, so "+1 555 123 4567" equals the "+15551234567" it saves as. */
const stored = (handle: string) => normalizeAlertTo(handle) ?? handle
const same = (a: Draft, b: Draft) => stored(a.alertTo) === stored(b.alertTo) && a.alertAfterMinutes === b.alertAfterMinutes

/**
 * The alert settings. The toggles save at once; the handle and the delay edit
 * a draft with one Save, like the auto-swap numbers, so a half-typed number is
 * never texted. Send test only uses the saved handle, so it waits for Save.
 */
function AlertsCard({ state, now, actions }: Props) {
  const settings = state.settings
  const [draft, setDraft] = useState<Draft>(() => pick(settings))
  const saving = actions.busy.has('settings')
  const testing = actions.busy.has('test-alert')
  const dirty = !same(draft, pick(settings))

  // Adopt backend changes unless the user is mid-edit; also adopt our own save
  // once it comes back normalized, so the field shows what is stored.
  const [seen, setSeen] = useState(settings)
  useEffect(() => {
    if (seen === settings) return
    const before = pick(seen)
    setSeen(settings)
    if (same(draft, before) || same(draft, pick(settings))) setDraft(pick(settings))
  }, [settings, seen, draft])

  const onMinutes = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.valueAsNumber
    setDraft((d) => ({ ...d, alertAfterMinutes: Number.isNaN(v) ? settings.alertAfterMinutes : v }))
  }

  const save = () => {
    // The daemon refuses alerts with nowhere to send them, so clearing the handle turns them off too.
    const clearing = draft.alertTo.trim() === '' && settings.alertsEnabled
    return actions.updateSettings(clearing ? { ...draft, alertsEnabled: false } : draft, clearing ? 'Session alerts off' : 'Alert settings saved')
  }

  const handle = settings.alertTo
  const testBlocker = !handle ? 'Set a number or email first' : dirty ? 'Save first' : undefined

  return (
    <div className="card panel">
      <div className="toggle-list">
        <Toggle
          label="Text me when a session needs me"
          hint={handle ? `iMessage to ${handle}` : 'Set a number or email below first'}
          checked={settings.alertsEnabled}
          disabled={saving || (!handle && !settings.alertsEnabled)}
          onChange={(v) => actions.updateSettings({ alertsEnabled: v }, v ? 'Session alerts on' : 'Session alerts off')}
        />
        <Toggle
          label="Only when I’m away"
          hint="Only if the Mac has had no keyboard or mouse input since the session started waiting"
          checked={settings.alertOnlyWhenAway}
          disabled={saving}
          onChange={(v) => actions.updateSettings({ alertOnlyWhenAway: v }, v ? 'Texts only when you’re away' : 'Texts whether or not you’re away')}
        />
      </div>

      <div className="field-grid">
        <label className="field field--wide">
          <span className="field__label">iMessage to</span>
          <input
            className="field__input"
            type="text"
            value={draft.alertTo}
            maxLength={ALERT_TO_MAX}
            placeholder="+1 555 123 4567 or you@icloud.com"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setDraft((d) => ({ ...d, alertTo: e.target.value }))}
          />
        </label>
        <label className="field">
          <span className="field__label">Text after (min)</span>
          <input className="field__input" type="number" min={1} max={60} step={1} value={draft.alertAfterMinutes} onChange={onMinutes} />
        </label>
      </div>

      <div className="panel__actions">
        <Button size="sm" disabled={testing || testBlocker != null} title={testBlocker} onClick={() => actions.sendTestAlert()}>
          {testing ? 'Sending…' : 'Send test'}
        </Button>
        <span className="spacer" />
        {dirty ? (
          <Button variant="quiet" size="sm" onClick={() => setDraft(pick(settings))}>
            Revert
          </Button>
        ) : null}
        <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {state.sessions.lastAlertAt ? (
        <div className="sessions__last">
          Last text <span className="mono">{formatAgo(state.sessions.lastAlertAt, now)}</span>
        </div>
      ) : null}

      <HooksRow installed actions={actions} ruled />
    </div>
  )
}

/**
 * Installing writes one hook script and registers it for the Claude Code
 * events that show a session waiting on the user; removing takes exactly that
 * back out. The same row offers either, like the feed and nudge rows.
 */
function HooksRow({ installed, actions, ruled = false }: { installed: boolean; actions: Actions; ruled?: boolean }) {
  const busy = actions.busy.has('sessions-hook')
  return (
    <div className={`hook-row${ruled ? ' hook-row--ruled' : ''}`}>
      <div className="hook-row__text">
        <span className="toggle-row__label">Claude Code session hooks</span>
        <span className="toggle-row__hint">
          {installed ? 'Installed. Sessions report here as they change.' : 'Adds hooks so Session Manager can see when a session is waiting on you.'}
        </span>
      </div>
      <Button
        size="sm"
        variant={installed ? 'default' : 'primary'}
        disabled={busy}
        onClick={() => (installed ? actions.uninstallSessionHooks() : actions.installSessionHooks())}
      >
        {busy ? 'Working…' : installed ? 'Remove' : 'Install'}
      </Button>
    </div>
  )
}
