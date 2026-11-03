import { fetchHostingAccounts, fetchPortfolio, HostingerError, type FetchLike, type HostingerDomain } from './hostinger.ts'
import {
  displayName,
  planHostingAccount,
  type DomainLink,
  type DomainLinkState,
  type ExistingHostingPlan,
  type HostingMatch,
  type SyncArgs,
} from './hostingPlan.ts'
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
 * POST { action: "hosting-preview" }
 *   → the account's hosting orders (with billing details and websites), each
 *     matched against the user's hosting plans, with the changes an import would make.
 * POST { action: "hosting-import", plans: [{ orderId, linkPlanId? }] }
 *   → re-reads Hostinger, then saves each selected plan and its domain links
 *     in one database transaction per plan (see hostingPlan.ts for the rules).
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

/** Hosting plan access as the signed-in user (RLS applies). */
export interface HostingStore {
  /** Returns schemaReady=false when the Hostinger columns from the 20261105 migration don't exist yet. */
  listHostingPlans(userId: string): Promise<{ rows: ExistingHostingPlan[]; schemaReady: boolean }>
  listDomainLinks(userId: string): Promise<DomainLink[]>
  /** Calls public.dd_sync_hostinger_plan: one transaction per plan. */
  syncHostingPlan(args: SyncArgs): Promise<{ planId: string; outcome: string; linked: number }>
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
  /** Required for the hosting-* actions. */
  hosting?: HostingStore
  now?: () => Date
}

export interface HostingPreviewItem {
  orderId: string
  subscriptionId: string | null
  /** Billing name, or the plan code made readable. */
  planName: string
  planCode: string | null
  orderStatus: string
  subscriptionStatus: string | null
  renewalDate: string | null
  renewalPrice: number | null
  currency: string | null
  autoRenew: boolean | null
  billingPeriod: string | null
  match: HostingMatch
  changes: string[]
  notes: string[]
  missing: string[]
  domains: { name: string; state: DomainLinkState; otherPlan?: string }[]
  existing: { id: string; planName: string } | null
}

export interface HostingPreviewResponse {
  fetchedAt: string
  schemaReady: boolean
  items: HostingPreviewItem[]
  /** Plans not yet linked to Hostinger, which an order can be linked to instead of creating a new plan. */
  manualPlans: { id: string; planName: string; provider: string }[]
  skipped: { entry: string; reason: string }[]
  warnings: string[]
}

export type HostingImportOutcome = 'inserted' | 'linked' | 'updated' | 'unchanged' | 'failed'

