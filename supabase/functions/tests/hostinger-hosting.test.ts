// Run with: npm run test:functions  (Node's built-in test runner; no network access)
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  handleRequest,
  type HandlerDeps,
  type HostingImportResponse,
  type HostingPreviewResponse,
  type HostingStore,
} from '../_shared/handler.ts'
import { fetchHostingAccounts, parseSubscriptions, type FetchLike } from '../_shared/hostinger.ts'
import {
  humanizePlanCode,
  mapOrderStatus,
  planHostingAccount,
  type DomainLink,
  type ExistingHostingPlan,
  type SyncArgs,
} from '../_shared/hostingPlan.ts'

const USER = '11111111-1111-1111-1111-111111111111'
const OTHER_USER = '22222222-2222-2222-2222-222222222222'
const TOKEN = 'test-hostinger-token'
const NOW = new Date('2026-11-05T00:00:00Z')

// Shapes follow the documented resources (Hostinger API 2.6.2):
// Hosting.V1.Orders.OrderResource, Hosting.V1.Websites.WebsiteResource, Billing subscriptions.
const ORDERS = [
  { id: 1001, client_id: 7, subscription_id: 'SubBusiness1', created_at: '2024-02-10T08:00:00+00:00', plan: { name: 'hostinger_business' }, status: 'active' },
  { id: 1002, client_id: 7, subscription_id: 'SubPremium2', created_at: '2025-01-05T08:00:00+00:00', plan: { name: 'hostinger_premium' }, status: 'suspended' },
  // No subscription id and an unknown plan: billing fields stay empty.
  { id: 1003, client_id: 7, subscription_id: null, created_at: '2023-06-01T00:00:00+00:00', plan: { name: 'cloud_startup' }, status: 'deleted' },
]
const WEBSITES = [
  { domain: 'alpha.com', vhost_type: 'main', is_enabled: true, username: 'u1', client_id: 7, order_id: 1001, created_at: '2024-02-10T08:00:00+00:00', website_type: 'wordpress' },
  { domain: 'Beta.com', vhost_type: 'addon', is_enabled: true, username: 'u1', client_id: 7, order_id: 1001, created_at: '2024-02-10T08:00:00+00:00', website_type: 'other' },
  { domain: 'unknown-site.com', vhost_type: 'addon', is_enabled: true, username: 'u1', client_id: 7, order_id: 1001, created_at: '2024-02-10T08:00:00+00:00', website_type: 'other' },
  { domain: 'gamma.com', vhost_type: 'main', is_enabled: false, username: 'u2', client_id: 7, order_id: 1002, created_at: '2025-01-05T08:00:00+00:00', website_type: 'wordpress' },
  { domain: null, vhost_type: null, is_enabled: true, username: null, client_id: 7, order_id: 1002, created_at: '2025-01-05T08:00:00+00:00', website_type: 'horizons' },
]
const SUBSCRIPTIONS = [
  { id: 'SubBusiness1', name: 'Business Web Hosting', status: 'active', billing_period: 1, billing_period_unit: 'year', currency_code: 'USD', total_price: 4788, renewal_price: 15588, is_auto_renewed: true, created_at: '2024-02-10T08:00:00Z', expires_at: null, next_billing_at: '2027-02-10T08:00:00Z' },
  { id: 'SubPremium2', name: 'Premium Web Hosting', status: 'not_renewing', billing_period: 2, billing_period_unit: 'year', currency_code: 'USD', total_price: 6000, renewal_price: 11976, is_auto_renewed: false, created_at: '2025-01-05T08:00:00Z', expires_at: '2027-01-05T08:00:00Z', next_billing_at: '2026-12-01T00:00:00Z' },
  { id: 'VpsUnrelated', name: 'KVM 1', status: 'active', billing_period: 1, billing_period_unit: 'month', currency_code: 'USD', total_price: 599, renewal_price: 1099, is_auto_renewed: true, created_at: '2025-01-01T00:00:00Z', expires_at: null, next_billing_at: '2026-12-01T00:00:00Z' },
]

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const page = (data: unknown[]) => jsonResponse(200, { data, meta: { current_page: 1, per_page: 100, total: data.length } })

