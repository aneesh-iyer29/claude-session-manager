import type { ReactNode } from 'react'

interface Props {
  /** Ties the visible name to the control, so clicking the name focuses it and screen readers announce it. */
  id: string
  label: string
  hint?: ReactNode
  children: ReactNode
}

/**
 * One setting: name and a line of why on the left, the control on the right.
 * The same shape and rules as `Toggle`, so switches and fields sit in one
 * list without the eye having to change gear.
 */
export function SettingRow({ id, label, hint, children }: Props) {
  return (
    <div className="toggle-row setting-row">
      <div className="setting-row__text">
        <label className="toggle-row__label" htmlFor={id}>
          {label}
        </label>
        {hint ? <div className="toggle-row__hint">{hint}</div> : null}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  )
}
