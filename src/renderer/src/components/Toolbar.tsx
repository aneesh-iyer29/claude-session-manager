import type { AppState } from '@shared/types'
import type { Actions } from '../hooks/useActions'
import { formatAgo } from '../lib/format'
import { Button } from './Button'
import { RefreshButton } from './RefreshButton'

export type View = 'dashboard' | 'settings'

/** The toolbar's Settings button; focus returns here when Settings closes. */
export const SETTINGS_BUTTON_ID = 'toolbar-settings'

interface Props {
  state: AppState
  now: Date
  actions: Actions
  view: View
  onOpenSettings: () => void
  onDone: () => void
}

export type ArmedState = 'armed' | 'dry' | 'off'

export function armedState(settings: AppState['settings']): ArmedState {
  if (!settings.autoswapEnabled) return 'off'
  return settings.dryRun ? 'dry' : 'armed'
}

/**
 * Translucent title strip under the hidden macOS title bar. The whole strip
 * drags the window; the controls opt out so clicks reach them. Its Refresh
 * covers the Claude accounts only; the Codex panel carries its own. In
 * Settings the Refresh and Settings buttons give way to Done.
 */
export function Toolbar({ state, now, actions, view, onOpenSettings, onDone }: Props) {
  const armed = armedState(state.settings)
  const refreshing = actions.busy.has('refresh') || state.polling.inFlight
  return (
    <header className="toolbar">
      <span className="toolbar__title">Session Manager</span>
      <div className="toolbar__controls">
        <ArmedPill armed={armed} />
        <span className="toolbar__age" aria-live="polite">
          {formatAgo(state.polling.lastPollAt, now)}
        </span>
        {view === 'settings' ? (
          <Button size="sm" variant="primary" onClick={onDone} aria-keyshortcuts="Escape">
            Done
          </Button>
        ) : (
          <>
            <RefreshButton spinning={refreshing} onClick={() => actions.refresh()} label="Refresh Claude" ariaLabel="Refresh Claude usage" />
            <Button size="sm" id={SETTINGS_BUTTON_ID} onClick={onOpenSettings} aria-keyshortcuts="Meta+Comma">
              <SlidersGlyph />
              Settings
            </Button>
          </>
        )}
      </div>
    </header>
  )
}

/** Three sliders: the settings mark, drawn like the refresh glyph (2 px stroke, currentColor). */
function SlidersGlyph() {
  return (
    <svg className="btn__glyph" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <path d="M15 4v4M9 10v4M17 16v4" />
    </svg>
  )
}

export function ArmedPill({ armed }: { armed: ArmedState }) {
  if (armed === 'armed')
    return (
      <span className="pill pill--armed">
        <span className="pill__dot" aria-hidden />
        Auto-swap armed
      </span>
    )
  if (armed === 'dry')
    return (
      <span className="pill pill--dry">
        <span className="pill__dot" aria-hidden />
        Auto-swap dry run
      </span>
    )
  return <span className="pill">Auto-swap off</span>
}
