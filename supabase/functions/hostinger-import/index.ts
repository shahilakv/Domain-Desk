// Supabase Edge Function: read-only import of the Hostinger domain portfolio.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   HOSTINGER_API_TOKEN         Hostinger API token. Never sent to the browser.
//   HOSTINGER_ALLOWED_USER_IDS  Comma-separated Supabase user ids that may use it (others get 403).
// Provided automatically by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY.
//
// All database access runs as the calling user (their JWT is forwarded), so the
// existing RLS policies apply. No service-role key is used.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { handleRequest, type DbError, type DomainStore } from '../_shared/handler.ts'
import { normalizeToken } from '../_shared/hostinger.ts'
import type { ExistingDomain } from '../_shared/importPlan.ts'

const BASE_COLUMNS = 'id, domain_name, client_id, registrar, expiry_date'
const SYNC_COLUMNS = `${BASE_COLUMNS}, ownership_type, provider, provider_domain_id, provider_status, registered_date`

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
  })
})
