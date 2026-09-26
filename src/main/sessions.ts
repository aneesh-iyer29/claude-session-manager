/**
 * Session tracker: which Claude Code sessions are open, and which are waiting on you.
 *
 * Claude Code exposes no list of running sessions, but it fires hooks at every
 * turn boundary. One bash script, registered for a handful of events, writes the
 * latest event of each kind per session to `<dataDir>/sessions/<id>.<Event>.json`.
 * One file per (session, event) keeps the hook trivially atomic (temp + rename,
 * no read-modify-write racing parallel async hooks) and lets the daemon rebuild
 * each session's state from file mtimes alone.
 *
 * The files hold the session id, working directory, tool name, notification
 * type and, for questions and notifications, a short message. Never a prompt,
 * a tool input, or a tool's output.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ClaudeSession, ClaudeSessionState } from '../shared/types'
import { claudeConfigHome, dataDir } from './paths'
import { atomicWrite } from './store'

export const SESSION_HOOK_SCRIPT_NAME = 'session-manager-sessions.sh'
/** Session files whose newest event is older than this are dropped and deleted. */
export const SESSION_MAX_AGE_MS = 12 * 60 * 60_000

/** Detail strings are shown in a menu and texted to the user; keep them short. */
const DETAIL_MAX_CHARS = 200
const FILE_RE = /^([A-Za-z0-9_-]+)\.([A-Za-z]+)\.json$/

export function sessionsDir(dir = dataDir()): string {
  return join(dir, 'sessions')
}

export function claudeSettingsPath(): string {
  return join(claudeConfigHome(), 'settings.json')
}

export function sessionHookScriptPath(): string {
  return join(claudeConfigHome(), 'hooks', SESSION_HOOK_SCRIPT_NAME)
}

/**
 * The hook. Runs under macOS /bin/bash 3.2 with nothing but builtins, cat, mv,
 * rm and mkdir, because it is spawned by whatever Claude Code is running.
 *
 * - stdout and stderr go to /dev/null first: SessionStart and UserPromptSubmit
 *   stdout would be injected into the conversation.
 * - Fields are pulled out with `[[ =~ ]]` from the first 16 KiB only. PostToolUse
 *   payloads carry whole tool outputs (megabytes), and every field we want comes
 *   before them. `LC_ALL=C` makes that slice and the regex byte-wise, so a cut
 *   through a multibyte character cannot break matching.
 * - Values are copied as JSON-escaped string bodies, so the file we write is
 *   valid JSON without ever unescaping anything in bash.
 * - SessionEnd deletes the session's files; everything else overwrites one file.
 */
export const SESSION_HOOK_SCRIPT = `#!/bin/bash
# Session Manager session tracker. Installed by Session Manager; safe to delete.
# Claude Code hook for several events (the event name is $1). Records the latest
# event of each kind per session in the app's data dir, so the app can tell which
# sessions are working and which are waiting on you. Keeps the session id, working
# directory, tool name, notification type and a short question or notification
# message; never prompts, tool inputs, or tool output.
exec >/dev/null 2>&1
umask 077
LC_ALL=C
dir="\${SESSION_MANAGER_HOME:-$HOME/Library/Application Support/Session Manager}/sessions"
event="$1"
re='^[A-Za-z]+$'
[[ $event =~ $re ]] || exit 0
input="$(cat)"
head="\${input:0:16384}"
sep='[[:space:]]*:[[:space:]]*'
str='"(([^"\\\\]|\\\\.)*)"'
field() {
  val=""
  local re="\\"$1\\"$sep$str"
  if [[ $head =~ $re ]]; then val="\${BASH_REMATCH[1]}"; fi
}
field session_id
sid="$val"
re='^[A-Za-z0-9_-]+$'
[[ $sid =~ $re ]] || exit 0
if [ "$event" = SessionEnd ]; then
  rm -f "$dir/$sid".*.json "$dir/.$sid".*.tmp
  exit 0
fi
field cwd; cwd="$val"
field tool_name; tool="$val"
field notification_type; ntype="$val"
msg=""
case "$event" in
  Notification) field message; msg="$val" ;;
  PreToolUse) field question; msg="$val" ;;
esac
mkdir -p "$dir" || exit 0
tmp="$dir/.$sid.$event.$$.tmp"
if printf '{"event":"%s","session_id":"%s","cwd":"%s","tool_name":"%s","notification_type":"%s","message":"%s"}\\n' "$event" "$sid" "$cwd" "$tool" "$ntype" "$msg" > "$tmp"; then
  mv -f "$tmp" "$dir/$sid.$event.json" || rm -f "$tmp"
else
  rm -f "$tmp"
fi
exit 0
`

