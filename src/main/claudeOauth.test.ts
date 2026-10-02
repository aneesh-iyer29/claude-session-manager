import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'

import {
  AUTHORIZE_URL,
  CLIENT_ID,
  EXCHANGE_URL,
  REFRESH_URL,
  UsageError,
  classifyUsageError,
  credentialFingerprint,
  extractAccessToken,
  extractExpiresAt,
  fetchUsage,
  identityFromProfile,
  isExpired,
  normalizeResets,
  normalizeUsage,
  redeemReset,
  refreshCredentials,
  resetUrl,
  startLoginFlow,
  type FetchFn,
} from './claudeOauth'

function makeCred(opts: { access?: string; refresh?: string | null; expiresAt?: number; plan?: string } = {}): string {
  const { access = 'access-1', refresh = 'refresh-1', expiresAt = 4_102_444_800_000, plan = 'max' } = opts
  const block: Record<string, unknown> = { accessToken: access, expiresAt, subscriptionType: plan }
  if (refresh !== null) block.refreshToken = refresh
  return JSON.stringify({ claudeAiOauth: block })
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const RAW_USAGE = {
  five_hour: { utilization: 41.0, resets_at: '2026-09-04T22:00:00Z' },
  seven_day: { utilization: 63.2, resets_at: '2026-09-08T10:00:00Z' },
  limits: [
    { kind: 'weekly_scoped', percent: 80.0, resets_at: '2026-09-07T10:00:00Z', scope: { model: { display_name: 'Fable' } } },
    { kind: 'weekly', percent: 5.0 }, // no model scope → ignored
    'garbage',
  ],
}

describe('normalizeUsage', () => {
  it('matches the spec shape including the Fable weekly_scoped window', () => {
    const usage = normalizeUsage(RAW_USAGE, 'Fable', 'max')
    expect(usage.ok).toBe(true)
    expect(usage.error).toBeNull()
    expect(usage.plan).toBe('max')
    expect(usage.fetchedAt.endsWith('Z')).toBe(true)
    expect(usage.windows).toEqual([
      { key: 'five_hour', label: '5-hour', pct: 41, resetsAt: '2026-09-04T22:00:00Z' },
      { key: 'seven_day', label: 'Weekly', pct: 63.2, resetsAt: '2026-09-08T10:00:00Z' },
      { key: 'model:fable', label: 'Fable weekly', pct: 80, resetsAt: '2026-09-07T10:00:00Z' },
    ])
  })

  it('tolerates missing pieces', () => {
    expect(normalizeUsage({ five_hour: { utilization: 3 }, seven_day: null, limits: null }).windows).toEqual([
      { key: 'five_hour', label: '5-hour', pct: 3, resetsAt: null },
    ])
    expect(normalizeUsage({}).windows).toEqual([])
    expect(normalizeUsage('nonsense').windows).toEqual([])
  })
})

describe('credential helpers', () => {
  it('fingerprints follow the refresh-token lineage', () => {
    const a = makeCred({ access: 'x', refresh: 'r' })
    const b = makeCred({ access: 'y', refresh: 'r' })
    const c = makeCred({ access: 'x', refresh: 'other' })
    expect(credentialFingerprint(a)).toBe(credentialFingerprint(b))
    expect(credentialFingerprint(a)).not.toBe(credentialFingerprint(c))
    expect(credentialFingerprint(a).startsWith('sha256:')).toBe(true)
    expect(credentialFingerprint(makeCred({ refresh: null })).startsWith('sha256-full:')).toBe(true)
    expect(credentialFingerprint('not json')).not.toBe(credentialFingerprint(''))
  })

  it('extracts tokens and expiry, and judges expiry with a buffer', () => {
    const cred = makeCred({ access: 'tok', expiresAt: 1_000_000 })
    expect(extractAccessToken(cred)).toBe('tok')
    expect(extractExpiresAt(cred)).toBe(1_000_000)
    expect(extractAccessToken('{}')).toBeNull()
    expect(extractAccessToken('nope')).toBeNull()
    expect(extractExpiresAt('{"claudeAiOauth": {}}')).toBeNull()
    expect(isExpired(cred, 0, 999_999)).toBe(false)
    expect(isExpired(cred, 0, 1_000_000)).toBe(true)
    expect(isExpired(cred, 300_000, 800_000)).toBe(true)
    expect(isExpired('{"claudeAiOauth": {}}')).toBe(false)
  })

  it('maps the profile payload to an identity', () => {
    expect(identityFromProfile({ account: { uuid: 'u', email: 'a@b.c' }, organization: { uuid: 'o', name: 'Org' } })).toEqual({
      email: 'a@b.c',
      orgUuid: 'o',
      orgName: 'Org',
      accountUuid: 'u',
    })
    expect(identityFromProfile({})).toEqual({ email: '', orgUuid: '', orgName: '', accountUuid: '' })
  })
})

describe('refreshCredentials', () => {
  it('rotates tokens on success and keeps untouched keys', async () => {
    const captured: { url?: string; body?: Record<string, unknown> } = {}
    const fetchFn: FetchFn = async (url, init) => {
      captured.url = String(url)
      captured.body = JSON.parse(String(init?.body))
      return jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'user:profile user:inference' })
    }
    const result = await refreshCredentials(makeCred({ access: 'old', refresh: 'old-refresh' }), fetchFn)
    expect(result.error).toBeNull()
    expect(captured.url).toBe(REFRESH_URL)
    expect(captured.body).toEqual({ grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: CLIENT_ID })
    const block = JSON.parse(result.credentials!).claudeAiOauth
    expect(block.accessToken).toBe('new-access')
    expect(block.refreshToken).toBe('new-refresh')
    expect(block.scopes).toEqual(['user:profile', 'user:inference'])
    expect(block.subscriptionType).toBe('max')
    expect(isExpired(result.credentials!)).toBe(false)
  })

  it.each([
    [jsonResponse({ error: 'invalid_grant' }, 400), 'invalid_grant'],
    [jsonResponse({ error: 'invalid_grant' }, 401), 'invalid_grant'],
    [jsonResponse({ error: 'invalid_request' }, 400), 'transient'],
    [new Response('not json', { status: 400 }), 'transient'],
    [jsonResponse({ error: 'invalid_grant' }, 500), 'transient'],
    [new Error('dns'), 'transient'],
  ])('classifies failure %#', async (outcome, expected) => {
    const fetchFn: FetchFn = async () => {
      if (outcome instanceof Error) throw outcome
      return outcome
    }
    const result = await refreshCredentials(makeCred(), fetchFn)
    expect(result.credentials).toBeNull()
    expect(result.error).toBe(expected)
  })

  it('does not hit the network without a refresh token or with torn JSON', async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error('no network call expected')
    }
    expect((await refreshCredentials(makeCred({ refresh: null }), fetchFn)).error).toBe('no_refresh_token')
    expect((await refreshCredentials('torn{', fetchFn)).error).toBe('transient')
  })
})

