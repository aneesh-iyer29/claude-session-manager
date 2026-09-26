import { describe, expect, it } from 'vitest'

import { SEND_SCRIPT, SEND_TIMEOUT_MS, explainFailure, normalizeHandle, sendIMessage, type ExecFileFn } from './imessage'

interface Call {
  file: string
  args: readonly string[]
  options: { timeout: number }
}

/** A fake osascript: records the call, then resolves or rejects. Nothing real ever runs. */
function fakeExec(calls: Call[], failure?: unknown): ExecFileFn {
  return async (file, args, options) => {
    calls.push({ file, args, options })
    if (failure !== undefined) throw failure
    return { stdout: '', stderr: '' }
  }
}

/** Shaped like an `execFile` rejection. */
function execError(fields: { stderr?: string; code?: unknown; killed?: boolean; signal?: string | null; message?: string }): Error {
  const err = new Error(fields.message ?? `Command failed: /usr/bin/osascript\n${fields.stderr ?? ''}`)
  return Object.assign(err, { stderr: '', code: 1, killed: false, signal: null, ...fields })
}

const HANDLE = '+15551234567'
const TEXT = 'Claude Code needs you. “secret-project” is asking you a question: Rotate the prod keys?'

describe('normalizeHandle', () => {
  it.each([
    ['+1 (555) 123-4567', '+15551234567'],
    ['555.123.4567', '5551234567'],
    ['  +44 20 7946 0958 ', '+442079460958'],
    [' Me@iCloud.com ', 'me@icloud.com'],
    ['first.last+tag@example.co.uk', 'first.last+tag@example.co.uk'],
  ])('accepts %j as %j', (raw, expected) => {
    expect(normalizeHandle(raw)).toBe(expected)
  })

  it.each([
    'hello',
    '123',
    '',
    '   ',
    '+1234567890123456', // 16 digits
    '++15551234567',
    '555-CALL-NOW',
    'me@icloud',
    'me@@icloud.com',
    'me @icloud.com',
    '-e@evil.com', // would reach osascript as an option
    `${'a'.repeat(250)}@x.com`,
  ])('rejects %j', (raw) => {
    expect(normalizeHandle(raw)).toBeNull()
  })
})

describe('sendIMessage', () => {
  it('runs the pinned osascript with the handle and text as argv, never in the script', async () => {
    const calls: Call[] = []
    await sendIMessage('+1 (555) 123-4567', TEXT, fakeExec(calls))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ file: '/usr/bin/osascript', args: ['-e', SEND_SCRIPT, HANDLE, TEXT], options: { timeout: SEND_TIMEOUT_MS } })
    expect(SEND_TIMEOUT_MS).toBe(60_000)
    expect(SEND_SCRIPT).toContain('on run argv')
    expect(SEND_SCRIPT).toContain('service type = iMessage')
    expect(SEND_SCRIPT).not.toContain(HANDLE)
  })

  it('passes AppleScript-looking text through untouched as data', async () => {
    const calls: Call[] = []
    const nasty = '" & (do shell script "rm -rf ~") & "'
    await sendIMessage('me@icloud.com', nasty, fakeExec(calls))
    expect(calls[0]!.args).toEqual(['-e', SEND_SCRIPT, 'me@icloud.com', nasty])
  })

  it('refuses an empty or invalid handle without running anything', async () => {
    const calls: Call[] = []
    await expect(sendIMessage('  ', TEXT, fakeExec(calls))).rejects.toThrow('Set a phone number or email to text first.')
    await expect(sendIMessage('hello', TEXT, fakeExec(calls))).rejects.toThrow(
      "That isn't a phone number or email Messages can text.",
    )
    expect(calls).toEqual([])
  })

  it('explains a failure without echoing the handle or the text', async () => {
    const node = execError({
      message: `Command failed: /usr/bin/osascript -e ${SEND_SCRIPT} ${HANDLE} ${TEXT}\nexecution error: ${TEXT} went wrong (-1)`,
      stderr: `execution error: Could not send "${TEXT}" to ${HANDLE} (-1)`,
    })
    const err = await sendIMessage('+1 (555) 123-4567', TEXT, fakeExec([], node)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toMatch(/^Messages couldn't send the text: /)
    expect(message).not.toContain(HANDLE)
    expect(message).not.toContain('secret-project')
    expect(message).not.toContain('Rotate')
  })

  it('maps a real-looking permission failure', async () => {
    const node = execError({ stderr: '0:180: execution error: Not authorized to send Apple events to Messages. (-1743)\n' })
    await expect(sendIMessage(HANDLE, TEXT, fakeExec([], node))).rejects.toThrow(/Privacy & Security → Automation/)
  })
})

