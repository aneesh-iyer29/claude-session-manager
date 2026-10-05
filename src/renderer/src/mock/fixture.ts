/**
 * Seed data for the in-browser mock backend. Times are relative to "now" so the
 * countdowns look alive no matter when the dev server is opened. The account
 * derivation mirrors `autoswap.headroom` / `bindingWindow` so the mock produces
 * the same `Account` shape the daemon would.
 */
import type { Account, AppState, ClaudeSession, CodexState, ResetCredits, Settings, SwapperEvent, Usage, UsageWindow } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { gatingKeys } from '../lib/format'

const HOUR = 3600_000
const DAY = 24 * HOUR

export interface MockAccount {
  id: string
  email: string
  alias: string
  orgName: string
  orgUuid: string
  accountUuid: string
  plan: string | null
  disabled: boolean
  addedAt: string
  tokenStatus: Account['tokenStatus']
  usage: Usage | null
}

export function makeUsage(now: Date, windows: { fiveHour: number; weekly: number; model: number }, model = 'Fable'): Usage {
  const t = now.getTime()
  return {
    fetchedAt: now.toISOString(),
    ok: true,
    error: null,
    plan: 'max',
    windows: [
      { key: 'five_hour', label: '5-hour', pct: windows.fiveHour, resetsAt: iso(t + 2 * HOUR + 14 * 60_000) },
      { key: 'seven_day', label: 'Weekly', pct: windows.weekly, resetsAt: iso(t + 3 * DAY + 4 * HOUR) },
      { key: `model:${model.toLowerCase()}`, label: `${model} weekly`, pct: windows.model, resetsAt: iso(t + 2 * DAY + 4 * HOUR) },
    ],
  }
}

export function seedAccounts(now: Date): MockAccount[] {
  const t = now.getTime()
  return [
    {
      id: 'acc_1',
      email: 'work@acme.dev',
      alias: 'work',
      orgName: 'Acme',
      orgUuid: 'org-1111',
      accountUuid: 'acct-1111',
      plan: 'max',
      disabled: false,
      addedAt: iso(t - 20 * DAY),
      tokenStatus: 'ok',
      usage: { ...makeUsage(now, { fiveHour: 21, weekly: 51, model: 63 }), resets: launchReset(now, true) },
    },
    {
      id: 'acc_2',
      email: 'aneesh@example.com',
      alias: 'personal',
      orgName: 'Personal',
      orgUuid: 'org-2222',
      accountUuid: 'acct-2222',
      plan: 'max',
      disabled: false,
      addedAt: iso(t - 12 * DAY),
      tokenStatus: 'ok',
      usage: {
        ...makeUsage(now, { fiveHour: 4, weekly: 12, model: 18 }),
        windows: [
          { key: 'five_hour', label: '5-hour', pct: 4, resetsAt: iso(t + 4 * HOUR + 40 * 60_000) },
          { key: 'seven_day', label: 'Weekly', pct: 12, resetsAt: iso(t + 5 * DAY + 2 * HOUR) },
          { key: 'model:fable', label: 'Fable weekly', pct: 18, resetsAt: iso(t + 3 * DAY + 1 * HOUR) },
        ],
      },
    },
    {
      id: 'acc_3',
      email: 'alt@acme.dev',
      alias: 'alt',
      orgName: 'Acme',
      orgUuid: 'org-1111',
      accountUuid: 'acct-3333',
      plan: 'pro',
      disabled: true,
      addedAt: iso(t - 3 * DAY),
      tokenStatus: 'ok',
      usage: {
        ...makeUsage(now, { fiveHour: 88, weekly: 95, model: 91 }),
        plan: 'pro',
        resets: launchReset(now, false),
        windows: [
          { key: 'five_hour', label: '5-hour', pct: 88, resetsAt: iso(t + 2 * HOUR + 5 * 60_000) },
          { key: 'seven_day', label: 'Weekly', pct: 95, resetsAt: iso(t + 22 * HOUR) },
          { key: 'model:fable', label: 'Fable weekly', pct: 91, resetsAt: iso(t + 1 * DAY + 6 * HOUR) },
        ],
      },
    },
  ]
}

/** The Opus 5.5 launch grant; `spendable` false is how a paused grant (or a cooldown) arrives. */
export function launchReset(now: Date, spendable: boolean): ResetCredits {
  return {
    available: 1,
    cooldownUntil: spendable ? null : iso(now.getTime() + 3 * HOUR),
    credits: [
      {
        id: spendable ? 'opus55-launch-promax-20260921' : null,
        title: 'Claude Opus 5.5 launch: one usage-limit reset for Pro and Max',
        count: 1,
        expiresAt: iso(now.getTime() + 20 * DAY),
        clears: ['five_hour', 'seven_day'],
      },
    ],
  }
}

export function seedCodexResets(now: Date): ResetCredits {
  const t = now.getTime()
  return {
    available: 2,
    cooldownUntil: null,
    credits: [
      { id: 'RateLimitResetCredit_a', title: null, count: 1, expiresAt: iso(t + 2 * DAY + 5 * HOUR), clears: [] },
      { id: 'RateLimitResetCredit_b', title: null, count: 1, expiresAt: iso(t + 26 * DAY), clears: [] },
    ],
  }
}

export function seedCodex(now: Date): CodexState {
  const t = now.getTime()
  return {
    configured: true,
    mode: 'chatgpt',
    email: 'me@example.com',
    plan: 'pro',
    usage: {
      fetchedAt: now.toISOString(),
      ok: true,
      error: null,
      plan: 'pro',
      windows: [
        { key: 'five_hour', label: '5-hour', pct: 41, resetsAt: iso(t + 3 * HOUR + 12 * 60_000) },
        { key: 'seven_day', label: 'Weekly', pct: 71, resetsAt: iso(t + 4 * DAY + 9 * HOUR) },
      ],
      resets: seedCodexResets(now),
    },
  }
}

