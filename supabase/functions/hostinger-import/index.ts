// Supabase Edge Function: read-only import of the Hostinger domain portfolio
// and hosting plans (hosting orders, their websites and billing subscriptions).
// Only GET requests are sent to Hostinger.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   HOSTINGER_API_TOKEN         Hostinger API token. Never sent to the browser.
//   HOSTINGER_ALLOWED_USER_IDS  Comma-separated Supabase user ids that may use it (others get 403).
// Provided automatically by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY.
//
// All database access runs as the calling user (their JWT is forwarded), so the
// existing RLS policies apply. No service-role key is used.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { handleRequest, type DbError, type DomainStore, type HostingStore } from '../_shared/handler.ts'
import { normalizeToken } from '../_shared/hostinger.ts'
import type { DomainLink, ExistingHostingPlan } from '../_shared/hostingPlan.ts'
import type { ExistingDomain } from '../_shared/importPlan.ts'

const BASE_COLUMNS = 'id, domain_name, client_id, registrar, expiry_date'
const SYNC_COLUMNS = `${BASE_COLUMNS}, ownership_type, provider, provider_domain_id, provider_status, registered_date`
const PLAN_BASE_COLUMNS =
  'id, provider, plan_name, start_date, renewal_date, hosting_cost, client_charge, currency, auto_renew, status'
const PLAN_SYNC_COLUMNS = `${PLAN_BASE_COLUMNS}, hostinger_order_id, hostinger_subscription_id, provider_status`

/** Column or table from a migration that hasn't been applied yet. */
const isSchemaGap = (error: unknown) => ['42703', 'PGRST204', 'PGRST205', '42P01'].includes((error as DbError)?.code ?? '')

function bearerToken(authorization: string | null): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '')
  return match ? match[1].trim() : null
}

function userClient(authorization: string): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!url || !anonKey) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY are not available to the function.')
  return createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function storeFor(client: SupabaseClient): DomainStore {
  return {
    async listDomains(userId) {
      const full = await client.from('domains').select(SYNC_COLUMNS).eq('user_id', userId)
      if (!full.error) return { rows: full.data as ExistingDomain[], schemaReady: true }
      const code = (full.error as DbError).code
      if (code !== '42703' && code !== 'PGRST204') throw full.error
      // Migration not applied yet: preview still works, import is blocked.
      const basic = await client.from('domains').select(BASE_COLUMNS).eq('user_id', userId)
      if (basic.error) throw basic.error
      return { rows: basic.data as ExistingDomain[], schemaReady: false }
    },
    async insertDomain(userId, values) {
      const { error } = await client.from('domains').insert({ ...values, user_id: userId })
      if (error) throw error
    },
    async updateDomain(userId, id, values) {
      const { data, error } = await client
        .from('domains')
        .update(values)
        .eq('id', id)
        .eq('user_id', userId)
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) throw new Error('Record not found. It may have been deleted.')
    },
  }
}

function hostingStoreFor(client: SupabaseClient): HostingStore {
  return {
    async listHostingPlans(userId) {
      const full = await client.from('hosting_plans').select(PLAN_SYNC_COLUMNS).eq('user_id', userId)
      if (!full.error) return { rows: full.data as ExistingHostingPlan[], schemaReady: true }
      if (!isSchemaGap(full.error)) throw full.error
      // Hostinger columns not there yet: preview still works (nothing matches), import is blocked.
      const basic = await client.from('hosting_plans').select(PLAN_BASE_COLUMNS).eq('user_id', userId)
      if (basic.error && !isSchemaGap(basic.error)) throw basic.error
      const rows = ((basic.data ?? []) as Omit<ExistingHostingPlan, 'hostinger_order_id' | 'hostinger_subscription_id' | 'provider_status'>[])
        .map((p) => ({ ...p, hostinger_order_id: null, hostinger_subscription_id: null, provider_status: null }))
      return { rows, schemaReady: false }
    },
    async listDomainLinks(userId) {
      const { data, error } = await client.from('domains').select('id, domain_name, hosting_plan_id').eq('user_id', userId)
      if (error) throw error
      return data as DomainLink[]
    },
    async syncHostingPlan(args) {
      const { data, error } = await client.rpc('dd_sync_hostinger_plan', {
        p_order_id: args.orderId,
        p_subscription_id: args.subscriptionId,
        p_link_plan_id: args.linkPlanId,
        p_plan_name: args.planName,
        p_start_date: args.startDate,
        p_renewal_date: args.renewalDate,
        p_hosting_cost: args.hostingCost,
        p_currency: args.currency,
        p_auto_renew: args.autoRenew,
        p_status: args.status,
        p_provider_status: args.providerStatus,
        p_domain_ids: args.domainIds,
      })
      if (error) throw error
      const result = data as { plan_id: string; outcome: string; linked: number }
      return { planId: result.plan_id, outcome: result.outcome, linked: result.linked }
    },
  }
}

Deno.serve((req) => {
  let client: SupabaseClient | null = null
  const { token, shape } = normalizeToken(Deno.env.get('HOSTINGER_API_TOKEN'))
  return handleRequest(req, {
    hostingerToken: token,
    tokenShape: shape,
    logError: (event) => console.error(JSON.stringify(event)),
    allowedUserIds: (Deno.env.get('HOSTINGER_ALLOWED_USER_IDS') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    fetch: (input, init) => fetch(input, init),
    async authenticate(authorization) {
      const jwt = bearerToken(authorization)
      if (!jwt || !authorization) return null
      client = userClient(authorization)
      const { data, error } = await client.auth.getUser(jwt)
      if (error || !data.user) return null
      return { userId: data.user.id }
    },
    store: {
      // authenticate() always runs first and sets the client.
      listDomains: (userId) => storeFor(client!).listDomains(userId),
      insertDomain: (userId, values) => storeFor(client!).insertDomain(userId, values),
      updateDomain: (userId, id, values) => storeFor(client!).updateDomain(userId, id, values),
    },
    hosting: {
      listHostingPlans: (userId) => hostingStoreFor(client!).listHostingPlans(userId),
      listDomainLinks: (userId) => hostingStoreFor(client!).listDomainLinks(userId),
      syncHostingPlan: (args) => hostingStoreFor(client!).syncHostingPlan(args),
    },
  })
})
