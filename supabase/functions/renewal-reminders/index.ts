// Supabase Edge Function: email + WhatsApp renewal reminders.
// Deploy with --no-verify-jwt: pg_cron calls it with x-reminders-secret
// (checked against Supabase Vault), and users call it with their own JWT,
// which the handler verifies itself.
//
// Secrets (Supabase → Edge Functions → Secrets); a channel stays off until its secrets exist:
//   RESEND_API_KEY              Resend API key (email)
//   WHATSAPP_ACCESS_TOKEN       WhatsApp Cloud API system-user token
//   WHATSAPP_PHONE_NUMBER_ID    WhatsApp Business phone number id
//   WHATSAPP_API_VERSION        optional Graph API version, default v23.0
// Provided automatically by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
//
// The service role is used only by the scheduled run, which must see every
// user's due renewals; every row it writes carries the renewal owner's user_id.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { handleRemindersRequest, type LogRow, type ReminderStore } from '../_shared/reminders.ts'
import type { ReminderCandidate, ReminderSettings } from '../_shared/reminderRules.ts'

const env = (name: string) => {
  const value = Deno.env.get(name)?.trim()
  return value ? value : null
}

function serviceClient(): SupabaseClient {
  const url = env('SUPABASE_URL')
  const key = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not available to the function.')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

function userClient(authorization: string): SupabaseClient {
  const url = env('SUPABASE_URL')
  const anonKey = env('SUPABASE_ANON_KEY')
  if (!url || !anonKey) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY are not available to the function.')
  return createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

const SETTINGS_COLUMNS =
  'user_id, email_enabled, whatsapp_enabled, reminder_days, send_hour, timezone, sender_name, sender_email, reply_to_email, agency_name, agency_email, agency_phone, agency_website, payment_instructions, whatsapp_template_name, whatsapp_template_language'
const LOG_COLUMNS =
  'id, user_id, renewal_id, channel, stage, due_date, status, retryable, attempts, last_attempt_at, next_attempt_at, retry_requested_at'

function storeFor(db: SupabaseClient): ReminderStore {
  return {
    async checkCronSecret(secret) {
      const { data, error } = await db.rpc('dd_check_reminders_secret', { p_secret: secret })
      if (error) throw error
      return data === true
    },
    async listSettings() {
      const { data, error } = await db.from('notification_settings').select(SETTINGS_COLUMNS).or('email_enabled.eq.true,whatsapp_enabled.eq.true')
      if (error) throw error
      return data as ReminderSettings[]
    },
    async listCandidates() {
      const { data, error } = await db.rpc('dd_reminder_candidates')
      if (error) throw error
      return data as ReminderCandidate[]
    },
    async listRetries(nowIso) {
      // Automatic back-off retries, plus failed rows a user asked to retry since the last attempt.
      const [auto, manual] = await Promise.all([
        db.from('notification_log').select(LOG_COLUMNS).eq('status', 'failed').eq('retryable', true).lte('next_attempt_at', nowIso).limit(500),
        db.from('notification_log').select(LOG_COLUMNS).eq('status', 'failed').not('retry_requested_at', 'is', null).limit(500),
      ])
      if (auto.error) throw auto.error
      if (manual.error) throw manual.error
      const rows = new Map<string, LogRow>()
      for (const r of auto.data as LogRow[]) rows.set(r.id, r)
      for (const r of manual.data as LogRow[]) {
        if (!r.last_attempt_at || r.retry_requested_at! > r.last_attempt_at) rows.set(r.id, r)
      }
      return [...rows.values()]
    },
    async failStale(cutoffIso) {
      const { data, error } = await db
        .from('notification_log')
        .update({ status: 'failed', retryable: false, error: 'Interrupted while sending; not resent automatically to avoid a duplicate. Use Retry if it never arrived.' })
        .eq('status', 'pending')
        .lt('last_attempt_at', cutoffIso)
        .select('id')
      if (error) throw error
      return data?.length ?? 0
    },
    async claim(row, nowIso) {
      const { data, error } = await db
        .from('notification_log')
        .upsert(
          { ...row, status: 'pending', attempts: 1, last_attempt_at: nowIso },
          { onConflict: 'renewal_id,channel,stage,due_date', ignoreDuplicates: true },
        )
        .select('id')
      if (error) throw error
      return data && data.length > 0 ? (data[0] as { id: string }).id : null
    },
    async claimRetry(row, recipient, nowIso) {
      const { data, error } = await db
        .from('notification_log')
        .update({ status: 'pending', attempts: row.attempts + 1, last_attempt_at: nowIso, recipient, next_attempt_at: null })
        .eq('id', row.id)
        .eq('status', 'failed')
        .eq('attempts', row.attempts)
        .select('id')
      if (error) throw error
      return Boolean(data && data.length > 0)
    },
    async finish(id, update) {
      const { error } = await db.from('notification_log').update(update).eq('id', id)
      if (error) throw error
    },
  }
}

Deno.serve((req) => {
  const resendKey = env('RESEND_API_KEY')
  const waToken = env('WHATSAPP_ACCESS_TOKEN')
  const waPhone = env('WHATSAPP_PHONE_NUMBER_ID')
  let db: SupabaseClient | null = null
  const service = () => (db ??= serviceClient())

  return handleRemindersRequest(req, {
    fetch: (input, init) => fetch(input, init),
    email: resendKey ? { apiKey: resendKey } : null,
    whatsapp: waToken && waPhone ? { accessToken: waToken, phoneNumberId: waPhone, apiVersion: env('WHATSAPP_API_VERSION') ?? 'v23.0' } : null,
    missing: {
      email: resendKey ? [] : ['RESEND_API_KEY'],
      whatsapp: [...(waToken ? [] : ['WHATSAPP_ACCESS_TOKEN']), ...(waPhone ? [] : ['WHATSAPP_PHONE_NUMBER_ID'])],
    },
    logError: (event) => console.error(JSON.stringify(event)),
    async authenticate(authorization) {
      const jwt = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1]?.trim()
      if (!jwt || !authorization) return null
      const { data, error } = await userClient(authorization).auth.getUser(jwt)
      if (error || !data.user) return null
      return { userId: data.user.id, email: data.user.email ?? null }
    },
    async userSettings(userId) {
      // Read as the user (RLS), not with the service role.
      const authorization = req.headers.get('Authorization')!
      const { data, error } = await userClient(authorization)
        .from('notification_settings')
        .select(SETTINGS_COLUMNS)
        .eq('user_id', userId)
        .maybeSingle()
      if (error) throw error
      return data as ReminderSettings | null
    },
    async scheduleStatus() {
      const authorization = req.headers.get('Authorization')!
      const { data, error } = await userClient(authorization).rpc('dd_reminder_schedule_status')
      if (error) return null
      const row = (data as { scheduled: boolean; schedule: string | null; last_run_at: string | null; last_run_status: string | null }[])[0]
      return row ? { scheduled: row.scheduled, schedule: row.schedule, lastRunAt: row.last_run_at, lastRunStatus: row.last_run_status } : null
    },
    store: {
      checkCronSecret: (s) => storeFor(service()).checkCronSecret(s),
      listSettings: () => storeFor(service()).listSettings(),
      listCandidates: () => storeFor(service()).listCandidates(),
      listRetries: (n) => storeFor(service()).listRetries(n),
      failStale: (c) => storeFor(service()).failStale(c),
      claim: (r, n) => storeFor(service()).claim(r, n),
      claimRetry: (r, to, n) => storeFor(service()).claimRetry(r, to, n),
      finish: (id, u) => storeFor(service()).finish(id, u),
    },
  })
})
