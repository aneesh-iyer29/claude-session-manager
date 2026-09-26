import type { AppState, Decision } from '@shared/types'
import type { Actions } from '../hooks/useActions'
import { formatDuration, weeklyGateLabel } from '../lib/format'
import { Button } from './Button'
import type { SettingsSection } from './SettingsView'
import { Toggle } from './Toggle'

interface Props {
  state: AppState
  actions: Actions
  onOpenSettings: (section: SettingsSection) => void
}

/**
 * The dashboard's view of the policy: what it is set to, what it last
 * decided, and the one switch worth having at hand. Every knob behind it
 * lives in Settings.
 */
export function AutoswapPanel({ state, actions, onOpenSettings }: Props) {
  const settings = state.settings
  return (
    <section className="section panel" aria-label="Auto-swap">
      <div className="section__head">
        <span className="eyebrow">Auto-swap</span>
        <Button variant="quiet" size="sm" onClick={() => onOpenSettings('autoswap')}>
          Settings
        </Button>
      </div>

      <div className="card panel">
        <div className="panel__summary">
          5-hour at {settings.fiveHourThreshold} · weekly ({weeklyGateLabel(settings)}) at {settings.threshold} · margin {settings.margin} · cooldown{' '}
          {formatDuration(settings.cooldownSeconds)} · every {formatDuration(settings.pollIntervalSeconds)}
        </div>
        <DecisionLine decision={state.autoswap.lastDecision} state={state} />
        <div className="toggle-list">
          <Toggle
            label="Auto-swap"
            hint={settings.autoswapEnabled ? (settings.dryRun ? 'Dry run: decisions are logged, nothing switches' : 'Switches accounts on its own') : 'Off. Usage is still watched.'}
            checked={settings.autoswapEnabled}
            disabled={actions.busy.has('settings')}
            onChange={(v) => void actions.updateSettings({ autoswapEnabled: v }, v ? 'Auto-swap armed' : 'Auto-swap off')}
          />
        </div>
      </div>
    </section>
  )
}

function DecisionLine({ decision, state }: { decision: Decision | null; state: AppState }) {
  if (!decision) return <div className="panel__decision">No decision yet.</div>
  const target = decision.targetId ? state.accounts.find((a) => a.id === decision.targetId) : null
  const label = decision.action === 'switch' && target ? `switch → ${target.alias || target.email}` : decision.action
  return (
    <div className="panel__decision">
      <span className={`panel__decision-action panel__decision-action--${decision.action}`}>{label}</span>
      <span>— {decision.reason}</span>
    </div>
  )
}
