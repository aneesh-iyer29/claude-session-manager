/**
 * Every user action goes through here so the "call the API, toast the
 * outcome" rule is enforced in one place. Success messages repeat the verb
 * ("Switched to personal"); failures show the backend's message verbatim
 * because the contract promises it is user-safe.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { Account, AppState, CodexState, Settings } from '@shared/types'
import { getApi } from '../api'
import { displayName } from '../lib/format'
import { useToasts } from './useToasts'

export type ActionKey = string

/** Every action resolves true when it succeeded and false when it failed (the reason is already toasted). */
export interface Actions {
  /** Ids of actions currently in flight, e.g. `switch:acc_2`, `refresh`, `refresh:codex`. */
  busy: ReadonlySet<ActionKey>
  /** The Claude accounts only. */
  refresh: () => Promise<boolean>
  /** The Codex snapshot only. */
  refreshCodex: () => Promise<boolean>
  switchTo: (account: Account) => Promise<boolean>
  captureActive: () => Promise<boolean>
  setDisabled: (account: Account, disabled: boolean) => Promise<boolean>
  setAlias: (account: Account, alias: string) => Promise<boolean>
  removeAccount: (account: Account) => Promise<boolean>
  updateSettings: (patch: Partial<Settings>, successMessage?: string) => Promise<boolean>
  openExternal: (url: string) => Promise<boolean>
  openDataFolder: () => Promise<boolean>
  installHook: () => Promise<boolean>
  uninstallHook: () => Promise<boolean>
  installFeed: () => Promise<boolean>
  uninstallFeed: () => Promise<boolean>
  /** Busy under `sessions-hook`. */
  installSessionHooks: () => Promise<boolean>
  uninstallSessionHooks: () => Promise<boolean>
  /** Busy under `test-alert`. */
  sendTestAlert: () => Promise<boolean>
}

export function useActions(): Actions {
  const { push } = useToasts()
  const [busy, setBusy] = useState<ReadonlySet<ActionKey>>(() => new Set())
  const counts = useRef(new Map<ActionKey, number>())

  const mark = useCallback((key: ActionKey, delta: 1 | -1) => {
    const next = (counts.current.get(key) ?? 0) + delta
    if (next <= 0) counts.current.delete(key)
    else counts.current.set(key, next)
    setBusy(new Set(counts.current.keys()))
  }, [])

  /** Wrap one API call: track busy, toast success or the error message. True when it succeeded. */
  const run = useCallback(
    async (key: ActionKey, fn: () => Promise<unknown>, success?: string | ((r: unknown) => string)): Promise<boolean> => {
      mark(key, 1)
      try {
        const result = await fn()
        if (success) push(typeof success === 'function' ? success(result) : success)
        return true
      } catch (err) {
        push(errorMessage(err), 'error')
        return false
      } finally {
        mark(key, -1)
      }
    },
    [mark, push],
  )

  return useMemo<Actions>(() => {
    const api = getApi()
    return {
      busy,
      refresh: () =>
        run('refresh', () => api.refresh(), (s) => {
          const n = (s as { accounts: Account[] }).accounts.filter((a) => !a.disabled).length
          return n === 1 ? 'Refreshed 1 account' : `Refreshed ${n} accounts`
        }),
      refreshCodex: () => run('refresh:codex', () => api.refreshCodex(), (s) => codexRefreshMessage((s as AppState).codex)),
      switchTo: (a) => run(`switch:${a.id}`, () => api.switchTo(a.id), `Switched to ${displayName(a)}`),
      captureActive: () =>
        run('capture', () => api.captureActive(), (s) => {
          const active = (s as { accounts: Account[]; activeId: string | null })
          const acc = active.accounts.find((x) => x.id === active.activeId)
          return acc ? `Captured ${displayName(acc)}` : 'Captured current login'
        }),
      setDisabled: (a, disabled) =>
        run(
          `disable:${a.id}`,
          () => api.setDisabled(a.id, disabled),
          disabled ? `Held ${displayName(a)} out of rotation` : `Returned ${displayName(a)} to rotation`,
        ),
      setAlias: (a, alias) =>
        run(`alias:${a.id}`, () => api.setAlias(a.id, alias), alias.trim() ? `Renamed to ${alias.trim()}` : 'Alias cleared'),
      removeAccount: (a) => run(`remove:${a.id}`, () => api.removeAccount(a.id), `Removed ${displayName(a)}`),
      updateSettings: (patch, message) => run('settings', () => api.updateSettings(patch), message ?? 'Settings saved'),
      openExternal: (url) => run(`open`, () => api.openExternal(url)),
      openDataFolder: () => run('open', () => api.openDataFolder()),
      installHook: () => run('hook', () => api.installHook(), 'Compact nudge hook installed in Claude Code'),
      uninstallHook: () => run('hook', () => api.uninstallHook(), 'Compact nudge hook removed'),
      installFeed: () => run('feed', () => api.installFeed(), 'Status line feed installed in Claude Code'),
      uninstallFeed: () => run('feed', () => api.uninstallFeed(), 'Status line feed removed'),
      installSessionHooks: () => run('sessions-hook', () => api.installSessionHooks(), 'Session hooks installed in Claude Code'),
      uninstallSessionHooks: () => run('sessions-hook', () => api.uninstallSessionHooks(), 'Session hooks removed'),
      sendTestAlert: () => run('test-alert', () => api.sendTestAlert(), 'Test iMessage sent'),
    }
  }, [busy, run])
}

/** What a manual Codex refresh found. A failed fetch rejects instead and is toasted as an error. */
export function codexRefreshMessage(codex: CodexState): string {
  if (!codex.configured) return 'Codex isn\u2019t logged in'
  if (codex.mode === 'apikey') return 'Codex is using an API key; there is no quota to fetch'
  return 'Refreshed Codex'
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return stripIpcPrefix(err.message)
  return String(err)
}

/** Electron prefixes rejected IPC errors with "Error invoking remote method 'x': Error: ". */
function stripIpcPrefix(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
