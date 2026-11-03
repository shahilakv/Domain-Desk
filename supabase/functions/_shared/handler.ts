import { fetchPortfolio, HostingerError, type FetchLike, type HostingerDomain } from './hostinger.ts'
import {
  DEFAULT_OWNERSHIP,
  indexExisting,
  normalizeName,
  OWNERSHIP_TYPES,
  planDomain,
  type DomainInsert,
  type DomainPatch,
  type ExistingDomain,
  type MatchKind,
  type OwnershipType,
} from './importPlan.ts'

/*
 * Request handling for the hostinger-import Edge Function, with every external
 * dependency injected (see ../hostinger-import/index.ts for the real wiring and
 * ../tests for the mocked one).
 *
 * POST { action: "preview" }
 *   → the merged Hostinger portfolio, each domain matched against the user's
 *     existing rows, with the changes an import would make.
 * POST { action: "import", domains: [{ name, ownershipType }] }
 *   → re-reads Hostinger (never trusts dates sent by the browser), then inserts
 *     or updates each selected domain independently and reports per-domain results.
 */

export interface DbError {
  code?: string
  message?: string
}

/** Database access as the signed-in user. Every implementation must scope to userId (RLS also enforces it). */
export interface DomainStore {
  /** Returns schemaReady=false when the sync columns from the migration don't exist yet. */
  listDomains(userId: string): Promise<{ rows: ExistingDomain[]; schemaReady: boolean }>
  insertDomain(userId: string, values: DomainInsert): Promise<void>
  /** Must match on both id and user_id and fail if no row was updated. */
  updateDomain(userId: string, id: string, values: DomainPatch): Promise<void>
}

export interface HandlerDeps {
  hostingerToken: string | undefined
  /** Non-secret description of the stored token (see normalizeToken), added to token errors. */
  tokenShape?: string
  /** Server-side log sink (Supabase function logs). Must never receive secrets. */
  logError?: (event: Record<string, unknown>) => void
  fetch: FetchLike
  /** Verifies the caller's Supabase access token; returns null when it is missing or invalid. */
  authenticate(authorization: string | null): Promise<{ userId: string } | null>
  /**
   * Supabase user ids allowed to use the Hostinger token (HOSTINGER_ALLOWED_USER_IDS).
   * The token belongs to one Hostinger account, so being signed in is not enough:
   * anyone who can sign up would otherwise see that portfolio. Empty = nobody.
   */
  allowedUserIds: string[]
  store: DomainStore
  now?: () => Date
}

export interface PreviewItem {
  name: string
  providerId: string
  type: string
  status: string
  expiryDate: string | null
  registeredDate: string | null
  createdDate: string | null
  entryCount: number
  match: MatchKind
  changes: string[]
  notes: string[]
  /** Ownership can only be chosen for new rows or rows that don't have one yet. */
  ownershipEditable: boolean
  existing: { id: string; hasClient: boolean; registrar: string | null; expiryDate: string | null; ownershipType: string | null } | null
}

export interface PreviewResponse {
  fetchedAt: string
  schemaReady: boolean
  items: PreviewItem[]
  skipped: { entry: string; reason: string }[]
  warnings: string[]
}

export type ImportOutcome = 'inserted' | 'updated' | 'unchanged' | 'failed'

export interface ImportResponse {
  results: { name: string; outcome: ImportOutcome; message?: string }[]
  summary: Record<ImportOutcome, number>
  warnings: string[]
}

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MAX_IMPORT = 500

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function fail(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } })
}

/** Defence in depth: never let the Hostinger token appear in a response, even if an upstream message echoes it. */
function redact(message: string, deps: HandlerDeps): string {
  return deps.hostingerToken ? message.split(deps.hostingerToken).join('[redacted]') : message
}

function hostingerFailure(error: HostingerError, deps: HandlerDeps): Response {
  deps.logError?.({
    event: 'hostinger_error',
    kind: error.kind,
    status: error.status,
    correlationId: error.correlationId,
    tokenShape: deps.tokenShape,
  })
  const message =
    error.kind === 'unauthorized' && deps.tokenShape ? `${error.message} Stored token: ${deps.tokenShape}.` : error.message
  // 502, not 401: a bad Hostinger token must not look like an expired DomainDesk session.
  return fail(502, `hostinger_${error.kind}`, redact(message, deps))
}

export function describeDbError(error: unknown): string {
  const err = (error ?? {}) as DbError
  switch (err.code) {
    case '23505':
      return 'Already in DomainDesk (skipped as a duplicate).'
    case '23514':
      return 'The database rejected one of the values.'
    case '42501':
      return 'Permission denied by row-level security.'
    case '42703':
    case 'PGRST204':
      return 'Database is missing the Hostinger columns. Run the 20261102000000_hostinger_import.sql migration.'
  }
  return err.message ? err.message.slice(0, 200) : 'Database write failed.'
}

function toPreviewItem(domain: HostingerDomain, existing: ExistingDomain | undefined, syncedAt: string): PreviewItem {
  const plan = planDomain(domain, existing, DEFAULT_OWNERSHIP, syncedAt)
  return {
    name: domain.name,
    providerId: domain.providerId,
    type: domain.type,
    status: domain.status,
    expiryDate: domain.expiryDate,
    registeredDate: domain.registeredDate,
    createdDate: domain.createdDate,
    entryCount: domain.entryCount,
    match: plan.kind,
    changes: plan.changes,
    notes: domain.detailsNote ? [...plan.notes, domain.detailsNote] : plan.notes,
    ownershipEditable: !existing || !existing.ownership_type,
    existing: existing
      ? {
          id: existing.id,
          hasClient: Boolean(existing.client_id),
          registrar: existing.registrar,
          expiryDate: existing.expiry_date,
          ownershipType: existing.ownership_type ?? null,
        }
      : null,
  }
}

