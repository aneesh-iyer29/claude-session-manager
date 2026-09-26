import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SESSION_HOOKS,
  SESSION_MAX_AGE_MS,
  deriveSession,
  installSessionHooks,
  isSessionHooksInstalled,
  readSessions,
  sessionHookScriptStale,
  sessionsDir,
  uninstallSessionHooks,
  type SessionEvent,
} from './sessions'

let dir: string
let settingsPath: string
let scriptPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sessions-'))
  // A space in the config path proves the registered command quotes the script path.
  settingsPath = join(dir, 'claude config', 'settings.json')
  scriptPath = join(dir, 'claude config', 'hooks', 'session-manager-sessions.sh')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const NUDGE = { hooks: [{ type: 'command', command: '"/Users/me/.claude/hooks/session-manager-nudge.sh"' }] }
const USER_PROMPT_HOOK = { hooks: [{ type: 'command', command: 'echo theirs' }] }
const USER_FORMATTER = { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'prettier --write' }] }

function writeSettings(value: unknown): void {
  mkdirSync(join(settingsPath, '..'), { recursive: true })
  writeFileSync(settingsPath, typeof value === 'string' ? value : JSON.stringify(value))
}

interface Entry {
  matcher?: string
  hooks: Array<{ type: string; command: string; async?: boolean }>
}

function readSettings(): { [key: string]: unknown; hooks: Record<string, Entry[]> } {
  return JSON.parse(readFileSync(settingsPath, 'utf8'))
}

