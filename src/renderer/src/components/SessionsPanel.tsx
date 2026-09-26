import { AnimatePresence, motion } from 'motion/react'
import type { AppState, ClaudeSession } from '@shared/types'
import { formatAgo, formatClock, formatElapsed } from '../lib/format'
import { spring } from '../lib/motion'
import { SESSION_STATE_LABEL, waitingCount, waitingLabel } from '../lib/sessions'
import { Button } from './Button'
import type { SettingsSection } from './SettingsView'

interface Props {
  state: AppState
  now: Date
  onOpenSettings: (section: SettingsSection) => void
}

/**
 * Every Claude Code session the hooks have reported, and whether texts are
 * going out about them. Setting any of it up happens in Settings; without the
 * hooks the app sees no sessions, so until then the panel points there.
 */
export function SessionsPanel({ state, now, onOpenSettings }: Props) {
  const { hooksInstalled, sessions } = state.sessions
  const waiting = waitingCount(sessions)
  return (
    <section className="section panel" aria-label="Claude Code sessions">
      <div className="section__head">
        <span className="eyebrow">Claude Code sessions</span>
        {waiting > 0 ? <span className="badge badge--warn">{waitingLabel(waiting)}</span> : null}
      </div>

      {hooksInstalled ? null : (
        <div className="card hook-row">
          <span className="toggle-row__hint">Install the session hooks to see which Claude Code sessions are working and which are waiting on you.</span>
          <Button size="sm" variant="primary" onClick={() => onOpenSettings('claude-code')}>
            Set up
          </Button>
        </div>
      )}
      {hooksInstalled || sessions.length > 0 ? <SessionList sessions={sessions} now={now} /> : null}
      {hooksInstalled ? <AlertStatus state={state} now={now} onOpenSettings={onOpenSettings} /> : null}
    </section>
  )
}

/** One quiet line: are texts going out, and to where. The switch and the number live in Settings. */
function AlertStatus({ state, now, onOpenSettings }: Props) {
  const s = state.settings
  const last = state.sessions.lastAlertAt
  const text = !s.alertsEnabled
    ? 'Texts off'
    : `Texting ${s.alertTo}${s.alertOnlyWhenAway ? ' when you’re away' : ''}${last ? ` · last ${formatAgo(last, now)}` : ''}`
  return (
    <div className="sessions__status">
      <span>{text}</span>
      <Button variant="quiet" size="sm" onClick={() => onOpenSettings('alerts')}>
        {s.alertsEnabled ? 'Change' : 'Set up'}
      </Button>
    </div>
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