export interface HostingImportResponse {
  results: { orderId: string; planName: string; outcome: HostingImportOutcome; linkedDomains: number; message?: string }[]
  summary: Record<HostingImportOutcome, number>
  warnings: string[]
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

const MAX_HOSTING_IMPORT = 200
const HOSTING_MIGRATION = '20261105000000_hostinger_hosting_sync.sql'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function describeHostingDbError(error: unknown): string {
  const code = (error as DbError)?.code
  if (code === '42703' || code === 'PGRST204' || code === 'PGRST202' || code === '42883') {
    return `Database is missing the Hostinger hosting columns. Run the ${HOSTING_MIGRATION} migration.`
  }
  if (code === '23505') return 'Already imported (duplicate skipped).'
  if (code === 'P0002') return 'The hosting plan to link was not found, or is already linked to Hostinger.'
  if (code === '23514') return 'The database rejected one of the values (e.g. renewal date before start date).'
  return describeDbError(error)
}

interface HostingContext {
  accounts: Awaited<ReturnType<typeof fetchHostingAccounts>>
  plans: ExistingHostingPlan[]
  schemaReady: boolean
  byOrder: Map<string, ExistingHostingPlan>
  manual: Map<string, ExistingHostingPlan>
  planNames: Map<string, string>
  domainsByName: Map<string, DomainLink>
}

async function loadHostingContext(hosting: HostingStore, deps: HandlerDeps, token: string, userId: string): Promise<HostingContext> {
  const [accounts, plans, domains] = await Promise.all([
    fetchHostingAccounts(deps.fetch, token),
    hosting.listHostingPlans(userId),
    hosting.listDomainLinks(userId),
  ])
  const byOrder = new Map<string, ExistingHostingPlan>()
  const manual = new Map<string, ExistingHostingPlan>()
  for (const p of plans.rows) {
    if (p.hostinger_order_id) byOrder.set(p.hostinger_order_id, p)
    else manual.set(p.id, p)
  }
  const domainsByName = new Map<string, DomainLink>()
  for (const d of domains) {
    const key = normalizeName(d.domain_name)
    if (!domainsByName.has(key)) domainsByName.set(key, d)
  }
  return {
    accounts,
    plans: plans.rows,
    schemaReady: plans.schemaReady,
    byOrder,
    manual,
    planNames: new Map(plans.rows.map((p) => [p.id, p.plan_name])),
    domainsByName,
  }
}

async function hostingPreview(hosting: HostingStore, deps: HandlerDeps, token: string, userId: string): Promise<Response> {
  const ctx = await loadHostingContext(hosting, deps, token, userId)
  const items = ctx.accounts.accounts.map((account): HostingPreviewItem => {
    const existing = ctx.byOrder.get(account.orderId)
    const decision = planHostingAccount(account, existing, undefined, ctx.domainsByName, ctx.planNames)
    return {
      orderId: account.orderId,
      subscriptionId: account.subscriptionId,
      planName: displayName(account),
      planCode: account.planCode,
      orderStatus: account.orderStatus,
      subscriptionStatus: account.subscriptionStatus,
      renewalDate: account.renewalDate,
      renewalPrice: account.renewalPrice,
      currency: account.currency,
      autoRenew: account.autoRenew,
      billingPeriod: account.billingPeriod,
      match: decision.kind,
      changes: decision.changes,
      notes: decision.notes,
      missing: decision.missing,
      domains: decision.domains,
      existing: existing ? { id: existing.id, planName: existing.plan_name } : null,
    }
  })
  const body: HostingPreviewResponse = {
    fetchedAt: (deps.now?.() ?? new Date()).toISOString(),
    schemaReady: ctx.schemaReady,
    items,
    manualPlans: [...ctx.manual.values()].map((p) => ({ id: p.id, planName: p.plan_name, provider: p.provider })),
    skipped: ctx.accounts.skipped,
    warnings: ctx.accounts.warnings,
  }
  return json(200, body)
}

interface HostingSelection {
  orderId: string
  linkPlanId: string | null
}

function parseHostingSelection(raw: unknown): HostingSelection[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'Select at least one hosting plan to import.'
  if (raw.length > MAX_HOSTING_IMPORT) return `Import at most ${MAX_HOSTING_IMPORT} hosting plans at a time.`
  const byOrder = new Map<string, HostingSelection>()
  const linkTargets = new Set<string>()
  for (const item of raw) {
    const { orderId, linkPlanId } = (item ?? {}) as { orderId?: unknown; linkPlanId?: unknown }
    if (typeof orderId !== 'string' || !/^\d{1,20}$/.test(orderId)) return 'Each selected plan needs a Hostinger order id.'
    if (linkPlanId !== undefined && linkPlanId !== null && (typeof linkPlanId !== 'string' || !UUID_PATTERN.test(linkPlanId))) {
      return `Invalid plan to link for order ${orderId}.`
    }
    const link = (linkPlanId as string | null | undefined) ?? null
    if (link) {
      if (linkTargets.has(link)) return 'Each existing plan can be linked to only one Hostinger order.'
      linkTargets.add(link)
    }
    byOrder.set(orderId, { orderId, linkPlanId: link })
  }
  return [...byOrder.values()]
}

async function hostingImport(
  hosting: HostingStore,
  deps: HandlerDeps,
  token: string,
  userId: string,
  rawSelection: unknown,
): Promise<Response> {
  const selection = parseHostingSelection(rawSelection)
  if (typeof selection === 'string') return fail(400, 'invalid_request', selection)

  const ctx = await loadHostingContext(hosting, deps, token, userId)
  if (!ctx.schemaReady) {
    return fail(409, 'schema_not_ready', `Run the ${HOSTING_MIGRATION} migration in Supabase before importing hosting plans.`)
  }
  const accounts = new Map(ctx.accounts.accounts.map((a) => [a.orderId, a]))

  const results: HostingImportResponse['results'] = []
  // Sequential on purpose: each plan is its own transaction, and a domain
  // linked by one plan must not be offered to the next.
  for (const { orderId, linkPlanId } of selection) {
    const account = accounts.get(orderId)
    if (!account) {
      results.push({ orderId, planName: `Order ${orderId}`, outcome: 'failed', linkedDomains: 0, message: 'No longer in your Hostinger account.' })
      continue
    }
    const planName = displayName(account)
    const existing = ctx.byOrder.get(orderId)
    const linkTo = !existing && linkPlanId ? ctx.manual.get(linkPlanId) : undefined
    if (!existing && linkPlanId && !linkTo) {
      results.push({ orderId, planName, outcome: 'failed', linkedDomains: 0, message: describeHostingDbError({ code: 'P0002' }) })
      continue
    }
    const decision = planHostingAccount(account, existing, linkTo, ctx.domainsByName, ctx.planNames)
    if (decision.kind === 'unchanged' || !decision.args) {
      results.push({ orderId, planName, outcome: 'unchanged', linkedDomains: 0, message: 'Already up to date.' })
      continue
    }
    try {
      const saved = await hosting.syncHostingPlan(decision.args)
      const outcome: HostingImportOutcome =
        saved.outcome === 'inserted' || saved.outcome === 'linked' ? saved.outcome : 'updated'
      results.push({ orderId, planName, outcome, linkedDomains: saved.linked, message: decision.changes.join('; ') || undefined })
      // Domains linked here are no longer free for later plans in this run.
      for (const id of decision.args.domainIds) {
        for (const d of ctx.domainsByName.values()) if (d.id === id) d.hosting_plan_id = saved.planId
      }
      if (linkTo) ctx.manual.delete(linkTo.id)
    } catch (error) {
      const code = (error as DbError)?.code
      results.push({
        orderId,
        planName,
        outcome: code === '23505' ? 'unchanged' : 'failed',
        linkedDomains: 0,
        message: describeHostingDbError(error),
      })
    }
  }

  const summary: HostingImportResponse['summary'] = { inserted: 0, linked: 0, updated: 0, unchanged: 0, failed: 0 }
  for (const r of results) summary[r.outcome]++
  const body: HostingImportResponse = { results, summary, warnings: ctx.accounts.warnings }
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

  let body: { action?: unknown; domains?: unknown; plans?: unknown }
  try {
    body = await req.json()
  } catch {
    return fail(400, 'invalid_request', 'Request body must be JSON.')
  }

  try {
    if (body?.action === 'preview') return await preview(deps, deps.hostingerToken, auth.userId)
    if (body?.action === 'import') return await runImport(deps, deps.hostingerToken, auth.userId, body.domains)
    if (body?.action === 'hosting-preview' || body?.action === 'hosting-import') {
      if (!deps.hosting) return fail(500, 'not_configured', 'Hosting import is not available in this deployment.')
      return body.action === 'hosting-preview'
        ? await hostingPreview(deps.hosting, deps, deps.hostingerToken, auth.userId)
        : await hostingImport(deps.hosting, deps, deps.hostingerToken, auth.userId, body.plans)
    }
    return fail(400, 'invalid_request', 'Unknown action. Use "preview", "import", "hosting-preview" or "hosting-import".')
  } catch (error) {
    if (error instanceof HostingerError) return hostingerFailure(error, deps)
    // Database read failures and anything unexpected. Never echo request headers or secrets.
    return fail(500, 'internal_error', redact(describeDbError(error), deps))
  }
}