export function seedEvents(now: Date): SwapperEvent[] {
  const t = now.getTime()
  return [
    { id: 'ev_4', at: iso(t - 6 * 60_000), kind: 'info', message: 'Refreshed 3 accounts', accountId: null },
    { id: 'ev_3', at: iso(t - 55 * 60_000), kind: 'switch', message: 'Switched personal → work', accountId: 'acc_1' },
    { id: 'ev_2', at: iso(t - 56 * 60_000), kind: 'autoswap', message: 'Fable weekly at 91% on personal, switching', accountId: 'acc_2' },
    { id: 'ev_1', at: iso(t - 1 * DAY - 2 * HOUR), kind: 'login', message: 'Added alt via browser login', accountId: 'acc_3' },
    // A run of older polls so the log folds in the browser preview, as it does after a few days of use.
    ...Array.from({ length: 20 }, (_, i): SwapperEvent => ({
      id: `ev_old_${i}`,
      at: iso(t - 2 * DAY - i * 3 * HOUR),
      kind: i % 7 === 3 ? 'error' : 'info',
      message: i % 7 === 3 ? 'work: usage fetch failed (HTTP 429), keeping the last numbers' : 'Refreshed 3 accounts',
      accountId: i % 7 === 3 ? 'acc_1' : null,
    })),
  ]
}

/**
 * A few Claude Code sessions in every state, most recent change first like the
 * daemon sends them. One waiting spell has already been texted so the
 * "Texted" marker and "Last text" line have something to show.
 */
export function seedSessions(now: Date): ClaudeSession[] {
  const t = now.getTime()
  const home = '/Users/aneesh'
  return [
    {
      id: 'sess_web',
      project: 'web',
      cwd: `${home}/code/web`,
      state: 'working',
      since: iso(t - 40_000),
      detail: null,
      alertedAt: null,
    },
    {
      id: 'sess_sm',
      project: 'session-manager',
      cwd: `${home}/Documents/GitHub/session-manager`,
      state: 'permission',
      since: iso(t - 70_000),
      detail: 'Permission to use Bash',
      alertedAt: null,
    },
    {
      id: 'sess_api',
      project: 'api',
      cwd: `${home}/code/api`,
      state: 'question',
      since: iso(t - 4 * 60_000 - 10_000),
      detail: 'Which auth method should we use? The existing session cookies, or signed JWTs issued by the gateway?',
      alertedAt: iso(t - 2 * 60_000),
    },
    {
      id: 'sess_docs',
      project: 'docs',
      cwd: `${home}/code/docs`,
      state: 'done',
      since: iso(t - 18 * 60_000),
      detail: null,
      alertedAt: null,
    },
  ]
}

export const seedSettings: Settings = { ...DEFAULT_SETTINGS, autoswapEnabled: true }

/** The gating windows under `weeklyGate`, the same set `autoswap.gatingWindows` uses. */
export function gating(usage: Usage | null, settings: Pick<Settings, 'model' | 'weeklyGate'>): UsageWindow[] {
  if (!usage || !usage.ok) return []
  const keys = gatingKeys(usage, settings)
  return usage.windows.filter((w) => keys.has(w.key))
}

/**
 * Mirrors `autoswap.bindingWindow`: the 5-hour session, or a weekly window that
 * is past the warn line and higher than the session; the highest window when
 * there is no session.
 */
export function toAccount(
  a: MockAccount,
  activeId: string | null,
  settings: Pick<Settings, 'model' | 'weeklyGate' | 'threshold' | 'warnPct'>,
): Account {
  const windows = gating(a.usage, settings)
  const session = windows.find((w) => w.key === 'five_hour') ?? null
  let binding: UsageWindow | null = session
  if (session) {
    const gate = Math.min(settings.warnPct, settings.threshold)
    for (const w of windows) if (w.key !== 'five_hour' && w.pct >= gate && w.pct > (binding as UsageWindow).pct) binding = w
  } else {
    for (const w of windows) if (!binding || w.pct > binding.pct) binding = w
  }
  return {
    ...a,
    active: a.id === activeId,
    headroom: binding ? Math.max(0, 100 - binding.pct) : null,
    bindingWindow: binding?.key ?? null,
  }
}

export function buildState(parts: {
  version: string
  now: Date
  activeId: string | null
  accounts: MockAccount[]
  settings: Settings
  codex: CodexState
  events: SwapperEvent[]
  lastPollAt: string | null
  inFlight: boolean
  lastDecision: AppState['autoswap']['lastDecision']
  lastSwitchAt: string | null
  nudge: AppState['nudge']
  liveFeed: AppState['liveFeed']
  sessions: AppState['sessions']
}): AppState {
  const { now, settings } = parts
  return {
    version: parts.version,
    now: now.toISOString(),
    activeId: parts.activeId,
    polling: {
      lastPollAt: parts.lastPollAt,
      nextPollAt: parts.lastPollAt ? iso(new Date(parts.lastPollAt).getTime() + settings.pollIntervalSeconds * 1000) : null,
      inFlight: parts.inFlight,
    },
    autoswap: { lastDecision: parts.lastDecision, lastSwitchAt: parts.lastSwitchAt },
    settings,
    accounts: parts.accounts.map((a) => toAccount(a, parts.activeId, settings)),
    codex: settings.codexEnabled ? parts.codex : { ...parts.codex, usage: null },
    nudge: parts.nudge,
    liveFeed: parts.liveFeed,
    sessions: parts.sessions,
    events: parts.events.slice(0, 100),
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}