describe('explainFailure', () => {
  it('spots a denied Automation permission', () => {
    const expected =
      "Session Manager isn't allowed to control Messages. Turn it on in System Settings → Privacy & Security → Automation, then try again."
    expect(explainFailure(execError({ stderr: 'execution error: Not authorized to send Apple events to Messages. (-1743)' }))).toBe(expected)
    expect(explainFailure(execError({ stderr: 'error -1743' }))).toBe(expected)
    expect(explainFailure(new Error('not authorised'))).toBe(expected)
  })

  it('spots a missing iMessage account', () => {
    const expected = 'Messages has no iMessage account on this Mac. Sign in to iMessage in Messages first.'
    expect(explainFailure(execError({ stderr: 'execution error: Messages got an error: Can’t get account 1 whose service type = iMessage. (-1728)' }))).toBe(expected)
    expect(explainFailure(execError({ stderr: "Can't get account 1 whose service type = iMessage." }))).toBe(expected)
    expect(explainFailure(execError({ stderr: 'Messages got an error: no enabled iMessage account' }))).toBe(expected)
    expect(explainFailure(execError({ stderr: 'account (-1728)' }))).toBe(expected)
  })

  it('spots an unreachable participant, even though the error names the account', () => {
    const expected = "Messages can't reach that number or email over iMessage. Check it and try again."
    const stderr = `execution error: Messages got an error: Can’t get participant "${HANDLE}" of account id "E:me@icloud.com". (-1728)`
    expect(explainFailure(execError({ stderr }), [HANDLE])).toBe(expected)
    expect(explainFailure(execError({ stderr: "Can't get buddy id 42" }))).toBe(expected)
  })

  it('spots a timeout', () => {
    const expected = "Messages didn't answer in time. Open Messages once, then try again."
    expect(explainFailure(execError({ killed: true, signal: 'SIGTERM', code: null }))).toBe(expected)
    expect(explainFailure(execError({ signal: 'SIGTERM' }))).toBe(expected)
    expect(explainFailure(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))).toBe(expected)
  })

  it('spots a missing osascript', () => {
    expect(explainFailure(Object.assign(new Error('spawn /usr/bin/osascript ENOENT'), { code: 'ENOENT' }))).toBe(
      "osascript isn't available; iMessage alerts need macOS.",
    )
  })

  it('falls back to the first line of stderr, tidied and scrubbed', () => {
    const stderr = `12:34: execution error: Messages got an error:   sending ${HANDLE} failed\n  second line`
    expect(explainFailure(execError({ stderr }), [HANDLE, TEXT])).toBe(
      'Messages couldn\'t send the text: Messages got an error: sending … failed',
    )
  })

  it('scrubs every occurrence of every secret, and quoted values it was not told about', () => {
    const stderr = `${HANDLE} ${HANDLE} "E:me@icloud.com" ${TEXT}`
    const out = explainFailure(execError({ stderr }), [HANDLE, TEXT])
    expect(out).not.toContain(HANDLE)
    expect(out).not.toContain('secret-project')
    expect(out).not.toContain('me@icloud.com')
    expect(out).toBe('Messages couldn\'t send the text: … … "…" …')
  })

  it('scrubs one line of a multi-line text that surfaces on its own', () => {
    const text = 'Claude Code needs you in 2 sessions:\n• “alpha-secret” finished and is waiting for your next message\n• “beta” finished'
    const stderr = 'failed on • “alpha-secret” finished and is waiting for your next message'
    const out = explainFailure(execError({ stderr }), [HANDLE, text])
    expect(out).not.toContain('alpha-secret')
  })

  it('caps the fallback detail at 120 characters', () => {
    const out = explainFailure(execError({ stderr: 'z'.repeat(500) }))
    const detail = out.replace("Messages couldn't send the text: ", '')
    expect(detail).toHaveLength(120)
    expect(detail.endsWith('…')).toBe(true)
  })

  it('never classifies or quotes the script and text from node\'s "Command failed" message', () => {
    // The script mentions "participant" and "account"; the text mentions authorisation. None of it is an error.
    const text = 'Claude Code needs you. “x” is waiting for your permission (not authorized -1743)'
    const node = execError({ message: `Command failed: /usr/bin/osascript -e ${SEND_SCRIPT} ${HANDLE} ${text}\n`, stderr: '', code: 1 })
    expect(explainFailure(node, [HANDLE, text])).toBe("Messages couldn't send the text: osascript exited with code 1")
  })

  it('handles non-Error values', () => {
    expect(explainFailure('boom')).toBe("Messages couldn't send the text: boom")
    expect(explainFailure(undefined)).toBe("Messages couldn't send the text.")
    expect(explainFailure({ stderr: Buffer.from('Not authorized (-1743)') })).toMatch(/Automation/)
  })
})
