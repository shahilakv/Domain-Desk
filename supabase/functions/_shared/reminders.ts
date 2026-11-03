import { sendEmail, sendWhatsApp, type EmailConfig, type FetchLike, type SendResult, type WhatsAppConfig } from './reminderProviders.ts'
import {
  buildReminderEmail,
  buildWhatsAppParams,
  daysBetween,
  dueStage,
  eligibility,
  isValidEmail,
  localClock,
  normalizeStages,
  normalizeWhatsApp,
  type Channel,
  type IneligibleReason,
  type ReminderCandidate,
  type ReminderSettings,
} from './reminderRules.ts'

/*
 * Request handling for the renewal-reminders Edge Function, with every
 * external dependency injected (see ../renewal-reminders/index.ts for the
 * real wiring and ../tests for the mocked one).
 *
 * POST { action: "run" }     header x-reminders-secret (pg_cron only)
 *   → sends every due reminder for every user, retries failed ones on a
 *     back-off, records each attempt in notification_log.
 * POST { action: "status" }  signed-in user
 *   → which provider secrets are configured (yes/no only) and scheduler health.
 * POST { action: "test", channel, to? }  signed-in user
 *   → sends one sample reminder to the user's own email, or to a WhatsApp
 *     number they enter. Not logged, never sent to clients.
 */

export const MAX_AUTO_ATTEMPTS = 3
export const MAX_MANUAL_ATTEMPTS = 5
/** Hours to wait before automatic retry n (after attempt n failed). */
export const RETRY_BACKOFF_HOURS = [1, 4, 12]
export const MAX_SENDS_PER_RUN = 300
/** A send still 'pending' after this long was interrupted; it is failed, not resent. */
export const STALE_PENDING_MINUTES = 30

export interface LogRow {
  id: string
  user_id: string
  renewal_id: string | null
  channel: Channel
  stage: number
  due_date: string
  status: string
  retryable: boolean
  attempts: number
  last_attempt_at: string | null
  next_attempt_at: string | null
  retry_requested_at: string | null
}

export interface LogInsert {
  user_id: string
  renewal_id: string
  channel: Channel
  stage: number
  due_date: string
  target_kind: string
  target_name: string
  client_id: string | null
  client_name: string | null
  recipient: string
  amount: number | null
  currency: string | null
}

export interface LogUpdate {
  status: 'accepted' | 'failed'
  retryable: boolean
  provider_message_id?: string | null
  error?: string | null
  sent_at?: string | null
  next_attempt_at?: string | null
}

/** Service-role database access used by the scheduler. */
export interface ReminderStore {
  checkCronSecret(secret: string): Promise<boolean>
  listSettings(): Promise<ReminderSettings[]>
  listCandidates(): Promise<ReminderCandidate[]>
  /** Failed rows that may be retried now (automatic back-off or a user request). */
  listRetries(nowIso: string): Promise<LogRow[]>
  /** Marks 'pending' rows older than the cutoff as failed (not resent). Returns how many. */
  failStale(cutoffIso: string): Promise<number>
  /** Inserts the row unless (renewal, channel, stage, due date) exists. Returns the id, or null for a duplicate. */
  claim(row: LogInsert, nowIso: string): Promise<string | null>
  /** Moves a failed row back to 'pending' if it is still in the expected state. */
  claimRetry(row: LogRow, recipient: string, nowIso: string): Promise<boolean>
  finish(id: string, update: LogUpdate): Promise<void>
}

export interface ReminderDeps {
  fetch: FetchLike
  email: EmailConfig | null
  whatsapp: WhatsAppConfig | null
  /** Names of missing secrets per channel, for the status action. */
  missing: { email: string[]; whatsapp: string[] }
  /** Verifies a user's access token. */
  authenticate(authorization: string | null): Promise<{ userId: string; email: string | null } | null>
  /** Loaded with the user's JWT, so RLS applies. */
  userSettings(userId: string): Promise<ReminderSettings | null>
  scheduleStatus(): Promise<{ scheduled: boolean; schedule: string | null; lastRunAt: string | null; lastRunStatus: string | null } | null>
  store: ReminderStore
  logError?: (event: Record<string, unknown>) => void
  now?: () => Date
}

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })
}

