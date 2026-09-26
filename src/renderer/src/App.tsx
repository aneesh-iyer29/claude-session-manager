import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from 'motion/react'
import type { AppState } from '@shared/types'
import { AccountCard } from './components/AccountCard'
import { ActivityPanel } from './components/ActivityPanel'
import { AddAccountRow } from './components/AddAccountRow'
import { AutoswapPanel } from './components/AutoswapPanel'
import { CodexPanel } from './components/CodexPanel'
import { EmptyState } from './components/EmptyState'
import { HeroCard } from './components/HeroCard'
import { SessionsPanel } from './components/SessionsPanel'
import { SettingsView, type SettingsSection } from './components/SettingsView'
import { Toasts } from './components/Toasts'
import { SETTINGS_BUTTON_ID, Toolbar, type View } from './components/Toolbar'
import { useActions, type Actions } from './hooks/useActions'
import { useAppState } from './hooks/useAppState'
import { useClock } from './hooks/useClock'
import { useLogin } from './hooks/useLogin'
import { useSettingsDraft } from './hooks/useSettingsDraft'
import { ToastProvider } from './hooks/useToasts'
import { fade } from './lib/motion'

export function App() {
  return (
    <ToastProvider>
      {/* reducedMotion="user" drops transforms and layout moves; opacity fades stay. */}
      <MotionConfig reducedMotion="user">
        <Shell />
        <Toasts />
      </MotionConfig>
    </ToastProvider>
  )
}

function Shell() {
  const state = useAppState()
  if (!state) return null
  return <Window state={state} />
}

/**
 * The window is either the dashboard (status, one-click actions) or Settings
 * (every knob), never both. The settings draft lives here, above both, so
 * leaving Settings with unsaved edits can be caught and asked about instead
 * of silently dropping them.
 */
function Window({ state }: { state: AppState }) {
  const now = useClock()
  const actions = useActions()
  const draft = useSettingsDraft(state.settings)
  const [view, setView] = useState<View>('dashboard')
  const [section, setSection] = useState<SettingsSection | null>(null)
  const [confirming, setConfirming] = useState(false)
  const wasSettings = useRef(false)

  const openSettings = useCallback((at: SettingsSection | null = null) => {
    setSection(at)
    setView('settings')
  }, [])
  const close = useCallback(() => {
    setConfirming(false)
    setView('dashboard')
  }, [])
  const requestClose = useCallback(() => (draft.dirty ? setConfirming(true) : close()), [draft.dirty, close])

  // Reverting or saving answers the question on its own.
  useEffect(() => {
    if (!draft.dirty) setConfirming(false)
  }, [draft.dirty])

  // Back on the dashboard, focus returns to the button that opened Settings.
  useEffect(() => {
    if (view === 'dashboard' && wasSettings.current) document.getElementById(SETTINGS_BUTTON_ID)?.focus()
    wasSettings.current = view === 'settings'
  }, [view])

  // ⌘, opens (or closes) Settings, as in every Mac app; Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        if (view === 'settings') requestClose()
        else openSettings()
      } else if (e.key === 'Escape' && view === 'settings' && !e.defaultPrevented) {
        if (confirming) setConfirming(false)
        else requestClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, confirming, requestClose, openSettings])

  return (
    <motion.div className="app" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fade}>
      <Toolbar state={state} now={now} actions={actions} view={view} onOpenSettings={() => openSettings()} onDone={requestClose} />
      <AnimatePresence mode="wait" initial={false}>
        {view === 'settings' ? (
          <motion.main key="settings" className="main main--settings" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
            <SettingsView state={state} now={now} actions={actions} draft={draft} initialSection={section} confirming={confirming} onClose={close} />
          </motion.main>
        ) : (
          <motion.main key="dashboard" className="main" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
            <Dashboard state={state} now={now} actions={actions} onOpenSettings={openSettings} />
          </motion.main>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function Dashboard({ state, now, actions, onOpenSettings }: { state: AppState; now: Date; actions: Actions; onOpenSettings: (section: SettingsSection) => void }) {
  const login = useLogin()

  const active = state.accounts.find((a) => a.active) ?? state.accounts.find((a) => a.id === state.activeId) ?? null
  const standby = state.accounts
    .filter((a) => a.id !== active?.id)
    .sort((a, b) => Number(a.disabled) - Number(b.disabled) || (b.headroom ?? -1) - (a.headroom ?? -1))

  return (
    <>
      <LayoutGroup>
        {/* layoutScroll: this column scrolls, so layout animations must account for its offset. */}
        <motion.div className="col col--left" layoutScroll>
          <section className="section" aria-label="Active">
            <div className="section__head">
              <span className="eyebrow">Active</span>
            </div>
            {active ? <HeroCard account={active} settings={state.settings} now={now} actions={actions} nudge={state.nudge.pending} /> : null}
            {!active && state.accounts.length === 0 ? <EmptyState actions={actions} login={login} /> : null}
            {!active && state.accounts.length > 0 ? (
              <div className="card">
                <p className="card__note" style={{ marginTop: 0 }}>
                  None of these accounts matches Claude Code's current login. Switch to one, or capture the current login.
                </p>
              </div>
            ) : null}
          </section>

          {standby.length > 0 ? (
            <section className="section" aria-label="Standby">
              <div className="section__head">
                <span className="eyebrow">Standby ({standby.length})</span>
              </div>
              <div className="standby-grid">
                {standby.map((a) => (
                  <AccountCard key={a.id} account={a} settings={state.settings} now={now} actions={actions} />
                ))}
              </div>
            </section>
          ) : null}

          {state.accounts.length > 0 ? <AddAccountRow actions={actions} login={login} /> : null}
        </motion.div>
      </LayoutGroup>

      {/* layoutScroll: session rows animate position inside this scrolling column. */}
      <motion.aside className="col col--right" layoutScroll>
        {state.settings.codexEnabled ? <CodexPanel codex={state.codex} now={now} actions={actions} /> : null}
        <SessionsPanel state={state} now={now} onOpenSettings={onOpenSettings} />
        <AutoswapPanel state={state} actions={actions} onOpenSettings={onOpenSettings} />
        <ActivityPanel events={state.events} now={now} />
      </motion.aside>
    </>
  )
}
