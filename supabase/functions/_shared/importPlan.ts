import type { HostingerDomain } from './hostinger.ts'

/*
 * Pure matching/merge rules for the Hostinger import. Kept free of I/O so the
 * same rules drive the preview and the actual write, and can be unit tested.
 *
 * Rules:
 *  - Domains are matched by normalised name (lower-case, no trailing dot).
 *  - A sync never writes client_id, notes, status, or auto_renew on an
 *    existing row, and never clears a value with a missing Hostinger one.
 *  - registrar and ownership_type are only filled in when empty.
 *  - Nothing creates renewals or payment records.
 */

export type OwnershipType = 'agency' | 'client'
export const OWNERSHIP_TYPES: OwnershipType[] = ['agency', 'client']
export const DEFAULT_OWNERSHIP: OwnershipType = 'agency'
export const REGISTRAR_NAME = 'Hostinger'
export const PROVIDER = 'hostinger'

/** The subset of a domains row the import reads. Sync columns are absent before the migration. */
export interface ExistingDomain {
  id: string
  domain_name: string
  client_id: string | null
  registrar: string | null
  expiry_date: string | null
  ownership_type?: string | null
  provider?: string | null
  provider_domain_id?: string | null
  provider_status?: string | null
  registered_date?: string | null
}

export type DomainInsert = {
  domain_name: string
  registrar: string
  expiry_date: string | null
  status: 'active' | 'cancelled'
  ownership_type: OwnershipType
  provider: string
  provider_domain_id: string | null
  provider_status: string
  registered_date: string | null
  last_synced_at: string
}

export type DomainPatch = Partial<Omit<DomainInsert, 'domain_name' | 'status'>>

export type MatchKind = 'new' | 'update' | 'unchanged'

export interface Plan {
  kind: MatchKind
  /** Human-readable list of what the import will change. */
  changes: string[]
  /** Things deliberately left alone that the user may want to review. */
  notes: string[]
  insert?: DomainInsert
  patch?: DomainPatch
  existingId?: string
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '')
}

/** Index existing rows by normalised name. The first row wins if the table already has duplicates. */
export function indexExisting(rows: ExistingDomain[]): Map<string, ExistingDomain> {
  const map = new Map<string, ExistingDomain>()
  for (const row of rows) {
    const key = normalizeName(row.domain_name)
    if (!map.has(key)) map.set(key, row)
  }
  return map
}

export function planDomain(
  domain: HostingerDomain,
  existing: ExistingDomain | undefined,
  ownership: OwnershipType,
  syncedAt: string,
): Plan {
  const providerId = domain.providerId || null

  if (!existing) {
    const changes = [`Add with registrar ${REGISTRAR_NAME}`, `Ownership: ${ownership}`]
    const notes: string[] = []
    if (!domain.expiryDate) notes.push('Hostinger has no expiry date for this domain; it will be saved without one.')
    return {
      kind: 'new',
      changes,
      notes,
      insert: {
        domain_name: domain.name,
        registrar: REGISTRAR_NAME,
        expiry_date: domain.expiryDate,
        // DomainDesk derives "expired" from the date; only a deleted domain is no longer ours.
        status: domain.status === 'deleted' ? 'cancelled' : 'active',
        ownership_type: ownership,
        provider: PROVIDER,
        provider_domain_id: providerId,
        provider_status: domain.status,
        registered_date: domain.registeredDate,
        last_synced_at: syncedAt,
      },
    }
  }

  const patch: DomainPatch = {}
  const changes: string[] = []
  const notes: string[] = []

  if (domain.expiryDate && domain.expiryDate !== existing.expiry_date) {
    patch.expiry_date = domain.expiryDate
    changes.push(existing.expiry_date ? `Expiry ${existing.expiry_date} → ${domain.expiryDate}` : `Expiry set to ${domain.expiryDate}`)
  } else if (!domain.expiryDate && existing.expiry_date) {
    notes.push('Hostinger has no expiry date; the recorded expiry is kept.')
  }

  if (!existing.registrar?.trim()) {
    patch.registrar = REGISTRAR_NAME
    changes.push(`Registrar set to ${REGISTRAR_NAME}`)
  } else if (existing.registrar.trim().toLowerCase() !== REGISTRAR_NAME.toLowerCase()) {
    notes.push(`Registrar is recorded as "${existing.registrar}" and will not be changed.`)
  }

  if (!existing.ownership_type) {
    patch.ownership_type = ownership
    changes.push(`Ownership set to ${ownership}`)
  }

  if (existing.provider !== PROVIDER) {
    patch.provider = PROVIDER
    changes.push('Linked to Hostinger')
  }
  if (providerId && existing.provider_domain_id !== providerId) patch.provider_domain_id = providerId
  if (existing.provider_status !== domain.status) {
    patch.provider_status = domain.status
    if (existing.provider === PROVIDER) changes.push(`Hostinger status: ${domain.status}`)
  }
  if (domain.registeredDate && existing.registered_date !== domain.registeredDate) {
    patch.registered_date = domain.registeredDate
    changes.push(existing.registered_date ? 'Registration date updated' : 'Registration date added')
  }

  if (Object.keys(patch).length === 0) {
    return { kind: 'unchanged', changes: [], notes, existingId: existing.id }
  }
  patch.last_synced_at = syncedAt
  return { kind: 'update', changes, notes, patch, existingId: existing.id }
}
