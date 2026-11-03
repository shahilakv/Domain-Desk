import { DEFAULT_CURRENCY, DEFAULT_OWNERSHIP } from '../data/options'
import type { ClientInput, ClientRow, DomainInput, DomainRow, RenewalInput, RenewalRow } from '../types/db'
import type { Client, Domain, DomainLifecycle, OwnershipType, Renewal, RenewalStatus } from '../types/domain'
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
    case 'PGRST204':
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

export async function fetchWorkspace(userId: string): Promise<WorkspaceData> {
  const [clientsRes, domainsRes, renewalsRes] = await Promise.all([
    supabase.from('clients').select('*').eq('user_id', userId).order('name'),
    supabase.from('domains').select('*').eq('user_id', userId).order('domain_name'),
    supabase
      .from('domain_renewals')
      .select('*')
      .eq('user_id', userId)
      .order('renewal_date', { ascending: false, nullsFirst: false }),
  ])
  if (clientsRes.error) throw clientsRes.error
  if (domainsRes.error) throw domainsRes.error
  if (renewalsRes.error) throw renewalsRes.error

  const clientRows = clientsRes.data as ClientRow[]
  const domainRows = domainsRes.data as DomainRow[]
  const renewalRows = renewalsRes.data as RenewalRow[]

  const clientNames = new Map(clientRows.map((c) => [c.id, c.name]))
  const domainCounts = new Map<string, number>()
  for (const d of domainRows) {
    if (d.client_id) domainCounts.set(d.client_id, (domainCounts.get(d.client_id) ?? 0) + 1)
  }
  const unpaidDomains = new Set(renewalRows.filter((r) => r.status === 'invoiced').map((r) => r.domain_id))

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
  }))
  const domainsById = new Map(domains.map((d) => [d.id, d]))

  return {
    clients: clientRows.map((c) => ({
      id: c.id,
      name: c.name,
      contactName: c.contact_name ?? '',
      email: c.email ?? '',
      phone: c.phone ?? '',
      notes: c.notes ?? '',
      domainCount: domainCounts.get(c.id) ?? 0,
    })),
    domains,
    renewals: renewalRows.map((r) => {
      const domain = domainsById.get(r.domain_id)
      return {
        id: r.id,
        domainId: r.domain_id,
        domainName: domain?.name ?? 'Unknown domain',
        clientName: domain?.client ?? '',
        renewalDate: r.renewal_date,
        registrarCost: toNumber(r.registrar_cost),
        clientCharge: toNumber(r.client_charge),
        currency: r.currency || DEFAULT_CURRENCY,
        status: asRenewalStatus(r.status),
        notes: r.notes ?? '',
      }
    }),
  }
}

type Table = 'clients' | 'domains' | 'domain_renewals'

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

export const deleteClient = (userId: string, id: string) => deleteRow('clients', userId, id)
export const deleteDomain = (userId: string, id: string) => deleteRow('domains', userId, id)
export const deleteRenewal = (userId: string, id: string) => deleteRow('domain_renewals', userId, id)
