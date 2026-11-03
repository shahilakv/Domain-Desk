export type PaymentStatus = 'paid' | 'pending'

/** Lifecycle stored in domains.status. Keep in sync with the SQL migration. */
export type DomainLifecycle = 'active' | 'transferred' | 'cancelled'

/** Whose registrar account holds the domain. Stored in domains.ownership_type. */
export type OwnershipType = 'agency' | 'client'

export interface Domain {
  id: string
  name: string
  clientId: string | null
  /** Client display name, or an empty string when unassigned. */
  client: string
  registrar: string
  /** ISO date string (YYYY-MM-DD), or null when not recorded. */
  expiryDate: string | null
  /** Derived: pending while any renewal for this domain is invoiced but unpaid. */
  paymentStatus: PaymentStatus
  lifecycle: DomainLifecycle
  autoRenew: boolean
  notes: string
  ownershipType: OwnershipType
  /** Set when the row is linked to a registrar import, e.g. 'hostinger'. */
  provider: string | null
  hostingPlanId: string | null
}

/** Status shown in the UI, derived from expiry date and payment status. */
export type DomainStatus = 'active' | 'renewal-due' | 'payment-pending' | 'expired'

export interface Client {
  id: string
  name: string
  contactName: string
  email: string
  phone: string
  notes: string
  domainCount: number
  hostingCount: number
}

/** Stored in domain_renewals.status. Keep in sync with the SQL migration. */
export type RenewalStatus = 'scheduled' | 'invoiced' | 'paid' | 'cancelled'

/** What a renewal record is for. */
export type RenewalKind = 'domain' | 'hosting'

export interface Renewal {
  id: string
  kind: RenewalKind
  /** Set for domain renewals only. */
  domainId: string | null
  /** Set for hosting renewals only. */
  hostingPlanId: string | null
  /** Domain name, or the hosting plan name. */
  targetName: string
  /** Hosting provider for hosting renewals; empty for domain renewals. */
  provider: string
  clientName: string
  /** ISO date string (YYYY-MM-DD), or null when not recorded. */
  renewalDate: string | null
  /** What the registrar or hosting provider charges. Kept separate from the client charge. */
  registrarCost: number | null
  /** What the client is billed. */
  clientCharge: number | null
  currency: string
  status: RenewalStatus
  notes: string
}

/** Stored in hosting_plans.status. Keep in sync with the SQL migration. */
export type HostingStatus = 'active' | 'suspended' | 'cancelled'

export interface HostingPlan {
  id: string
  provider: string
  planName: string
  clientId: string | null
  /** Client display name, or an empty string when unassigned. */
  client: string
  /** ISO date strings (YYYY-MM-DD), or null when not recorded. */
  startDate: string | null
  renewalDate: string | null
  /** What the provider charges. Kept separate from the client charge. */
  hostingCost: number | null
  /** What the client is billed. */
  clientCharge: number | null
  currency: string
  autoRenew: boolean
  status: HostingStatus
  notes: string
  /** Names of the domains linked through domains.hosting_plan_id. */
  domainNames: string[]
  /** Set when the plan is imported from (linked to) a Hostinger hosting order. */
  hostingerOrderId: string | null
  /** When the Hostinger import last updated the plan. */
  lastSyncedAt: string | null
}
