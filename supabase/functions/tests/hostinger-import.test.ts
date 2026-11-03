// Run with: npm run test:functions  (Node's built-in test runner; no network access)
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { handleRequest, type DomainStore, type HandlerDeps, type ImportResponse, type PreviewResponse } from '../_shared/handler.ts'
import { mergePortfolio, normalizeToken, parsePortfolio, toISODate, type FetchLike } from '../_shared/hostinger.ts'
import type { DomainInsert, DomainPatch, ExistingDomain } from '../_shared/importPlan.ts'

const USER = '11111111-1111-1111-1111-111111111111'
const OTHER_USER = '22222222-2222-2222-2222-222222222222'
const TOKEN = 'test-hostinger-token'
const NOW = new Date('2026-11-02T00:00:00Z')

// Shape copied from a real GET /api/domains/v1/portfolio response (names changed).
const PORTFOLIO = [
  { id: 1, domain: 'freebie.com', type: 'free_domain', status: 'active', created_at: '2023-09-25T05:54:18Z', expires_at: null },
  { id: 2, domain: 'alpha.com', type: 'domain', status: 'active', created_at: '2023-09-29T16:00:51Z', expires_at: '2027-09-29T16:01:36Z' },
  { id: 3, domain: 'lapsed.com', type: 'domain', status: 'expired', created_at: '2023-10-20T05:18:59Z', expires_at: '2026-10-20T05:18:59Z' },
  // Listed three times: two free-domain entitlements and the paid registration.
  { id: 4, domain: 'triple.com', type: 'free_domain', status: 'active', created_at: '2024-01-01T00:00:00Z', expires_at: null },
  { id: 5, domain: 'triple.com', type: 'free_domain', status: 'active', created_at: '2024-02-01T00:00:00Z', expires_at: null },
  { id: 6, domain: 'Triple.com', type: 'domain', status: 'active', created_at: '2024-03-01T00:00:00Z', expires_at: '2027-11-19T07:09:24Z' },
  { id: 7, domain: 'client-owned.com', type: 'domain', status: 'active', created_at: '2024-01-01T00:00:00Z', expires_at: '2027-03-07T05:51:34Z' },
]

