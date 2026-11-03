// Run with: npm run test:functions  (Node's built-in test runner; no network access, no real messages)
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'
import { handleWebhook, type DeliveryStatus } from '../_shared/deliveryWebhooks.ts'
import type { FetchLike } from '../_shared/reminderProviders.ts'
import {
  buildReminderEmail,
  buildWhatsAppParams,
  daysBetween,
  dueStage,
  eligibility,
  localClock,
  nextStage,
  normalizeStages,
  normalizeWhatsApp,
  type ReminderCandidate,
  type ReminderSettings,
} from '../_shared/reminderRules.ts'
import {
  handleRemindersRequest,
  runReminders,
  type LogInsert,
  type LogRow,
  type LogUpdate,
  type ReminderDeps,
  type ReminderStore,
} from '../_shared/reminders.ts'

const A = 'user-a'
const B = 'user-b'
const SECRET = 'a'.repeat(64)
// 2026-11-05 10:30 in Asia/Kolkata (05:00 UTC).
const NOW = new Date('2026-11-05T05:00:00Z')

const settings = (over: Partial<ReminderSettings> = {}): ReminderSettings => ({
  user_id: A,
  email_enabled: true,
  whatsapp_enabled: true,
  reminder_days: [30, 15, 7, 3, 0],
  send_hour: 9,
  timezone: 'Asia/Kolkata',
  sender_name: 'Acme Web',
  sender_email: 'billing@acmeweb.example',
  reply_to_email: null,
  agency_name: 'Acme Web Studio',
  agency_email: 'hello@acmeweb.example',
  agency_phone: '+61 400 000 000',
  agency_website: 'acmeweb.example',
  payment_instructions: 'Pay by bank transfer to BSB 000-000, account 1234.',
  whatsapp_template_name: 'renewal_reminder',
  whatsapp_template_language: 'en',
  ...over,
})

