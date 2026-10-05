import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ANY_CREDIT,
  CLIENT_ID,
  CONSUME_URL,
  RESET_CREDITS_URL,
  TOKEN_URL,
  USAGE_URL,
  jwtClaims,
  maybeRefresh,
  needsRefresh,
  normalizeResetCredits,
  normalizeUsage,
  readAuth,
  redeemReset,
  snapshot,
  type CodexAuth,
  type FetchFn,
} from './codex'

const NOW = new Date('2026-09-04T18:00:00Z')
const FAR_FUTURE = new Date('2100-01-01T00:00:00Z')

/** Build an unsigned JWT with base64url segments and no padding, as Codex does. */
function jwt(claims: Record<string, unknown>): string {
  const seg = (obj: Record<string, unknown>): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${seg({ alg: 'none' })}.${seg(claims)}.sig`
}

function chatgptAuth(exp: Date = FAR_FUTURE): Record<string, unknown> {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: jwt({ exp: Math.floor(exp.getTime() / 1000) }),
      refresh_token: 'rt-1',
      id_token: jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'pro' } }),
      account_id: 'acct-1',
    },
    last_refresh: '2026-09-01T00:00:00Z',
    extra: { keep: 'me' },
  }
}

let home: string
let authPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'swapper-codex-'))
  authPath = join(home, '.codex', 'auth.json')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function writeAuth(data: unknown): void {
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(authPath, JSON.stringify(data))
}

describe('jwtClaims', () => {
  it('decodes without verifying and tolerates missing padding', () => {
    expect(jwtClaims(jwt({ a: 1 }))).toEqual({ a: 1 })
    // a payload whose base64 length is not a multiple of 4
    const unpadded = 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImFAYi5jIn0.sig'
    expect(jwtClaims(unpadded)).toEqual({ email: 'a@b.c' })
    expect(jwtClaims('not.a')).toEqual({})
    expect(jwtClaims(null)).toEqual({})
    expect(jwtClaims('x.!!!.y')).toEqual({})
  })
})

describe('readAuth', () => {
  it('reads the chatgpt identity from the id token', () => {
    writeAuth(chatgptAuth())
    const auth = readAuth(authPath)
    expect(auth.mode).toBe('chatgpt')
    expect(auth.email).toBe('me@example.com')
    expect(auth.plan).toBe('pro')
    expect(auth.accountId).toBe('acct-1')
    expect(auth.refreshToken).toBe('rt-1')
  })

  it('detects apikey and none modes', () => {
    expect(readAuth(authPath).mode).toBe('none')
    writeAuth({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' })
    expect(readAuth(authPath).mode).toBe('apikey')
    writeAuth({ OPENAI_API_KEY: 'sk-test' })
    expect(readAuth(authPath).mode).toBe('apikey')
    writeAuth({ tokens: {} })
    expect(readAuth(authPath).mode).toBe('none')
  })
})

describe('normalizeUsage', () => {
  it('handles the reset_at epoch shape', () => {
    const raw = {
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 41, limit_window_seconds: 18000, reset_at: 1788000000 },
        secondary_window: { used_percent: 71.26, limit_window_seconds: 604800, reset_at: 1788400000 },
      },
    }
    const usage = normalizeUsage(raw, NOW)
    expect(usage.ok).toBe(true)
    expect(usage.plan).toBe('pro')
    expect(usage.fetchedAt).toBe('2026-09-04T18:00:00Z')
    expect(usage.windows).toEqual([
      { key: 'five_hour', label: '5-hour', pct: 41, resetsAt: '2026-08-29T10:40:00Z' },
      { key: 'seven_day', label: 'Weekly', pct: 71.3, resetsAt: '2026-09-03T01:46:40Z' },
    ])
  })

  it('treats reset_after_seconds as relative to now and clamps pct', () => {
    const raw = { rate_limits: { primary: { percent_used: 120, reset_after_seconds: 90 }, secondary: { used_percent: 5 } } }
    const usage = normalizeUsage(raw, NOW)
    expect(usage.windows[0]!.pct).toBe(100)
    expect(usage.windows[0]!.resetsAt).toBe('2026-09-04T18:01:30Z')
    expect(usage.windows[1]!.resetsAt).toBeNull()
    expect(usage.plan).toBeNull()
    expect(normalizeUsage({}, NOW).windows).toEqual([])
  })

  it('labels windows by their length, not their slot, shortest first', () => {
    const raw = {
      rate_limit: {
        primary_window: { used_percent: 1, limit_window_seconds: 604800, reset_at: 1757545200 },
        secondary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1757030400 },
      },
    }
    expect(normalizeUsage(raw, NOW).windows.map((w) => [w.key, w.label, w.pct])).toEqual([
      ['five_hour', '5-hour', 12],
      ['seven_day', 'Weekly', 1],
    ])
    const day = normalizeUsage({ rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 86400 } } }, NOW)
    expect(day.windows[0]).toMatchObject({ key: 'window:24h', label: '24-hour' })
  })

  it('a slot with no length whose reset is days away is the weekly window', () => {
    const reset = Math.floor((NOW.getTime() + (6 * 24 + 23) * 3_600_000) / 1000)
    const usage = normalizeUsage({ rate_limit: { primary_window: { used_percent: 1, reset_at: reset } } }, NOW)
    expect(usage.windows).toEqual([{ key: 'seven_day', label: 'Weekly', pct: 1, resetsAt: '2026-09-11T17:00:00Z' }])
  })
})

describe('needsRefresh / maybeRefresh', () => {
  const at = (d: Date): number => Math.floor(d.getTime() / 1000)

  it('uses the access token exp claim', () => {
    const soon: CodexAuth = { mode: 'chatgpt', accessToken: jwt({ exp: at(new Date(NOW.getTime() + 10 * 60_000)) }), refreshToken: 'rt', path: authPath }
    const later: CodexAuth = { mode: 'chatgpt', accessToken: jwt({ exp: at(new Date(NOW.getTime() + 3 * 3_600_000)) }), refreshToken: 'rt', path: authPath }
    expect(needsRefresh(soon, NOW.getTime())).toBe(true)
    expect(needsRefresh(later, NOW.getTime())).toBe(false)
    expect(needsRefresh({ mode: 'chatgpt', accessToken: 'opaque', refreshToken: 'rt', path: authPath }, NOW.getTime())).toBe(false)
    expect(needsRefresh({ mode: 'apikey', path: authPath }, NOW.getTime())).toBe(false)
  })

  it('writes back preserving unknown keys and file mode', async () => {
    writeAuth(chatgptAuth(new Date(NOW.getTime() + 5 * 60_000)))
    chmodSync(authPath, 0o600)
    const auth = readAuth(authPath)
    const seen: { url?: string; form?: URLSearchParams; contentType?: string } = {}
    const fetchFn: FetchFn = async (url, init) => {
      seen.url = String(url)
      seen.form = new URLSearchParams(String(init?.body))
      seen.contentType = (init?.headers as Record<string, string>)['Content-Type']
      return new Response(
        JSON.stringify({
          access_token: jwt({ exp: at(new Date(NOW.getTime() + 3_600_000)) }),
          refresh_token: 'rt-2',
          id_token: jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }),
        }),
        { status: 200 },
      )
    }
    const next = await maybeRefresh(auth, fetchFn, NOW)
    expect(seen.url).toBe(TOKEN_URL)
    expect(seen.contentType).toBe('application/x-www-form-urlencoded')
    expect(seen.form!.get('grant_type')).toBe('refresh_token')
    expect(seen.form!.get('client_id')).toBe(CLIENT_ID)
    expect(seen.form!.get('refresh_token')).toBe('rt-1')
    expect(next.refreshToken).toBe('rt-2')
    expect(next.plan).toBe('plus')
    expect(next.accountId).toBe('acct-1')
    const onDisk = JSON.parse(readFileSync(authPath, 'utf8'))
    expect(onDisk.extra).toEqual({ keep: 'me' })
    expect(onDisk.auth_mode).toBe('chatgpt')
    expect(onDisk.tokens.refresh_token).toBe('rt-2')
    expect(onDisk.tokens.account_id).toBe('acct-1')
    expect(onDisk.last_refresh).not.toBe('2026-09-01T00:00:00Z')
    expect(statSync(authPath).mode & 0o777).toBe(0o600)
    // not due → untouched, no network
    const noNetwork: FetchFn = async () => {
      throw new Error('unexpected network call')
    }
    expect(await maybeRefresh(next, noNetwork, NOW)).toBe(next)
  })
})

describe('snapshot', () => {
  it('reports none and apikey modes without touching the network', async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error('unexpected network call')
    }
    expect(await snapshot({ path: authPath, fetchFn })).toEqual({ configured: false, mode: 'none', email: null, plan: null, usage: null })
    writeAuth({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' })
    const snap = await snapshot({ path: authPath, fetchFn })
    expect(snap.configured).toBe(true)
    expect(snap.mode).toBe('apikey')
    expect(snap.usage).toBeNull()
  })

  it('fetches usage for chatgpt mode and surfaces failures without throwing', async () => {
    writeAuth(chatgptAuth())
    let headers: Record<string, string> = {}
    const urls: string[] = []
    const ok: FetchFn = async (url, init) => {
      urls.push(String(url))
      if (String(url) === RESET_CREDITS_URL) return new Response(JSON.stringify({ credits: [{ id: 'c1', status: 'available' }] }), { status: 200 })
      headers = init?.headers as Record<string, string>
      return new Response(JSON.stringify({ plan_type: 'pro', rate_limit: { primary_window: { used_percent: 10 } } }), { status: 200 })
    }
    const snap = await snapshot({ path: authPath, fetchFn: ok, now: NOW })
    expect(snap.mode).toBe('chatgpt')
    expect(snap.email).toBe('me@example.com')
    expect(snap.plan).toBe('pro')
    expect(snap.usage!.windows[0]!.key).toBe('five_hour')
    expect(headers['ChatGPT-Account-ID']).toBe('acct-1')
    expect(headers.originator).toBe('codex_cli_rs')
    expect(urls.sort()).toEqual([RESET_CREDITS_URL, USAGE_URL].sort())
    expect(snap.usage!.resets?.credits.map((c) => c.id)).toEqual(['c1'])

    const offline: FetchFn = async () => {
      throw new Error('offline')
    }
    const failed = await snapshot({ path: authPath, fetchFn: offline, now: NOW })
    expect(failed.configured).toBe(true)
    expect(failed.usage!.ok).toBe(false)
    expect(failed.usage!.error).toContain('offline')

    const expired: FetchFn = async () => new Response('', { status: 401 })
    const dead = await snapshot({ path: authPath, fetchFn: expired, now: NOW })
    expect(dead.usage!.error).toContain('codex login')
  })
})

describe('normalizeResetCredits', () => {
  it('keeps available credits, soonest expiry first, and reads every expiry spelling', () => {
    const r = normalizeResetCredits(
      {
        available_count: 3,
        credits: [
          { id: 'late', status: 'available', expires_at: '2026-10-30T00:00:00Z', title: 'Make-good' },
          { id: 'soon', status: 'AVAILABLE', expires_at: Date.parse('2026-09-10T00:00:00Z') / 1000 },
          { credit_id: 'nostatus' },
          { id: 'used', status: 'redeemed' },
          { id: 'gone', status: 'available', expires_at: '2026-09-01T00:00:00Z' },
          { status: 'available' },
        ],
      },
      null,
      NOW,
    )!
    expect(r.credits.map((c) => [c.id, c.expiresAt, c.title])).toEqual([
      ['soon', '2026-09-10T00:00:00Z', null],
      ['late', '2026-10-30T00:00:00Z', 'Make-good'],
      ['nostatus', null, null],
    ])
    expect(r.available).toBe(3)
  })

  it('falls back to the usage body count, and is null when neither says', () => {
    const fallback = normalizeResetCredits(null, { rate_limit_reset_credits: { available_count: 2 } }, NOW)!
    expect(fallback.available).toBe(2)
    expect(fallback.credits).toEqual([{ id: ANY_CREDIT, title: null, count: 2, expiresAt: null, clears: [] }])
    expect(normalizeResetCredits(null, { rate_limit_reset_credits: { available_count: 0 } }, NOW)!.credits).toEqual([])
    expect(normalizeResetCredits(null, {}, NOW)).toBeNull()
    expect(normalizeResetCredits({ credits: [] }, {}, NOW)).toEqual({ available: 0, credits: [], cooldownUntil: null })
  })
})

describe('redeemReset', () => {
  const auth: CodexAuth = { mode: 'chatgpt', accessToken: 'tok', accountId: 'acct-1', path: '/nowhere' }
  const answer =
    (body: unknown, status = 200): FetchFn =>
    async () =>
      new Response(JSON.stringify(body), { status })

  it('posts the credit and idempotency key once', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ code: 'reset', windows_reset: 2 }), { status: 200 })
    }
    expect(await redeemReset(auth, 'c1', 'req-1', fetchFn)).toEqual({ cleared: 2 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(CONSUME_URL)
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ credit_id: 'c1', redeem_request_id: 'req-1' })
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers['ChatGPT-Account-ID']).toBe('acct-1')

    await redeemReset(auth, ANY_CREDIT, 'req-2', fetchFn)
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ redeem_request_id: 'req-2' })
  })

  it('maps the answer codes', async () => {
    expect(await redeemReset(auth, 'c', 'r', answer({ code: 'already_redeemed' }))).toEqual({ cleared: 0 })
    expect(await redeemReset(auth, 'c', 'r', answer({ windows_reset: 1 }))).toEqual({ cleared: 1 })
    await expect(redeemReset(auth, 'c', 'r', answer({ code: 'nothing_to_reset' }))).rejects.toThrow(/kept for later/)
    await expect(redeemReset(auth, 'c', 'r', answer({ code: 'no_credit' }))).rejects.toThrow(/no reset/)
    await expect(redeemReset(auth, 'c', 'r', answer({}))).rejects.toThrow(/refresh to check/)
    await expect(redeemReset(auth, 'c', 'r', answer({}, 401))).rejects.toThrow(/codex login/)
    await expect(redeemReset(auth, 'c', 'r', answer({}, 500))).rejects.toThrow(/was not used/)
    await expect(redeemReset({ mode: 'apikey', path: '/x' }, 'c', 'r', answer({}))).rejects.toThrow(/not logged in/)
  })
})
