/**
 * Text the user's phone through the Mac's own Messages app.
 *
 * AppleScript via the system `/usr/bin/osascript` is the one route that needs
 * no extra software, server, or account: Messages sends as whoever is signed in
 * to iMessage on this Mac. The handle and text travel as `argv` to the
 * script's `on run` handler and are never spliced into its source, so no
 * character in a project name or a question can change what the script does.
 *
 * Failures come back as AppleScript error text, which quotes the values it
 * could not use (the handle, the signed-in Apple ID). `explainFailure` turns
 * that into advice the settings screen can show without echoing any of it.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** The only thing this module needs from the OS; tests inject a fake so nothing is ever sent. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>

const OSASCRIPT = '/usr/bin/osascript' // pinned: a PATH shim must never see the handle or the text
/** The first send can sit behind macOS's Automation consent prompt until the user answers it. */
export const SEND_TIMEOUT_MS = 60_000

const HANDLE_MAX = 254
/** Loose on purpose (Messages is the real judge), but no leading `-`, which osascript would parse as an option. */
const EMAIL = /^[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+$/
const PHONE = /^\+?\d{7,15}$/
const PHONE_FORMATTING = /[\s\-.()]/g

/** Phone (digits, optional leading +, formatting stripped; 7-15 digits) or email (lowercased). null when neither. */
export function normalizeHandle(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value === '' || value.length > HANDLE_MAX) return null
  if (value.includes('@')) return EMAIL.test(value) ? value.toLowerCase() : null
  const digits = value.replace(PHONE_FORMATTING, '')
  return PHONE.test(digits) ? digits : null
}

/**
 * Sends `item 2 of argv` to `item 1 of argv` over the first iMessage account.
 * Pinning the iMessage service keeps a text from silently going out as SMS
 * through a paired iPhone, or to the wrong account on a Mac with several.
 */
export const SEND_SCRIPT = `on run argv
	set theHandle to item 1 of argv
	set theText to item 2 of argv
	tell application "Messages"
		set theAccount to first account whose service type = iMessage
		send theText to participant theHandle of theAccount
	end tell
end run`

const execFileAsync = promisify(execFile)

const defaultExec: ExecFileFn = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], { timeout: options.timeout, encoding: 'utf8' })
  return { stdout, stderr }
}

/** Send one iMessage. Throws an `Error` whose message is safe to show and log. */
export async function sendIMessage(to: string, text: string, exec: ExecFileFn = defaultExec): Promise<void> {
  if (typeof to !== 'string' || to.trim() === '') throw new Error('Set a phone number or email to text first.')
  const handle = normalizeHandle(to)
  if (handle === null) throw new Error("That isn't a phone number or email Messages can text.")
  try {
    await exec(OSASCRIPT, ['-e', SEND_SCRIPT, handle, text], { timeout: SEND_TIMEOUT_MS })
  } catch (err) {
    throw new Error(explainFailure(err, [handle, text, to]))
  }
}

interface Failure {
  stderr: string
  message: string
  code: unknown
  killed: boolean
  signal: unknown
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  return Buffer.isBuffer(value) ? value.toString('utf8') : ''
}

/** The fields an `execFile` rejection carries, read defensively since `err` is untyped. */
function readFailure(err: unknown): Failure {
  const e = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : asText(e.message)
  return { stderr: asText(e.stderr), message, code: e.code, killed: e.killed === true, signal: e.signal }
}

/**
 * Replaces every secret with `…`. A multi-line text may surface one line at a
 * time in an error, so each longer line is scrubbed on its own too. Longest
 * first, so a secret that contains another is removed whole.
 */
function scrubber(secrets: readonly string[]): (text: string) => string {
  const lines = secrets.flatMap((s) => s.split('\n').map((l) => l.trim()).filter((l) => l.length >= 4))
  const needles = [...new Set([...secrets.filter((s) => s !== ''), ...lines])].sort((a, b) => b.length - a.length)
  return (text) => needles.reduce((acc, needle) => acc.split(needle).join('…'), text)
}

/**
 * Node's `Command failed: …` message repeats the whole command line, script,
 * handle and text included. Only the error text is worth classifying.
 */
function haystack(f: Failure, scrub: (text: string) => string): string {
  return `${scrub(f.stderr)}\n${scrub(f.message.split(SEND_SCRIPT).join(''))}`
}

const PERMISSION_DENIED = /-1743|not authori[sz]ed/i
const NO_ACCOUNT = /can.t get account|no .*imessage account/i
const NO_ACCOUNT_LOOSE = /-1728.*account|account.*-1728/i
const PARTICIPANT = /participant|buddy/i
const CANT_GET = /-1728|can.t get/i

/** One secret-free line of what went wrong, for errors no branch recognises. */
function fallbackDetail(f: Failure, scrub: (text: string) => string): string {
  const source = f.stderr.trim() !== '' ? f.stderr : f.message.startsWith('Command failed:') ? '' : f.message
  const line = scrub(source).split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
  const cleaned = line
    .replace(/^\d+:\d+:\s*/, '') // osascript's "line:column:" prefix
    .replace(/^execution error:\s*/i, '')
    .replace(/"[^"]*("|$)/g, '"…"') // AppleScript quotes the values it choked on, e.g. the Apple ID
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned !== '') return cleaned.length <= 120 ? cleaned : cleaned.slice(0, 119).trimEnd() + '…'
  return typeof f.code === 'number' ? `osascript exited with code ${f.code}` : ''
}

/** User-safe reason for a failed send. Never contains the handle or the message text. */
export function explainFailure(err: unknown, secrets: readonly string[] = []): string {
  const f = readFailure(err)
  const scrub = scrubber(secrets)
  const text = haystack(f, scrub)
  if (PERMISSION_DENIED.test(text)) {
    return "Session Manager isn't allowed to control Messages. Turn it on in System Settings → Privacy & Security → Automation, then try again."
  }
  // "Can't get participant … of account id … (-1728)" also mentions the account,
  // so the participant check sits between the exact and the loose account checks.
  if (NO_ACCOUNT.test(text)) return noAccount()
  if (PARTICIPANT.test(text) && CANT_GET.test(text)) {
    return "Messages can't reach that number or email over iMessage. Check it and try again."
  }
  if (NO_ACCOUNT_LOOSE.test(text)) return noAccount()
  if (f.killed || f.signal === 'SIGTERM' || f.code === 'ETIMEDOUT') {
    return "Messages didn't answer in time. Open Messages once, then try again."
  }
  if (f.code === 'ENOENT') return "osascript isn't available; iMessage alerts need macOS."
  const detail = fallbackDetail(f, scrub)
  return detail ? `Messages couldn't send the text: ${detail}` : "Messages couldn't send the text."
}

function noAccount(): string {
  return 'Messages has no iMessage account on this Mac. Sign in to iMessage in Messages first.'
}