async function preview(deps: HandlerDeps, token: string, userId: string): Promise<Response> {
  const [portfolio, existing] = await Promise.all([
    fetchPortfolio(deps.fetch, token),
    deps.store.listDomains(userId),
  ])
  const syncedAt = (deps.now?.() ?? new Date()).toISOString()
  const byName = indexExisting(existing.rows)
  const body: PreviewResponse = {
    fetchedAt: syncedAt,
    schemaReady: existing.schemaReady,
    items: portfolio.domains.map((d) => toPreviewItem(d, byName.get(d.name), syncedAt)),
    skipped: portfolio.skipped,
    warnings: portfolio.warnings,
  }
  return json(200, body)
}

interface Selection {
  name: string
  ownership: OwnershipType
}

function parseSelection(raw: unknown): Selection[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'Select at least one domain to import.'
  if (raw.length > MAX_IMPORT) return `Import at most ${MAX_IMPORT} domains at a time.`
  const seen = new Map<string, Selection>()
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof (item as { name?: unknown }).name !== 'string') {
      return 'Each selected domain needs a name.'
    }
    const { name, ownershipType } = item as { name: string; ownershipType?: unknown }
    if (ownershipType !== undefined && !OWNERSHIP_TYPES.includes(ownershipType as OwnershipType)) {
      return `Invalid ownership type for ${name}.`
    }
    const key = normalizeName(name)
    seen.set(key, { name: key, ownership: (ownershipType as OwnershipType | undefined) ?? DEFAULT_OWNERSHIP })
  }
  return [...seen.values()]
}

async function runImport(deps: HandlerDeps, token: string, userId: string, rawSelection: unknown): Promise<Response> {
  const selection = parseSelection(rawSelection)
  if (typeof selection === 'string') return fail(400, 'invalid_request', selection)

  const existing = await deps.store.listDomains(userId)
  if (!existing.schemaReady) {
    return fail(
      409,
      'schema_not_ready',
      'Run the 20261102000000_hostinger_import.sql migration in Supabase before importing.',
    )
  }

  const portfolio = await fetchPortfolio(deps.fetch, token, { detailsFor: new Set(selection.map((s) => s.name)) })
  const fromHostinger = new Map(portfolio.domains.map((d) => [d.name, d]))
  const byName = indexExisting(existing.rows)
  const syncedAt = (deps.now?.() ?? new Date()).toISOString()

  const results: ImportResponse['results'] = []
  // Sequential on purpose: a handful of domains, clear per-row errors, no write bursts.
  for (const { name, ownership } of selection) {
    const domain = fromHostinger.get(name)
    if (!domain) {
      results.push({ name, outcome: 'failed', message: 'No longer in your Hostinger portfolio.' })
      continue
    }
    const plan = planDomain(domain, byName.get(name), ownership, syncedAt)
    try {
      if (plan.kind === 'new' && plan.insert) {
        await deps.store.insertDomain(userId, plan.insert)
        results.push({ name, outcome: 'inserted' })
      } else if (plan.kind === 'update' && plan.patch && plan.existingId) {
        await deps.store.updateDomain(userId, plan.existingId, plan.patch)
        results.push({ name, outcome: 'updated', message: plan.changes.join('; ') })
      } else {
        results.push({ name, outcome: 'unchanged', message: 'Already up to date.' })
      }
    } catch (error) {
      const code = (error as DbError)?.code
      // A row created since the preview (another tab, double click): treat as a skipped duplicate.
      if (code === '23505') results.push({ name, outcome: 'unchanged', message: describeDbError(error) })
      else results.push({ name, outcome: 'failed', message: describeDbError(error) })
    }
  }

  const summary: ImportResponse['summary'] = { inserted: 0, updated: 0, unchanged: 0, failed: 0 }
  for (const r of results) summary[r.outcome]++
  const body: ImportResponse = { results, summary, warnings: portfolio.warnings }
  return json(200, body)
}

export async function handleRequest(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  const auth = await deps.authenticate(req.headers.get('Authorization'))
  if (!auth) return fail(401, 'unauthorized', 'Your session has expired. Please sign in again.')

  if (!deps.allowedUserIds.includes(auth.userId)) {
    return fail(
      403,
      'forbidden',
      deps.allowedUserIds.length === 0
        ? 'Hostinger import is locked: no users are allowed yet (HOSTINGER_ALLOWED_USER_IDS is not set).'
        : 'Your account is not allowed to use the Hostinger connection.',
    )
  }

  if (!deps.hostingerToken) {
    return fail(
      500,
      'not_configured',
      'Hostinger is not connected: the HOSTINGER_API_TOKEN secret is not set for this Edge Function.',
    )
  }

  let body: { action?: unknown; domains?: unknown }
  try {
    body = await req.json()
  } catch {
    return fail(400, 'invalid_request', 'Request body must be JSON.')
  }

  try {
    if (body?.action === 'preview') return await preview(deps, deps.hostingerToken, auth.userId)
    if (body?.action === 'import') return await runImport(deps, deps.hostingerToken, auth.userId, body.domains)
    return fail(400, 'invalid_request', 'Unknown action. Use "preview" or "import".')
  } catch (error) {
    if (error instanceof HostingerError) return hostingerFailure(error, deps)
    // Database read failures and anything unexpected. Never echo request headers or secrets.
    return fail(500, 'internal_error', redact(describeDbError(error), deps))
  }
}
