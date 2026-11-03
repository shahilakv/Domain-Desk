/*
 * Pure renewal-reminder rules, shared by the renewal-reminders Edge Function
 * and the web app (src/), so "upcoming reminders" in the app match what the
 * scheduler sends. No imports and no I/O.
 *
 * Stages are days relative to the renewal date: 30 = thirty days before,
 * 0 = on the day, -3 = three days overdue. A stage is due on
 * (renewal date − stage). If a run is missed, a stage is still sent up to
 * GRACE_DAYS late; older stages are skipped rather than sent out of order.
 */

export type Channel = 'email' | 'whatsapp'
export type TargetKind = 'domain' | 'hosting'

export const DEFAULT_REMINDER_DAYS = [30, 15, 7, 3, 0]
export const GRACE_DAYS = 2
export const MAX_STAGES = 10
export const MIN_STAGE = -60
export const MAX_STAGE = 365

/** One unpaid renewal with its client contact (see public.dd_reminder_candidates). */
export interface ReminderCandidate {
  renewal_id: string
  user_id: string
  target_kind: TargetKind
  target_name: string
  provider: string | null
  /** YYYY-MM-DD */
  renewal_date: string
  renewal_status: string
  amount: number | string | null
  currency: string | null
  client_id: string | null
  client_name: string | null
  contact_name: string | null
  email: string | null
  email_reminders: boolean
  whatsapp_number: string | null
  whatsapp_opt_in: boolean
}

/** A row of public.notification_settings. */
export interface ReminderSettings {
  user_id: string
  email_enabled: boolean
  whatsapp_enabled: boolean
  reminder_days: number[]
  send_hour: number
  timezone: string
  sender_name: string | null
  sender_email: string | null
  reply_to_email: string | null
  agency_name: string | null
  agency_email: string | null
  agency_phone: string | null
  agency_website: string | null
  payment_instructions: string | null
  whatsapp_template_name: string | null
  whatsapp_template_language: string
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** E.164: + then 8–15 digits, no leading zero. */
const WHATSAPP_PATTERN = /^\+[1-9][0-9]{7,14}$/

export const isValidEmail = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.length <= 320 && EMAIL_PATTERN.test(value)

export const isValidWhatsApp = (value: string | null | undefined): value is string =>
  typeof value === 'string' && WHATSAPP_PATTERN.test(value)

/** "+91 98765-43210" → "+919876543210"; null when it can't be an international number. */
export function normalizeWhatsApp(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('+')) return null
  const digits = '+' + trimmed.slice(1).replace(/[\s().-]/g, '')
  return isValidWhatsApp(digits) ? digits : null
}

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/** The calendar date and hour at `now` in `timezone` (UTC if the zone is invalid). */
export function localClock(now: Date, timezone: string): { date: string; hour: number } {
  const zone = isValidTimeZone(timezone) ? timezone : 'UTC'
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) }
}

const toUtcDay = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcDay(to) - toUtcDay(from)) / 86_400_000)
}

export function addDays(iso: string, days: number): string {
  return new Date(toUtcDay(iso) + days * 86_400_000).toISOString().slice(0, 10)
}

/** Cleans a user-entered list: integers in range, unique, largest first, at most MAX_STAGES. */
export function normalizeStages(days: number[]): number[] {
  const clean = [...new Set(days.filter((d) => Number.isInteger(d) && d >= MIN_STAGE && d <= MAX_STAGE))]
  return clean.sort((a, b) => b - a).slice(0, MAX_STAGES)
}

/**
 * The stage to send today, given how many days remain until the renewal date.
 * Returns the stage closest to today whose day has arrived, if it is at most
 * GRACE_DAYS old; otherwise null.
 */
export function dueStage(daysUntil: number, stages: number[]): number | null {
  let best: number | null = null
  for (const stage of stages) {
    const late = stage - daysUntil
    if (late >= 0 && late <= GRACE_DAYS && (best === null || stage < best)) best = stage
  }
  return best
}

/** The next stage that will fire (today or later), or null when none are left. */
export function nextStage(daysUntil: number, stages: number[]): number | null {
  let best: number | null = null
  for (const stage of stages) if (stage <= daysUntil && (best === null || stage > best)) best = stage
  return best
}

