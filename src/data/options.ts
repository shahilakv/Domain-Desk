import type { DomainLifecycle, HostingStatus, OwnershipType, RenewalStatus } from '../types/domain'

/*
 * Allowed values for the free-text status columns. The SQL migration in
 * supabase/migrations enforces the same lists with CHECK constraints.
 */

export const domainLifecycles: { value: DomainLifecycle; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'transferred', label: 'Transferred out' },
  { value: 'cancelled', label: 'Cancelled' },
]

export const ownershipTypes: { value: OwnershipType; label: string }[] = [
  { value: 'agency', label: 'Agency account' },
  { value: 'client', label: "Client's account" },
]

/** Matches the column default in the live database (domains.ownership_type default 'client'). */
export const DEFAULT_OWNERSHIP: OwnershipType = 'client'

export const renewalStatuses: { value: RenewalStatus; label: string }[] = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'invoiced', label: 'Invoiced · awaiting payment' },
  { value: 'paid', label: 'Paid' },
  { value: 'cancelled', label: 'Cancelled' },
]

export const renewalStatusLabels: Record<RenewalStatus, string> = {
  scheduled: 'Scheduled',
  invoiced: 'Invoiced',
  paid: 'Paid',
  cancelled: 'Cancelled',
}

export const lifecycleLabels: Record<DomainLifecycle, string> = {
  active: 'Active',
  transferred: 'Transferred out',
  cancelled: 'Cancelled',
}

export const hostingStatuses: { value: HostingStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'cancelled', label: 'Cancelled' },
]

export const hostingStatusLabels: Record<HostingStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  cancelled: 'Cancelled',
}

export const DEFAULT_CURRENCY = 'AUD'

/** Currencies offered in money forms. Only the 3-letter code is stored. */
export const currencies: { value: string; label: string }[] = [
  { value: 'INR', label: 'INR (₹)' },
  { value: 'USD', label: 'USD ($)' },
  { value: 'AED', label: 'AED' },
  { value: 'AUD', label: 'AUD (A$)' },
  { value: 'CAD', label: 'CAD (C$)' },
  { value: 'GBP', label: 'GBP (£)' },
  { value: 'EUR', label: 'EUR (€)' },
  { value: 'SAR', label: 'SAR' },
  { value: 'OMR', label: 'OMR' },
  { value: 'MYR', label: 'MYR' },
  { value: 'SGD', label: 'SGD (S$)' },
  { value: 'KWD', label: 'KWD' },
  { value: 'QAR', label: 'QAR' },
  { value: 'BHD', label: 'BHD' },
  { value: 'LKR', label: 'LKR' },
  { value: 'PKR', label: 'PKR' },
  { value: 'JPY', label: 'JPY (¥)' },
  { value: 'CNY', label: 'CNY' },
  { value: 'NZD', label: 'NZD (NZ$)' },
  { value: 'CHF', label: 'CHF' },
]
