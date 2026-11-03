import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  DEFAULT_REMINDER_DAYS,
  isValidTimeZone,
  MAX_STAGES,
  WHATSAPP_TEMPLATE_EXAMPLE,
} from '../../supabase/functions/_shared/reminderRules.ts'
import { Button } from '../components/Button'
import { Field } from '../components/FormDialog'
import { Icon } from '../components/Icon'
import { PageHeader, SearchBox } from '../components/PageHeader'
import { describeError, saveNotificationSettings } from '../lib/api'
import { HostingerImportError } from '../lib/hostinger'
import { fetchReminderStatus, sendTestReminder, type ReminderServiceStatus } from '../lib/reminders'
import type { NotificationSettingsInput, NotificationSettingsRow } from '../types/db'
import type {
  Client,
  Domain,
  HostingPlan,
  NotificationChannel,
  NotificationLogEntry,
  NotificationStatus,
  Renewal,
} from '../types/domain'
import { formatDate } from '../utils/domainStatus'
import { formatMoney, matchesSearch, nullIfEmpty } from '../utils/format'
import { describeReminderStage, upcomingReminders } from '../utils/reminders'

interface NotificationsPageProps {
  userId: string
  settings: NotificationSettingsRow | null
  notifications: NotificationLogEntry[]
  /** Why reminders could not be loaded (e.g. migration not applied); null when they loaded. */
  unavailable: string | null
  renewals: Renewal[]
  domains: Domain[]
  hostingPlans: HostingPlan[]
  clients: Client[]
  onSaved: (message: string) => void
  onRetry: (entry: NotificationLogEntry) => void
}

const channelLabels: Record<NotificationChannel, string> = { email: 'Email', whatsapp: 'WhatsApp' }

const statusLabels: Record<NotificationStatus, string> = {
  pending: 'Sending',
  accepted: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
}

const statusBadge: Record<NotificationStatus, string> = {
  pending: 'badge-plan',
  accepted: 'badge-plan',
  delivered: 'badge-calm',
  read: 'badge-calm',
  failed: 'badge-expired',
}

/** Up to this many manual retries per reminder (the scheduler enforces the same limit). */
const MAX_MANUAL_ATTEMPTS = 5

function errorText(error: unknown): string {
  return error instanceof HostingerImportError ? error.message : describeError(error)
}

export function NotificationsPage(props: NotificationsPageProps) {
  const { unavailable } = props
  return (
    <>
      <PageHeader
        eyebrow="Notifications"
        title="Renewal reminders, sent for you."
        subtitle="Email and WhatsApp reminders to clients before (and after) each renewal date."
      />
      {unavailable ? (
        <section className="card section-card">
          <p className="empty-state">{unavailable}</p>
        </section>
      ) : (
        <>
          <DeliverySetup settings={props.settings} />
          <ReminderSettings {...props} />
          <UpcomingReminders {...props} />
          <History notifications={props.notifications} onRetry={props.onRetry} />
        </>
      )}
    </>
  )
}