export interface HookRegistration {
  event: string
  matcher?: string
  async: boolean
}

/**
 * Where the script is registered. Async so a session never waits on us, except
 * SessionEnd: Claude Code exits right after it, and an async hook could be
 * killed before it deletes the session's files. PreToolUse is narrowed to
 * AskUserQuestion (the only tool call that waits on the user without a
 * permission prompt); Notification to the kinds that mean "waiting on you".
 */
export const SESSION_HOOKS: readonly HookRegistration[] = [
  { event: 'SessionStart', async: true },
  { event: 'UserPromptSubmit', async: true },
  { event: 'PreToolUse', matcher: 'AskUserQuestion', async: true },
  { event: 'PermissionRequest', async: true },
  { event: 'PostToolUse', async: true },
  { event: 'Notification', matcher: 'permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input', async: true },
  { event: 'Stop', async: true },
  { event: 'SessionEnd', async: false },
]

interface HookCommand {
  type?: string
  command?: string
  async?: boolean
}

interface HookEntry {
  matcher?: string
  hooks?: HookCommand[]
}

function readSettingsForWrite(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    raw = null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} is not a JSON object; not touching it`)
  return raw as Record<string, unknown>
}

function hooksOf(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks
  return hooks && typeof hooks === 'object' && !Array.isArray(hooks) ? { ...(hooks as Record<string, unknown>) } : {}
}

function listOf(hooks: Record<string, unknown>, event: string): HookEntry[] {
  const list = hooks[event]
  return Array.isArray(list) ? (list as HookEntry[]) : []
}

function isOurCommand(h: HookCommand): boolean {
  return !!h && typeof h.command === 'string' && h.command.includes(SESSION_HOOK_SCRIPT_NAME)
}

function hasOurs(entry: HookEntry): boolean {
  return !!entry && Array.isArray(entry.hooks) && entry.hooks.some(isOurCommand)
}

/**
 * Drop our commands from an event list. An entry whose only commands were ours
 * goes away; a user's command that shares an entry with ours is kept, and
 * entries we never touched are returned as the same objects.
 */
function withoutOurs(list: HookEntry[]): HookEntry[] {
  const next: HookEntry[] = []
  for (const entry of list) {
    if (!hasOurs(entry)) {
      next.push(entry)
      continue
    }
    const rest = (entry.hooks ?? []).filter((h) => !isOurCommand(h))
    if (rest.length) next.push({ ...entry, hooks: rest })
  }
  return next
}

function entryFor(reg: HookRegistration, scriptPath: string): HookEntry {
  const command: HookCommand = { type: 'command', command: `"${scriptPath}" ${reg.event}` }
  if (reg.async) command.async = true
  return reg.matcher === undefined ? { hooks: [command] } : { matcher: reg.matcher, hooks: [command] }
}

function writeSettings(path: string, settings: Record<string, unknown>): void {
  atomicWrite(path, JSON.stringify(settings, null, 2) + '\n')
}

export function isSessionHooksInstalled(settingsPath = claudeSettingsPath(), scriptPath = sessionHookScriptPath()): boolean {
  try {
    if (!existsSync(scriptPath)) return false
    const hooks = hooksOf(readSettingsForWrite(settingsPath))
    return SESSION_HOOKS.every((reg) => listOf(hooks, reg.event).some(hasOurs))
  } catch {
    return false
  }
}

/**
 * Write the script (0755, set before the rename so Claude Code never sees it
 * half-installed) and register it for every event in SESSION_HOOKS. Our old
 * entries are replaced, never duplicated; every other hook (the compact nudge
 * included) and every other settings key is preserved. An unparsable
 * settings.json is refused rather than overwritten.
 */
export function installSessionHooks(settingsPath = claudeSettingsPath(), scriptPath = sessionHookScriptPath()): void {
  const settings = readSettingsForWrite(settingsPath)
  atomicWrite(scriptPath, SESSION_HOOK_SCRIPT, 0o755)
  const hooks = hooksOf(settings)
  for (const reg of SESSION_HOOKS) {
    hooks[reg.event] = [...withoutOurs(listOf(hooks, reg.event)), entryFor(reg, scriptPath)]
  }
  settings.hooks = hooks
  writeSettings(settingsPath, settings)
}

/**
 * Remove our entries from every event (not only today's SESSION_HOOKS, so a
 * registration dropped in a later version still gets cleaned up), then the
 * lists and `hooks` key that this leaves empty, then the script.
 */
export function uninstallSessionHooks(settingsPath = claudeSettingsPath(), scriptPath = sessionHookScriptPath()): void {
  if (existsSync(settingsPath)) {
    const settings = readSettingsForWrite(settingsPath)
    const hooks = hooksOf(settings)
    let changed = false
    for (const event of Object.keys(hooks)) {
      const list = listOf(hooks, event)
      if (!list.some(hasOurs)) continue
      changed = true
      const next = withoutOurs(list)
      if (next.length) hooks[event] = next
      else delete hooks[event]
    }
    if (changed) {
      if (Object.keys(hooks).length) settings.hooks = hooks
      else delete settings.hooks
      writeSettings(settingsPath, settings)
    }
  }
  rmSync(scriptPath, { force: true })
}

/** True when the script on disk is not the one this build would write (an older install). */
export function sessionHookScriptStale(scriptPath = sessionHookScriptPath()): boolean {
  try {
    statSync(scriptPath)
    return readFileSync(scriptPath, 'utf8') !== SESSION_HOOK_SCRIPT
  } catch {
    return false
  }
}

export interface SessionEvent {
  event: string
  at: Date
  cwd: string
  toolName: string
  notificationType: string
  message: string
}

export type SessionView = Omit<ClaudeSession, 'alertedAt'>

interface Mapped {
  state: ClaudeSessionState
  detail: string | null
  at: Date
}

const WAITING: ReadonlySet<ClaudeSessionState> = new Set<ClaudeSessionState>(['done', 'question', 'permission'])

/** PreToolUse is registered for AskUserQuestion only, so its newest message is the open question. */
function lastQuestion(events: SessionEvent[]): string {
  let best: SessionEvent | null = null
  for (const e of events) if (e.event === 'PreToolUse' && (!best || e.at.getTime() > best.at.getTime())) best = e
  return best?.message ?? ''
}

/**
 * Events that mark a definite turn boundary. PermissionRequest for
 * AskUserQuestion is a question, not a permission; its payload carries no
 * message, so the question text comes from the PreToolUse that preceded it.
 */
function hardState(e: SessionEvent, all: SessionEvent[]): Omit<Mapped, 'at'> | null {
  switch (e.event) {
    case 'SessionStart':
      return { state: 'ready', detail: null }
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return { state: 'working', detail: null }
    case 'PreToolUse':
      return { state: 'question', detail: e.message }
    case 'PermissionRequest':
      if (e.toolName === 'AskUserQuestion') return { state: 'question', detail: e.message || lastQuestion(all) }
      return { state: 'permission', detail: e.toolName ? `Permission to use ${e.toolName}` : null }
    case 'Stop':
      return { state: 'done', detail: null }
    default:
      return null
  }
}

/** Notifications only hint at a state: they can race hard events, so they win only when newer. */
function softState(e: SessionEvent): Omit<Mapped, 'at'> | null {
  if (e.event !== 'Notification') return null
  switch (e.notificationType) {
    case 'permission_prompt':
      return { state: 'permission', detail: e.message }
    case 'idle_prompt':
      return { state: 'done', detail: null }
    case 'elicitation_dialog':
    case 'elicitation_url_dialog':
    case 'agent_needs_input':
      return { state: 'question', detail: e.message }
    default:
      return null
  }
}

function newest(events: SessionEvent[], map: (e: SessionEvent) => Omit<Mapped, 'at'> | null): Mapped | null {
  let best: Mapped | null = null
  for (const e of events) {
    const m = map(e)
    if (m && (!best || e.at.getTime() > best.at.getTime())) best = { ...m, at: e.at }
  }
  return best
}

/** Collapse whitespace and cap by code points so a long question cannot flood a menu or a text. */
function cleanDetail(detail: string | null): string | null {
  if (!detail) return null
  const text = detail.replace(/\s+/g, ' ').trim()
  if (!text) return null
  const chars = Array.from(text)
  return chars.length <= DETAIL_MAX_CHARS ? text : chars.slice(0, DETAIL_MAX_CHARS - 1).join('').trimEnd() + '…'
}

/** The rule order that turns a hard and a soft candidate into one state. */
function pick(hard: Mapped | null, soft: Mapped | null): Mapped | null {
  if (hard && WAITING.has(hard.state)) return hard
  if (soft && (!hard || soft.at.getTime() > hard.at.getTime())) return soft
  return hard ? { ...hard, detail: null } : null
}

/** Events that start a stretch of work: every PostToolUse after one of these is the same stretch. */
const TURN_BOUNDARIES: ReadonlySet<string> = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop'])

/**
 * When a working stretch began. PostToolUse rewrites its file on every tool
 * call, so its mtime would restart the clock (and churn the UI) all turn long;
 * the newest boundary before it (the prompt, or the question or permission it
 * resumed from) is stable and close enough.
 */
function workingSince(chosen: Mapped, events: SessionEvent[]): Date {
  let since: Date | null = null
  for (const e of events) {
    if (!TURN_BOUNDARIES.has(e.event) || e.at.getTime() > chosen.at.getTime()) continue
    if (!since || e.at.getTime() > since.getTime()) since = e.at
  }
  return since ?? chosen.at
}

/**
 * Pure: derive one session from its latest event of each type. null when nothing meaningful.
 *
 * A waiting hard event (Stop, a question, a permission request) always wins:
 * nothing but a new prompt or tool result ends a wait. Otherwise a newer
 * notification wins, which catches a permission prompt racing a parallel
 * tool's PostToolUse and an Esc-interrupted turn that never fired Stop but did
 * get idle_prompt.
 */
export function deriveSession(id: string, events: SessionEvent[]): SessionView | null {
  const chosen = pick(
    newest(events, (e) => hardState(e, events)),
    newest(events, softState),
  )
  if (!chosen) return null
  let cwdEvent: SessionEvent | null = null
  for (const e of events) if (e.cwd && (!cwdEvent || e.at.getTime() > cwdEvent.at.getTime())) cwdEvent = e
  const cwd = cwdEvent?.cwd ?? ''
  return {
    id,
    project: (cwd && basename(cwd)) || 'Claude Code',
    cwd,
    state: chosen.state,
    since: (chosen.state === 'working' ? workingSince(chosen, events) : chosen.at).toISOString(),
    detail: cleanDetail(chosen.detail),
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** The event name comes from the file name, so one file is always one event kind. */
function parseEvent(path: string, event: string, at: Date): SessionEvent | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const f = raw as Record<string, unknown>
    return { event, at, cwd: str(f.cwd), toolName: str(f.tool_name), notificationType: str(f.notification_type), message: str(f.message) }
  } catch {
    return null
  }
}

interface Group {
  files: string[]
  events: SessionEvent[]
  newest: number
}

function scan(dir: string): Map<string, Group> {
  const groups = new Map<string, Group>()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return groups
  }
  for (const name of names) {
    const m = FILE_RE.exec(name)
    if (!m || !m[1] || !m[2]) continue
    const path = join(dir, name)
    let at: Date
    try {
      at = statSync(path).mtime
    } catch {
      continue // removed by a SessionEnd between readdir and stat
    }
    const group = groups.get(m[1]) ?? { files: [], events: [], newest: 0 }
    groups.set(m[1], group)
    group.files.push(path)
    group.newest = Math.max(group.newest, at.getTime())
    const ev = parseEvent(path, m[2], at)
    if (ev) group.events.push(ev)
  }
  return groups
}

/**
 * Sessions that crashed or were killed never fire SessionEnd, so their files
 * are swept here once they have been silent for SESSION_MAX_AGE_MS.
 */
function sweep(files: string[]): void {
  for (const f of files) {
    try {
      rmSync(f, { force: true })
    } catch {
      // best effort; the next read tries again
    }
  }
}

/** Read <dir>/*.json, group by session, derive, drop+delete groups older than SESSION_MAX_AGE_MS. Sorted by `since` desc. Never throws (missing dir → []). */
export function readSessions(dir = sessionsDir(), now = new Date()): SessionView[] {
  const cutoff = now.getTime() - SESSION_MAX_AGE_MS
  const out: SessionView[] = []
  for (const [id, group] of scan(dir)) {
    if (group.newest < cutoff) {
      sweep(group.files)
      continue
    }
    const view = deriveSession(id, group.events)
    if (view) out.push(view)
  }
  return out.sort((a, b) => Date.parse(b.since) - Date.parse(a.since))
}