/** "in 30 days", "tomorrow", "today", "3 days ago". */
export function describeStage(stage: number): string {
  if (stage === 0) return 'today'
  if (stage === 1) return 'tomorrow'
  if (stage === -1) return '1 day ago'
  return stage > 0 ? `in ${stage} days` : `${-stage} days ago`
}

export type IneligibleReason =
  | 'channel_off'
  | 'no_client'
  | 'opted_out'
  | 'no_email'
  | 'no_whatsapp_number'
  | 'no_whatsapp_consent'
  | 'sender_missing'
  | 'template_missing'

export const reasonLabels: Record<IneligibleReason, string> = {
  channel_off: 'Channel turned off',
  no_client: 'No client on this renewal',
  opted_out: 'Client opted out of email reminders',
  no_email: 'Client has no valid email',
  no_whatsapp_number: 'Client has no WhatsApp number',
  no_whatsapp_consent: 'Client has not consented to WhatsApp',
  sender_missing: 'Sender email not set',
  template_missing: 'WhatsApp template not set',
}

/** Whether a reminder for this renewal may be sent on this channel; the recipient if so. */
export function eligibility(
  candidate: Pick<ReminderCandidate, 'client_id' | 'email' | 'email_reminders' | 'whatsapp_number' | 'whatsapp_opt_in'>,
  settings: Pick<ReminderSettings, 'email_enabled' | 'whatsapp_enabled' | 'sender_email' | 'whatsapp_template_name'>,
  channel: Channel,
): { ok: true; recipient: string } | { ok: false; reason: IneligibleReason } {
  if (channel === 'email') {
    if (!settings.email_enabled) return { ok: false, reason: 'channel_off' }
    if (!candidate.client_id) return { ok: false, reason: 'no_client' }
    if (!candidate.email_reminders) return { ok: false, reason: 'opted_out' }
    if (!isValidEmail(candidate.email)) return { ok: false, reason: 'no_email' }
    if (!isValidEmail(settings.sender_email)) return { ok: false, reason: 'sender_missing' }
    return { ok: true, recipient: candidate.email }
  }
  if (!settings.whatsapp_enabled) return { ok: false, reason: 'channel_off' }
  if (!candidate.client_id) return { ok: false, reason: 'no_client' }
  if (!isValidWhatsApp(candidate.whatsapp_number)) return { ok: false, reason: 'no_whatsapp_number' }
  if (!candidate.whatsapp_opt_in) return { ok: false, reason: 'no_whatsapp_consent' }
  if (!settings.whatsapp_template_name) return { ok: false, reason: 'template_missing' }
  return { ok: true, recipient: candidate.whatsapp_number }
}

function toAmount(value: number | string | null): number | null {
  if (value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function formatAmount(value: number | string | null, currency: string | null): string | null {
  const n = toAmount(value)
  if (n === null || !currency || !/^[A-Z]{3}$/.test(currency)) return null
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(n)
  } catch {
    return `${currency} ${n.toFixed(2)}`
  }
}

/** "8 Nov 2026" — unambiguous across locales. */
export function formatReminderDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(toUtcDay(iso)),
  )
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

export interface ReminderContent {
  /** "Domain example.com" or "Hosting plan Business Web Hosting (Hostinger)". */
  item: string
  date: string
  amount: string | null
  when: string
  overdue: boolean
}

export function reminderContent(candidate: ReminderCandidate, stage: number): ReminderContent {
  const item =
    candidate.target_kind === 'hosting'
      ? `Hosting plan ${candidate.target_name}${candidate.provider ? ` (${candidate.provider})` : ''}`
      : `Domain ${candidate.target_name}`
  return {
    item,
    date: formatReminderDate(candidate.renewal_date),
    amount: formatAmount(candidate.amount, candidate.currency),
    when: describeStage(stage),
    overdue: stage < 0,
  }
}

export interface EmailMessage {
  subject: string
  html: string
  text: string
}