function mockHostinger(opts: { orders?: () => Response; websites?: () => Response; subscriptions?: () => Response } = {}) {
  const calls: { path: string; search: string; method: string; auth: string | null }[] = []
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input)
    calls.push({ path: url.pathname, search: url.search, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('Authorization') })
    if (url.pathname === '/api/hosting/v1/orders') return opts.orders?.() ?? page(ORDERS)
    if (url.pathname === '/api/hosting/v1/websites') return opts.websites?.() ?? page(WEBSITES)
    if (url.pathname === '/api/billing/v1/subscriptions') return opts.subscriptions?.() ?? jsonResponse(200, SUBSCRIPTIONS)
    return jsonResponse(404, { message: 'Not found' })
  }
  return { fetch, calls }
}

type PlanRow = ExistingHostingPlan & { user_id: string; client_id: string | null; notes: string | null }
type DomainRow = DomainLink & { user_id: string }

/**
 * In-memory hosting store with the same rules as public.dd_sync_hostinger_plan
 * (the SQL itself is tested against Postgres separately): scoped to the user,
 * NULL keeps the stored value, only free domains get linked, unique order ids.
 */
function memoryHosting(userId: string, initial: { plans?: PlanRow[]; domains?: DomainRow[] } = {}, opts: { schemaReady?: boolean; failFor?: Record<string, { code: string; message: string }> } = {}) {
  const plans: PlanRow[] = (initial.plans ?? []).map((p) => ({ ...p }))
  const domains: DomainRow[] = (initial.domains ?? []).map((d) => ({ ...d }))
  const syncCalls: SyncArgs[] = []
  let nextId = 500
  const store: HostingStore = {
    async listHostingPlans(uid) {
      return { rows: plans.filter((p) => p.user_id === uid).map((p) => ({ ...p })), schemaReady: opts.schemaReady ?? true }
    },
    async listDomainLinks(uid) {
      return domains.filter((d) => d.user_id === uid).map((d) => ({ ...d }))
    },
    async syncHostingPlan(args) {
      syncCalls.push(structuredClone(args))
      const forced = opts.failFor?.[args.orderId]
      if (forced) throw forced
      let plan = plans.find((p) => p.user_id === userId && p.hostinger_order_id === args.orderId)
      let outcome = 'updated'
      if (!plan && args.linkPlanId) {
        plan = plans.find((p) => p.id === args.linkPlanId && p.user_id === userId && !p.hostinger_order_id)
        if (!plan) throw { code: 'P0002', message: 'not found' }
        outcome = 'linked'
      }
      if (!plan) {
        plan = {
          id: `p${nextId++}`, user_id: userId, client_id: null, notes: null, provider: 'Hostinger', plan_name: args.planName,
          start_date: args.startDate, renewal_date: args.renewalDate, hosting_cost: args.hostingCost, client_charge: null,
          currency: args.currency, auto_renew: args.autoRenew ?? false, status: args.status ?? 'active',
          hostinger_order_id: args.orderId, hostinger_subscription_id: args.subscriptionId, provider_status: args.providerStatus,
        }
        plans.push(plan)
        outcome = 'inserted'
      } else {
        plan.hostinger_order_id = args.orderId
        plan.hostinger_subscription_id = args.subscriptionId ?? plan.hostinger_subscription_id
        plan.start_date = plan.start_date ?? args.startDate
        plan.renewal_date = args.renewalDate ?? plan.renewal_date
        plan.hosting_cost = args.hostingCost ?? plan.hosting_cost
        plan.currency = args.currency ?? plan.currency
        plan.auto_renew = args.autoRenew ?? plan.auto_renew
        plan.status = args.status ?? plan.status
        plan.provider_status = args.providerStatus ?? plan.provider_status
      }
      let linked = 0
      for (const d of domains) {
        if (args.domainIds.includes(d.id) && d.user_id === userId && d.hosting_plan_id === null) {
          d.hosting_plan_id = plan.id
          linked++
        }
      }
      return { planId: plan.id, outcome, linked }
    },
  }
  return { store, plans, domains, syncCalls }
}

