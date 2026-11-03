import { DEFAULT_CURRENCY, DEFAULT_OWNERSHIP } from '../data/options'
import type {
  ClientInput,
  ClientRow,
  DomainInput,
  DomainRow,
  HostingPlanInput,
  HostingPlanRow,
  NotificationLogRow,
  NotificationSettingsInput,
  NotificationSettingsRow,
  RenewalInput,
  RenewalRow,
} from '../types/db'
import type {
  Client,
  Domain,
  DomainLifecycle,
  HostingPlan,
  HostingStatus,
  NotificationChannel,
  NotificationLogEntry,
  NotificationStatus,
  OwnershipType,
  Renewal,
  RenewalStatus,
} from '../types/domain'
import { supabase } from './supabase'

/*
 * All reads and writes go through here. RLS on every table limits rows to
 * auth.uid(); each query also filters by user_id so a misconfigured policy
 * can never widen what the UI touches.
 */

export interface WorkspaceData {
  clients: Client[]
  domains: Domain[]
  renewals: Renewal[]
  hostingPlans: HostingPlan[]
  /** Why hosting plans could not be loaded (e.g. migration not applied); null when they loaded. */
  hostingError: string | null
  /** Reminder settings; null until saved for the first time. */
  notificationSettings: NotificationSettingsRow | null
  /** Most recent reminders first. */
  notifications: NotificationLogEntry[]
  /** Why reminders could not be loaded (e.g. migration not applied); null when they loaded. */
  notificationsError: string | null
}

interface DbError {
  code?: string
  message?: string
  details?: string | null
}

/** Turns Supabase/Postgres errors into messages fit for the UI. */
export function describeError(error: unknown): string {
  const err = (error ?? {}) as DbError
  switch (err.code) {
    case '23505':
      return 'That record already exists.'
    case '23503':
      return 'This record is linked to other records. Remove or reassign those first.'
    case '23514':
      return 'The database rejected one of the values (it failed a validation rule).'
    case '23502':
      return 'A required field is missing.'
    case '42501':
      return "You don't have permission to change this record."
    case 'PGRST301':
    case 'PGRST303':
      return 'Your session has expired. Please sign in again.'
    case '42703':
    case '42P01':
    case 'PGRST204':
    case 'PGRST205':
      return 'The database schema does not match the app. Check the Supabase migration.'
  }
  if (error instanceof TypeError || err.message === 'Failed to fetch') {
    return 'Could not reach the server. Check your connection and try again.'
  }
  return err.message || 'Something went wrong. Please try again.'
}