describe('installer', () => {
  it('registers every event with the documented shape on a fresh install', () => {
    installSessionHooks(settingsPath, scriptPath)
    const hooks = readSettings().hooks
    expect(Object.keys(hooks).sort()).toEqual(SESSION_HOOKS.map((h) => h.event).sort())
    expect(hooks.PreToolUse).toEqual([{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `"${scriptPath}" PreToolUse`, async: true }] }])
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: `"${scriptPath}" Stop`, async: true }] }])
    expect(hooks.SessionEnd).toEqual([{ hooks: [{ type: 'command', command: `"${scriptPath}" SessionEnd` }] }])
    expect(hooks.Notification?.[0]?.matcher).toBe('permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input')
    expect(hooks.PermissionRequest?.[0]).not.toHaveProperty('matcher')
    expect(statSync(scriptPath).mode & 0o777).toBe(0o755)
    expect(isSessionHooksInstalled(settingsPath, scriptPath)).toBe(true)
    expect(sessionHookScriptStale(scriptPath)).toBe(false)
  })

  it('is idempotent and preserves the nudge hook, user hooks, and other keys; uninstall restores the original', () => {
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { UserPromptSubmit: [NUDGE, USER_PROMPT_HOOK], PostToolUse: [USER_FORMATTER], PreCompact: [USER_PROMPT_HOOK], Stop: [] },
    }
    writeSettings(original)
    installSessionHooks(settingsPath, scriptPath)
    installSessionHooks(settingsPath, scriptPath)
    const after = readSettings()
    expect(after.model).toBe('opus')
    expect(after.permissions).toEqual(original.permissions)
    expect(after.hooks.UserPromptSubmit).toHaveLength(3)
    expect(after.hooks.UserPromptSubmit?.slice(0, 2)).toEqual([NUDGE, USER_PROMPT_HOOK])
    expect(after.hooks.UserPromptSubmit?.[2]?.hooks[0]?.command).toBe(`"${scriptPath}" UserPromptSubmit`)
    expect(after.hooks.PostToolUse).toHaveLength(2)
    expect(after.hooks.PostToolUse?.[0]).toEqual(USER_FORMATTER)
    expect(after.hooks.PreCompact).toEqual([USER_PROMPT_HOOK])
    expect(after.hooks.Stop).toHaveLength(1)
    for (const reg of SESSION_HOOKS) expect(after.hooks[reg.event]?.filter((e) => JSON.stringify(e).includes('session-manager-sessions.sh'))).toHaveLength(1)

    uninstallSessionHooks(settingsPath, scriptPath)
    const originalHooks: Record<string, unknown> = { ...original.hooks }
    delete originalHooks.Stop // emptied by the install (we were its only entry), so uninstall drops it
    expect(readSettings()).toEqual({ ...original, hooks: originalHooks })
    expect(existsSync(scriptPath)).toBe(false)
    expect(isSessionHooksInstalled(settingsPath, scriptPath)).toBe(false)
  })

  it('keeps a user command that shares an entry with ours', () => {
    const mixed = { hooks: [{ type: 'command', command: `"${scriptPath}" Stop`, async: true }, { type: 'command', command: 'say done' }] }
    writeSettings({ hooks: { Stop: [mixed] } })
    installSessionHooks(settingsPath, scriptPath)
    expect(readSettings().hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'say done' }] },
      { hooks: [{ type: 'command', command: `"${scriptPath}" Stop`, async: true }] },
    ])
    uninstallSessionHooks(settingsPath, scriptPath)
    expect(readSettings()).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } })
  })

  it('drops the hooks key when only ours were there, and leaves a missing settings file missing', () => {
    installSessionHooks(settingsPath, scriptPath)
    uninstallSessionHooks(settingsPath, scriptPath)
    expect(readSettings()).toEqual({})
    rmSync(settingsPath)
    uninstallSessionHooks(settingsPath, scriptPath)
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('reports not installed when an event is missing, the script is gone, or settings are unreadable', () => {
    installSessionHooks(settingsPath, scriptPath)
    const s = readSettings()
    delete s.hooks.SessionEnd
    writeSettings(s)
    expect(isSessionHooksInstalled(settingsPath, scriptPath)).toBe(false)
    installSessionHooks(settingsPath, scriptPath)
    rmSync(scriptPath)
    expect(isSessionHooksInstalled(settingsPath, scriptPath)).toBe(false)
    installSessionHooks(settingsPath, scriptPath)
    writeSettings('{ torn')
    expect(isSessionHooksInstalled(settingsPath, scriptPath)).toBe(false)
  })

  it('refuses an unparsable or non-object settings.json without writing anything', () => {
    for (const bad of ['{ not json', '[1, 2]', '"text"', 'null']) {
      writeSettings(bad)
      expect(() => installSessionHooks(settingsPath, scriptPath)).toThrow(`${settingsPath} is not a JSON object; not touching it`)
      expect(() => uninstallSessionHooks(settingsPath, scriptPath)).toThrow(/not a JSON object/)
      expect(readFileSync(settingsPath, 'utf8')).toBe(bad)
      expect(existsSync(scriptPath)).toBe(false)
    }
  })

  it('flags a script that differs from this build', () => {
    expect(sessionHookScriptStale(scriptPath)).toBe(false)
    installSessionHooks(settingsPath, scriptPath)
    writeFileSync(scriptPath, '#!/bin/bash\nexit 0\n')
    expect(sessionHookScriptStale(scriptPath)).toBe(true)
  })
})

