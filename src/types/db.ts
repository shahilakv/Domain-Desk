/*
 * Row shapes of the Supabase tables, matching the live schema
 * (see supabase/checks/inspect_schema.sql to re-verify).
 */

export interface ClientRow {
  id: string
  user_id: string
  name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  notes: string | null
  created_at: string
  updated_at: string | null
}

export interface DomainRow {
  id: string
  user_id: string
  client_id: string | null
  domain_name: string
  registrar: string | null
  /** date (YYYY-MM-DD) */
  expiry_date: string | null
  status: string | null
  auto_renew: boolean | null
  notes: string | null
  /** 'agency' | 'client'; NOT NULL, defaults to 'client'. */
  ownership_type: string
  /* The columns below come from the 20261102 migration and are absent before it. */
  /** 'hostinger' when the row is linked to a registrar import. */
  provider?: string | null
  provider_domain_id?: string | null
  provider_status?: string | null
  /** date (YYYY-MM-DD) */
  registered_date?: string | null
  last_synced_at?: string | null
  /** From the 20261103 migration; absent before it. */
  hosting_plan_id?: string | null
  created_at: string
  updated_at: string | null
}

export interface RenewalRow {
  id: string
  user_id: string
  /** Exactly one of domain_id and hosting_plan_id is set. */
  domain_id: string | null
  /** From the 20261104 migration; absent before it. */
  hosting_plan_id?: string | null
  /** date (YYYY-MM-DD) */
  renewal_date: string | null
  /** numeric: what the registrar charges us */
  registrar_cost: number | string | null
  /** numeric: what we bill the client */
  client_charge: number | string | null
  currency: string | null
  status: string | null
  notes: string | null
  created_at: string
}

export interface HostingPlanRow {
  id: string
  client_id: string | null
  provider: string
  plan_name: string
  /** date (YYYY-MM-DD) */
  start_date: string | null
  /** date (YYYY-MM-DD) */
  renewal_date: string | null
  /** numeric: what the provider charges us */
  hosting_cost: number | string | null
  /** numeric: what we bill the client */
  client_charge: number | string | null
  currency: string | null
  auto_renew: boolean
  status: string
  notes: string | null
}

/** Columns the app writes. user_id is always set from the signed-in session. */
export type ClientInput = Pick<ClientRow, 'name' | 'contact_name' | 'email' | 'phone' | 'notes'>
export type DomainInput = Pick<
  DomainRow,
  'client_id' | 'domain_name' | 'registrar' | 'expiry_date' | 'status' | 'auto_renew' | 'notes' | 'ownership_type'
>
type RenewalFields = Pick<RenewalRow, 'renewal_date' | 'registrar_cost' | 'client_charge' | 'currency' | 'status' | 'notes'>
/** A renewal targets a domain or a hosting plan, never both. */
export type RenewalInput =
  | (RenewalFields & { domain_id: string; hosting_plan_id?: never })
  | (RenewalFields & { hosting_plan_id: string; domain_id?: never })
export type HostingPlanInput = Omit<HostingPlanRow, 'id'>
