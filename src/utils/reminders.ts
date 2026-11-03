import {
  addDays,
  daysBetween,
  eligibility,
  localClock,
  nextStage,
  normalizeStages,
  reasonLabels,
  type Channel,
} from '../../supabase/functions/_shared/reminderRules.ts'
import type { NotificationSettingsRow } from '../types/db'
import type { Client, Domain, HostingPlan, NotificationLogEntry, Renewal } from '../types/domain'

/*
 * Upcoming reminders as the scheduler will see them, computed in the browser
 * from the same rules (supabase/functions/_shared/reminderRules.ts) and the
 * same eligibility checks as the renewal-reminders Edge Function.
 */

export interface UpcomingReminder {
  key: string
  renewal: Renewal
  channel: Channel
  stage: number
  /** YYYY-MM-DD the reminder goes out. */
  sendDate: string
  recipient: string | null
  /** Why it won't be sent; null when it will. */
  blocked: string | null
}

export function upcomingReminders(
  settings: NotificationSettingsRow | null,
  renewals: Renewal[],
  domains: Domain[],
  plans: HostingPlan[],
  clients: Client[],
  log: NotificationLogEntry[],
  withinDays: number,
  now = new Date(),
): UpcomingReminder[] {
  if (!settings || (!settings.email_enabled && !settings.whatsapp_enabled)) return []
  const today = localClock(now, settings.timezone).date
  const stages = normalizeStages(settings.reminder_days)
  const domainsById = new Map(domains.map((d) => [d.id, d]))
  const plansById = new Map(plans.map((p) => [p.id, p]))
  const clientsById = new Map(clients.map((c) => [c.id, c]))
  const sent = new Set(log.map((l) => `${l.renewalId}|${l.channel}|${l.stage}|${l.dueDate}`))
  const result: UpcomingReminder[] = []

  for (const renewal of renewals) {
    if ((renewal.status !== 'scheduled' && renewal.status !== 'invoiced') || !renewal.renewalDate) continue
    const domain = renewal.domainId ? domainsById.get(renewal.domainId) : undefined
    const plan = renewal.hostingPlanId ? plansById.get(renewal.hostingPlanId) : undefined
    // Same exclusions as public.dd_reminder_candidates.
    if (domain && domain.lifecycle !== 'active') continue
    if (plan && plan.status === 'cancelled') continue
    if (!domain && !plan) continue
    const clientId = plan ? plan.clientId : domain?.clientId
    const client = clientId ? clientsById.get(clientId) : undefined

    const stage = nextStage(daysBetween(today, renewal.renewalDate), stages)
    if (stage === null) continue
    const sendDate = addDays(renewal.renewalDate, -stage)
    if (daysBetween(today, sendDate) > withinDays) continue

    for (const channel of ['email', 'whatsapp'] as const) {
      if (sent.has(`${renewal.id}|${channel}|${stage}|${renewal.renewalDate}`)) continue
      const check = eligibility(
        {
          client_id: client?.id ?? null,
          email: client?.email || null,
          email_reminders: client?.emailReminders ?? false,
          whatsapp_number: client?.whatsappNumber || null,
          whatsapp_opt_in: client?.whatsappOptIn ?? false,
        },
        settings,
        channel,
      )
      if (!check.ok && check.reason === 'channel_off') continue
      result.push({
        key: `${renewal.id}-${channel}`,
        renewal,
        channel,
        stage,
        sendDate,
        recipient: check.ok ? check.recipient : null,
        blocked: check.ok ? null : reasonLabels[check.reason],
      })
    }
  }
  return result.sort((a, b) => a.sendDate.localeCompare(b.sendDate) || a.renewal.targetName.localeCompare(b.renewal.targetName))
}

/** Dashboard counts; null when no reminder channel is turned on. */
export function reminderSummary(
  settings: NotificationSettingsRow | null,
  data: { renewals: Renewal[]; domains: Domain[]; hostingPlans: HostingPlan[]; clients: Client[]; notifications: NotificationLogEntry[] },
  now = new Date(),
): { upcoming: number; blocked: number; sent: number; failed: number } | null {
  if (!settings || (!settings.email_enabled && !settings.whatsapp_enabled)) return null
  const upcoming = upcomingReminders(settings, data.renewals, data.domains, data.hostingPlans, data.clients, data.notifications, 7, now)
  const weekAgo = now.getTime() - 7 * 86_400_000
  return {
    upcoming: upcoming.filter((u) => !u.blocked).length,
    blocked: upcoming.filter((u) => u.blocked).length,
    sent: data.notifications.filter((n) => n.status !== 'failed' && n.status !== 'pending' && Date.parse(n.createdAt) >= weekAgo).length,
    failed: data.notifications.filter((n) => n.status === 'failed' && !n.retryRequested).length,
  }
}

/** "15 days before", "On the renewal date", "3 days overdue". */
export function describeReminderStage(stage: number): string {
  if (stage === 0) return 'On the renewal date'
  if (stage > 0) return `${stage} day${stage === 1 ? '' : 's'} before`
  return `${-stage} day${stage === -1 ? '' : 's'} overdue`
}
