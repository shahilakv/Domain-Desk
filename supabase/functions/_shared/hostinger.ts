/*
 * Read-only Hostinger Domains API client.
 * Docs: https://developers.hostinger.com/#tag/domains-portfolio
 *
 * Only GET endpoints are used. Nothing here renews, locks or otherwise changes
 * anything in the Hostinger account. The API token is passed in by the caller
 * and is never included in errors or logs.
 */

export const HOSTINGER_API_BASE = 'https://developers.hostinger.com'

const REQUEST_TIMEOUT_MS = 15_000
const DETAIL_CONCURRENCY = 3

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Raw item from GET /api/domains/v1/portfolio (Domains.V1.Domain.DomainResource). */
interface PortfolioItem {
  id: number
  domain: string | null
  type: string
  status: string
  created_at: string | null
  expires_at: string | null
}

/** One domain after duplicate portfolio entries have been merged. */
export interface HostingerDomain {
  /** Normalised name, e.g. "example.com". */
  name: string
  providerId: string
  /** 'domain', 'free_domain', 'domain_transfer' or 'free_domain_transfer'. */
  type: string
  /** Raw Hostinger status: active, expired, pending_setup, deleted, … */
  status: string
  /** YYYY-MM-DD, or null when Hostinger has no expiry (e.g. unregistered free-domain entitlements). */
  expiryDate: string | null
  /** YYYY-MM-DD from the domain details endpoint, or null when unavailable. */
  registeredDate: string | null
  /** YYYY-MM-DD when the portfolio entry was created (order date). */
  createdDate: string | null
  /** How many portfolio entries were merged into this one (free domain + registration, …). */
  entryCount: number
  /** Hostinger's explanation when the details lookup was refused (e.g. "Domain is not registered at Hostinger"). */
  detailsNote: string | null
}

export interface PortfolioResult {
  domains: HostingerDomain[]
  /** Entries that could not be used, with a reason. */
  skipped: { entry: string; reason: string }[]
  /** Non-fatal problems, e.g. a details lookup that failed. */
  warnings: string[]
}

export type HostingerErrorKind = 'unauthorized' | 'blocked' | 'rate_limited' | 'unavailable' | 'invalid_response' | 'network'

export class HostingerError extends Error {
  readonly kind: HostingerErrorKind
  readonly status: number | null
  /** Hostinger's correlation_id, for tracing the request with Hostinger support. */
  readonly correlationId: string | null
  constructor(kind: HostingerErrorKind, message: string, status: number | null = null, correlationId: string | null = null) {
    super(message)
    this.name = 'HostingerError'
    this.kind = kind
    this.status = status
    this.correlationId = correlationId
  }
}

/**
 * Tidies common paste mistakes in the stored secret (surrounding quotes, a
 * "Bearer " prefix, whitespace). `shape` describes the result without
 * revealing it: length plus what was fixed, safe to show to the allowed user.
 */
export function normalizeToken(raw: string | undefined): { token: string | undefined; shape: string } {
  let token = (raw ?? '').trim()
  const fixes: string[] = []
  if (/^(["'`]).*\1$/s.test(token)) {
    token = token.slice(1, -1).trim()
    fixes.push('surrounding quotes removed')
  }
  if (/^bearer\s+/i.test(token)) {
    token = token.replace(/^bearer\s+/i, '')
    fixes.push('"Bearer " prefix removed')
  }
  if (/\s/.test(token)) fixes.push('contains whitespace inside (likely a bad paste)')
  if (!token) return { token: undefined, shape: 'empty' }
  return { token, shape: `${token.length} characters${fixes.length ? `, ${fixes.join(', ')}` : ''}` }
}

/** Same rules as normalizeDomainName in the web app (src/utils/format.ts). */
export function normalizeDomainName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '')
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/

export function isValidDomainName(name: string): boolean {
  return DOMAIN_PATTERN.test(name)
}

/**
 * "2027-09-29T16:01:36Z" or "2027-05-25 13:53:04" → "2027-09-29" (UTC calendar
 * date). Returns null for missing or unparseable values.
 */
export function toISODate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (!match) return null
  const [, y, m, d] = match
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) {
    return null
  }
  return `${y}-${m}-${d}`
}

