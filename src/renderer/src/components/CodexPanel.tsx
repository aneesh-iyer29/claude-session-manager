import type { CodexState } from '@shared/types'
import type { Actions } from '../hooks/useActions'
import { formatAgo, formatPlan } from '../lib/format'
import { MeterRow } from './Meter'
import { RefreshButton } from './RefreshButton'
import { ResetRow } from './ResetRow'

interface Props {
  codex: CodexState
  now: Date
  actions: Actions
}

/**
 * Quota for the one Codex login. Nothing here switches anything; the only
 * write is spending a banked limit reset, behind a confirmation.
 * The header's Refresh re-fetches only Codex, so after `codex login` the new
 * account shows up without waiting for the next poll; the toolbar's Refresh
 * leaves Codex alone. Hiding the panel is a setting (Settings → General), and
 * the dashboard leaves it out entirely then.
 */
export function CodexPanel({ codex, now, actions }: Props) {
  const refreshing = actions.busy.has('refresh:codex')
  const fetchedAt = codex.usage?.fetchedAt ?? null
  return (
    <section className="section" aria-label="Codex">
      <div className="section__head">
        <span className="eyebrow">Codex</span>
        <div className="section__actions">
          {fetchedAt ? <span className="section__age">{formatAgo(fetchedAt, now)}</span> : null}
          <RefreshButton variant="quiet" spinning={refreshing} onClick={() => actions.refreshCodex()} label="Refresh" ariaLabel="Refresh Codex usage" />
        </div>
      </div>
      <div className="card">
        <CodexBody codex={codex} now={now} actions={actions} />
      </div>
    </section>
  )
}

function CodexBody({ codex, now, actions }: { codex: CodexState; now: Date; actions: Actions }) {
  if (!codex.configured)
    return (
      <p className="card__note" style={{ marginTop: 0 }}>
        Not logged in. Run <span className="mono">codex login</span> to see its quota here.
      </p>
    )
  if (codex.mode === 'apikey')
    return <p className="card__note" style={{ marginTop: 0 }}>Using an API key. Usage limits don't apply.</p>

  const usage = codex.usage
  return (
    <>
      <div className="codex__identity">
        {codex.plan ? <span className="card__meta" style={{ color: 'var(--text)', fontWeight: 600 }}>{formatPlan(codex.plan)}</span> : null}
        <span className="card__email" title={codex.email ?? undefined}>
          {codex.email ?? 'ChatGPT login'}
        </span>
      </div>
      {usage?.ok ? (
        <div className="meter-list meter-list--compact">
          {usage.windows.map((w) => (
            <MeterRow key={w.key} window={w} now={now} />
          ))}
        </div>
      ) : (
        <p className="card__note card__note--danger">{usage?.error ?? 'Usage not fetched yet'}</p>
      )}
      {usage?.ok ? (
        <ResetRow
          resets={usage.resets}
          owner="Codex"
          now={now}
          busy={actions.busy.has('reset:codex')}
          onRedeem={(creditId) => actions.redeemCodexReset(creditId)}
        />
      ) : null}
    </>
  )
}