const fail = (status: number, code: string, message: string) => json(status, { error: { code, message } })

export interface RunSummary {
  users: number
  candidates: number
  accepted: number
  failed: number
  retried: number
  duplicates: number
  stale: number
  skipped: Partial<Record<IneligibleReason | 'provider_missing' | 'before_send_hour' | 'not_due' | 'run_limit', number>>
}

function fromAddress(settings: ReminderSettings): string {
  const name = (settings.sender_name || settings.agency_name || '').replace(/["<>\r\n]/g, '').trim()
  return name ? `${name} <${settings.sender_email}>` : settings.sender_email!
}

async function deliver(
  deps: ReminderDeps,
  channel: Channel,
  candidate: ReminderCandidate,
  settings: ReminderSettings,
  stage: number,
  recipient: string,
  idempotencyKey: string,
): Promise<SendResult> {
  if (channel === 'email') {
    if (!deps.email) return { ok: false, retryable: false, error: 'Email provider is not configured (RESEND_API_KEY).' }
    const message = buildReminderEmail(candidate, settings, stage)
    return sendEmail(deps.fetch, deps.email, { ...message, from: fromAddress(settings), to: recipient, replyTo: settings.reply_to_email ?? settings.agency_email }, idempotencyKey)
  }
  if (!deps.whatsapp) return { ok: false, retryable: false, error: 'WhatsApp provider is not configured.' }
  return sendWhatsApp(deps.fetch, deps.whatsapp, {
    to: recipient,
    templateName: settings.whatsapp_template_name!,
    language: settings.whatsapp_template_language,
    params: buildWhatsAppParams(candidate, settings, stage),
  })
}

function resultUpdate(result: SendResult, attempts: number, now: Date): LogUpdate {
  if (result.ok) {
    return { status: 'accepted', retryable: false, provider_message_id: result.providerMessageId, error: null, sent_at: now.toISOString(), next_attempt_at: null }
  }
  const canRetry = result.retryable && attempts < MAX_AUTO_ATTEMPTS
  const hours = RETRY_BACKOFF_HOURS[Math.min(attempts, RETRY_BACKOFF_HOURS.length) - 1] ?? 12
  return {
    status: 'failed',
    retryable: canRetry,
    error: result.error,
    next_attempt_at: canRetry ? new Date(now.getTime() + hours * 3_600_000).toISOString() : null,
  }
}

const providerReady = (deps: ReminderDeps, channel: Channel) => (channel === 'email' ? deps.email !== null : deps.whatsapp !== null)

export async function runReminders(deps: ReminderDeps): Promise<RunSummary> {
  const now = deps.now?.() ?? new Date()
  const nowIso = now.toISOString()
  const summary: RunSummary = { users: 0, candidates: 0, accepted: 0, failed: 0, retried: 0, duplicates: 0, stale: 0, skipped: {} }
  const skip = (reason: keyof RunSummary['skipped']) => (summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1)

  summary.stale = await deps.store.failStale(new Date(now.getTime() - STALE_PENDING_MINUTES * 60_000).toISOString())

  const [settingsRows, candidates] = await Promise.all([deps.store.listSettings(), deps.store.listCandidates()])
  const settingsByUser = new Map(settingsRows.map((s) => [s.user_id, s]))
  const byRenewal = new Map(candidates.map((c) => [c.renewal_id, c]))
  summary.users = settingsByUser.size
  summary.candidates = candidates.length
  let sends = 0

  const record = async (id: string, result: SendResult, attempts: number) => {
    await deps.store.finish(id, resultUpdate(result, attempts, deps.now?.() ?? new Date()))
    if (result.ok) summary.accepted++
    else {
      summary.failed++
      deps.logError?.({ event: 'reminder_failed', logId: id, retryable: result.retryable, error: result.error })
    }
  }

  // 1. Retries: only while the renewal is still due on the same date and the
  //    client can still be reached on that channel.
  for (const row of await deps.store.listRetries(nowIso)) {
    if (sends >= MAX_SENDS_PER_RUN) break
    const candidate = row.renewal_id ? byRenewal.get(row.renewal_id) : undefined
    const settings = settingsByUser.get(row.user_id)
    const allowed = row.retry_requested_at ? MAX_MANUAL_ATTEMPTS : MAX_AUTO_ATTEMPTS
    if (!candidate || !settings || candidate.renewal_date !== row.due_date || row.attempts >= allowed) {
      await deps.store.finish(row.id, {
        status: 'failed',
        retryable: false,
        error: row.attempts >= allowed ? 'Not retried: attempt limit reached.' : 'Not retried: the renewal is no longer due on this date (paid, cancelled or changed).',
        next_attempt_at: null,
      })
      continue
    }
    const check = eligibility(candidate, settings, row.channel)
    if (!check.ok || !providerReady(deps, row.channel)) {
      await deps.store.finish(row.id, {
        status: 'failed',
        retryable: false,
        error: `Not retried: ${check.ok ? 'provider not configured' : check.reason.replace(/_/g, ' ')}.`,
        next_attempt_at: null,
      })
      continue
    }
    const attempt = row.attempts + 1
    if (!(await deps.store.claimRetry(row, check.recipient, nowIso))) continue
    sends++
    summary.retried++
    const result = await deliver(deps, row.channel, candidate, settings, row.stage, check.recipient, `${row.id}-${attempt}`)
    await record(row.id, result, attempt)
  }

  // 2. New reminders.
  for (const candidate of candidates) {
    const settings = settingsByUser.get(candidate.user_id)
    if (!settings) continue
    const clock = localClock(now, settings.timezone)
    if (clock.hour < settings.send_hour) {
      skip('before_send_hour')
      continue
    }
    const stage = dueStage(daysBetween(clock.date, candidate.renewal_date), normalizeStages(settings.reminder_days))
    if (stage === null) {
      skip('not_due')
      continue
    }
    for (const channel of ['email', 'whatsapp'] as const) {
      const check = eligibility(candidate, settings, channel)
      if (!check.ok) {
        if (check.reason !== 'channel_off') skip(check.reason)
        continue
      }
      if (!providerReady(deps, channel)) {
        skip('provider_missing')
        continue
      }
      if (sends >= MAX_SENDS_PER_RUN) {
        skip('run_limit')
        continue
      }
      const amount = candidate.amount === null || candidate.amount === '' ? null : Number(candidate.amount)
      const id = await deps.store.claim(
        {
          user_id: candidate.user_id,
          renewal_id: candidate.renewal_id,
          channel,
          stage,
          due_date: candidate.renewal_date,
          target_kind: candidate.target_kind,
          target_name: candidate.target_name,
          client_id: candidate.client_id,
          client_name: candidate.client_name,
          recipient: check.recipient,
          amount: Number.isFinite(amount) ? amount : null,
          currency: candidate.currency,
        },
        nowIso,
      )
      if (!id) {
        summary.duplicates++
        continue
      }
      sends++
      const result = await deliver(deps, channel, candidate, settings, stage, check.recipient, `${id}-1`)
      await record(id, result, 1)
    }
  }
  return summary
}

const SAMPLE: ReminderCandidate = {
  renewal_id: 'test',
  user_id: 'test',
  target_kind: 'domain',
  target_name: 'example.com',
  provider: null,
  renewal_date: '2030-01-01',
  renewal_status: 'scheduled',
  amount: 25,
  currency: 'USD',
  client_id: 'test',
  client_name: 'Sample Client',
  contact_name: 'Sample Client',
  email: null,
  email_reminders: true,
  whatsapp_number: null,
  whatsapp_opt_in: true,
}

async function sendTest(deps: ReminderDeps, user: { userId: string; email: string | null }, body: { channel?: unknown; to?: unknown }): Promise<Response> {
  const settings = await deps.userSettings(user.userId)
  if (!settings) return fail(400, 'no_settings', 'Save your reminder settings first.')
  const now = deps.now?.() ?? new Date()
  const sample = { ...SAMPLE, renewal_date: new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10) }
  if (body.channel === 'email') {
    if (!deps.email) return fail(409, 'provider_missing', `Email is not configured: missing ${deps.missing.email.join(', ')}.`)
    if (!isValidEmail(settings.sender_email)) return fail(400, 'sender_missing', 'Set a sender email first.')
    if (!isValidEmail(user.email)) return fail(400, 'no_recipient', 'Your account has no email address to send the test to.')
    const message = buildReminderEmail(sample, settings, 30)
    const result = await sendEmail(deps.fetch, deps.email, { ...message, subject: `[Test] ${message.subject}`, from: fromAddress(settings), to: user.email, replyTo: settings.reply_to_email }, `test-${user.userId}-${now.getTime()}`)
    return result.ok
      ? json(200, { ok: true, message: `Resend accepted a test email to ${user.email}. Check the inbox (and spam) to confirm delivery.` })
      : fail(502, 'provider_error', result.error)
  }
  if (body.channel === 'whatsapp') {
    if (!deps.whatsapp) return fail(409, 'provider_missing', `WhatsApp is not configured: missing ${deps.missing.whatsapp.join(', ')}.`)
    if (!settings.whatsapp_template_name) return fail(400, 'template_missing', 'Set the approved WhatsApp template name first.')
    const to = typeof body.to === 'string' ? normalizeWhatsApp(body.to) : null
    if (!to) return fail(400, 'invalid_number', 'Enter your own WhatsApp number in international format, e.g. +61400000000.')
    const result = await sendWhatsApp(deps.fetch, deps.whatsapp, {
      to,
      templateName: settings.whatsapp_template_name,
      language: settings.whatsapp_template_language,
      params: buildWhatsAppParams(sample, settings, 30),
    })
    return result.ok
      ? json(200, { ok: true, message: `WhatsApp accepted a test message to ${to}. Check the phone to confirm delivery.` })
      : fail(502, 'provider_error', result.error)
  }
  return fail(400, 'invalid_request', 'Choose the channel to test: "email" or "whatsapp".')
}

export async function handleRemindersRequest(req: Request, deps: ReminderDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.')

  let body: { action?: unknown; channel?: unknown; to?: unknown }
  try {
    body = await req.json()
  } catch {
    return fail(400, 'invalid_request', 'Request body must be JSON.')
  }

  try {
    if (body?.action === 'run') {
      const secret = req.headers.get('x-reminders-secret') ?? ''
      if (secret.length < 32 || !(await deps.store.checkCronSecret(secret))) return fail(401, 'unauthorized', 'Invalid scheduler secret.')
      return json(200, await runReminders(deps))
    }

    const user = await deps.authenticate(req.headers.get('Authorization'))
    if (!user) return fail(401, 'unauthorized', 'Your session has expired. Please sign in again.')

    if (body?.action === 'status') {
      return json(200, {
        email: { configured: deps.email !== null, missing: deps.missing.email },
        whatsapp: { configured: deps.whatsapp !== null, missing: deps.missing.whatsapp },
        scheduler: await deps.scheduleStatus(),
      })
    }
    if (body?.action === 'test') return await sendTest(deps, user, body)
    return fail(400, 'invalid_request', 'Unknown action. Use "status" or "test".')
  } catch (error) {
    deps.logError?.({ event: 'reminders_error', message: error instanceof Error ? error.message : String(error) })
    const message = (error as { message?: unknown })?.message
    return fail(500, 'internal_error', typeof message === 'string' ? message.slice(0, 200) : 'Something went wrong.')
  }
}