const domainRow = (id: string, name: string, planId: string | null = null, user = USER): DomainRow => ({
  id, domain_name: name, hosting_plan_id: planId, user_id: user,
})

const manualPlan = (over: Partial<PlanRow>): PlanRow => ({
  id: 'manual-1', user_id: USER, client_id: 'client-9', notes: 'Hand-written notes', provider: 'Hostinger',
  plan_name: 'Agency Business', start_date: null, renewal_date: '2027-03-01', hosting_cost: 200, client_charge: 400,
  currency: 'USD', auto_renew: false, status: 'active', hostinger_order_id: null, hostinger_subscription_id: null,
  provider_status: null, ...over,
})

function deps(hosting: HostingStore, overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    hostingerToken: TOKEN,
    fetch: mockHostinger().fetch,
    authenticate: async (header) =>
      header === 'Bearer valid-user-jwt' ? { userId: USER } : header === 'Bearer other-user-jwt' ? { userId: OTHER_USER } : null,
    allowedUserIds: [USER],
    store: {
      listDomains: async () => ({ rows: [], schemaReady: true }),
      insertDomain: async () => {},
      updateDomain: async () => {},
    },
    hosting,
    now: () => NOW,
    ...overrides,
  }
}

function post(body: unknown, auth: string | null = 'Bearer valid-user-jwt'): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) headers.Authorization = auth
  return new Request('http://localhost/hostinger-import', { method: 'POST', headers, body: JSON.stringify(body) })
}

async function call<T>(req: Request, d: HandlerDeps): Promise<{ status: number; body: T }> {
  const res = await handleRequest(req, d)
  return { status: res.status, body: (await res.json()) as T }
}

const preview = (d: HandlerDeps) => call<HostingPreviewResponse>(post({ action: 'hosting-preview' }), d)
const runImport = (d: HandlerDeps, plans: unknown) => call<HostingImportResponse>(post({ action: 'hosting-import', plans }), d)