describe('hook script', () => {
  const SID = '3f2a9c1e-77b0-4d2e-9c1a-0b5e8f6d4a21'
  const base = (event: string, sid = SID) => ({
    session_id: sid,
    transcript_path: `/Users/me/.claude/projects/-Users-me-proj/${sid}.jsonl`,
    cwd: '/Users/me/proj',
    permission_mode: 'default',
    hook_event_name: event,
  })
  const run = (event: string, payload: unknown) =>
    spawnSync('/bin/bash', [scriptPath, event], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      env: { ...process.env, SESSION_MANAGER_HOME: dir },
      encoding: 'utf8',
    })
  const fileOf = (event: string, sid = SID) => join(sessionsDir(dir), `${sid}.${event}.json`)
  const written = (event: string, sid = SID) => JSON.parse(readFileSync(fileOf(event, sid), 'utf8'))
  const listing = () => (existsSync(sessionsDir(dir)) ? readdirSync(sessionsDir(dir)).sort() : [])

  beforeEach(() => installSessionHooks(settingsPath, scriptPath))

  it('records a permission notification, unescaping nothing and printing nothing', () => {
    const message = 'Claude needs your permission to use "Bash" \\ now ☕'
    const r = run('Notification', { ...base('Notification'), message, title: 'Permission needed', notification_type: 'permission_prompt' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
    expect(written('Notification')).toEqual({
      event: 'Notification',
      session_id: SID,
      cwd: '/Users/me/proj',
      tool_name: '',
      notification_type: 'permission_prompt',
      message,
    })
    expect(statSync(fileOf('Notification')).mode & 0o777).toBe(0o600)
    expect(listing()).toEqual([`${SID}.Notification.json`])
  })

  it('handles pretty-printed payloads', () => {
    run('Notification', JSON.stringify({ ...base('Notification'), message: 'Claude is waiting for your input', notification_type: 'idle_prompt' }, null, 2))
    expect(written('Notification')).toMatchObject({ notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })
  })

  it('keeps the AskUserQuestion question but none of the rest of the tool input', () => {
    const payload = {
      ...base('PreToolUse'),
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Which auth method?',
            header: 'Auth',
            options: [
              { label: 'OAuth PKCE', description: 'Browser login flow' },
              { label: 'API key', description: 'Paste a key' },
            ],
            multiSelect: false,
          },
        ],
      },
      tool_use_id: 'toolu_01ABC',
    }
    expect(run('PreToolUse', payload).status).toBe(0)
    expect(written('PreToolUse')).toEqual({
      event: 'PreToolUse',
      session_id: SID,
      cwd: '/Users/me/proj',
      tool_name: 'AskUserQuestion',
      notification_type: '',
      message: 'Which auth method?',
    })
    const raw = readFileSync(fileOf('PreToolUse'), 'utf8')
    for (const leak of ['OAuth PKCE', 'Browser login', 'Paste a key', 'toolu_01ABC']) expect(raw).not.toContain(leak)
  })

  it('stays fast on a multi-megabyte PostToolUse and stores no tool input or output', () => {
    const payload = {
      ...base('PostToolUse'),
      tool_name: 'Bash',
      tool_input: { command: 'cat secrets.txt', description: 'Show the secrets file' },
      tool_response: { stdout: 'SECRET-OUTPUT "quoted" \\ \n'.repeat(120_000), stderr: '', message: 'nested', question: 'nested?', interrupted: false },
      tool_use_id: 'toolu_02',
    }
    const started = Date.now()
    expect(run('PostToolUse', payload).status).toBe(0)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(written('PostToolUse')).toEqual({
      event: 'PostToolUse',
      session_id: SID,
      cwd: '/Users/me/proj',
      tool_name: 'Bash',
      notification_type: '',
      message: '',
    })
    const raw = readFileSync(fileOf('PostToolUse'), 'utf8')
    for (const leak of ['SECRET-OUTPUT', 'secrets.txt', 'nested']) expect(raw).not.toContain(leak)
  })

  it('never stores the prompt', () => {
    run('UserPromptSubmit', { ...base('UserPromptSubmit'), prompt: 'my private prompt "message": "x"' })
    const raw = readFileSync(fileOf('UserPromptSubmit'), 'utf8')
    expect(raw).not.toContain('private prompt')
    expect(written('UserPromptSubmit').message).toBe('')
  })

  it('copies a cwd with spaces and escapes verbatim so it round-trips through JSON', () => {
    const raw = String.raw`{"session_id":"s-cwd_1","transcript_path":"/t.jsonl","cwd":"/Users/me/My Projects/café \"q\" back\\slash","hook_event_name":"Stop","stop_hook_active":false}`
    expect(run('Stop', raw).status).toBe(0)
    expect(written('Stop', 's-cwd_1').cwd).toBe('/Users/me/My Projects/café "q" back\\slash')
    expect(readSessions(sessionsDir(dir))[0]).toMatchObject({ id: 's-cwd_1', project: 'café "q" back\\slash', state: 'done' })
  })

  it('ignores bad session ids and bad event names', () => {
    for (const sid of ['../../etc/passwd', 'a b', '', 'x.y']) expect(run('Stop', { ...base('Stop', sid) }).status).toBe(0)
    expect(run('Stop', { cwd: '/x' }).status).toBe(0)
    expect(run('Stop', 'not json at all').status).toBe(0)
    for (const event of ['../Stop', 'Stop1', '']) expect(run(event, base('Stop')).status).toBe(0)
    expect(listing()).toEqual([])
  })

  it('SessionEnd removes only that session and writes nothing', () => {
    const other = 'other-session'
    run('UserPromptSubmit', base('UserPromptSubmit'))
    run('Stop', base('Stop'))
    run('Stop', base('Stop', other))
    expect(listing()).toHaveLength(3)
    const r = run('SessionEnd', { ...base('SessionEnd'), reason: 'prompt_input_exit' })
    expect(r.status).toBe(0)
    expect(listing()).toEqual([`${other}.Stop.json`])
  })

  it('runs through the registered command string with the event as argv[1]', () => {
    const command = readSettings().hooks.Stop?.[0]?.hooks[0]?.command ?? ''
    const r = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify(base('Stop')), env: { ...process.env, SESSION_MANAGER_HOME: dir }, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(written('Stop').event).toBe('Stop')
    expect(execFileSync(scriptPath, ['UserPromptSubmit'], { input: JSON.stringify(base('UserPromptSubmit')), env: { ...process.env, SESSION_MANAGER_HOME: dir }, encoding: 'utf8' })).toBe('')
    expect(listing().filter((n) => n.startsWith('.'))).toEqual([])
  })

  it('feeds readSessions end to end', () => {
    const t0 = Date.now() - 60_000
    const at = (s: number) => new Date(t0 + s * 1000)
    const stamp = (event: string, s: number) => utimesSync(fileOf(event), at(s), at(s))
    run('UserPromptSubmit', base('UserPromptSubmit'))
    stamp('UserPromptSubmit', 0)
    run('PermissionRequest', { ...base('PermissionRequest'), tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
    stamp('PermissionRequest', 5)
    expect(readSessions(sessionsDir(dir))).toEqual([
      { id: SID, project: 'proj', cwd: '/Users/me/proj', state: 'permission', since: at(5).toISOString(), detail: 'Permission to use Bash' },
    ])
    expect(readFileSync(fileOf('PermissionRequest'), 'utf8')).not.toContain('rm -rf')
    run('PostToolUse', { ...base('PostToolUse'), tool_name: 'Bash', tool_response: { stdout: '' } })
    stamp('PostToolUse', 9)
    // Working again since the permission request it resumed from, not since the tool call.
    expect(readSessions(sessionsDir(dir))[0]).toMatchObject({ state: 'working', since: at(5).toISOString(), detail: null })
    run('Stop', base('Stop'))
    stamp('Stop', 20)
    expect(readSessions(sessionsDir(dir))[0]).toMatchObject({ state: 'done', since: at(20).toISOString() })
  })
})