function DeliverySetup({ settings }: { settings: NotificationSettingsRow | null }) {
  const [status, setStatus] = useState<ReminderServiceStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testNumber, setTestNumber] = useState('')
  const [testing, setTesting] = useState<NotificationChannel | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    let active = true
    fetchReminderStatus()
      .then((s) => active && setStatus(s))
      .catch((e: unknown) => active && setError(errorText(e)))
    return () => {
      active = false
    }
  }, [])

  const test = async (channel: NotificationChannel) => {
    setTesting(channel)
    setTestResult(null)
    try {
      const res = await sendTestReminder(channel, channel === 'whatsapp' ? testNumber : undefined)
      setTestResult({ ok: true, message: res.message })
    } catch (e) {
      setTestResult({ ok: false, message: errorText(e) })
    } finally {
      setTesting(null)
    }
  }

  const scheduler = status?.scheduler
  return (
    <section className="card section-card" aria-labelledby="delivery-title">
      <header className="section-header">
        <div className="section-title">
          <span className="icon-chip tone-sky">
            <Icon name="bell" />
          </span>
          <div>
            <h2 id="delivery-title">Delivery setup</h2>
            <p className="section-subtitle">Provider keys are stored as Supabase Edge Function secrets, never in the browser.</p>
          </div>
        </div>
      </header>

      {error ? (
        <p className="form-error" role="alert">
          Couldn't check the reminder service: {error}
        </p>
      ) : !status ? (
        <p className="section-subtitle" role="status">
          Checking providers…
        </p>
      ) : (
        <dl className="totals-strip provider-strip">
          <ProviderItem label="Email (Resend)" configured={status.email.configured} missing={status.email.missing} />
          <ProviderItem label="WhatsApp Cloud API" configured={status.whatsapp.configured} missing={status.whatsapp.missing} />
          <div>
            <dt>Scheduler</dt>
            <dd>
              <span className={`badge ${scheduler?.scheduled ? 'badge-calm' : 'badge-expired'}`}>
                {scheduler?.scheduled ? 'Runs hourly' : 'Not scheduled'}
              </span>
              <span className="cell-sub">
                {scheduler?.lastRunAt
                  ? `Last run ${new Date(scheduler.lastRunAt).toLocaleString()} (${scheduler.lastRunStatus ?? 'unknown'})`
                  : 'No runs yet'}
              </span>
            </dd>
          </div>
        </dl>
      )}

      {status && (
        <div className="test-row">
          <Button
            variant="secondary"
            icon="check"
            onClick={() => test('email')}
            disabled={testing !== null || !status.email.configured || !settings?.sender_email}
            title={!settings?.sender_email ? 'Save a sender email first' : undefined}
          >
            {testing === 'email' ? 'Sending…' : 'Send test email to me'}
          </Button>
          <div className="test-whatsapp">
            <label htmlFor="test-whatsapp" className="visually-hidden">
              Your WhatsApp number for a test
            </label>
            <input
              id="test-whatsapp"
              type="tel"
              value={testNumber}
              onChange={(e) => setTestNumber(e.target.value)}
              placeholder="Your WhatsApp, e.g. +61 400 000 000"
            />
            <Button
              variant="secondary"
              icon="check"
              onClick={() => test('whatsapp')}
              disabled={testing !== null || !status.whatsapp.configured || !settings?.whatsapp_template_name || !testNumber.trim()}
              title={!settings?.whatsapp_template_name ? 'Save the WhatsApp template name first' : undefined}
            >
              {testing === 'whatsapp' ? 'Sending…' : 'Send test WhatsApp'}
            </Button>
          </div>
        </div>
      )}
      {testResult && (
        <p className={testResult.ok ? 'section-subtitle' : 'form-error'} role={testResult.ok ? 'status' : 'alert'}>
          {testResult.message}
        </p>
      )}
    </section>
  )
}

function ProviderItem({ label, configured, missing }: { label: string; configured: boolean; missing: string[] }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span className={`badge ${configured ? 'badge-calm' : 'badge-soon'}`}>{configured ? 'Configured' : 'Not configured'}</span>
        {!configured && <span className="cell-sub">Missing secret: {missing.join(', ')}</span>}
      </dd>
    </div>
  )
}