async function request(fetchImpl: FetchLike, token: string, path: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetchImpl(`${HOSTINGER_API_BASE}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    })
  } catch {
    throw new HostingerError('network', 'Could not reach the Hostinger API. Try again in a moment.')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Maps a non-2xx response to a HostingerError. Only Hostinger's own message
 * and correlation id are passed on, never request headers.
 */
async function toHostingerError(res: Response): Promise<HostingerError> {
  let detail = ''
  let correlationId: string | null = null
  let isJson = false
  try {
    const body = await res.json()
    isJson = true
    if (body && typeof body.message === 'string') detail = body.message.slice(0, 200)
    if (body && typeof body.correlation_id === 'string') correlationId = body.correlation_id.slice(0, 64)
  } catch {
    // Not JSON: typically a CDN/firewall page rather than the API itself.
  }
  const upstream = `HTTP ${res.status}${detail ? ` "${detail}"` : isJson ? '' : ', non-JSON response'}${correlationId ? `, correlation ${correlationId}` : ''}`
  if (res.status === 401) {
    return new HostingerError(
      'unauthorized',
      `Hostinger rejected the API token (${upstream}). HOSTINGER_API_TOKEN is invalid, expired or revoked.`,
      401,
      correlationId,
    )
  }
  if (res.status === 403) {
    return isJson
      ? new HostingerError('unauthorized', `Hostinger refused this token (${upstream}).`, 403, correlationId)
      : new HostingerError(
          'blocked',
          `Hostinger's firewall blocked the request from Supabase (${upstream}). This is not a token problem.`,
          403,
        )
  }
  if (res.status === 429) {
    return new HostingerError('rate_limited', `Hostinger is rate limiting requests (${upstream}). Wait a minute and try again.`, 429, correlationId)
  }
  return new HostingerError('unavailable', `Hostinger API error (${upstream}).`, res.status, correlationId)
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new HostingerError('invalid_response', 'Hostinger returned a response that is not valid JSON.', res.status)
  }
}

/** Validates the portfolio payload shape. Bad entries are reported, not fatal. */
export function parsePortfolio(payload: unknown): { items: PortfolioItem[]; skipped: PortfolioResult['skipped'] } {
  // The API documents a bare array; accept a { data: [...] } envelope too.
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null
  if (!list) {
    throw new HostingerError('invalid_response', 'Hostinger returned an unexpected portfolio format (expected a list of domains).')
  }

  const items: PortfolioItem[] = []
  const skipped: PortfolioResult['skipped'] = []
  list.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      skipped.push({ entry: `Entry ${index + 1}`, reason: 'Not a domain object.' })
      return
    }
    const r = raw as Record<string, unknown>
    const label = typeof r.domain === 'string' && r.domain ? r.domain : `Entry ${index + 1}`
    if (r.domain === null || r.domain === undefined || r.domain === '') {
      // Documented: domain is null for a free-domain entitlement that hasn't been claimed.
      skipped.push({ entry: label, reason: 'Unclaimed free domain (no domain name yet).' })
      return
    }
    if (typeof r.domain !== 'string') {
      skipped.push({ entry: label, reason: 'Domain name is not text.' })
      return
    }
    items.push({
      id: typeof r.id === 'number' || typeof r.id === 'string' ? Number(r.id) : NaN,
      domain: r.domain,
      type: typeof r.type === 'string' ? r.type : 'domain',
      status: typeof r.status === 'string' ? r.status : 'unknown',
      created_at: typeof r.created_at === 'string' ? r.created_at : null,
      expires_at: typeof r.expires_at === 'string' ? r.expires_at : null,
    })
  })
  return { items, skipped }
}

/** Real registrations beat free-domain entitlements; then the later expiry wins. */
function rank(item: PortfolioItem): [number, string] {
  const registered = item.type === 'domain' || item.type === 'domain_transfer' ? 1 : 0
  return [registered, toISODate(item.expires_at) ?? '']
}

/**
 * The portfolio can list one domain several times (e.g. a hosting plan's free
 * domain entitlement and the paid registration). Merge them by normalised name.
 */
