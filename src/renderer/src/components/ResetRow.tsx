import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useState } from 'react'
import type { ResetCredits } from '@shared/types'
import { formatCountdown, resetEffect, spendableReset } from '../lib/format'
import { spring } from '../lib/motion'
import { Button } from './Button'

interface Props {
  resets: ResetCredits | null | undefined
  /** Whose limits the reset puts back to full, for the confirmation: "work", "Codex". */
  owner: string
  now: Date
  busy: boolean
  /** Spend the credit; resolves true when it went through. */
  onRedeem: (creditId: string) => Promise<boolean>
}

/**
 * Banked usage-limit resets on one account, and the one way to spend them.
 * A reset is scarce and cannot be taken back, so "Use reset" only opens an
 * inline confirmation that says what will happen; the confirming press spends
 * it. Cancel holds focus, so a stray Enter backs out. Nothing renders when the
 * provider reports no resets.
 */
export function ResetRow({ resets, owner, now, busy, onRedeem }: Props) {
  const [confirming, setConfirming] = useState(false)
  const reduced = useReducedMotion()
  const credit = spendableReset(resets)

  // The offer can vanish under an open confirmation (spent elsewhere, expired, a cooldown began).
  useEffect(() => {
    if (!credit) setConfirming(false)
  }, [credit])

  if (!resets || resets.available < 1) return null
  const soonest = resets.credits[0]?.expiresAt ?? null
  const left = resets.available - 1

  return (
    <div className="resets">
      <div className="resets__row">
        <span className="resets__label">Limit resets</span>
        <span className="resets__summary" title={resets.credits.map((c) => c.title).filter(Boolean).join('\n') || undefined}>
          {resets.available} banked
          {soonest ? <span className="resets__expiry">expires in {formatCountdown(soonest, now)}</span> : null}
        </span>
        {credit ? (
          <Button size="sm" disabled={busy || confirming} onClick={() => setConfirming(true)} aria-expanded={confirming}>
            {busy ? 'Using…' : 'Use reset'}
          </Button>
        ) : (
          <span className="badge" title="The provider is not offering this reset right now">
            {resets.cooldownUntil ? `Usable in ${formatCountdown(resets.cooldownUntil, now)}` : 'Not usable yet'}
          </span>
        )}
      </div>

      <AnimatePresence initial={false}>
        {confirming && credit ? (
          <motion.div
            key="confirm"
            className="resets__confirm"
            role="alertdialog"
            aria-label={`Use a limit reset on ${owner}`}
            initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={spring}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setConfirming(false)
            }}
          >
            <p className="resets__question">
              Use a reset on <strong>{owner}</strong>? {resetEffect(credit.clears)}{' '}
              {left === 0 ? 'This is the last one banked.' : `${left} left after this.`} It can't be undone.
            </p>
            <div className="resets__actions">
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setConfirming(false)
                  void onRedeem(credit.id as string)
                }}
              >
                Use reset
              </Button>
              <Button variant="quiet" size="sm" autoFocus onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