const DETAILS: Record<string, object> = {
  'alpha.com': { domain: 'alpha.com', status: 'Active', registered_at: '2023-09-29T16:01:36Z', expires_at: '2027-09-29T16:01:36Z' },
  'lapsed.com': { domain: 'lapsed.com', status: 'Expired', registered_at: '2023-10-20T05:18:59Z', expires_at: '2026-10-20T05:18:59Z' },
  'triple.com': { domain: 'triple.com', status: 'Active', registered_at: '2024-03-01T00:00:00Z', expires_at: '2027-11-19T07:09:24Z' },
  'client-owned.com': { domain: 'client-owned.com', status: 'Active', registered_at: '2024-01-01T00:00:00Z', expires_at: '2027-03-07T05:51:34Z' },
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface MockHostinger {
  fetch: FetchLike
  calls: { url: string; auth: string | null; method: string }[]
}

function mockHostinger(
  opts: { portfolio?: () => Response; details?: (name: string) => Response } = {},
): MockHostinger {
  const calls: MockHostinger['calls'] = []
  const fetch: FetchLike = async (input, init) => {
    const headers = new Headers(init?.headers)
    calls.push({ url: input, auth: headers.get('Authorization'), method: init?.method ?? 'GET' })
    const path = new URL(input).pathname
    if (path === '/api/domains/v1/portfolio') return opts.portfolio?.() ?? jsonResponse(200, PORTFOLIO)
    const name = decodeURIComponent(path.replace('/api/domains/v1/portfolio/', ''))
    if (opts.details) return opts.details(name)
    return DETAILS[name] ? jsonResponse(200, DETAILS[name]) : jsonResponse(404, { message: 'Not found' })
  }
  return { fetch, calls }
}

type Row = ExistingDomain & { user_id: string; notes: string | null; status: string | null } & Record<string, unknown>

/** In-memory domains table that scopes every call to the user, like RLS. */
function memoryStore(initial: Row[] = [], opts: { schemaReady?: boolean; failInsertFor?: Record<string, { code?: string; message: string }> } = {}) {
  const rows: Row[] = initial.map((r) => ({ ...r }))
  let nextId = 100
  const writes: { op: 'insert' | 'update'; values: Record<string, unknown> }[] = []
  const store: DomainStore = {
    async listDomains(userId) {
      return { rows: rows.filter((r) => r.user_id === userId).map((r) => ({ ...r })), schemaReady: opts.schemaReady ?? true }
    },
    async insertDomain(userId, values: DomainInsert) {
      writes.push({ op: 'insert', values: { ...values } })
      const forced = opts.failInsertFor?.[values.domain_name]
      if (forced) throw forced
      if (rows.some((r) => r.user_id === userId && r.domain_name.toLowerCase() === values.domain_name)) {
        throw { code: '23505', message: 'duplicate key value violates unique constraint' }
      }
      rows.push({ id: String(nextId++), user_id: userId, client_id: null, notes: null, ...values })
    },
    async updateDomain(userId, id, values: DomainPatch) {
      writes.push({ op: 'update', values: { ...values } })
      const row = rows.find((r) => r.id === id && r.user_id === userId)
      if (!row) throw new Error('Record not found.')
      Object.assign(row, values)
    },
  }
  return { store, rows, writes }
}

function deps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    hostingerToken: TOKEN,
    fetch: mockHostinger().fetch,
    authenticate: async (header) =>
      header === 'Bearer valid-user-jwt' ? { userId: USER } : header === 'Bearer other-user-jwt' ? { userId: OTHER_USER } : null,
    allowedUserIds: [USER],
    store: memoryStore().store,
    now: () => NOW,
    ...overrides,
  }
}