export function mergePortfolio(items: PortfolioItem[]): { domains: HostingerDomain[]; skipped: PortfolioResult['skipped'] } {
  const groups = new Map<string, PortfolioItem[]>()
  const skipped: PortfolioResult['skipped'] = []
  for (const item of items) {
    const name = normalizeDomainName(item.domain ?? '')
    if (!isValidDomainName(name)) {
      skipped.push({ entry: item.domain ?? '', reason: 'Not a valid domain name.' })
      continue
    }
    const group = groups.get(name)
    if (group) group.push(item)
    else groups.set(name, [item])
  }

  const domains: HostingerDomain[] = []
  for (const [name, group] of groups) {
    const best = group.reduce((a, b) => {
      const [ra, ea] = rank(a)
      const [rb, eb] = rank(b)
      return rb > ra || (rb === ra && eb > ea) ? b : a
    })
    domains.push({
      name,
      providerId: Number.isFinite(best.id) ? String(best.id) : '',
      type: best.type,
      status: best.status,
      expiryDate: toISODate(best.expires_at),
      registeredDate: null,
      createdDate: toISODate(best.created_at),
      entryCount: group.length,
      detailsNote: null,
    })
  }
  domains.sort((a, b) => a.name.localeCompare(b.name))
  return { domains, skipped }
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  })
  await Promise.all(workers)
}

/**
 * Fills registeredDate from GET /api/domains/v1/portfolio/{domain}. Only for
 * real registrations (free-domain entries 404). Failures become warnings; an
 * auth failure stops the lookups and is rethrown.
 */
async function addRegistrationDates(fetchImpl: FetchLike, token: string, domains: HostingerDomain[], warnings: string[]) {
  const targets = domains.filter((d) => d.type === 'domain' || d.type === 'domain_transfer')
  let authError: HostingerError | null = null
  let failed = 0

  await mapWithConcurrency(targets, DETAIL_CONCURRENCY, async (domain) => {
    if (authError) return
    try {
      const res = await request(fetchImpl, token, `/api/domains/v1/portfolio/${encodeURIComponent(domain.name)}`)
      if (!res.ok) {
        if (res.status === 404) {
          // Seen for some portfolio entries: "[Domains:2006] Domain is not registered at Hostinger."
          const body = await res.json().catch(() => null)
          const message = typeof body?.message === 'string' ? body.message.slice(0, 200) : 'Domain details not found.'
          domain.detailsNote = `Hostinger details unavailable: ${message}`
          return
        }
        const err = await toHostingerError(res)
        if (err.kind === 'unauthorized') authError = err
        else failed++
        return
      }
      const body = (await res.json()) as Record<string, unknown>
      domain.registeredDate = toISODate(body.registered_at)
      // The details endpoint is authoritative if the list had no expiry.
      domain.expiryDate ??= toISODate(body.expires_at)
    } catch {
      failed++
    }
  })

  if (authError) throw authError
  if (failed > 0) {
    warnings.push(`Registration date unavailable for ${failed} domain${failed === 1 ? '' : 's'} (Hostinger details lookup failed).`)
  }
}

export interface FetchPortfolioOptions {
  /** Look up registration dates (one request per registered domain). */
  includeDetails?: boolean
  /** Restrict detail lookups to these normalised names. */
  detailsFor?: Set<string>
}

export async function fetchPortfolio(
  fetchImpl: FetchLike,
  token: string,
  { includeDetails = true, detailsFor }: FetchPortfolioOptions = {},
): Promise<PortfolioResult> {
  const res = await request(fetchImpl, token, '/api/domains/v1/portfolio')
  if (!res.ok) throw await toHostingerError(res)

  const parsed = parsePortfolio(await readJson(res))
  const merged = mergePortfolio(parsed.items)
  const warnings: string[] = []

  if (includeDetails) {
    const targets = detailsFor ? merged.domains.filter((d) => detailsFor.has(d.name)) : merged.domains
    await addRegistrationDates(fetchImpl, token, targets, warnings)
  }

  return { domains: merged.domains, skipped: [...parsed.skipped, ...merged.skipped], warnings }
}

/*
 * Hosting accounts. Read-only, three documented endpoints:
 *   GET /api/hosting/v1/orders            Web/Cloud hosting orders (paginated)
 *   GET /api/hosting/v1/websites          websites on those orders (paginated)
 *   GET /api/billing/v1/subscriptions     billing: name, renewal price, dates
 * Docs: https://developers.hostinger.com/#tag/hosting-orders,
 *       #tag/hosting-websites, #tag/billing-subscriptions
 */

const PAGE_SIZE = 100
/** Safety stop for pagination (100 × 20 = 2,000 orders or websites). */
const MAX_PAGES = 20