describe('Hostinger hosting API parsing', () => {
  it('joins orders with billing subscriptions and websites, using only documented fields', async () => {
    const { accounts, warnings } = await fetchHostingAccounts(mockHostinger().fetch, TOKEN)
    assert.deepEqual(warnings, [])
    assert.equal(accounts.length, 3)
    const [business, premium, cloud] = accounts
    assert.equal(business.subscriptionName, 'Business Web Hosting')
    assert.equal(business.planCode, 'hostinger_business')
    assert.equal(business.renewalDate, '2027-02-10', 'auto-renewing: next_billing_at')
    assert.equal(business.renewalPrice, 155.88, 'cents → major units')
    assert.equal(business.currency, 'USD')
    assert.equal(business.autoRenew, true)
    assert.equal(business.billingPeriod, '1 year')
    assert.equal(business.createdDate, '2024-02-10')
    assert.deepEqual(business.websites.map((w) => w.name), ['alpha.com', 'beta.com', 'unknown-site.com'])
    assert.equal(premium.renewalDate, '2027-01-05', 'not auto-renewing: expires_at, next_billing_at ignored')
    assert.equal(premium.billingPeriod, '2 years')
    assert.deepEqual(premium.websites.map((w) => w.name), ['gamma.com'], 'websites without a domain are ignored')
    assert.equal(premium.websites[0].enabled, false)
    assert.equal(cloud.subscriptionName, null)
    assert.equal(cloud.renewalDate, null)
    assert.equal(cloud.renewalPrice, null)
    assert.equal(cloud.currency, null)
  })

  it('only sends authenticated GET requests, and pages through orders and websites', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ ...ORDERS[0], id: 2000 + i, subscription_id: null }))
    const mock = mockHostinger({
      orders: (() => {
        let n = 0
        return () => {
          n++
          const data = n === 1 ? many.slice(0, 100) : many.slice(100)
          return jsonResponse(200, { data, meta: { current_page: n, per_page: 100, total: 150 } })
        }
      })(),
    })
    const { accounts } = await fetchHostingAccounts(mock.fetch, TOKEN)
    assert.equal(accounts.length, 150)
    assert.ok(mock.calls.every((c) => c.method === 'GET' && c.auth === `Bearer ${TOKEN}`))
    assert.deepEqual(mock.calls.filter((c) => c.path === '/api/hosting/v1/orders').map((c) => c.search), [
      '?page=1&per_page=100',
      '?page=2&per_page=100',
    ])
  })

  it('tolerates missing and malformed fields without inventing values', () => {
    const subs = parseSubscriptions([
      { id: 'a', name: 'X', renewal_price: 'free', currency_code: 'dollars', is_auto_renewed: 'yes', next_billing_at: 'soon' },
      { id: 'b' },
      { name: 'no id' },
    ])
    assert.deepEqual(subs.get('a'), { name: 'X', status: null, renewalDate: null, renewalPrice: null, currency: null, autoRenew: null, billingPeriod: null })
    assert.equal(subs.get('b')?.name, null)
    assert.equal(subs.size, 2)
  })

  it('skips orders without an id', async () => {
    const mock = mockHostinger({ orders: () => page([{ status: 'active' }, ORDERS[0]]) })
    const { accounts, skipped } = await fetchHostingAccounts(mock.fetch, TOKEN)
    assert.equal(accounts.length, 1)
    assert.equal(skipped.length, 1)
  })

  it('keeps going when billing or websites fail, with a warning', async () => {
    const mock = mockHostinger({
      subscriptions: () => jsonResponse(403, { message: 'Forbidden scope' }),
      websites: () => jsonResponse(500, { message: 'oops' }),
    })
    const { accounts, warnings } = await fetchHostingAccounts(mock.fetch, TOKEN)
    assert.equal(accounts.length, 3)
    assert.equal(accounts[0].renewalDate, null)
    assert.equal(accounts[0].websites.length, 0)
    assert.equal(warnings.length, 2)
    assert.match(warnings.join(' '), /Billing details/)
    assert.match(warnings.join(' '), /Connected domains/)
  })

  it('maps order statuses and plan codes', () => {
    assert.equal(mapOrderStatus('active'), 'active')
    assert.equal(mapOrderStatus('suspended'), 'suspended')
    assert.equal(mapOrderStatus('deleted'), 'cancelled')
    assert.equal(mapOrderStatus('deleting'), 'cancelled')
    assert.equal(mapOrderStatus('mystery'), null)
    assert.equal(humanizePlanCode('hostinger_business'), 'Hostinger Business')
  })
})