describe('deriveSession', () => {
  const T0 = Date.parse('2026-09-26T10:00:00Z')
  const ev = (event: string, s: number, extra: Partial<SessionEvent> = {}): SessionEvent => ({
    event,
    at: new Date(T0 + s * 1000),
    cwd: '/Users/me/proj',
    toolName: '',
    notificationType: '',
    message: '',
    ...extra,
  })
  const iso = (s: number) => new Date(T0 + s * 1000).toISOString()
  const note = (type: string, s: number, message = '') => ev('Notification', s, { notificationType: type, message })

  it('is null without a meaningful event', () => {
    expect(deriveSession('a', [])).toBeNull()
    expect(deriveSession('a', [ev('PreCompact', 1), note('auth_success', 2)])).toBeNull()
  })

  it('maps hard events', () => {
    expect(deriveSession('a', [ev('SessionStart', 1)])).toEqual({ id: 'a', project: 'proj', cwd: '/Users/me/proj', state: 'ready', since: iso(1), detail: null })
    expect(deriveSession('a', [ev('SessionStart', 1), ev('UserPromptSubmit', 2)])?.state).toBe('working')
    // A working stretch dates from its prompt: every tool call rewrites PostToolUse, which must not restart the clock.
    expect(deriveSession('a', [ev('UserPromptSubmit', 2), ev('PostToolUse', 3, { toolName: 'Read' })])).toMatchObject({ state: 'working', since: iso(2), detail: null })
    expect(deriveSession('a', [ev('UserPromptSubmit', 2), ev('PostToolUse', 30)])?.since).toBe(iso(2))
    expect(deriveSession('a', [ev('UserPromptSubmit', 2), ev('Stop', 9)])).toMatchObject({ state: 'done', since: iso(9), detail: null })
    expect(deriveSession('a', [ev('PreToolUse', 4, { toolName: 'AskUserQuestion', message: 'Which auth method?' })])).toMatchObject({ state: 'question', detail: 'Which auth method?' })
    expect(deriveSession('a', [ev('PermissionRequest', 4, { toolName: 'Bash' })])).toMatchObject({ state: 'permission', detail: 'Permission to use Bash' })
  })

  it('treats a permission request for AskUserQuestion as the question PreToolUse recorded', () => {
    const events = [ev('PreToolUse', 4, { toolName: 'AskUserQuestion', message: 'Ship it?' }), ev('PermissionRequest', 5, { toolName: 'AskUserQuestion' })]
    expect(deriveSession('a', events)).toMatchObject({ state: 'question', since: iso(5), detail: 'Ship it?' })
  })

  it('keeps a waiting hard state over later notifications', () => {
    expect(deriveSession('a', [ev('Stop', 10), note('idle_prompt', 70, 'Claude is waiting for your input')])).toMatchObject({ state: 'done', since: iso(10) })
    expect(deriveSession('a', [ev('PermissionRequest', 10, { toolName: 'Edit' }), note('permission_prompt', 16, 'Claude needs your permission to use Edit')])).toMatchObject({
      state: 'permission',
      since: iso(10),
      detail: 'Permission to use Edit',
    })
  })

  it('lets a newer notification override a working state', () => {
    // A permission prompt racing a parallel tool's PostToolUse.
    const race = [ev('UserPromptSubmit', 1), ev('PostToolUse', 5), note('permission_prompt', 6, 'Claude needs your permission to use Bash')]
    expect(deriveSession('a', race)).toMatchObject({ state: 'permission', since: iso(6), detail: 'Claude needs your permission to use Bash' })
    // Esc-interrupted turn: no Stop, but idle_prompt later.
    expect(deriveSession('a', [ev('UserPromptSubmit', 1), note('idle_prompt', 61, 'Claude is waiting for your input')])).toMatchObject({ state: 'done', since: iso(61), detail: null })
    for (const type of ['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']) {
      expect(deriveSession('a', [ev('UserPromptSubmit', 1), note(type, 3, 'Server wants a token')])).toMatchObject({ state: 'question', detail: 'Server wants a token' })
    }
    expect(deriveSession('a', [note('idle_prompt', 3)])).toMatchObject({ state: 'done', since: iso(3) })
  })

  it('ignores notifications older than the newest hard event', () => {
    expect(deriveSession('a', [note('permission_prompt', 5, 'old'), ev('PostToolUse', 8)])).toMatchObject({ state: 'working', since: iso(8), detail: null })
    expect(deriveSession('a', [note('idle_prompt', 5), ev('UserPromptSubmit', 8)])).toMatchObject({ state: 'working', since: iso(8) })
  })

  it('cleans the detail', () => {
    const q = (message: string) => deriveSession('a', [ev('PreToolUse', 1, { toolName: 'AskUserQuestion', message })])?.detail
    expect(q('  Which\n\tone?  ')).toBe('Which one?')
    expect(q('   ')).toBeNull()
    expect(q('')).toBeNull()
    const long = q('word '.repeat(100)) ?? ''
    expect(Array.from(long)).toHaveLength(200)
    expect(long.endsWith('…')).toBe(true)
    expect(Array.from(q('😀'.repeat(250)) ?? '')).toHaveLength(200)
  })

  it('takes cwd from the newest event that has one', () => {
    const events = [ev('SessionStart', 1, { cwd: '/old/place' }), ev('UserPromptSubmit', 2, { cwd: '/Users/me/new-place/' }), ev('Stop', 3, { cwd: '' })]
    expect(deriveSession('a', events)).toMatchObject({ cwd: '/Users/me/new-place/', project: 'new-place' })
    expect(deriveSession('a', [ev('Stop', 3, { cwd: '' })])).toMatchObject({ cwd: '', project: 'Claude Code' })
  })
})