/** Professional, responsive (single column, table-based, inline styles) reminder email. */
export function buildReminderEmail(candidate: ReminderCandidate, settings: ReminderSettings, stage: number): EmailMessage {
  const c = reminderContent(candidate, stage)
  const agency = settings.agency_name || settings.sender_name || 'Your web team'
  const greetingName = candidate.contact_name || candidate.client_name || 'there'
  const subject = c.overdue
    ? `Overdue: ${c.item} renewal was due ${c.date}`
    : stage === 0
      ? `Due today: ${c.item} renewal`
      : `Reminder: ${c.item} renews on ${c.date}`
  const lead = c.overdue
    ? `The renewal of your ${c.item.toLowerCase().startsWith('domain') ? 'domain' : 'hosting plan'} was due on ${c.date} and is still outstanding.`
    : `This is a reminder that the following renewal is due ${c.when === 'today' ? 'today' : `${c.when} (${c.date})`}.`
  const contact = [settings.agency_email, settings.agency_phone, settings.agency_website].filter(Boolean) as string[]

  const rows: [string, string][] = [
    [candidate.target_kind === 'hosting' ? 'Hosting plan' : 'Domain', candidate.target_name + (candidate.provider ? ` (${candidate.provider})` : '')],
    ['Renewal date', c.date],
  ]
  if (c.amount) rows.push(['Amount', c.amount])

  const text = [
    `Hi ${greetingName},`,
    '',
    lead,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    ...(settings.payment_instructions ? ['How to renew:', settings.payment_instructions, ''] : []),
    'If you have already arranged this renewal, please ignore this message.',
    '',
    agency,
    ...contact,
  ].join('\n')

  const rowHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 0;color:#6a6690;font-size:14px;width:40%">${escapeHtml(k)}</td><td style="padding:8px 0;color:#1d1a33;font-size:14px;font-weight:600">${escapeHtml(v)}</td></tr>`,
    )
    .join('')
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fb;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;padding:28px">
<tr><td style="font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${c.overdue ? '#c2410c' : '#5b4bd6'}">${c.overdue ? 'Renewal overdue' : 'Renewal reminder'}</td></tr>
<tr><td style="padding-top:8px;font-size:22px;font-weight:700;color:#1d1a33;line-height:1.3">${escapeHtml(c.item)}</td></tr>
<tr><td style="padding-top:16px;font-size:15px;color:#3b3858;line-height:1.6">Hi ${escapeHtml(greetingName)},<br>${escapeHtml(lead)}</td></tr>
<tr><td style="padding-top:16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e7e8f3;border-bottom:1px solid #e7e8f3">${rowHtml}</table></td></tr>
${settings.payment_instructions ? `<tr><td style="padding-top:16px;font-size:15px;color:#3b3858;line-height:1.6"><strong>How to renew</strong><br>${escapeHtml(settings.payment_instructions).replace(/\n/g, '<br>')}</td></tr>` : ''}
<tr><td style="padding-top:16px;font-size:14px;color:#6a6690;line-height:1.6">If you have already arranged this renewal, please ignore this message.</td></tr>
<tr><td style="padding-top:20px;font-size:14px;color:#3b3858;line-height:1.6"><strong>${escapeHtml(agency)}</strong>${contact.map((x) => `<br>${escapeHtml(x)}`).join('')}</td></tr>
</table></td></tr></table></body></html>`
  return { subject, html, text }
}

/**
 * Body parameters for the approved WhatsApp template, in this fixed order:
 * {{1}} client name, {{2}} what renews, {{3}} renewal date,
 * {{4}} amount (or "see invoice"), {{5}} agency name and contact.
 */
export const WHATSAPP_TEMPLATE_EXAMPLE =
  'Hello {{1}}, this is a reminder that your {{2}} renews on {{3}}. Amount: {{4}}. Please contact {{5}} to renew. Reply STOP to opt out.'

export function buildWhatsAppParams(candidate: ReminderCandidate, settings: ReminderSettings, stage: number): string[] {
  const c = reminderContent(candidate, stage)
  const agency = settings.agency_name || settings.sender_name || 'your web team'
  const contact = settings.agency_phone || settings.agency_email
  // WhatsApp rejects parameters with newlines, tabs or 4+ spaces in a row.
  const clean = (v: string) => v.replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 200)
  return [
    clean(candidate.contact_name || candidate.client_name || 'there'),
    clean(c.item.charAt(0).toLowerCase() + c.item.slice(1)),
    clean(c.date),
    clean(c.amount ?? 'see your invoice'),
    clean(contact ? `${agency} (${contact})` : agency),
  ]
}