const candidate = (over: Partial<ReminderCandidate> = {}): ReminderCandidate => ({
  renewal_id: 'r-domain',
  user_id: A,
  target_kind: 'domain',
  target_name: 'acme.com',
  provider: null,
  renewal_date: '2026-11-20', // 15 days after 2026-11-05
  renewal_status: 'invoiced',
  amount: '49.00',
  currency: 'AUD',
  client_id: 'c1',
  client_name: 'Acme Trading',
  contact_name: 'Priya',
  email: 'priya@acme.example',
  email_reminders: true,
  whatsapp_number: '+61400111222',
  whatsapp_opt_in: true,
  ...over,
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Mock Resend + WhatsApp. Records every call; never touches the network. */
function mockProviders(opts: { email?: () => Response; whatsapp?: () => Response } = {}) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
  let n = 0
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    n++
    if (input.startsWith('https://api.resend.com/')) return opts.email?.() ?? json(200, { id: `email-${n}` })
    if (input.startsWith('https://graph.facebook.com/')) return opts.whatsapp?.() ?? json(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.${n}` }] })
    return json(404, {})
  }
  return { fetch, calls }
}

type Row = LogRow & LogInsert & Partial<Omit<LogUpdate, 'status'>>

/** In-memory notification_log with the same unique key as the migration. */
function memoryStore(init: { settings?: ReminderSettings[]; candidates?: ReminderCandidate[]; rows?: Row[] } = {}) {
  const rows: Row[] = (init.rows ?? []).map((r) => ({ ...r }))
  let id = 0
  const store: ReminderStore = {
    checkCronSecret: async (s) => s === SECRET,
    listSettings: async () => (init.settings ?? [settings()]).filter((s) => s.email_enabled || s.whatsapp_enabled),
    listCandidates: async () => init.candidates ?? [candidate()],
    async listRetries(nowIso) {
      // Copies, like rows read from the database.
      return rows.map((r) => ({ ...r })).filter(
        (r) =>
          r.status === 'failed' &&
          ((r.retryable && r.next_attempt_at !== null && r.next_attempt_at! <= nowIso) ||
            (r.retry_requested_at !== null && (!r.last_attempt_at || r.retry_requested_at > r.last_attempt_at))),
      )
    },
    async failStale(cutoff) {
      let n = 0
      for (const r of rows) if (r.status === 'pending' && r.last_attempt_at! < cutoff) { r.status = 'failed'; r.retryable = false; n++ }
      return n
    },
    async claim(row, nowIso) {
      if (rows.some((r) => r.renewal_id === row.renewal_id && r.channel === row.channel && r.stage === row.stage && r.due_date === row.due_date)) return null
      const newId = `log-${++id}`
      rows.push({ ...row, id: newId, status: 'pending', retryable: false, attempts: 1, last_attempt_at: nowIso, next_attempt_at: null, retry_requested_at: null })
      return newId
    },
    async claimRetry(row, recipient, nowIso) {
      const r = rows.find((x) => x.id === row.id && x.status === 'failed' && x.attempts === row.attempts)
      if (!r) return false
      Object.assign(r, { status: 'pending', attempts: r.attempts + 1, last_attempt_at: nowIso, recipient, next_attempt_at: null })
      return true
    },
    async finish(rowId, update) {
      Object.assign(rows.find((r) => r.id === rowId)!, update)
    },
  }
  return { store, rows }
}

function deps(store: ReminderStore, fetch: FetchLike, over: Partial<ReminderDeps> = {}): ReminderDeps {
  return {
    fetch,
    email: { apiKey: 're_test_key' },
    whatsapp: { accessToken: 'wa_test_token', phoneNumberId: '1234567890', apiVersion: 'v23.0' },
    missing: { email: [], whatsapp: [] },
    authenticate: async (h) => (h === 'Bearer user-a-jwt' ? { userId: A, email: 'owner@acmeweb.example' } : null),
    userSettings: async (uid) => (uid === A ? settings() : null),
    scheduleStatus: async () => ({ scheduled: true, schedule: '15 * * * *', lastRunAt: null, lastRunStatus: null }),
    store,
    now: () => NOW,
    ...over,
  }
}

describe('reminder rules', () => {
  it('fires each stage on its day, a missed stage up to 2 days late, never out of order', () => {
    const stages = [30, 15, 7, 3, 0, -3]
    assert.equal(dueStage(15, stages), 15)
    assert.equal(dueStage(14, stages), 15, '1 day late (missed run)')
    assert.equal(dueStage(12, stages), null, 'too late for 15, not yet 7')
    assert.equal(dueStage(0, stages), 0)
    assert.equal(dueStage(-3, stages), -3, 'overdue stage')
    assert.equal(dueStage(5, [30]), null, 'renewal added late: no stale 30-day reminder')
    assert.equal(nextStage(20, stages), 15)
    assert.equal(nextStage(-10, stages), null)
  })

  it('uses the user time zone for "today" and the send hour', () => {
    assert.deepEqual(localClock(NOW, 'Asia/Kolkata'), { date: '2026-11-05', hour: 10 })
    assert.deepEqual(localClock(NOW, 'America/Los_Angeles'), { date: '2026-11-04', hour: 21 }, 'PST after DST ends')
    assert.deepEqual(localClock(NOW, 'Not/AZone'), { date: '2026-11-05', hour: 5 }, 'invalid zone falls back to UTC')
    assert.equal(daysBetween('2026-11-05', '2026-11-20'), 15)
  })

  it('cleans configured stages', () => {
    assert.deepEqual(normalizeStages([7, 30, 7, 400, -90, 1.5, 0]), [30, 7, 0])
  })

  it('validates WhatsApp numbers as international (E.164)', () => {
    assert.equal(normalizeWhatsApp('+61 400-111 222'), '+61400111222')
    assert.equal(normalizeWhatsApp('0400 111 222'), null, 'no country code')
    assert.equal(normalizeWhatsApp('+0123'), null)
  })

  it('checks consent, opt-out, contact details and sender per channel', () => {
    const s = settings()
    assert.deepEqual(eligibility(candidate(), s, 'email'), { ok: true, recipient: 'priya@acme.example' })
    assert.deepEqual(eligibility(candidate({ email_reminders: false }), s, 'email'), { ok: false, reason: 'opted_out' })
    assert.deepEqual(eligibility(candidate({ email: 'not-an-email' }), s, 'email'), { ok: false, reason: 'no_email' })
    assert.deepEqual(eligibility(candidate({ email: null }), s, 'email'), { ok: false, reason: 'no_email' })
    assert.deepEqual(eligibility(candidate({ client_id: null }), s, 'email'), { ok: false, reason: 'no_client' })
    assert.deepEqual(eligibility(candidate(), settings({ sender_email: null }), 'email'), { ok: false, reason: 'sender_missing' })
    assert.deepEqual(eligibility(candidate(), settings({ email_enabled: false }), 'email'), { ok: false, reason: 'channel_off' })
    assert.deepEqual(eligibility(candidate(), s, 'whatsapp'), { ok: true, recipient: '+61400111222' })
    assert.deepEqual(eligibility(candidate({ whatsapp_opt_in: false }), s, 'whatsapp'), { ok: false, reason: 'no_whatsapp_consent' })
    assert.deepEqual(eligibility(candidate({ whatsapp_number: null }), s, 'whatsapp'), { ok: false, reason: 'no_whatsapp_number' })
    assert.deepEqual(eligibility(candidate(), settings({ whatsapp_template_name: null }), 'whatsapp'), { ok: false, reason: 'template_missing' })
  })

  it('builds a reminder email with item, date, amount, instructions and agency contact (escaped)', () => {
    const mail = buildReminderEmail(candidate({ target_name: 'acme<script>.com' }), settings(), 15)
    assert.match(mail.subject, /^Reminder: Domain acme<script>\.com renews on 20 Nov 2026$/)
    assert.match(mail.text, /Amount: A\$49\.00/)
    assert.match(mail.text, /Pay by bank transfer/)
    assert.match(mail.text, /hello@acmeweb\.example/)
    assert.ok(mail.html.includes('acme&lt;script&gt;.com'))
    assert.ok(!mail.html.includes('<script>'))
    assert.match(mail.html, /max-width:560px/)
  })

  it('builds hosting and overdue emails, and omits a missing amount instead of inventing one', () => {
    const hosting = buildReminderEmail(candidate({ target_kind: 'hosting', target_name: 'Business Web Hosting', provider: 'Hostinger', amount: null }), settings({ payment_instructions: null }), -3)
    assert.match(hosting.subject, /^Overdue: Hosting plan Business Web Hosting \(Hostinger\)/)
    assert.doesNotMatch(hosting.text, /Amount/)
    assert.doesNotMatch(hosting.text, /How to renew/)
  })

  it('builds the five WhatsApp template parameters in order', () => {
    assert.deepEqual(buildWhatsAppParams(candidate(), settings(), 15), [
      'Priya',
      'domain acme.com',
      '20 Nov 2026',
      'A$49.00',
      'Acme Web Studio (+61 400 000 000)',
    ])
    const p = buildWhatsAppParams(candidate({ amount: null, contact_name: 'Line\nbreak' }), settings(), 15)
    assert.equal(p[0], 'Line break', 'no newlines (WhatsApp rejects them)')
    assert.equal(p[3], 'see your invoice')
  })
})

describe('scheduled run', () => {
  it('sends a due domain reminder on both channels and records the provider ids as accepted (not delivered)', async () => {
    const mock = mockProviders()
    const { store, rows } = memoryStore()
    const summary = await runReminders(deps(store, mock.fetch))
    assert.equal(summary.accepted, 2)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((r) => [r.channel, r.stage, r.status]), [['email', 15, 'accepted'], ['whatsapp', 15, 'accepted']])
    assert.ok(rows.every((r) => r.provider_message_id))
    const email = mock.calls[0]
    assert.equal(email.headers.get('Authorization'), 'Bearer re_test_key')
    assert.equal(email.headers.get('Idempotency-Key'), 'log-1-1')
    assert.equal(email.body.from, 'Acme Web <billing@acmeweb.example>')
    assert.deepEqual(email.body.to, ['priya@acme.example'])
    const wa = mock.calls[1]
    assert.equal(wa.url, 'https://graph.facebook.com/v23.0/1234567890/messages')
    assert.equal(wa.body.to, '61400111222')
    assert.equal(wa.body.type, 'template')
    assert.equal((wa.body.template as { name: string }).name, 'renewal_reminder')
  })

  it('sends hosting renewal reminders too', async () => {
    const mock = mockProviders()
    const { store, rows } = memoryStore({ candidates: [candidate({ renewal_id: 'r-host', target_kind: 'hosting', target_name: 'Business Web Hosting', provider: 'Hostinger' })] })
    await runReminders(deps(store, mock.fetch))
    assert.equal(rows.length, 2)
    assert.equal(rows[0].target_kind, 'hosting')
    assert.match(String(mock.calls[0].body.subject), /Hosting plan Business Web Hosting \(Hostinger\)/)
  })

  it('never sends the same stage twice (repeat runs are duplicates)', async () => {
    const mock = mockProviders()
    const { store, rows } = memoryStore()
    await runReminders(deps(store, mock.fetch))
    const again = await runReminders(deps(store, mock.fetch))
    assert.equal(again.accepted, 0)
    assert.equal(again.duplicates, 2)
    assert.equal(rows.length, 2)
    assert.equal(mock.calls.length, 2)
  })

  it('a changed renewal date starts a new cycle', async () => {
    const mock = mockProviders()
    const { store } = memoryStore({ candidates: [candidate()] })
    await runReminders(deps(store, mock.fetch))
    const moved = memoryStore({ candidates: [candidate({ renewal_date: '2026-11-12' })] }) // 7 days
    const r = await runReminders(deps(moved.store, mock.fetch))
    assert.equal(r.accepted, 2)
  })

  it('waits for the send hour in the user time zone', async () => {
    const mock = mockProviders()
    const { store, rows } = memoryStore({ settings: [settings({ send_hour: 11 })] })
    const r = await runReminders(deps(store, mock.fetch))
    assert.equal(r.skipped.before_send_hour, 1)
    assert.equal(rows.length, 0)
  })

  it('skips renewals that are not at a reminder stage', async () => {
    const mock = mockProviders()
    const { store, rows } = memoryStore({ candidates: [candidate({ renewal_date: '2026-11-17' })] }) // 12 days
    const r = await runReminders(deps(store, mock.fetch))
    assert.equal(r.skipped.not_due, 1)
    assert.equal(rows.length, 0)
  })

  it('respects opt-out, missing contact details and missing consent per channel', async () => {
    const mock = mockProviders()
    const { store, rows } = memoryStore({
      candidates: [
        candidate({ renewal_id: 'r1', email_reminders: false, whatsapp_opt_in: false }),
        candidate({ renewal_id: 'r2', email: null, whatsapp_number: null }),
      ],
    })
    const r = await runReminders(deps(store, mock.fetch))
    assert.equal(rows.length, 0)
    assert.equal(mock.calls.length, 0)
    assert.deepEqual(r.skipped, { opted_out: 1, no_whatsapp_consent: 1, no_email: 1, no_whatsapp_number: 1 })
  })

  it('does not send or record anything for a channel whose provider is not configured', async () => {
    const mock = mockProviders()
    const { store, rows } = memoryStore()
    const r = await runReminders(deps(store, mock.fetch, { whatsapp: null, missing: { email: [], whatsapp: ['WHATSAPP_ACCESS_TOKEN'] } }))
    assert.deepEqual(rows.map((x) => x.channel), ['email'])
    assert.equal(r.skipped.provider_missing, 1)
  })

  it("only uses each user's own settings (users without enabled settings get nothing)", async () => {
    const mock = mockProviders()
    const { store, rows } = memoryStore({
      settings: [settings(), settings({ user_id: B, email_enabled: false, whatsapp_enabled: false })],
      candidates: [candidate(), candidate({ renewal_id: 'r-b', user_id: B, email: 'b@client.example' })],
    })
    await runReminders(deps(store, mock.fetch))
    assert.ok(rows.every((r) => r.user_id === A))
    assert.ok(!mock.calls.some((c) => JSON.stringify(c.body).includes('b@client.example')))
  })

  it('records provider failures; retryable ones get a back-off, others are final', async () => {
    const mock = mockProviders({
      email: () => json(503, { message: 'Service unavailable' }),
      whatsapp: () => json(400, { error: { message: 'Template name does not exist in the translation', code: 132001 } }),
    })
    const { store, rows } = memoryStore()
    const r = await runReminders(deps(store, mock.fetch))
    assert.equal(r.failed, 2)
    const [email, wa] = rows
    assert.equal(email.status, 'failed')
    assert.equal(email.retryable, true)
    assert.equal(email.next_attempt_at, '2026-11-05T06:00:00.000Z', '1 hour back-off')
    assert.equal(wa.retryable, false)
    assert.match(wa.error ?? '', /error 132001.*not approved/)
    assert.ok(!(wa.error ?? '').includes('wa_test_token'))
  })

  it('retries on the back-off, then stops after 3 automatic attempts', async () => {
    let status = 503
    const mock = mockProviders({ email: () => json(status, { message: 'down' }) })
    const { store, rows } = memoryStore({ settings: [settings({ whatsapp_enabled: false })] })
    await runReminders(deps(store, mock.fetch))
    const at = (iso: string) => deps(store, mock.fetch, { now: () => new Date(iso) })
    assert.equal((await runReminders(at('2026-11-05T05:30:00Z'))).retried, 0, 'not before the back-off')
    assert.equal((await runReminders(at('2026-11-05T06:00:00Z'))).retried, 1)
    assert.equal(rows[0].attempts, 2)
    assert.equal(rows[0].next_attempt_at, '2026-11-05T10:00:00.000Z', '4 hour back-off')
    await runReminders(at('2026-11-05T10:00:00Z'))
    assert.equal(rows[0].attempts, 3)
    assert.equal(rows[0].retryable, false, 'automatic retries exhausted')
    status = 200
    assert.equal((await runReminders(at('2026-11-06T10:00:00Z'))).retried, 0)
  })

  it('a user-requested retry resends a failed reminder once', async () => {
    const mock = mockProviders()
    const { store, rows } = memoryStore({
      settings: [settings({ whatsapp_enabled: false })],
      rows: [{
        id: 'old', user_id: A, renewal_id: 'r-domain', channel: 'email', stage: 15, due_date: '2026-11-20', status: 'failed', retryable: false,
        attempts: 3, last_attempt_at: '2026-11-04T00:00:00Z', next_attempt_at: null, retry_requested_at: '2026-11-05T04:00:00Z',
        target_kind: 'domain', target_name: 'acme.com', client_id: 'c1', client_name: 'Acme', recipient: 'old@acme.example', amount: 49, currency: 'AUD',
      }],
    })
    const r = await runReminders(deps(store, mock.fetch))
    assert.equal(r.retried, 1)
    assert.equal(rows[0].status, 'accepted')
    assert.equal(rows[0].recipient, 'priya@acme.example', 'uses the current contact')
    assert.equal(r.duplicates, 1, 'the new-reminder pass sees the stage already recorded')
    assert.equal((await runReminders(deps(store, mock.fetch))).retried, 0, 'one retry per request')
  })

  it('does not retry a reminder whose renewal was paid or changed', async () => {
    const mock = mockProviders()
    const { store, rows } = memoryStore({
      candidates: [],
      rows: [{
        id: 'old', user_id: A, renewal_id: 'r-paid', channel: 'email', stage: 15, due_date: '2026-11-20', status: 'failed', retryable: true,
        attempts: 1, last_attempt_at: '2026-11-05T00:00:00Z', next_attempt_at: '2026-11-05T01:00:00Z', retry_requested_at: null,
        target_kind: 'domain', target_name: 'acme.com', client_id: 'c1', client_name: 'Acme', recipient: 'x@acme.example', amount: 49, currency: 'AUD',
      }],
    })
    await runReminders(deps(store, mock.fetch))
    assert.equal(mock.calls.length, 0)
    assert.equal(rows[0].retryable, false)
    assert.match(rows[0].error ?? '', /no longer due/)
  })

  it('fails interrupted sends instead of resending them', async () => {
    const mock = mockProviders()
    const { store, rows } = memoryStore({
      candidates: [],
      rows: [{
        id: 'stuck', user_id: A, renewal_id: 'r-domain', channel: 'email', stage: 15, due_date: '2026-11-20', status: 'pending', retryable: false,
        attempts: 1, last_attempt_at: '2026-11-05T03:00:00Z', next_attempt_at: null, retry_requested_at: null,
        target_kind: 'domain', target_name: 'acme.com', client_id: 'c1', client_name: 'Acme', recipient: 'x@acme.example', amount: 49, currency: 'AUD',
      }],
    })
    const r = await runReminders(deps(store, mock.fetch))
    assert.equal(r.stale, 1)
    assert.equal(rows[0].status, 'failed')
    assert.equal(mock.calls.length, 0)
  })

  it('keeps going after one reminder fails', async () => {
    let n = 0
    const mock = mockProviders({ email: () => (++n === 1 ? json(500, {}) : json(200, { id: 'ok' })) })
    const { store, rows } = memoryStore({
      settings: [settings({ whatsapp_enabled: false })],
      candidates: [candidate({ renewal_id: 'r1' }), candidate({ renewal_id: 'r2' })],
    })
    const r = await runReminders(deps(store, mock.fetch))
    assert.equal(r.failed, 1)
    assert.equal(r.accepted, 1)
    assert.deepEqual(rows.map((x) => x.status), ['failed', 'accepted'])
  })
})

describe('renewal-reminders requests', () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request('http://localhost/renewal-reminders', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

  it('only runs with the scheduler secret', async () => {
    const mock = mockProviders()
    const { store } = memoryStore()
    assert.equal((await handleRemindersRequest(post({ action: 'run' }), deps(store, mock.fetch))).status, 401)
    assert.equal((await handleRemindersRequest(post({ action: 'run' }, { 'x-reminders-secret': 'b'.repeat(64) }), deps(store, mock.fetch))).status, 401)
    assert.equal((await handleRemindersRequest(post({ action: 'run' }, { 'Authorization': 'Bearer user-a-jwt' }), deps(store, mock.fetch))).status, 401, 'a user JWT cannot trigger a run')
    assert.equal(mock.calls.length, 0)
    const ok = await handleRemindersRequest(post({ action: 'run' }, { 'x-reminders-secret': SECRET }), deps(store, mock.fetch))
    assert.equal(ok.status, 200)
  })

  it('reports provider configuration as yes/no plus missing secret names, never values', async () => {
    const { store } = memoryStore()
    const res = await handleRemindersRequest(post({ action: 'status' }, { Authorization: 'Bearer user-a-jwt' }), deps(store, mockProviders().fetch, {
      email: null,
      missing: { email: ['RESEND_API_KEY'], whatsapp: [] },
    }))
    const body = await res.json()
    assert.deepEqual(body.email, { configured: false, missing: ['RESEND_API_KEY'] })
    assert.equal(body.whatsapp.configured, true)
    assert.ok(!JSON.stringify(body).includes('wa_test_token'))
    assert.equal((await handleRemindersRequest(post({ action: 'status' }), deps(store, mockProviders().fetch))).status, 401)
  })

  it('sends a test email only to the signed-in user, and a test WhatsApp only to a valid number', async () => {
    const mock = mockProviders()
    const { store, rows } = memoryStore()
    const auth = { Authorization: 'Bearer user-a-jwt' }
    const email = await handleRemindersRequest(post({ action: 'test', channel: 'email' }, auth), deps(store, mock.fetch))
    assert.equal(email.status, 200)
    assert.deepEqual(mock.calls[0].body.to, ['owner@acmeweb.example'])
    assert.match(String(mock.calls[0].body.subject), /^\[Test\]/)
    assert.equal((await handleRemindersRequest(post({ action: 'test', channel: 'whatsapp', to: '0400' }, auth), deps(store, mock.fetch))).status, 400)
    assert.equal((await handleRemindersRequest(post({ action: 'test', channel: 'whatsapp', to: '+61 400 999 888' }, auth), deps(store, mock.fetch))).status, 200)
    assert.equal(rows.length, 0, 'tests are not logged as client reminders')
    const missing = await handleRemindersRequest(post({ action: 'test', channel: 'email' }, auth), deps(store, mock.fetch, { email: null, missing: { email: ['RESEND_API_KEY'], whatsapp: [] } }))
    assert.equal(missing.status, 409)
    assert.match((await missing.json()).error.message, /RESEND_API_KEY/)
  })
})

describe('delivery webhooks', () => {
  function webhookStore() {
    const applied: { channel: string; id: string; status: DeliveryStatus; error: string | null }[] = []
    return { applied, store: { apply: async (channel: 'email' | 'whatsapp', id: string, status: DeliveryStatus, error: string | null) => (applied.push({ channel, id, status, error }), 1) } }
  }
  const metaBody = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [
    { id: 'wamid.1', status: 'sent' },
    { id: 'wamid.1', status: 'delivered' },
    { id: 'wamid.2', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] },
  ] } }] }] })
  const metaSig = (body: string, secret = 'app-secret') => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  const metaReq = (body: string, sig: string | null) =>
    new Request('http://x/notification-webhooks?provider=whatsapp', { method: 'POST', headers: sig ? { 'x-hub-signature-256': sig } : {}, body })
  const base = { whatsappAppSecret: 'app-secret', whatsappVerifyToken: 'verify-me', resendWebhookSecret: 'whsec_' + Buffer.from('resend-secret').toString('base64') }

  it('verifies the Meta subscription challenge', async () => {
    const { store } = webhookStore()
    const ok = await handleWebhook(new Request('http://x/?provider=whatsapp&hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42'), { ...base, store })
    assert.equal(await ok.text(), '42')
    const bad = await handleWebhook(new Request('http://x/?provider=whatsapp&hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42'), { ...base, store })
    assert.equal(bad.status, 403)
  })

  it('records WhatsApp delivered/failed only from correctly signed requests', async () => {
    const w = webhookStore()
    assert.equal((await handleWebhook(metaReq(metaBody, null), { ...base, store: w.store })).status, 401)
    assert.equal((await handleWebhook(metaReq(metaBody, metaSig(metaBody, 'wrong')), { ...base, store: w.store })).status, 401)
    assert.equal(w.applied.length, 0)
    assert.equal((await handleWebhook(metaReq(metaBody, metaSig(metaBody)), { ...base, store: w.store })).status, 200)
    assert.deepEqual(w.applied.map((a) => [a.id, a.status]), [['wamid.1', 'delivered'], ['wamid.2', 'failed']])
    assert.match(w.applied[1].error ?? '', /undeliverable/)
  })

  it('records Resend delivered/bounced only with a valid, fresh Svix signature', async () => {
    const w = webhookStore()
    const now = new Date('2026-11-05T05:00:00Z')
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'email-1', bounce: { message: 'Mailbox does not exist' } } })
    const ts = String(Math.floor(now.getTime() / 1000))
    const sig = 'v1,' + createHmac('sha256', Buffer.from('resend-secret')).update(`msg_1.${ts}.${body}`).digest('base64')
    const req = (signature: string, timestamp = ts) =>
      new Request('http://x/?provider=resend', { method: 'POST', headers: { 'svix-id': 'msg_1', 'svix-timestamp': timestamp, 'svix-signature': signature }, body })
    assert.equal((await handleWebhook(req('v1,AAAA'), { ...base, store: w.store, now: () => now })).status, 401)
    assert.equal((await handleWebhook(req(sig, String(Number(ts) - 3600)), { ...base, store: w.store, now: () => now })).status, 401, 'replayed')
    assert.equal((await handleWebhook(req(sig), { ...base, store: w.store, now: () => now })).status, 200)
    assert.deepEqual(w.applied, [{ channel: 'email', id: 'email-1', status: 'failed', error: 'Email bounced: Mailbox does not exist' }])
  })

  it('refuses webhooks when their secret is not configured', async () => {
    const w = webhookStore()
    const res = await handleWebhook(metaReq(metaBody, metaSig(metaBody)), { whatsappAppSecret: null, whatsappVerifyToken: null, resendWebhookSecret: null, store: w.store })
    assert.equal(res.status, 503)
    assert.equal(w.applied.length, 0)
  })
})