describe('readSessions', () => {
  const now = new Date('2026-09-26T12:00:00Z')
  const ago = (ms: number) => new Date(now.getTime() - ms)
  let sdir: string

  beforeEach(() => {
    sdir = sessionsDir(dir)
    mkdirSync(sdir, { recursive: true })
  })

  function put(name: string, body: unknown, at: Date): string {
    const path = join(sdir, name)
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
    utimesSync(path, at, at)
    return path
  }

  it('returns [] for a missing directory', () => {
    expect(readSessions(join(dir, 'nope'), now)).toEqual([])
  })

  it('groups by session, sorts by since, and skips junk without deleting it', () => {
    put('aaa.UserPromptSubmit.json', { event: 'UserPromptSubmit', cwd: '/w/alpha' }, ago(60_000))
    put('aaa.Stop.json', { event: 'Stop', cwd: '/w/alpha' }, ago(30_000))
    put('bbb.PostToolUse.json', { event: 'PostToolUse', cwd: '/w/beta', tool_name: 'Read' }, ago(5_000))
    const torn = put('bbb.Stop.json', '{ torn', ago(1_000))
    put('.bbb.Stop.123.tmp', { event: 'Stop' }, ago(1_000))
    put('notes.txt', 'x', ago(1_000))
    put('bad id.Stop.json', { event: 'Stop' }, ago(1_000))
    put('ccc.Custom.json', { event: 'Custom' }, ago(1_000))
    expect(readSessions(sdir, now)).toEqual([
      { id: 'bbb', project: 'beta', cwd: '/w/beta', state: 'working', since: ago(5_000).toISOString(), detail: null },
      { id: 'aaa', project: 'alpha', cwd: '/w/alpha', state: 'done', since: ago(30_000).toISOString(), detail: null },
    ])
    expect(existsSync(torn)).toBe(true)
    expect(existsSync(join(sdir, 'ccc.Custom.json'))).toBe(true)
  })

  it('sweeps sessions silent for longer than the max age', () => {
    const stale = [
      put('old.UserPromptSubmit.json', { cwd: '/w/old' }, ago(SESSION_MAX_AGE_MS + 120_000)),
      put('old.PostToolUse.json', { cwd: '/w/old' }, ago(SESSION_MAX_AGE_MS + 60_000)),
      put('old.Stop.json', '{ torn', ago(SESSION_MAX_AGE_MS + 60_000)),
    ]
    // One recent file keeps the whole group alive, even though its other files are old.
    put('live.SessionStart.json', { cwd: '/w/live' }, ago(SESSION_MAX_AGE_MS + 60_000))
    put('live.UserPromptSubmit.json', { cwd: '/w/live' }, ago(60_000))
    expect(readSessions(sdir, now).map((s) => [s.id, s.state])).toEqual([['live', 'working']])
    for (const f of stale) expect(existsSync(f)).toBe(false)
    expect(readdirSync(sdir).sort()).toEqual(['live.SessionStart.json', 'live.UserPromptSubmit.json'])
  })
})