describe('hosting actions: authentication and errors', () => {
  it('requires a signed-in, allow-listed user before calling Hostinger', async () => {
    const mock = mockHostinger()
    const { store } = memoryHosting(USER)
    assert.equal((await call(post({ action: 'hosting-preview' }, null), deps(store, { fetch: mock.fetch }))).status, 401)
    assert.equal((await call(post({ action: 'hosting-preview' }, 'Bearer other-user-jwt'), deps(store, { fetch: mock.fetch }))).status, 403)
    assert.equal(mock.calls.length, 0)
  })

  it('maps a rejected token to 502 and never leaks it', async () => {
    const { store } = memoryHosting(USER)
    const mock = mockHostinger({ orders: () => jsonResponse(401, { message: `Unauthenticated ${TOKEN}` }) })
    const res = await preview(deps(store, { fetch: mock.fetch }))
    assert.equal(res.status, 502)
    assert.ok(!JSON.stringify(res.body).includes(TOKEN))
  })

  it('a 401 on billing is a token problem, not a warning', async () => {
    const { store } = memoryHosting(USER)
    const mock = mockHostinger({ subscriptions: () => jsonResponse(401, { message: 'Unauthenticated' }) })
    assert.equal((await preview(deps(store, { fetch: mock.fetch }))).status, 502)
  })

  it('reports Hostinger outages', async () => {
    const { store } = memoryHosting(USER)
    const mock = mockHostinger({ orders: () => new Response('<html>down</html>', { status: 503 }) })
    const res = await preview(deps(store, { fetch: mock.fetch }))
    assert.equal(res.status, 502)
  })

  it('validates the selection', async () => {
    const { store } = memoryHosting(USER)
    for (const bad of [[], [{ orderId: 1001 }], [{ orderId: 'abc' }], [{ orderId: '1001', linkPlanId: 'x' }]]) {
      assert.equal((await runImport(deps(store), bad)).status, 400)
    }
    const dupLink = [
      { orderId: '1001', linkPlanId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { orderId: '1002', linkPlanId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    ]
    assert.equal((await runImport(deps(store), dupLink)).status, 400)
  })

  it('blocks importing until the migration is applied, but still previews', async () => {
    const { store, syncCalls } = memoryHosting(USER, {}, { schemaReady: false })
    const p = await preview(deps(store))
    assert.equal(p.status, 200)
    assert.equal(p.body.schemaReady, false)
    assert.equal((await runImport(deps(store), [{ orderId: '1001' }])).status, 409)
    assert.equal(syncCalls.length, 0)
  })
})

describe('hosting preview', () => {
  it('lists discovered plans, missing information and domain links', async () => {
    const { store } = memoryHosting(USER, {
      plans: [manualPlan({})],
      domains: [domainRow('d-alpha', 'alpha.com'), domainRow('d-beta', 'beta.com', 'manual-1'), domainRow('d-gamma', 'gamma.com')],
    })
    const { status, body } = await preview(deps(store))
    assert.equal(status, 200)
    assert.equal(body.items.length, 3)
    assert.deepEqual(body.manualPlans, [{ id: 'manual-1', planName: 'Agency Business', provider: 'Hostinger' }])
    const business = body.items[0]
    assert.equal(business.match, 'new')
    assert.equal(business.planName, 'Business Web Hosting')
    assert.deepEqual(business.domains, [
      { name: 'alpha.com', state: 'link' },
      { name: 'beta.com', state: 'other_plan', otherPlan: 'Agency Business' },
      { name: 'unknown-site.com', state: 'not_in_domaindesk' },
    ])
    assert.deepEqual(business.missing, [])
    const cloud = body.items[2]
    assert.equal(cloud.planName, 'Cloud Startup', 'no billing name: readable plan code, nothing invented')
    assert.deepEqual(cloud.missing, ['renewal date', 'renewal price'])
  })

  it("only reads the signed-in user's plans and domains", async () => {
    const { store } = memoryHosting(USER, {
      plans: [manualPlan({ id: 'theirs', user_id: OTHER_USER, hostinger_order_id: '1001' })],
      domains: [domainRow('d-x', 'alpha.com', null, OTHER_USER)],
    })
    const { body } = await preview(deps(store))
    assert.equal(body.items[0].match, 'new', "another user's import of the same order is invisible")
    assert.equal(body.items[0].domains[0].state, 'not_in_domaindesk')
    assert.deepEqual(body.manualPlans, [])
  })
})

describe('hosting import', () => {
  it('creates plans with Hostinger data and links matching, unlinked domains', async () => {
    const h = memoryHosting(USER, { domains: [domainRow('d-alpha', 'alpha.com'), domainRow('d-beta', 'beta.com')] })
    const { status, body } = await runImport(deps(h.store), [{ orderId: '1001' }])
    assert.equal(status, 200)
    assert.deepEqual(body.summary, { inserted: 1, linked: 0, updated: 0, unchanged: 0, failed: 0 })
    assert.equal(body.results[0].linkedDomains, 2)
    const plan = h.plans[0]
    assert.equal(plan.provider, 'Hostinger')
    assert.equal(plan.plan_name, 'Business Web Hosting')
    assert.equal(plan.renewal_date, '2027-02-10')
    assert.equal(plan.hosting_cost, 155.88)
    assert.equal(plan.currency, 'USD')
    assert.equal(plan.auto_renew, true)
    assert.equal(plan.status, 'active')
    assert.equal(plan.start_date, '2024-02-10')
    assert.equal(plan.client_charge, null, 'client charge is never imported')
    assert.equal(plan.hostinger_subscription_id, 'SubBusiness1')
    assert.deepEqual(h.domains.map((d) => d.hosting_plan_id), [plan.id, plan.id])
  })

  it('is repeatable: a second import creates no duplicates and changes nothing', async () => {
    const h = memoryHosting(USER, { domains: [domainRow('d-alpha', 'alpha.com')] })
    await runImport(deps(h.store), [{ orderId: '1001' }, { orderId: '1002' }, { orderId: '1003' }])
    const before = structuredClone(h.plans)
    const again = await runImport(deps(h.store), [{ orderId: '1001' }, { orderId: '1002' }, { orderId: '1003' }])
    assert.deepEqual(again.body.summary, { inserted: 0, linked: 0, updated: 0, unchanged: 3, failed: 0 })
    assert.deepEqual(h.plans, before)
    assert.equal(h.plans.length, 3)
  })

  it('updates Hostinger-owned fields and never plan name, client, client charge or notes', async () => {
    const h = memoryHosting(USER, {
      plans: [manualPlan({ id: 'imp', hostinger_order_id: '1001', hostinger_subscription_id: 'SubBusiness1', provider_status: 'active', plan_name: 'Renamed by me', renewal_date: '2026-02-10', hosting_cost: 100, start_date: '2024-02-10' })],
    })
    const { body } = await runImport(deps(h.store), [{ orderId: '1001' }])
    assert.equal(body.results[0].outcome, 'updated')
    const plan = h.plans[0]
    assert.equal(plan.renewal_date, '2027-02-10')
    assert.equal(plan.hosting_cost, 155.88)
    assert.equal(plan.auto_renew, true)
    assert.equal(plan.plan_name, 'Renamed by me')
    assert.equal(plan.client_id, 'client-9')
    assert.equal(plan.client_charge, 400)
    assert.equal(plan.notes, 'Hand-written notes')
  })

  it('a missing Hostinger value never clears a stored one', async () => {
    const h = memoryHosting(USER, {
      plans: [manualPlan({ id: 'imp', hostinger_order_id: '1003', renewal_date: '2027-06-01', hosting_cost: 99, currency: 'AUD', provider_status: 'active' })],
    })
    await runImport(deps(h.store), [{ orderId: '1003' }])
    assert.equal(h.plans[0].renewal_date, '2027-06-01')
    assert.equal(h.plans[0].hosting_cost, 99)
    assert.equal(h.plans[0].currency, 'AUD')
    assert.equal(h.plans[0].status, 'cancelled', 'deleted at Hostinger')
  })

  it('keeps cost and currency when the client charge is recorded in another currency', async () => {
    const h = memoryHosting(USER, {
      plans: [manualPlan({ id: 'imp', hostinger_order_id: '1001', currency: 'INR', hosting_cost: 9000, client_charge: 15000, provider_status: 'active' })],
    })
    const { body } = await runImport(deps(h.store), [{ orderId: '1001' }])
    assert.equal(h.plans[0].currency, 'INR')
    assert.equal(h.plans[0].hosting_cost, 9000)
    assert.equal(h.plans[0].renewal_date, '2027-02-10', 'other fields still update')
    assert.match(body.results[0].message ?? '', /Renewal/)
    const p = await preview(deps(h.store))
    assert.match(p.body.items[0].notes.join(' '), /bills in USD .* client charge is in INR/)
  })

  it('links an order to a manual plan instead of duplicating it, keeping its name and client', async () => {
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const h = memoryHosting(USER, { plans: [manualPlan({ id })] })
    const { body } = await runImport(deps(h.store), [{ orderId: '1001', linkPlanId: id }])
    assert.equal(body.results[0].outcome, 'linked')
    assert.equal(h.plans.length, 1)
    assert.equal(h.plans[0].hostinger_order_id, '1001')
    assert.equal(h.plans[0].plan_name, 'Agency Business')
    assert.equal(h.plans[0].client_id, 'client-9')
  })

  it("cannot link to another user's plan or to a plan already linked to Hostinger", async () => {
    const h = memoryHosting(USER, {
      plans: [
        manualPlan({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: OTHER_USER }),
        manualPlan({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', hostinger_order_id: '1002' }),
      ],
    })
    const { body } = await runImport(deps(h.store), [
      { orderId: '1001', linkPlanId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { orderId: '1003', linkPlanId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    ])
    assert.deepEqual(body.results.map((r) => r.outcome), ['failed', 'failed'])
    assert.equal(h.syncCalls.length, 0)
    assert.equal(h.plans.find((p) => p.user_id === OTHER_USER)?.hostinger_order_id, null)
  })

  it('never moves a domain that is already on another plan, and never creates domains', async () => {
    const h = memoryHosting(USER, {
      plans: [manualPlan({})],
      domains: [domainRow('d-alpha', 'alpha.com', 'manual-1')],
    })
    await runImport(deps(h.store), [{ orderId: '1001' }])
    assert.equal(h.domains.length, 1)
    assert.equal(h.domains[0].hosting_plan_id, 'manual-1')
    assert.deepEqual(h.syncCalls[0].domainIds, [])
  })

  it('a domain listed on two orders is linked only once', async () => {
    const dup = [...WEBSITES, { ...WEBSITES[0], order_id: 1002 }]
    const h = memoryHosting(USER, { domains: [domainRow('d-alpha', 'alpha.com')] })
    await runImport(deps(h.store, { fetch: mockHostinger({ websites: () => page(dup) }).fetch }), [{ orderId: '1001' }, { orderId: '1002' }])
    assert.deepEqual(h.syncCalls.map((c) => c.domainIds), [['d-alpha'], []])
  })

  it('reports a per-plan failure and continues; a unique-violation race is a skipped duplicate', async () => {
    const h = memoryHosting(USER, {}, {
      failFor: { '1001': { code: '23514', message: 'check' }, '1002': { code: '23505', message: 'duplicate' } },
    })
    const { body } = await runImport(deps(h.store), [{ orderId: '1001' }, { orderId: '1002' }, { orderId: '1003' }])
    assert.deepEqual(body.results.map((r) => r.outcome), ['failed', 'unchanged', 'inserted'])
    assert.match(body.results[0].message ?? '', /rejected/)
  })

  it('reports orders that disappeared from Hostinger', async () => {
    const h = memoryHosting(USER)
    const { body } = await runImport(deps(h.store), [{ orderId: '999' }])
    assert.equal(body.results[0].outcome, 'failed')
  })
})

describe('sync rules', () => {
  const account = {
    orderId: '1', subscriptionId: null, planCode: 'x', orderStatus: 'active', createdDate: '2027-05-01',
    subscriptionName: null, subscriptionStatus: null, renewalDate: null, renewalPrice: null, currency: null,
    autoRenew: null, billingPeriod: null, websites: [],
  }
  it('does not fill a start date that would be after the renewal date', () => {
    const plan = manualPlan({ hostinger_order_id: '1', renewal_date: '2027-03-01', provider_status: 'active' })
    const d = planHostingAccount(account, plan, undefined, new Map(), new Map())
    assert.equal(d.kind, 'unchanged')
    const fresh = planHostingAccount({ ...account, renewalDate: '2027-04-01' }, undefined, undefined, new Map(), new Map())
    assert.equal(fresh.args?.startDate, null)
  })
})