describe('fetchUsage error classification', () => {
  it('maps HTTP statuses to UsageError kinds', async () => {
    const withStatus = (status: number, headers: Record<string, string> = {}): FetchFn => async () => jsonResponse({}, status, headers)
    await expect(fetchUsage('t', withStatus(401))).rejects.toMatchObject({ kind: 'unauthorized', status: 401 })
    await expect(fetchUsage('t', withStatus(429, { 'retry-after': '120' }))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 })
    await expect(fetchUsage('t', withStatus(503))).rejects.toMatchObject({ kind: 'server' })
    const offline: FetchFn = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(fetchUsage('t', offline)).rejects.toMatchObject({ kind: 'network' })
    expect(classifyUsageError(new UsageError('server', 'x')).kind).toBe('server')
    expect(classifyUsageError('boom').kind).toBe('network')
  })

  it('sends the OAuth beta headers and bearer token', async () => {
    let seen: Record<string, string> = {}
    const fetchFn: FetchFn = async (_url, init) => {
      seen = init?.headers as Record<string, string>
      return jsonResponse(RAW_USAGE)
    }
    await fetchUsage('secret-token', fetchFn)
    expect(seen.Authorization).toBe('Bearer secret-token')
    expect(seen['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(seen['anthropic-version']).toBe('2023-06-01')
  })
})

const NOW = new Date('2026-10-02T12:00:00Z')

/** The block Anthropic answers with for an account holding the Opus 5.5 launch reset. */
const EMBER = {
  eligible: true,
  ineligible_reason: null,
  grants: [
    {
      id: 'opus55-launch-promax-20260921',
      label: 'Claude Opus 5.5 launch',
      resets_total: 1,
      resets_left: 1,
      ends_at: '2026-10-22T16:00:00+00:00',
      clears: ['five_hour', 'seven_day'],
      paused: false,
      usable_now: true,
    },
  ],
  next_grant_id: 'opus55-launch-promax-20260921',
  cooldown_until: null,
}

describe('normalizeResets', () => {
  it('offers the grant the server names as spendable', () => {
    expect(normalizeResets(EMBER, NOW)).toEqual({
      available: 1,
      cooldownUntil: null,
      credits: [
        {
          id: 'opus55-launch-promax-20260921',
          title: 'Claude Opus 5.5 launch',
          count: 1,
          expiresAt: '2026-10-22T16:00:00.000Z',
          clears: ['five_hour', 'seven_day'],
        },
      ],
    })
  })

  it('is null when the account is not eligible or the block is missing', () => {
    expect(normalizeResets({ ...EMBER, eligible: false }, NOW)).toBeNull()
    expect(normalizeResets(null, NOW)).toBeNull()
    expect(normalizeResets('x', NOW)).toBeNull()
  })

  it('shows grants it cannot spend without an id', () => {
    const grant = EMBER.grants[0]!
    const ids = (block: unknown): Array<string | null> => normalizeResets(block, NOW)!.credits.map((c) => c.id)
    expect(ids({ ...EMBER, next_grant_id: null })).toEqual([null])
    expect(ids({ ...EMBER, grants: [{ ...grant, paused: true }] })).toEqual([null])
    expect(ids({ ...EMBER, grants: [{ ...grant, usable_now: false }] })).toEqual([null])
    expect(ids({ ...EMBER, grants: [{ ...grant, id: 'Bad Id!' }], next_grant_id: 'Bad Id!' })).toEqual([null])
    const cooling = normalizeResets({ ...EMBER, cooldown_until: '2026-10-02T13:00:00Z' }, NOW)!
    expect(cooling.credits[0]!.id).toBeNull()
    expect(cooling.cooldownUntil).toBe('2026-10-02T13:00:00.000Z')
    // A cooldown already over does not count.
    expect(normalizeResets({ ...EMBER, cooldown_until: '2026-10-01T00:00:00Z' }, NOW)!.cooldownUntil).toBeNull()
  })

  it('drops used-up, expired and malformed grants, counts banked ones, and sorts by expiry', () => {
    const r = normalizeResets(
      {
        eligible: true,
        next_grant_id: 'b',
        grants: [
          { id: 'a', resets_total: 3, resets_left: 9, ends_at: '2026-11-01T00:00:00Z' },
          { id: 'b', resets_total: 1, resets_left: 1, ends_at: '2026-10-05T00:00:00Z', usable_now: true },
          { id: 'c', resets_total: 1, resets_left: 0, ends_at: '2026-10-05T00:00:00Z' },
          { id: 'd', resets_total: 1, resets_left: 1, ends_at: '2026-10-01T00:00:00Z' },
          { id: 'e', resets_total: 1, resets_left: 1, ends_at: 'soon' },
          { id: '', resets_total: 1, resets_left: 1, ends_at: '2026-10-05T00:00:00Z' },
          'garbage',
        ],
      },
      NOW,
    )!
    expect(r.available).toBe(4)
    expect(r.credits.map((c) => [c.id, c.count])).toEqual([
      ['b', 1],
      [null, 3],
    ])
  })

  it('rides along on normalizeUsage', () => {
    expect(normalizeUsage({ ...RAW_USAGE, cedar_ember: EMBER }, 'Fable', null, NOW).resets?.available).toBe(1)
    expect(normalizeUsage(RAW_USAGE).resets).toBeNull()
  })
})

describe('fetchUsage', () => {
  it('asks for the reset block as Claude Code', async () => {
    let seen = ''
    let ua = ''
    const fetchFn: FetchFn = async (url, init) => {
      seen = String(url)
      ua = (init?.headers as Record<string, string>)['User-Agent'] ?? ''
      return jsonResponse(RAW_USAGE)
    }
    await fetchUsage('t', fetchFn)
    expect(seen).toBe('https://api.anthropic.com/api/oauth/usage?cedar_ember=1')
    expect(ua).toMatch(/^claude-cli\//)
  })
})

describe('redeemReset', () => {
  const answer =
    (body: unknown, status = 200): FetchFn =>
    async () =>
      jsonResponse(body, status)

  it('posts once to the org with the grant and idempotency key', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({ result: 'reset', cleared: ['five_hour', 'seven_day'] })
    }
    expect(await redeemReset('tok', 'org-1', 'grant-1', 'req-1', fetchFn)).toEqual({ cleared: 2 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(resetUrl('org-1'))
    expect(calls[0]!.url).toBe('https://api.anthropic.com/api/organizations/org-1/reset_rate_limits')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ program: 'cedar_ember', grant_id: 'grant-1', request_id: 'req-1' })
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('treats a replayed key as spent and everything else as not spent', async () => {
    expect(await redeemReset('t', 'o', 'g', 'r', answer({ result: 'already_used' }))).toEqual({ cleared: 0 })
    await expect(redeemReset('t', 'o', 'g', 'r', answer({ result: 'not_limited' }))).rejects.toThrow(/kept for later/)
    await expect(redeemReset('t', 'o', 'g', 'r', answer({ result: 'cooldown' }))).rejects.toThrow(/cooling down/)
    await expect(redeemReset('t', 'o', 'g', 'r', answer({ result: 'ineligible' }))).rejects.toThrow(/no reset/)
    await expect(redeemReset('t', 'o', 'g', 'r', answer({ result: 'mystery' }))).rejects.toThrow(/refresh to check/)
    await expect(redeemReset('t', 'o', 'g', 'r', answer({}, 429))).rejects.toThrow(/Rate limited/)
    await expect(redeemReset('t', 'o', 'g', 'r', answer({}, 401))).rejects.toThrow(/rejected the token/)
    await expect(redeemReset('t', 'o', 'g', 'r', answer({}, 500))).rejects.toThrow(/was not used/)
  })

  it('refuses ids that did not come from the server without a network call', async () => {
    const noNetwork: FetchFn = async () => {
      throw new Error('no network call expected')
    }
    await expect(redeemReset('t', 'org', 'Bad Id', 'r', noNetwork)).rejects.toThrow(/not one Claude offered/)
    await expect(redeemReset('t', '../x', 'g', 'r', noNetwork)).rejects.toThrow(/no organization/)
  })
})

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

describe('startLoginFlow', () => {
  it('builds a PKCE S256 authorize URL and completes via the local callback', async () => {
    const port = await freePort()
    const exchange: { url?: string; body?: Record<string, unknown> } = {}
    const fetchFn: FetchFn = async (url, init) => {
      exchange.url = String(url)
      exchange.body = JSON.parse(String(init?.body))
      return jsonResponse({ access_token: 'fresh', refresh_token: 'fresh-r', expires_in: 3600 })
    }
    const opened: string[] = []
    const flow = await new Promise<ReturnType<typeof startLoginFlow>>((resolve) => {
      const f = startLoginFlow({
        fetchFn,
        port,
        openUrl: (url) => {
          opened.push(url)
          resolve(f)
        },
      })
    })
    expect(opened).toEqual([flow.url])
    expect(flow.status().status).toBe('pending')

    const url = new URL(flow.url)
    expect(flow.url.startsWith(AUTHORIZE_URL + '?')).toBe(true)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(`http://localhost:${port}/callback`)
    expect(url.searchParams.get('scope')).toBe('org:create_api_key user:profile user:inference')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const state = url.searchParams.get('state')!
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const res = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=${state}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('close this tab')
    const credential = await flow.promise
    expect(extractAccessToken(credential)).toBe('fresh')
    expect(flow.status()).toEqual({ status: 'done', credential })
    expect(exchange.url).toBe(EXCHANGE_URL)
    expect(exchange.body).toMatchObject({ grant_type: 'authorization_code', client_id: CLIENT_ID, code: 'abc', state, redirect_uri: `http://localhost:${port}/callback` })
    // the verifier sent to the token endpoint must hash to the challenge in the URL
    const verifier = exchange.body!.code_verifier as string
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'))
  })

  it('rejects a state mismatch and can be cancelled', async () => {
    const port = await freePort()
    const flow = await new Promise<ReturnType<typeof startLoginFlow>>((resolve) => {
      const f = startLoginFlow({
        fetchFn: async () => {
          throw new Error('must not exchange')
        },
        port,
        openUrl: () => resolve(f),
      })
    })
    // A stray or hostile hit without our state is refused but must not abort the login.
    let res = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=wrong`)
    expect(res.status).toBe(400)
    expect(flow.status().status).toBe('pending')
    res = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=wrong`)
    expect(res.status).toBe(400)
    expect(flow.status().status).toBe('pending')
    res = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=${new URL(flow.url).searchParams.get('state')}`, { method: 'POST' })
    expect(res.status).toBe(404)
    expect(flow.status().status).toBe('pending')
    flow.cancel()
    await expect(flow.promise).rejects.toThrow(/cancelled/)
    expect(flow.status().status).toBe('error')

    const port2 = await freePort()
    const flow2 = startLoginFlow({ port: port2, openUrl: () => {} })
    flow2.cancel()
    await expect(flow2.promise).rejects.toThrow(/cancelled/)
    expect(flow2.status()).toEqual({ status: 'error', error: 'login cancelled' })
  })

  it('honours a denial only with the right state and exchanges only the first matching callback', async () => {
    const port = await freePort()
    const flow = await new Promise<ReturnType<typeof startLoginFlow>>((resolve) => {
      const f = startLoginFlow({ fetchFn: async () => { throw new Error('must not exchange') }, port, openUrl: () => resolve(f) })
    })
    const state = new URL(flow.url).searchParams.get('state')!
    const res = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&error_description=nope&state=${state}`)
    expect(res.status).toBe(400)
    await expect(flow.promise).rejects.toThrow(/nope/)

    const port2 = await freePort()
    let exchanges = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetchFn: FetchFn = async () => {
      exchanges += 1
      await gate
      return jsonResponse({ access_token: 'fresh', refresh_token: 'fresh-r', expires_in: 3600 })
    }
    const flow2 = await new Promise<ReturnType<typeof startLoginFlow>>((resolve) => {
      const f = startLoginFlow({ fetchFn, port: port2, openUrl: () => resolve(f) })
    })
    const state2 = new URL(flow2.url).searchParams.get('state')!
    const first = fetch(`http://127.0.0.1:${port2}/callback?code=one&state=${state2}`)
    await new Promise((r) => setTimeout(r, 50)) // first request is now parked in the exchange
    const second = await fetch(`http://127.0.0.1:${port2}/callback?code=two&state=${state2}`)
    expect(second.status).toBe(400)
    release()
    expect((await first).status).toBe(200)
    await flow2.promise
    expect(exchanges).toBe(1)
  })
})