/** A website Hostinger runs on a hosting order. */
export interface HostingerWebsite {
  /** Normalised domain name. */
  name: string
  /** 'main' | 'addon' | 'parked' | 'subdomain', or null when Hostinger doesn't say. */
  vhostType: string | null
  /** False when the website is suspended. */
  enabled: boolean
}

/** One hosting order, joined with its billing subscription when Hostinger returns it. */
export interface HostingerHostingAccount {
  orderId: string
  subscriptionId: string | null
  /** Hostinger plan code, e.g. "hostinger_business". */
  planCode: string | null
  /** Raw order status: active, suspended, deleting, deleted. */
  orderStatus: string
  /** YYYY-MM-DD the order was created. */
  createdDate: string | null
  /** Display name from the billing subscription, e.g. "Business Web Hosting". */
  subscriptionName: string | null
  subscriptionStatus: string | null
  /** Next charge while auto-renewing, otherwise the scheduled expiry. Null when Hostinger has neither. */
  renewalDate: string | null
  /** Renewal price in major units (Hostinger sends cents). */
  renewalPrice: number | null
  currency: string | null
  autoRenew: boolean | null
  /** e.g. "1 year", from billing_period + billing_period_unit. */
  billingPeriod: string | null
  websites: HostingerWebsite[]
}

export interface HostingAccountsResult {
  accounts: HostingerHostingAccount[]
  skipped: { entry: string; reason: string }[]
  warnings: string[]
}

function listFrom(payload: unknown, what: string): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: unknown[] }).data
  }
  throw new HostingerError('invalid_response', `Hostinger returned an unexpected ${what} format (expected a list).`)
}