const parseDays = (value: string) =>
  value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((v) => Number(v))

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function ReminderSettings({ userId, settings, onSaved }: NotificationsPageProps) {
  const initialDays = settings?.reminder_days ?? DEFAULT_REMINDER_DAYS
  const [emailEnabled, setEmailEnabled] = useState(settings?.email_enabled ?? false)
  const [whatsappEnabled, setWhatsappEnabled] = useState(settings?.whatsapp_enabled ?? false)
  const [beforeDays, setBeforeDays] = useState(initialDays.filter((d) => d >= 0).join(', '))
  const [overdueDays, setOverdueDays] = useState(initialDays.filter((d) => d < 0).map((d) => -d).join(', '))
  const [sendHour, setSendHour] = useState(settings?.send_hour ?? 9)
  const [timezone, setTimezone] = useState(settings?.timezone ?? browserTimeZone())
  const [senderName, setSenderName] = useState(settings?.sender_name ?? '')
  const [senderEmail, setSenderEmail] = useState(settings?.sender_email ?? '')
  const [replyTo, setReplyTo] = useState(settings?.reply_to_email ?? '')
  const [agencyName, setAgencyName] = useState(settings?.agency_name ?? '')
  const [agencyEmail, setAgencyEmail] = useState(settings?.agency_email ?? '')
  const [agencyPhone, setAgencyPhone] = useState(settings?.agency_phone ?? '')
  const [agencyWebsite, setAgencyWebsite] = useState(settings?.agency_website ?? '')
  const [paymentInstructions, setPaymentInstructions] = useState(settings?.payment_instructions ?? '')
  const [templateName, setTemplateName] = useState(settings?.whatsapp_template_name ?? '')
  const [templateLanguage, setTemplateLanguage] = useState(settings?.whatsapp_template_language ?? 'en')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const before = parseDays(beforeDays)
    const overdue = parseDays(overdueDays)
    if ([...before, ...overdue].some((d) => !Number.isInteger(d) || d < 0)) {
      return setError('Reminder days must be whole numbers, e.g. 30, 15, 7, 3, 0.')
    }
    if (before.some((d) => d > 365) || overdue.some((d) => d > 60)) {
      return setError('Use at most 365 days before and 60 days overdue.')
    }
    const days = [...new Set([...before, ...overdue.filter((d) => d > 0).map((d) => -d)])].sort((a, b) => b - a)
    if (days.length === 0) return setError('Add at least one reminder day.')
    if (days.length > MAX_STAGES) return setError(`Use at most ${MAX_STAGES} reminder days in total.`)
    if (!isValidTimeZone(timezone.trim())) return setError('Enter a valid time zone, e.g. Asia/Kolkata or Australia/Sydney.')
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    for (const [label, value] of [['Sender email', senderEmail], ['Reply-to email', replyTo], ['Agency email', agencyEmail]]) {
      if (value.trim() && !email.test(value.trim())) return setError(`${label} is not a valid email address.`)
    }
    if (emailEnabled && !senderEmail.trim()) return setError('Email reminders need a sender email on a domain verified in Resend.')
    const template = templateName.trim().toLowerCase()
    if (template && !/^[a-z0-9_]+$/.test(template)) return setError('The WhatsApp template name uses lowercase letters, numbers and underscores.')
    if (whatsappEnabled && !template) return setError('WhatsApp reminders need the name of your approved message template.')
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(templateLanguage.trim())) return setError('Template language looks like en, en_US or hi.')

    const values: NotificationSettingsInput = {
      email_enabled: emailEnabled,
      whatsapp_enabled: whatsappEnabled,
      reminder_days: days,
      send_hour: sendHour,
      timezone: timezone.trim(),
      sender_name: nullIfEmpty(senderName),
      sender_email: nullIfEmpty(senderEmail),
      reply_to_email: nullIfEmpty(replyTo),
      agency_name: nullIfEmpty(agencyName),
      agency_email: nullIfEmpty(agencyEmail),
      agency_phone: nullIfEmpty(agencyPhone),
      agency_website: nullIfEmpty(agencyWebsite),
      payment_instructions: nullIfEmpty(paymentInstructions),
      whatsapp_template_name: template || null,
      whatsapp_template_language: templateLanguage.trim(),
    }
    setError(null)
    setSaving(true)
    try {
      await saveNotificationSettings(userId, values)
      onSaved('Saved reminder settings.')
    } catch (e) {
      setError(describeError(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="card section-card" aria-labelledby="reminder-settings-title">
      <header className="section-header">
        <div className="section-title">
          <span className="icon-chip tone-sunny">
            <Icon name="settings" />
          </span>
          <div>
            <h2 id="reminder-settings-title">Reminder settings</h2>
            <p className="section-subtitle">
              Reminders go to the client of each scheduled or invoiced renewal. Paid and cancelled renewals are never
              reminded.
            </p>
          </div>
        </div>
      </header>
      <form className="settings-form" onSubmit={submit} noValidate>
        <div className="form-grid">
          <div className="field field-checkbox">
            <label>
              <input type="checkbox" checked={emailEnabled} onChange={(e) => setEmailEnabled(e.target.checked)} />
              Send email reminders
            </label>
          </div>
          <div className="field field-checkbox">
            <label>
              <input type="checkbox" checked={whatsappEnabled} onChange={(e) => setWhatsappEnabled(e.target.checked)} />
              Send WhatsApp reminders
            </label>
          </div>
          <Field label="Days before the renewal date" htmlFor="days-before" hint="0 = on the day. Default: 30, 15, 7, 3, 0">
            <input id="days-before" value={beforeDays} onChange={(e) => setBeforeDays(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Days overdue (optional)" htmlFor="days-overdue" hint="Reminders after the date while still unpaid, e.g. 3, 7">
            <input id="days-overdue" value={overdueDays} onChange={(e) => setOverdueDays(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Send from" htmlFor="send-hour" hint="Local time; the hourly run sends from this hour">
            <select id="send-hour" value={sendHour} onChange={(e) => setSendHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </Field>
          <Field label="Time zone" htmlFor="timezone" hint="e.g. Asia/Kolkata, Australia/Sydney">
            <input id="timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} spellCheck={false} />
          </Field>

          <Field label="Sender name" htmlFor="sender-name">
            <input id="sender-name" value={senderName} onChange={(e) => setSenderName(e.target.value)} maxLength={100} placeholder="Acme Web Studio" />
          </Field>
          <Field label="Sender email" htmlFor="sender-email" hint="Must be on a domain verified in Resend">
            <input id="sender-email" type="email" value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)} placeholder="billing@yourdomain.com" />
          </Field>
          <Field label="Reply-to email" htmlFor="reply-to" hint="Optional; defaults to the agency email">
            <input id="reply-to" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} />
          </Field>
          <Field label="Agency name" htmlFor="agency-name">
            <input id="agency-name" value={agencyName} onChange={(e) => setAgencyName(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Agency email" htmlFor="agency-email">
            <input id="agency-email" type="email" value={agencyEmail} onChange={(e) => setAgencyEmail(e.target.value)} />
          </Field>
          <Field label="Agency phone" htmlFor="agency-phone">
            <input id="agency-phone" type="tel" value={agencyPhone} onChange={(e) => setAgencyPhone(e.target.value)} maxLength={50} />
          </Field>
          <Field label="Agency website" htmlFor="agency-website">
            <input id="agency-website" value={agencyWebsite} onChange={(e) => setAgencyWebsite(e.target.value)} maxLength={200} />
          </Field>
          <Field label="How to renew / pay" htmlFor="payment-instructions" full hint="Shown in emails. Leave empty to omit; no payment link is added for you.">
            <textarea
              id="payment-instructions"
              rows={3}
              value={paymentInstructions}
              onChange={(e) => setPaymentInstructions(e.target.value)}
              maxLength={2000}
              placeholder="e.g. Pay by bank transfer to … or reply to this email to renew."
            />
          </Field>
          <Field label="WhatsApp template name" htmlFor="template-name" hint="An approved Utility template in WhatsApp Manager">
            <input id="template-name" value={templateName} onChange={(e) => setTemplateName(e.target.value)} spellCheck={false} placeholder="renewal_reminder" />
          </Field>
          <Field label="Template language" htmlFor="template-language">
            <input id="template-language" value={templateLanguage} onChange={(e) => setTemplateLanguage(e.target.value)} spellCheck={false} maxLength={6} />
          </Field>
          <p className="field-hint field-full template-example">
            The template body must have exactly five variables, in this order: client name, what renews, renewal date,
            amount, agency and contact. Example: <q>{WHATSAPP_TEMPLATE_EXAMPLE}</q>
          </p>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="settings-actions">
          <Button type="submit" icon="check" disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      </form>
    </section>
  )
}

const UPCOMING_DAYS = 30

function UpcomingReminders({ settings, renewals, domains, hostingPlans, clients, notifications }: NotificationsPageProps) {
  const upcoming = useMemo(
    () => upcomingReminders(settings, renewals, domains, hostingPlans, clients, notifications, UPCOMING_DAYS),
    [settings, renewals, domains, hostingPlans, clients, notifications],
  )
  const enabled = settings && (settings.email_enabled || settings.whatsapp_enabled)
  return (
    <section className="card section-card" aria-labelledby="upcoming-reminders-title">
      <header className="section-header">
        <div className="section-title">
          <span className="icon-chip tone-lavender">
            <Icon name="calendar" />
          </span>
          <div>
            <h2 id="upcoming-reminders-title">Upcoming reminders</h2>
            <p className="section-subtitle">Next {UPCOMING_DAYS} days, from scheduled and invoiced renewals</p>
          </div>
        </div>
      </header>
      {!enabled ? (
        <p className="empty-state">Turn on email or WhatsApp reminders above to see what will be sent.</p>
      ) : upcoming.length === 0 ? (
        <p className="empty-state">No reminders due in the next {UPCOMING_DAYS} days. Reminders come from renewal records on the Renewals page.</p>
      ) : (
        <div className="table-scroll">
          <table className="domain-table data-table">
            <caption className="visually-hidden">Reminders due in the next {UPCOMING_DAYS} days</caption>
            <thead>
              <tr>
                <th scope="col">Renewal for</th>
                <th scope="col">Renewal date</th>
                <th scope="col">Reminder</th>
                <th scope="col">Channel</th>
                <th scope="col">Goes out</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.map((u) => (
                <tr key={u.key}>
                  <td className="cell-domain cell-wrap">
                    {u.renewal.targetName}
                    <span className="cell-sub">
                      {u.renewal.kind === 'hosting' ? 'Hosting' : 'Domain'}
                      {u.renewal.clientName && ` · ${u.renewal.clientName}`}
                    </span>
                  </td>
                  <td data-label="Renews">{formatDate(u.renewal.renewalDate)}</td>
                  <td data-label="Reminder">{describeReminderStage(u.stage)}</td>
                  <td data-label="Channel" className="cell-wrap">
                    {channelLabels[u.channel]}
                    <span className="cell-sub">{u.recipient ?? ''}</span>
                  </td>
                  <td data-label="Goes out" className="cell-wrap">
                    {u.blocked ? (
                      <>
                        <span className="badge badge-soon">Won't send</span>
                        <span className="cell-sub">{u.blocked}</span>
                      </>
                    ) : (
                      formatDate(u.sendDate)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function History({ notifications, onRetry }: { notifications: NotificationLogEntry[]; onRetry: (entry: NotificationLogEntry) => void }) {
  const [query, setQuery] = useState('')
  const [channel, setChannel] = useState<NotificationChannel | 'all'>('all')
  const [status, setStatus] = useState<NotificationStatus | 'all'>('all')

  const visible = useMemo(
    () =>
      notifications.filter(
        (n) =>
          (channel === 'all' || n.channel === channel) &&
          (status === 'all' || n.status === status) &&
          matchesSearch(query, n.targetName, n.clientName, n.recipient, n.error),
      ),
    [notifications, query, channel, status],
  )

  return (
    <section className="card section-card" aria-labelledby="history-title">
      <header className="section-header">
        <div className="section-title">
          <span className="icon-chip tone-mint">
            <Icon name="refresh" />
          </span>
          <div>
            <h2 id="history-title">Notification history</h2>
            <p className="section-subtitle">
              {visible.length === notifications.length ? `${notifications.length} most recent` : `${visible.length} of ${notifications.length} shown`}
            </p>
          </div>
        </div>
        <div className="toolbar">
          <label htmlFor="history-channel" className="visually-hidden">
            Filter by channel
          </label>
          <select id="history-channel" className="select-pill" value={channel} onChange={(e) => setChannel(e.target.value as NotificationChannel | 'all')}>
            <option value="all">All channels</option>
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
          <label htmlFor="history-status" className="visually-hidden">
            Filter by status
          </label>
          <select id="history-status" className="select-pill" value={status} onChange={(e) => setStatus(e.target.value as NotificationStatus | 'all')}>
            <option value="all">All statuses</option>
            {(Object.keys(statusLabels) as NotificationStatus[]).map((s) => (
              <option key={s} value={s}>
                {statusLabels[s]}
              </option>
            ))}
          </select>
          <SearchBox id="history-search" label="Search notifications" value={query} onChange={setQuery} placeholder="Search client or renewal" />
        </div>
      </header>
      <p className="section-subtitle history-legend">
        <strong>Sent</strong> means the provider accepted the message. <strong>Delivered</strong> and <strong>Read</strong> are
        shown only when the provider confirms them.
      </p>
      {visible.length === 0 ? (
        <p className="empty-state">{notifications.length === 0 ? 'No reminders sent yet.' : 'No reminders match your filters.'}</p>
      ) : (
        <div className="table-scroll">
          <table className="domain-table data-table">
            <caption className="visually-hidden">Reminders sent, most recent first</caption>
            <thead>
              <tr>
                <th scope="col">Renewal for</th>
                <th scope="col">Renewal date</th>
                <th scope="col">Channel</th>
                <th scope="col">Reminder</th>
                <th scope="col">Sent</th>
                <th scope="col">Status</th>
                <th scope="col" className="cell-actions">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((n) => {
                const canRetry = n.status === 'failed' && !n.retryRequested && n.attempts < MAX_MANUAL_ATTEMPTS && n.renewalId !== null
                return (
                  <tr key={n.id} className={n.status === 'failed' ? 'urgency-urgent' : undefined}>
                    <td className="cell-domain cell-wrap">
                      {n.targetName}
                      <span className="cell-sub">
                        {n.targetKind === 'hosting' ? 'Hosting' : 'Domain'}
                        {n.clientName && ` · ${n.clientName}`}
                        {n.amount !== null && n.currency && ` · ${formatMoney(n.amount, n.currency)}`}
                      </span>
                    </td>
                    <td data-label="Renews">{formatDate(n.dueDate)}</td>
                    <td data-label="Channel" className="cell-wrap">
                      {channelLabels[n.channel]}
                      <span className="cell-sub">{n.recipient}</span>
                    </td>
                    <td data-label="Reminder">{describeReminderStage(n.stage)}</td>
                    <td data-label="Sent">
                      {new Date(n.sentAt ?? n.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                    <td data-label="Status" className="cell-status cell-wrap">
                      <span className={`badge ${statusBadge[n.status]}`}>{statusLabels[n.status]}</span>
                      {n.status === 'failed' && (
                        <span className="cell-sub">
                          {n.error}
                          {n.retryRequested
                            ? ' Retry requested.'
                            : n.retryable && n.nextAttemptAt
                              ? ` Retrying automatically after ${new Date(n.nextAttemptAt).toLocaleString()}.`
                              : ''}
                        </span>
                      )}
                    </td>
                    <td className="cell-actions">
                      {canRetry && (
                        <Button variant="secondary" icon="refresh" onClick={() => onRetry(n)}>
                          Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