function toNumber(value: number | string | null): number | null {
  if (value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

const lifecycleValues: DomainLifecycle[] = ['active', 'transferred', 'cancelled']
const renewalStatusValues: RenewalStatus[] = ['scheduled', 'invoiced', 'paid', 'cancelled']

function asLifecycle(value: string | null): DomainLifecycle {
  return lifecycleValues.includes(value as DomainLifecycle) ? (value as DomainLifecycle) : 'active'
}

function asOwnership(value: string | null | undefined): OwnershipType {
  return value === 'agency' || value === 'client' ? value : DEFAULT_OWNERSHIP
}

function asRenewalStatus(value: string | null): RenewalStatus {
  return renewalStatusValues.includes(value as RenewalStatus) ? (value as RenewalStatus) : 'scheduled'
}

const hostingStatusValues: HostingStatus[] = ['active', 'suspended', 'cancelled']

function asHostingStatus(value: string | null): HostingStatus {
  return hostingStatusValues.includes(value as HostingStatus) ? (value as HostingStatus) : 'active'
}

/** Only the columns the app uses. */
const HOSTING_COLUMNS =
  'id, client_id, provider, plan_name, start_date, renewal_date, hosting_cost, client_charge, currency, auto_renew, status, notes'
const HOSTING_SYNC_COLUMNS = `${HOSTING_COLUMNS}, hostinger_order_id, last_synced_at`

/** Hosting plans, with the Hostinger columns when the 20261105 migration is applied. */
async function fetchHostingPlans(userId: string) {
  const query = (columns: string) =>
    supabase
      .from('hosting_plans')
      .select(columns)
      .eq('user_id', userId)
      .order('renewal_date', { ascending: true, nullsFirst: false })
  const full = await query(HOSTING_SYNC_COLUMNS)
  const code = (full.error as DbError | null)?.code
  return code === '42703' || code === 'PGRST204' ? query(HOSTING_COLUMNS) : full
}

/** The hosting_plans table does not exist yet (migration not applied). */
function isMissingTable(error: { code?: string }): boolean {
  return error.code === 'PGRST205' || error.code === '42P01'
}

export const HOSTING_MIGRATION_MESSAGE =
  'Hosting plans need a one-time database update (supabase/migrations/20261103000000_hosting_plans.sql). Apply it in Supabase, then reload.'

export const HOSTING_RENEWALS_MIGRATION_MESSAGE =
  'Hosting renewals need a one-time database update (supabase/migrations/20261104000000_hosting_renewals.sql). Apply it in Supabase, then try again.'

/** The domain_renewals.hosting_plan_id column does not exist yet (migration not applied). */
export function isMissingColumn(error: unknown): boolean {
  const code = (error as DbError | null)?.code
  return code === 'PGRST204' || code === '42703'
}

export const REMINDERS_MIGRATION_MESSAGE =
  'Reminders need a one-time database update (supabase/migrations/20261106000000_renewal_reminders.sql). Apply it in Supabase, then reload.'

const NOTIFICATION_HISTORY_LIMIT = 300
const NOTIFICATION_COLUMNS =
  'id, renewal_id, channel, stage, due_date, target_kind, target_name, client_id, client_name, recipient, amount, currency, status, retryable, attempts, last_attempt_at, next_attempt_at, retry_requested_at, error, created_at, sent_at'
const notificationStatuses: NotificationStatus[] = ['pending', 'accepted', 'delivered', 'read', 'failed']

function toLogEntry(r: NotificationLogRow): NotificationLogEntry {
  return {
    id: r.id,
    renewalId: r.renewal_id,
    channel: (r.channel === 'whatsapp' ? 'whatsapp' : 'email') as NotificationChannel,
    stage: r.stage,
    dueDate: r.due_date,
    targetKind: r.target_kind === 'hosting' ? 'hosting' : 'domain',
    targetName: r.target_name,
    clientName: r.client_name ?? '',
    recipient: r.recipient,
    amount: toNumber(r.amount),
    currency: r.currency,
    status: notificationStatuses.includes(r.status as NotificationStatus) ? (r.status as NotificationStatus) : 'pending',
    retryable: r.retryable,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    retryRequested: Boolean(r.retry_requested_at && (!r.last_attempt_at || r.retry_requested_at > r.last_attempt_at)),
    error: r.error ?? '',
    createdAt: r.created_at,
    sentAt: r.sent_at,
  }
}

export async function fetchWorkspace(userId: string): Promise<WorkspaceData> {
  const [clientsRes, domainsRes, renewalsRes, hostingRes, settingsRes, logRes] = await Promise.all([
    supabase.from('clients').select('*').eq('user_id', userId).order('name'),
    supabase.from('domains').select('*').eq('user_id', userId).order('domain_name'),
    supabase
      .from('domain_renewals')
      .select('*')
      .eq('user_id', userId)
      .order('renewal_date', { ascending: false, nullsFirst: false }),
    fetchHostingPlans(userId),
    supabase.from('notification_settings').select('*').eq('user_id', userId).maybeSingle(),
    supabase
      .from('notification_log')
      .select(NOTIFICATION_COLUMNS)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(NOTIFICATION_HISTORY_LIMIT),
  ])
  if (clientsRes.error) throw clientsRes.error
  if (domainsRes.error) throw domainsRes.error
  if (renewalsRes.error) throw renewalsRes.error
  // A hosting problem (e.g. migration not applied) never blocks the rest of the workspace.
  const hostingError = hostingRes.error
    ? isMissingTable(hostingRes.error)
      ? HOSTING_MIGRATION_MESSAGE
      : describeError(hostingRes.error)
    : null

  // Like hosting: a reminders problem never blocks the rest of the workspace.
  const notificationsFailure = settingsRes.error ?? logRes.error
  const notificationsError = notificationsFailure
    ? isMissingTable(notificationsFailure)
      ? REMINDERS_MIGRATION_MESSAGE
      : describeError(notificationsFailure)
    : null

  const clientRows = clientsRes.data as ClientRow[]
  const domainRows = domainsRes.data as DomainRow[]
  const renewalRows = renewalsRes.data as RenewalRow[]
  const hostingRows = (hostingRes.data ?? []) as unknown as HostingPlanRow[]

  const clientNames = new Map(clientRows.map((c) => [c.id, c.name]))
  const domainCounts = new Map<string, number>()
  const domainNamesByPlan = new Map<string, string[]>()
  for (const d of domainRows) {
    if (d.client_id) domainCounts.set(d.client_id, (domainCounts.get(d.client_id) ?? 0) + 1)
    if (d.hosting_plan_id) {
      const names = domainNamesByPlan.get(d.hosting_plan_id)
      if (names) names.push(d.domain_name)
      else domainNamesByPlan.set(d.hosting_plan_id, [d.domain_name])
    }
  }
  const hostingCounts = new Map<string, number>()
  for (const h of hostingRows) {
    if (h.client_id) hostingCounts.set(h.client_id, (hostingCounts.get(h.client_id) ?? 0) + 1)
  }
  // Only domain renewals mark a domain as payment pending; hosting renewals have no domain_id.
  const unpaidDomains = new Set(
    renewalRows.filter((r) => r.status === 'invoiced' && r.domain_id).map((r) => r.domain_id),
  )

  const domains: Domain[] = domainRows.map((d) => ({
    id: d.id,
    name: d.domain_name,
    clientId: d.client_id,
    client: (d.client_id && clientNames.get(d.client_id)) || '',
    registrar: d.registrar ?? '',
    expiryDate: d.expiry_date,
    paymentStatus: unpaidDomains.has(d.id) ? 'pending' : 'paid',
    lifecycle: asLifecycle(d.status),
    autoRenew: d.auto_renew ?? false,
    notes: d.notes ?? '',
    ownershipType: asOwnership(d.ownership_type),
    provider: d.provider ?? null,
    hostingPlanId: d.hosting_plan_id ?? null,
  }))
  const domainsById = new Map(domains.map((d) => [d.id, d]))
  const plansById = new Map(hostingRows.map((h) => [h.id, h]))

  return {
    clients: clientRows.map((c) => ({
      id: c.id,
      name: c.name,
      contactName: c.contact_name ?? '',
      email: c.email ?? '',
      phone: c.phone ?? '',
      notes: c.notes ?? '',
      domainCount: domainCounts.get(c.id) ?? 0,
      hostingCount: hostingCounts.get(c.id) ?? 0,
      emailReminders: c.email_reminders ?? true,
      whatsappNumber: c.whatsapp_number ?? '',
      whatsappOptIn: c.whatsapp_opt_in ?? false,
      whatsappOptInAt: c.whatsapp_opt_in_at ?? null,
    })),
    domains,
    renewals: renewalRows.map((r) => {
      const hostingPlanId = r.hosting_plan_id ?? null
      const plan = hostingPlanId ? plansById.get(hostingPlanId) : undefined
      const domain = r.domain_id ? domainsById.get(r.domain_id) : undefined
      return {
        id: r.id,
        kind: hostingPlanId ? 'hosting' : 'domain',
        domainId: r.domain_id,
        hostingPlanId,
        targetName: hostingPlanId ? (plan?.plan_name ?? 'Unknown hosting plan') : (domain?.name ?? 'Unknown domain'),
        provider: plan?.provider ?? '',
        clientName: hostingPlanId
          ? (plan?.client_id && clientNames.get(plan.client_id)) || ''
          : (domain?.client ?? ''),
        renewalDate: r.renewal_date,
        registrarCost: toNumber(r.registrar_cost),
        clientCharge: toNumber(r.client_charge),
        currency: r.currency || DEFAULT_CURRENCY,
        status: asRenewalStatus(r.status),
        notes: r.notes ?? '',
      }
    }),
    hostingPlans: hostingRows.map((h) => ({
      id: h.id,
      provider: h.provider,
      planName: h.plan_name,
      clientId: h.client_id,
      client: (h.client_id && clientNames.get(h.client_id)) || '',
      startDate: h.start_date,
      renewalDate: h.renewal_date,
      hostingCost: toNumber(h.hosting_cost),
      clientCharge: toNumber(h.client_charge),
      currency: h.currency || DEFAULT_CURRENCY,
      autoRenew: h.auto_renew,
      status: asHostingStatus(h.status),
      notes: h.notes ?? '',
      domainNames: domainNamesByPlan.get(h.id) ?? [],
      hostingerOrderId: h.hostinger_order_id ?? null,
      lastSyncedAt: h.last_synced_at ?? null,
    })),
    hostingError,
    notificationSettings: notificationsError ? null : ((settingsRes.data as NotificationSettingsRow | null) ?? null),
    notifications: notificationsError ? [] : ((logRes.data ?? []) as unknown as NotificationLogRow[]).map(toLogEntry),
    notificationsError,
  }
}

type Table = 'clients' | 'domains' | 'domain_renewals' | 'hosting_plans' | 'notification_log'

async function insertRow(table: Table, userId: string, values: object): Promise<void> {
  const { error } = await supabase.from(table).insert({ ...values, user_id: userId })
  if (error) throw error
}

async function updateRow(table: Table, userId: string, id: string, values: object): Promise<void> {
  // Never let an update move a row to another owner: user_id is not in `values`.
  const { data, error } = await supabase.from(table).update(values).eq('id', id).eq('user_id', userId).select('id')
  if (error) throw error
  if (!data || data.length === 0) throw new Error('Record not found. It may have been deleted.')
}

async function deleteRow(table: Table, userId: string, id: string): Promise<void> {
  const { data, error } = await supabase.from(table).delete().eq('id', id).eq('user_id', userId).select('id')
  if (error) throw error
  if (!data || data.length === 0) throw new Error('Record not found. It may already have been deleted.')
}

export const saveClient = (userId: string, values: ClientInput, id?: string) =>
  id ? updateRow('clients', userId, id, values) : insertRow('clients', userId, values)

export const saveDomain = (userId: string, values: DomainInput, id?: string) =>
  id ? updateRow('domains', userId, id, values) : insertRow('domains', userId, values)

export const saveRenewal = (userId: string, values: RenewalInput, id?: string) =>
  id ? updateRow('domain_renewals', userId, id, values) : insertRow('domain_renewals', userId, values)

/**
 * Saves a plan and the complete set of domains it covers in one request. The
 * database function runs as the signed-in user (RLS applies) inside a single
 * transaction, so the plan and its links are saved together or not at all.
 */
export async function saveHostingPlan(values: HostingPlanInput, domainIds: string[], id?: string): Promise<void> {
  const { error } = await supabase.rpc('dd_save_hosting_plan', {
    p_id: id ?? null,
    p_provider: values.provider,
    p_plan_name: values.plan_name,
    p_client_id: values.client_id,
    p_start_date: values.start_date,
    p_renewal_date: values.renewal_date,
    p_hosting_cost: values.hosting_cost,
    p_client_charge: values.client_charge,
    p_currency: values.currency,
    p_auto_renew: values.auto_renew,
    p_status: values.status,
    p_notes: values.notes,
    p_domain_ids: domainIds,
  })
  if (error) throw error
}

/** Linked domains are unlinked by the database (ON DELETE SET NULL), never deleted. */
export const deleteHostingPlan = (userId: string, id: string) => deleteRow('hosting_plans', userId, id)

/** Creates or replaces the signed-in user's reminder settings. */
export async function saveNotificationSettings(userId: string, values: NotificationSettingsInput): Promise<void> {
  const { error } = await supabase.from('notification_settings').upsert({ ...values, user_id: userId }, { onConflict: 'user_id' })
  if (error) throw error
}

/** Asks the next scheduled run to resend a failed reminder (RLS allows only this column, only on failed rows). */
export const requestNotificationRetry = (userId: string, id: string) =>
  updateRow('notification_log', userId, id, { retry_requested_at: new Date().toISOString() })

export const deleteClient = (userId: string, id: string) => deleteRow('clients', userId, id)
export const deleteDomain = (userId: string, id: string) => deleteRow('domains', userId, id)
export const deleteRenewal = (userId: string, id: string) => deleteRow('domain_renewals', userId, id)