function post(body: unknown, auth: string | null = 'Bearer valid-user-jwt'): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) headers.Authorization = auth
  return new Request('http://localhost/hostinger-import', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function call<T>(req: Request, d: HandlerDeps): Promise<{ status: number; body: T }> {
  const res = await handleRequest(req, d)
  return { status: res.status, body: (await res.json()) as T }
}

const existingRow = (over: Partial<Row>): Row => ({
  id: 'e1',
  user_id: USER,
  domain_name: 'x.com',
  client_id: null,
  registrar: null,
  expiry_date: null,
  ownership_type: null,
  provider: null,
  provider_domain_id: null,
  provider_status: null,
  registered_date: null,
  notes: null,
  status: 'active',
  ...over,
})

describe('Hostinger response parsing', () => {
  it('converts Hostinger timestamps to calendar dates', () => {
    assert.equal(toISODate('2027-09-29T16:01:36Z'), '2027-09-29')
    assert.equal(toISODate('2027-05-25 13:53:04'), '2027-05-25')
    assert.equal(toISODate(null), null)
    assert.equal(toISODate('not a date'), null)
    assert.equal(toISODate('2027-02-30T00:00:00Z'), null)
  })

  it('merges duplicate portfolio entries, preferring the paid registration', () => {
    const { items } = parsePortfolio(PORTFOLIO)
    const { domains } = mergePortfolio(items)
    assert.equal(domains.length, 5)
    const triple = domains.find((d) => d.name === 'triple.com')!
    assert.equal(triple.entryCount, 3)
    assert.equal(triple.type, 'domain')
    assert.equal(triple.providerId, '6')
    assert.equal(triple.expiryDate, '2027-11-19')
  })

  it('skips malformed entries without failing the whole list', () => {
    const { items, skipped } = parsePortfolio([
      { id: 9, domain: null, type: 'free_domain', status: 'active', created_at: null, expires_at: null },
      'garbage',
      { id: 10, domain: 42 },
      { id: 11, domain: 'ok.com', type: 'domain', status: 'active', created_at: null, expires_at: null },
    ])
    assert.equal(items.length, 1)
    assert.equal(skipped.length, 3)
    const merged = mergePortfolio([{ id: 12, domain: 'not a domain!', type: 'domain', status: 'active', created_at: null, expires_at: null }])
    assert.equal(merged.domains.length, 0)
    assert.equal(merged.skipped.length, 1)
  })
})

describe('authentication and configuration', () => {
  it('rejects requests without a valid Supabase user', async () => {
    const hostinger = mockHostinger()
    for (const auth of [null, 'Bearer forged', 'Basic abc']) {
      const { status, body } = await call<{ error: { code: string } }>(post({ action: 'preview' }, auth), deps({ fetch: hostinger.fetch }))
      assert.equal(status, 401)
      assert.equal(body.error.code, 'unauthorized')
    }
    assert.equal(hostinger.calls.length, 0, 'Hostinger must not be called for unauthenticated requests')
  })

  it('rejects signed-in users who are not on the allowlist, before calling Hostinger', async () => {
    const hostinger = mockHostinger()
    const { store, writes } = memoryStore()
    for (const action of ['preview', 'import']) {
      const { status, body } = await call<{ error: { code: string } }>(
        post({ action, domains: [{ name: 'alpha.com' }] }, 'Bearer other-user-jwt'),
        deps({ fetch: hostinger.fetch, store }),
      )
      assert.equal(status, 403)
      assert.equal(body.error.code, 'forbidden')
    }
    assert.equal(hostinger.calls.length, 0)
    assert.equal(writes.length, 0)
  })

  it('locks the import for everyone when no allowlist is configured', async () => {
    const hostinger = mockHostinger()
    const { status, body } = await call<{ error: { message: string } }>(
      post({ action: 'preview' }),
      deps({ fetch: hostinger.fetch, allowedUserIds: [] }),
    )
    assert.equal(status, 403)
    assert.match(body.error.message, /HOSTINGER_ALLOWED_USER_IDS/)
    assert.equal(hostinger.calls.length, 0)
  })

  it('reports a missing HOSTINGER_API_TOKEN secret', async () => {
    const { status, body } = await call<{ error: { code: string } }>(post({ action: 'preview' }), deps({ hostingerToken: undefined }))
    assert.equal(status, 500)
    assert.equal(body.error.code, 'not_configured')
  })

  it('maps a rejected Hostinger token to 502 (not a DomainDesk session error) and never leaks it', async () => {
    const hostinger = mockHostinger({ portfolio: () => jsonResponse(401, { message: 'Unauthenticated', correlation_id: 'x' }) })
    const res = await handleRequest(post({ action: 'preview' }), deps({ fetch: hostinger.fetch }))
    const text = await res.text()
    assert.equal(res.status, 502)
    assert.match(text, /hostinger_unauthorized/)
    assert.doesNotMatch(text, new RegExp(TOKEN))
    assert.equal(hostinger.calls[0].auth, `Bearer ${TOKEN}`)
  })

  it('only sends GET requests to Hostinger', async () => {
    const hostinger = mockHostinger()
    await call(post({ action: 'preview' }), deps({ fetch: hostinger.fetch }))
    await call(post({ action: 'import', domains: [{ name: 'alpha.com' }] }), deps({ fetch: hostinger.fetch }))
    assert.ok(hostinger.calls.length > 0)
    assert.ok(hostinger.calls.every((c) => c.method === 'GET'))
  })

  it('rejects unknown actions, bad JSON and other methods', async () => {
    assert.equal((await handleRequest(post({ action: 'renew' }), deps())).status, 400)
    assert.equal((await handleRequest(post('{not json'), deps())).status, 400)
    assert.equal((await handleRequest(new Request('http://localhost/x', { method: 'GET' }), deps())).status, 405)
    assert.equal((await handleRequest(new Request('http://localhost/x', { method: 'OPTIONS' }), deps())).status, 200)
  })
})

describe('invalid Hostinger responses', () => {
  it('handles a non-JSON body', async () => {
    const hostinger = mockHostinger({ portfolio: () => new Response('<html>oops</html>', { status: 200 }) })
    const { status, body } = await call<{ error: { code: string } }>(post({ action: 'preview' }), deps({ fetch: hostinger.fetch }))
    assert.equal(status, 502)
    assert.equal(body.error.code, 'hostinger_invalid_response')
  })

  it('handles an unexpected JSON shape', async () => {
    const hostinger = mockHostinger({ portfolio: () => jsonResponse(200, { domains: 'nope' }) })
    const { status, body } = await call<{ error: { code: string } }>(post({ action: 'preview' }), deps({ fetch: hostinger.fetch }))
    assert.equal(status, 502)
    assert.equal(body.error.code, 'hostinger_invalid_response')
  })

  it('handles Hostinger outages and rate limits', async () => {
    for (const [code, kind] of [[500, 'hostinger_unavailable'], [429, 'hostinger_rate_limited']] as const) {
      const hostinger = mockHostinger({ portfolio: () => jsonResponse(code, { message: 'Error message' }) })
      const { status, body } = await call<{ error: { code: string } }>(post({ action: 'preview' }), deps({ fetch: hostinger.fetch }))
      assert.equal(status, 502)
      assert.equal(body.error.code, kind)
    }
  })

  it('handles a network failure', async () => {
    const { status, body } = await call<{ error: { code: string } }>(
      post({ action: 'preview' }),
      deps({ fetch: async () => { throw new TypeError('fetch failed') } }),
    )
    assert.equal(status, 502)
    assert.equal(body.error.code, 'hostinger_network')
  })

  it('treats failed detail lookups as warnings, not errors', async () => {
    const hostinger = mockHostinger({ details: () => jsonResponse(500, { message: 'boom' }) })
    const { status, body } = await call<PreviewResponse>(post({ action: 'preview' }), deps({ fetch: hostinger.fetch }))
    assert.equal(status, 200)
    assert.equal(body.items.length, 5)
    assert.ok(body.items.every((i) => i.registeredDate === null))
    assert.match(body.warnings[0], /Registration date unavailable for 4 domains/)
  })

  it('shows the Hostinger reason on the domain when details are refused with 404', async () => {
    const hostinger = mockHostinger({
      details: (name) =>
        name === 'triple.com'
          ? jsonResponse(404, { message: '[Domains:2006] Domain is not registered at Hostinger.' })
          : jsonResponse(200, DETAILS[name]),
    })
    const { body } = await call<PreviewResponse>(post({ action: 'preview' }), deps({ fetch: hostinger.fetch }))
    const triple = body.items.find((i) => i.name === 'triple.com')!
    assert.equal(triple.registeredDate, null)
    assert.equal(triple.expiryDate, '2027-11-19')
    assert.match(triple.notes.join(' '), /Domains:2006/)
    assert.deepEqual(body.warnings, [])
  })
})

describe('preview', () => {
  it('matches existing domains by normalised name and describes changes', async () => {
    const { store } = memoryStore([
      existingRow({ id: 'a', domain_name: 'Alpha.COM.', client_id: 'client-1', registrar: null, expiry_date: '2026-09-29' }),
      existingRow({
        id: 'c', domain_name: 'client-owned.com', registrar: 'Hostinger', expiry_date: '2027-03-07', ownership_type: 'client',
        provider: 'hostinger', provider_domain_id: '7', provider_status: 'active', registered_date: '2024-01-01',
      }),
      existingRow({ id: 'o', user_id: OTHER_USER, domain_name: 'triple.com' }),
    ])
    const { status, body } = await call<PreviewResponse>(post({ action: 'preview' }), deps({ store }))
    assert.equal(status, 200)
    const byName = Object.fromEntries(body.items.map((i) => [i.name, i]))

    assert.equal(byName['alpha.com'].match, 'update')
    assert.deepEqual(byName['alpha.com'].existing?.hasClient, true)
    assert.ok(byName['alpha.com'].changes.includes('Expiry 2026-09-29 → 2027-09-29'))
    assert.equal(byName['alpha.com'].registeredDate, '2023-09-29')

    assert.equal(byName['client-owned.com'].match, 'unchanged')
    assert.equal(byName['client-owned.com'].ownershipEditable, false)

    // Another user's row must not count as a match.
    assert.equal(byName['triple.com'].match, 'new')
    assert.equal(byName['triple.com'].entryCount, 3)
  })

  it('shows expired domains and domains with no expiry date', async () => {
    const { body } = await call<PreviewResponse>(post({ action: 'preview' }), deps())
    const lapsed = body.items.find((i) => i.name === 'lapsed.com')!
    assert.equal(lapsed.status, 'expired')
    assert.equal(lapsed.expiryDate, '2026-10-20')
    const freebie = body.items.find((i) => i.name === 'freebie.com')!
    assert.equal(freebie.expiryDate, null)
    assert.match(freebie.notes.join(' '), /no expiry date/)
  })

  it('works before the migration but flags it', async () => {
    const { store } = memoryStore([], { schemaReady: false })
    const { status, body } = await call<PreviewResponse>(post({ action: 'preview' }), deps({ store }))
    assert.equal(status, 200)
    assert.equal(body.schemaReady, false)
  })
})

describe('import', () => {
  it('inserts new domains for the authenticated user with safe defaults', async () => {
    const { store, rows, writes } = memoryStore()
    const { status, body } = await call<ImportResponse>(
      post({ action: 'import', domains: [{ name: 'alpha.com' }, { name: 'client-owned.com', ownershipType: 'client' }, { name: 'freebie.com' }] }),
      deps({ store }),
    )
    assert.equal(status, 200)
    assert.deepEqual(body.summary, { inserted: 3, updated: 0, unchanged: 0, failed: 0 })
    assert.ok(rows.every((r) => r.user_id === USER))

    const alpha = rows.find((r) => r.domain_name === 'alpha.com')!
    assert.equal(alpha.registrar, 'Hostinger')
    assert.equal(alpha.ownership_type, 'agency')
    assert.equal(alpha.expiry_date, '2027-09-29')
    assert.equal(alpha.registered_date, '2023-09-29')
    assert.equal(alpha.provider, 'hostinger')
    assert.equal(alpha.provider_domain_id, '2')
    assert.equal(rows.find((r) => r.domain_name === 'client-owned.com')!.ownership_type, 'client')
    assert.equal(rows.find((r) => r.domain_name === 'freebie.com')!.expiry_date, null)

    for (const w of writes) {
      assert.ok(!('client_id' in w.values), 'import must never set a client')
      assert.ok(!('notes' in w.values), 'import must never write notes')
      assert.ok(!('user_id' in w.values), 'user_id comes from the verified session, not the plan')
    }
  })

  it('never overwrites client, notes, status, registrar or ownership on existing rows', async () => {
    const { store, rows, writes } = memoryStore([
      existingRow({
        id: 'a', domain_name: 'alpha.com', client_id: 'client-1', notes: 'Billed yearly in March',
        registrar: 'VentraIP', expiry_date: '2026-09-29', ownership_type: 'client', status: 'transferred',
      }),
    ])
    const { body } = await call<ImportResponse>(
      post({ action: 'import', domains: [{ name: 'alpha.com', ownershipType: 'agency' }] }),
      deps({ store }),
    )
    assert.equal(body.summary.updated, 1)
    const row = rows[0]
    assert.equal(row.client_id, 'client-1')
    assert.equal(row.notes, 'Billed yearly in March')
    assert.equal(row.registrar, 'VentraIP')
    assert.equal(row.ownership_type, 'client')
    assert.equal(row.status, 'transferred')
    assert.equal(row.expiry_date, '2027-09-29')
    assert.deepEqual(Object.keys(writes[0].values).sort(), [
      'expiry_date', 'last_synced_at', 'provider', 'provider_domain_id', 'provider_status', 'registered_date',
    ])
  })

  it('does not clear a recorded expiry when Hostinger has none', async () => {
    const { store, rows } = memoryStore([existingRow({ id: 'f', domain_name: 'freebie.com', expiry_date: '2027-01-01' })])
    await call(post({ action: 'import', domains: [{ name: 'freebie.com' }] }), deps({ store }))
    assert.equal(rows[0].expiry_date, '2027-01-01')
  })

  it('is repeatable: a second run creates no duplicates and reports them as skipped', async () => {
    const { store, rows } = memoryStore()
    const all = { action: 'import', domains: ['alpha.com', 'lapsed.com', 'triple.com', 'freebie.com'].map((name) => ({ name })) }
    const first = await call<ImportResponse>(post(all), deps({ store }))
    assert.equal(first.body.summary.inserted, 4)
    const second = await call<ImportResponse>(post(all), deps({ store }))
    assert.deepEqual(second.body.summary, { inserted: 0, updated: 0, unchanged: 4, failed: 0 })
    assert.equal(rows.length, 4)
  })

  it('treats a row created since the preview (unique violation) as a skipped duplicate', async () => {
    const { store } = memoryStore([], { failInsertFor: { 'alpha.com': { code: '23505', message: 'duplicate key' } } })
    const { body } = await call<ImportResponse>(post({ action: 'import', domains: [{ name: 'alpha.com' }] }), deps({ store }))
    assert.equal(body.results[0].outcome, 'unchanged')
    assert.match(body.results[0].message!, /duplicate/)
  })

  it('continues after a per-domain failure and reports it', async () => {
    const { store, rows } = memoryStore([], { failInsertFor: { 'lapsed.com': { code: '42501', message: 'new row violates row-level security policy' } } })
    const { status, body } = await call<ImportResponse>(
      post({ action: 'import', domains: [{ name: 'alpha.com' }, { name: 'lapsed.com' }, { name: 'gone.com' }, { name: 'triple.com' }] }),
      deps({ store }),
    )
    assert.equal(status, 200)
    assert.deepEqual(body.summary, { inserted: 2, updated: 0, unchanged: 0, failed: 2 })
    assert.match(body.results.find((r) => r.name === 'lapsed.com')!.message!, /row-level security/)
    assert.match(body.results.find((r) => r.name === 'gone.com')!.message!, /No longer in your Hostinger portfolio/)
    assert.deepEqual(rows.map((r) => r.domain_name).sort(), ['alpha.com', 'triple.com'])
  })

  it('blocks importing until the migration has been applied', async () => {
    const { store, writes } = memoryStore([], { schemaReady: false })
    const { status, body } = await call<{ error: { code: string } }>(post({ action: 'import', domains: [{ name: 'alpha.com' }] }), deps({ store }))
    assert.equal(status, 409)
    assert.equal(body.error.code, 'schema_not_ready')
    assert.equal(writes.length, 0)
  })

  it('validates the selection', async () => {
    for (const domains of [undefined, [], [{}], [{ name: 'alpha.com', ownershipType: 'owner' }]]) {
      const { status } = await call(post({ action: 'import', domains }), deps())
      assert.equal(status, 400)
    }
  })

  it('only looks up details for the selected domains', async () => {
    const hostinger = mockHostinger()
    await call(post({ action: 'import', domains: [{ name: 'alpha.com' }] }), deps({ fetch: hostinger.fetch }))
    const detailCalls = hostinger.calls.filter((c) => c.url.includes('/portfolio/'))
    assert.deepEqual(detailCalls.map((c) => new URL(c.url).pathname), ['/api/domains/v1/portfolio/alpha.com'])
  })
})

describe('token diagnostics', () => {
  it('fixes common paste mistakes and describes the token without revealing it', () => {
    assert.deepEqual(normalizeToken('  abc123  '), { token: 'abc123', shape: '6 characters' })
    assert.deepEqual(normalizeToken('"abc123"'), { token: 'abc123', shape: '6 characters, surrounding quotes removed' })
    assert.deepEqual(normalizeToken('Bearer abc123'), { token: 'abc123', shape: '6 characters, "Bearer " prefix removed' })
    assert.match(normalizeToken('abc 123').shape, /whitespace inside/)
    assert.deepEqual(normalizeToken(undefined), { token: undefined, shape: 'empty' })
    assert.deepEqual(normalizeToken('""'), { token: undefined, shape: 'empty' })
  })

  it('redacts the token if Hostinger echoes it, and never returns the caller JWT', async () => {
    const logged: Record<string, unknown>[] = []
    const scenarios: (() => Response)[] = [
      () => jsonResponse(401, { message: `Token ${TOKEN} is invalid`, correlation_id: 'c1' }),
      () => jsonResponse(403, { message: `Forbidden for ${TOKEN}` }),
      () => jsonResponse(500, { message: `Upstream failed using ${TOKEN}` }),
      () => new Response('<html>blocked</html>', { status: 403 }),
    ]
    for (const portfolio of scenarios) {
      const res = await handleRequest(
        post({ action: 'preview' }),
        deps({ fetch: mockHostinger({ portfolio }).fetch, tokenShape: '20 characters', logError: (e) => logged.push(e) }),
      )
      const text = await res.text()
      assert.equal(res.status, 502)
      assert.doesNotMatch(text, new RegExp(TOKEN))
      assert.doesNotMatch(text, /valid-user-jwt/)
    }
    assert.doesNotMatch(JSON.stringify(logged), new RegExp(TOKEN))
    assert.doesNotMatch(JSON.stringify(logged), /valid-user-jwt/)
  })

  it('reports Hostinger status, message, correlation id and token shape on 401, and logs no secret', async () => {
    const logged: Record<string, unknown>[] = []
    const hostinger = mockHostinger({
      portfolio: () => jsonResponse(401, { message: 'Unauthenticated.', correlation_id: 'corr-123' }),
    })
    const res = await handleRequest(
      post({ action: 'preview' }),
      deps({ fetch: hostinger.fetch, tokenShape: '48 characters', logError: (e) => logged.push(e) }),
    )
    const body = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(res.status, 502)
    assert.equal(body.error.code, 'hostinger_unauthorized')
    assert.match(body.error.message, /HTTP 401 "Unauthenticated\."/)
    assert.match(body.error.message, /correlation corr-123/)
    assert.match(body.error.message, /Stored token: 48 characters/)
    assert.deepEqual(logged, [
      { event: 'hostinger_error', kind: 'unauthorized', status: 401, correlationId: 'corr-123', tokenShape: '48 characters' },
    ])
    assert.doesNotMatch(JSON.stringify(logged) + JSON.stringify(body), new RegExp(TOKEN))
  })

  it('distinguishes a firewall block (403, non-JSON) from a bad token', async () => {
    const hostinger = mockHostinger({ portfolio: () => new Response('<html>Access denied</html>', { status: 403 }) })
    const { status, body } = await call<{ error: { code: string; message: string } }>(
      post({ action: 'preview' }),
      deps({ fetch: hostinger.fetch, tokenShape: '48 characters' }),
    )
    assert.equal(status, 502)
    assert.equal(body.error.code, 'hostinger_blocked')
    assert.match(body.error.message, /not a token problem/)
    assert.doesNotMatch(body.error.message, /Stored token/)
  })
})