/** Reads every page of a paginated list endpoint ({ data, meta: { current_page, per_page, total } }). */
async function fetchAllPages(fetchImpl: FetchLike, token: string, path: string, what: string): Promise<unknown[]> {
  const items: unknown[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await request(fetchImpl, token, `${path}?page=${page}&per_page=${PAGE_SIZE}`)
    if (!res.ok) throw await toHostingerError(res)
    const payload = await readJson(res)
    const list = listFrom(payload, what)
    items.push(...list)
    const meta = (payload as { meta?: { total?: unknown } } | null)?.meta
    const total = typeof meta?.total === 'number' ? meta.total : null
    // Stop on a short page, or when the documented total has been reached.
    if (list.length < PAGE_SIZE || (total !== null && items.length >= total)) return items
  }
  return items
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const idText = (v: unknown): string | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0
    ? String(v)
    : typeof v === 'string' && /^\d{1,20}$/.test(v)
      ? v
      : null

interface RawOrder {
  orderId: string
  subscriptionId: string | null
  planCode: string | null
  status: string
  createdDate: string | null
}

export function parseOrders(list: unknown[]): { orders: RawOrder[]; skipped: HostingAccountsResult['skipped'] } {
  const orders: RawOrder[] = []
  const skipped: HostingAccountsResult['skipped'] = []
  list.forEach((raw, index) => {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    const orderId = idText(r?.id)
    if (!r || !orderId) {
      skipped.push({ entry: `Hosting order ${index + 1}`, reason: 'No usable order id.' })
      return
    }
    const plan = r.plan && typeof r.plan === 'object' ? (r.plan as Record<string, unknown>) : null
    orders.push({
      orderId,
      subscriptionId: str(r.subscription_id),
      planCode: str(plan?.name),
      status: str(r.status) ?? 'unknown',
      createdDate: toISODate(r.created_at),
    })
  })
  return { orders, skipped }
}

/** Websites grouped by order id. Websites without a domain (e.g. not yet attached) are ignored. */
export function parseWebsites(list: unknown[]): Map<string, HostingerWebsite[]> {
  const byOrder = new Map<string, HostingerWebsite[]>()
  for (const raw of list) {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    const orderId = idText(r?.order_id)
    const domain = str(r?.domain)
    if (!r || !orderId || !domain) continue
    const name = normalizeDomainName(domain)
    if (!isValidDomainName(name)) continue
    const site: HostingerWebsite = { name, vhostType: str(r.vhost_type), enabled: r.is_enabled !== false }
    const sites = byOrder.get(orderId)
    if (!sites) byOrder.set(orderId, [site])
    else if (!sites.some((s) => s.name === name)) sites.push(site)
  }
  for (const sites of byOrder.values()) sites.sort((a, b) => a.name.localeCompare(b.name))
  return byOrder
}

interface RawSubscription {
  name: string | null
  status: string | null
  renewalDate: string | null
  renewalPrice: number | null
  currency: string | null
  autoRenew: boolean | null
  billingPeriod: string | null
}

export function parseSubscriptions(list: unknown[]): Map<string, RawSubscription> {
  const byId = new Map<string, RawSubscription>()
  for (const raw of list) {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    const id = str(r?.id)
    if (!r || !id) continue
    const autoRenew = typeof r.is_auto_renewed === 'boolean' ? r.is_auto_renewed : null
    // Documented: next_billing_at only applies while auto-renewing; expires_at is set
    // once a cancellation is scheduled (e.g. auto-renewal turned off).
    const renewalDate =
      autoRenew === false ? toISODate(r.expires_at) : (toISODate(r.next_billing_at) ?? toISODate(r.expires_at))
    const cents =
      typeof r.renewal_price === 'number' && Number.isFinite(r.renewal_price) && r.renewal_price >= 0 ? r.renewal_price : null
    const currency = str(r.currency_code)?.toUpperCase() ?? null
    const period = typeof r.billing_period === 'number' && r.billing_period > 0 ? r.billing_period : null
    const unit = str(r.billing_period_unit)
    byId.set(id, {
      name: str(r.name),
      status: str(r.status),
      renewalDate,
      renewalPrice: cents === null ? null : Math.round(cents) / 100,
      currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
      autoRenew,
      billingPeriod: period && unit ? `${period} ${unit}${period === 1 ? '' : 's'}` : null,
    })
  }
  return byId
}

/**
 * Optional lookups: a failure (other than a rejected token) becomes a warning
 * so the orders can still be imported, with the missing fields left empty.
 */
async function optional<T>(load: () => Promise<T>, fallback: T, warning: string, warnings: string[]): Promise<T> {
  try {
    return await load()
  } catch (error) {
    if (error instanceof HostingerError && error.status === 401) throw error
    warnings.push(`${warning} (${error instanceof HostingerError ? error.message : 'request failed'})`)
    return fallback
  }
}

async function fetchSubscriptions(fetchImpl: FetchLike, token: string): Promise<unknown[]> {
  const res = await request(fetchImpl, token, '/api/billing/v1/subscriptions')
  if (!res.ok) throw await toHostingerError(res)
  return listFrom(await readJson(res), 'subscriptions')
}

export async function fetchHostingAccounts(fetchImpl: FetchLike, token: string): Promise<HostingAccountsResult> {
  const warnings: string[] = []
  const [orderList, websiteList, subscriptionList] = await Promise.all([
    fetchAllPages(fetchImpl, token, '/api/hosting/v1/orders', 'hosting orders'),
    optional(
      () => fetchAllPages(fetchImpl, token, '/api/hosting/v1/websites', 'websites'),
      [] as unknown[],
      'Connected domains are unavailable, so no domains will be linked automatically',
      warnings,
    ),
    optional(
      () => fetchSubscriptions(fetchImpl, token),
      [] as unknown[],
      'Billing details (plan name, renewal date and price) are unavailable',
      warnings,
    ),
  ])

  const { orders, skipped } = parseOrders(orderList)
  const websites = parseWebsites(websiteList)
  const subscriptions = parseSubscriptions(subscriptionList)

  const accounts = orders.map((o): HostingerHostingAccount => {
    const sub = o.subscriptionId ? subscriptions.get(o.subscriptionId) : undefined
    return {
      orderId: o.orderId,
      subscriptionId: o.subscriptionId,
      planCode: o.planCode,
      orderStatus: o.status,
      createdDate: o.createdDate,
      subscriptionName: sub?.name ?? null,
      subscriptionStatus: sub?.status ?? null,
      renewalDate: sub?.renewalDate ?? null,
      renewalPrice: sub?.renewalPrice ?? null,
      currency: sub?.currency ?? null,
      autoRenew: sub?.autoRenew ?? null,
      billingPeriod: sub?.billingPeriod ?? null,
      websites: websites.get(o.orderId) ?? [],
    }
  })
  accounts.sort((a, b) => Number(a.orderId) - Number(b.orderId))
  return { accounts, skipped, warnings }
}
