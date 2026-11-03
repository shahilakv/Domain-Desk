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
