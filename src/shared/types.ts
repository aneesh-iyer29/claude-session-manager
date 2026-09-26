/**
 * Shared data model. This file is the contract between the main process, the
 * preload bridge, and the renderer. Every process imports from here and nobody
 * redefines these shapes. Keep it dependency-free.
 */

/** One rate-limit window as reported by a provider, normalized. `pct` is 0-100 used. */
export interface UsageWindow {
  /** `five_hour`, `seven_day`, or `model:<display name lowercased>` (e.g. `model:fable`). */
  key: string
  /** Human label: "5-hour", "Weekly", "Fable weekly". */
  label: string
  pct: number
  /** ISO timestamp when the window resets, or null when unknown. */
  resetsAt: string | null
  /** True when projected from another window rather than reported (see the Fable estimate). */
  estimated?: boolean
}

export interface Usage {
  fetchedAt: string
  ok: boolean
  /** Short, secret-free error description when `ok` is false. */
  error: string | null
  windows: UsageWindow[]
  /** Subscription tier as reported by the provider ("max", "pro", ...), if known. */
  plan: string | null
}

export type TokenStatus = 'ok' | 'expired' | 'dead' | 'unknown'

export interface Account {
  /** Stable id like `acc_3`. */
  id: string
  email: string
  alias: string
  orgName: string
  orgUuid: string
  accountUuid: string
  plan: string | null
  /** True when this account's credential is the one Claude Code is using right now. */
  active: boolean
  /** Held out of auto-rotation. Still a valid manual switch target. */
  disabled: boolean
  addedAt: string
  tokenStatus: TokenStatus
  usage: Usage | null
  /**
   * 100 - pct of the binding window, or null when usage is unknown. The 5-hour
   * session's headroom unless a weekly window has taken over (see `bindingWindow`).
   */
  headroom: number | null
  /**
   * Key of the window the account is up against: the 5-hour session, or a weekly
   * window that is past the warn line and closer to its limit than the session.
   */
  bindingWindow: string | null
}

export type CodexMode = 'chatgpt' | 'apikey' | 'none'

export interface CodexState {
  configured: boolean
  mode: CodexMode
  email: string | null
  plan: string | null
  usage: Usage | null
}

export type Strategy = 'best' | 'consume_first'

/**
 * Which weekly window gates swapping. `all`: the all-models week (`seven_day`).
 * `model`: the per-model week named by `Settings.model`, or the all-models week
 * for an account that does not report one. `both`: whichever of the two is tighter.
 */
export type WeeklyGate = 'all' | 'model' | 'both'

export interface Settings {
  autoswapEnabled: boolean
  dryRun: boolean
  /** 50-100. The swap line for the 5-hour session: the active account is swapped when its session reaches this. */
  fiveHourThreshold: number
  /** 50-100. The swap line for the weekly windows (all models, and the per-model one). */
  threshold: number
  /** 0-50. A switch target must beat the active account's headroom by this much. */
  margin: number
  /** >= 0. Minimum seconds between automatic switches. */
  cooldownSeconds: number
  /** >= 15. The active account is fetched at most every 5 minutes; standby accounts every 10 unless near the threshold. The usage endpoint allows ~30 requests an hour per token. */
  pollIntervalSeconds: number
  strategy: Strategy
  /** Display name of the per-model weekly window that gates swapping. Default "Fable". */
  model: string
  codexEnabled: boolean
  notify: boolean
  launchAtLogin: boolean
  showInDock: boolean
  /**
   * 50-100. Below the swap lines. The compact nudge flag is raised when a gating window of
   * the active account reaches this, and a weekly window past it takes over from the
   * 5-hour session as the binding window.
   */
  warnPct: number
  /** `block`: the Claude Code hook stops the first prompt after the flag with a message; `context`: it only tells Claude. */
  nudgeMode: NudgeMode
  /** Which weekly window counts toward headroom and the weekly swap line. Default `both`. */
  weeklyGate: WeeklyGate
  /** Send an iMessage when a Claude Code session is waiting on the user. Needs `alertTo`. */
  alertsEnabled: boolean
  /** Phone number (digits, optional leading +) or Apple ID email the alert goes to; empty until set. */
  alertTo: string
  /** Only text when the Mac has had no keyboard or mouse input since the session started waiting. */
  alertOnlyWhenAway: boolean
  /** 1-60. How long a session must have been waiting before the text goes out. */
  alertAfterMinutes: number
}

export type NudgeMode = 'block' | 'context'

/** Raised while the active account is near its swap line; consumed by the Claude Code hook. */
export interface NudgeFlag {
  /** Stable for one episode (account + window + reset), so the hook blocks at most once per episode. */
  id: string
  at: string
  accountId: string
  /** Alias or email of the account. */
  label: string
  /** Window label, e.g. "Fable weekly". */
  window: string
  pct: number
  message: string
}

/** The Claude Code status line feed: live 5-hour / weekly usage for the active account. */
export interface LiveFeedState {
  /** Whether our status line script is registered in ~/.claude/settings.json. */
  installed: boolean
  /** When Claude Code last wrote usage, or null. */
  lastAt: string | null
}

export interface NudgeState {
  /** Whether the UserPromptSubmit hook is present in ~/.claude/settings.json. */
  hookInstalled: boolean
  pending: NudgeFlag | null
}

/**
 * What a Claude Code session is doing, derived from its latest hook events.
 * `ready`: opened, no prompt yet. `working`: running a turn. `done`: finished
 * its turn and waiting for the next message. `question`: asking the user
 * (AskUserQuestion, an MCP elicitation). `permission`: waiting on a permission prompt.
 */
export type ClaudeSessionState = 'ready' | 'working' | 'done' | 'question' | 'permission'

/** One Claude Code session seen through the session hooks. */
export interface ClaudeSession {
  /** Claude Code's session id. */
  id: string
  /** Last component of the working directory, e.g. "session-manager". */
  project: string
  cwd: string
  state: ClaudeSessionState
  /** ISO time the session entered `state`. */
  since: string
  /** What it is waiting on, when known: the question, or "Permission to use Bash". Short; never a prompt or tool input. */
  detail: string | null
  /** When this waiting spell was texted to the user, or null. */
  alertedAt: string | null
}

export interface SessionsState {
  /** Whether the session hooks are registered in ~/.claude/settings.json. */
  hooksInstalled: boolean
  /** Most recent state change first. Ended sessions and ones silent for 12 hours are dropped. */
  sessions: ClaudeSession[]
  /** When the last iMessage alert went out, or null. */
  lastAlertAt: string | null
}

export type DecisionAction = 'stay' | 'switch' | 'blocked'

export interface Decision {
  action: DecisionAction
  targetId: string | null
  reason: string
  at: string
}

export type EventKind = 'switch' | 'autoswap' | 'error' | 'login' | 'capture' | 'info'

export interface SwapperEvent {
  id: string
  at: string
  kind: EventKind
  message: string
  accountId: string | null
}

export interface AppState {
  version: string
  now: string
  activeId: string | null
  polling: {
    lastPollAt: string | null
    nextPollAt: string | null
    inFlight: boolean
  }
  autoswap: {
    lastDecision: Decision | null
    lastSwitchAt: string | null
  }
  settings: Settings
  accounts: Account[]
  codex: CodexState
  nudge: NudgeState
  liveFeed: LiveFeedState
  sessions: SessionsState
  /** Newest first, at most 100. */
  events: SwapperEvent[]
}

export type LoginPhase = 'pending' | 'done' | 'error'

export interface LoginStatus {
  id: string
  status: LoginPhase
  /** Authorize URL; the main process also opens it in the default browser. */
  url: string
  account?: Account
  error?: string
}

export const DEFAULT_SETTINGS: Settings = {
  autoswapEnabled: false,
  dryRun: false,
  fiveHourThreshold: 90,
  threshold: 90,
  margin: 10,
  cooldownSeconds: 300,
  pollIntervalSeconds: 300,
  strategy: 'best',
  model: 'Fable',
  codexEnabled: true,
  notify: true,
  launchAtLogin: false,
  showInDock: true,
  warnPct: 80,
  nudgeMode: 'block',
  weeklyGate: 'both',
  alertsEnabled: false,
  alertTo: '',
  alertOnlyWhenAway: true,
  alertAfterMinutes: 2,
}
