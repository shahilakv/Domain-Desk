import type { HostingerHostingAccount } from './hostinger.ts'

/*
 * Pure rules for importing Hostinger hosting orders as DomainDesk hosting
 * plans. Kept free of I/O so the same rules drive the preview and the write,
 * and can be unit tested.
 *
 * Rules:
 *  - A plan is matched by its Hostinger order id (stored in hosting_plans.hostinger_order_id).
 *    Without a match it is created, or linked to a manual plan the user picked.
 *  - Hostinger keeps these fields current: renewal date, renewal cost,
 *    currency, auto-renew, status (start date only when empty).
 *  - Never written on an existing plan: provider, plan name, client, client
 *    charge, notes. A missing Hostinger value never clears a stored one.
 *  - Cost and currency are left alone when Hostinger bills in a different
 *    currency than the one the plan's client charge is recorded in.
 *  - Domains are linked only when Hostinger lists them as websites on the
 *    order, the exact name exists in DomainDesk, and the domain is not on any
 *    plan yet. Nothing creates domains or renewal records.
 */

export const HOSTINGER_PROVIDER = 'Hostinger'

/** The subset of a hosting_plans row the import reads. */
export interface ExistingHostingPlan {
  id: string
  provider: string
  plan_name: string
  start_date: string | null
  renewal_date: string | null
  hosting_cost: number | string | null
  client_charge: number | string | null
  currency: string | null
  auto_renew: boolean
  status: string
  hostinger_order_id: string | null
  hostinger_subscription_id: string | null
  provider_status: string | null
}

export interface DomainLink {
  id: string
  domain_name: string
  hosting_plan_id: string | null
}

/** Arguments for public.dd_sync_hostinger_plan. Null means "keep the stored value". */
export interface SyncArgs {
  orderId: string
  subscriptionId: string | null
  linkPlanId: string | null
  planName: string
  startDate: string | null
  renewalDate: string | null
  hostingCost: number | null
  currency: string | null
  autoRenew: boolean | null
  status: HostingStatus | null
  providerStatus: string
  domainIds: string[]
}

export type HostingStatus = 'active' | 'suspended' | 'cancelled'
export type HostingMatch = 'new' | 'link' | 'update' | 'unchanged'
export type DomainLinkState = 'link' | 'linked' | 'other_plan' | 'not_in_domaindesk'

export interface HostingDecision {
  kind: HostingMatch
  changes: string[]
  notes: string[]
  /** Fields Hostinger did not provide; to be entered by hand. */
  missing: string[]
  domains: { name: string; state: DomainLinkState; otherPlan?: string }[]
  /** Absent when nothing would change. */
  args?: SyncArgs
}

/** Hostinger order status → DomainDesk plan status. Unknown statuses keep the stored one. */
export function mapOrderStatus(status: string): HostingStatus | null {
  if (status === 'active') return 'active'
  if (status === 'suspended') return 'suspended'
  if (status === 'deleting' || status === 'deleted') return 'cancelled'
  return null
}

/** "hostinger_business" → "Hostinger Business". */
export function humanizePlanCode(code: string): string {
  return code
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function displayName(account: HostingerHostingAccount): string {
  return (
    account.subscriptionName ??
    (account.planCode ? humanizePlanCode(account.planCode) : `Hostinger hosting #${account.orderId}`)
  ).slice(0, 200)
}

function toNumber(value: number | string | null): number | null {
  if (value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

export function planHostingAccount(
  account: HostingerHostingAccount,
  existing: ExistingHostingPlan | undefined,
  linkTo: ExistingHostingPlan | undefined,
  domainsByName: Map<string, DomainLink>,
  planNames: Map<string, string>,
): HostingDecision {
  const target = existing ?? linkTo
  const changes: string[] = []
  const notes: string[] = []
  const missing: string[] = []

  if (!account.renewalDate) missing.push('renewal date')
  if (account.renewalPrice === null) missing.push('renewal price')
  if (account.subscriptionId && !account.subscriptionName) {
    notes.push('Hostinger returned no billing subscription for this order.')
  }

  const status = mapOrderStatus(account.orderStatus)
  let cost = account.currency ? account.renewalPrice : null
  let currency = account.currency
  if (account.renewalPrice !== null && !account.currency) {
    notes.push('Hostinger sent a price without a currency; the cost was not imported.')
  }

  if (target) {
    const targetCurrency = target.currency
    const chargeRecorded = toNumber(target.client_charge) !== null
    if (currency && targetCurrency && currency !== targetCurrency && chargeRecorded) {
      notes.push(
        `Hostinger bills in ${currency} but this plan's client charge is in ${targetCurrency}; cost and currency were kept.`,
      )
      cost = null
      currency = null
    }
  }

  // Domain links.
  const domainIds: string[] = []
  const domains = account.websites.map((site): HostingDecision['domains'][number] => {
    const row = domainsByName.get(site.name)
    if (!row) return { name: site.name, state: 'not_in_domaindesk' }
    if (row.hosting_plan_id === null) {
      domainIds.push(row.id)
      return { name: site.name, state: 'link' }
    }
    if (target && row.hosting_plan_id === target.id) return { name: site.name, state: 'linked' }
    return { name: site.name, state: 'other_plan', otherPlan: planNames.get(row.hosting_plan_id) ?? 'another plan' }
  })
  if (domainIds.length > 0) changes.push(`Link ${domainIds.length} domain${domainIds.length === 1 ? '' : 's'}`)

  // hosting_plans_dates_check requires renewal_date >= start_date.
  const renewalAfterSync = account.renewalDate ?? target?.renewal_date ?? null
  const startDate =
    account.createdDate && (!renewalAfterSync || account.createdDate <= renewalAfterSync) ? account.createdDate : null

  const args: SyncArgs = {
    orderId: account.orderId,
    subscriptionId: account.subscriptionId,
    linkPlanId: !existing && linkTo ? linkTo.id : null,
    planName: displayName(account),
    startDate,
    renewalDate: account.renewalDate,
    hostingCost: cost,
    currency,
    autoRenew: account.autoRenew,
    status,
    providerStatus: account.orderStatus,
    domainIds,
  }

  if (!target) {
    changes.unshift(`Add as ${HOSTINGER_PROVIDER} plan "${args.planName}"`)
    return { kind: 'new', changes, notes, missing, domains, args }
  }

  // What the sync would change on the existing (or linked) plan.
  const fieldChanges: string[] = []
  if (account.renewalDate && account.renewalDate !== target.renewal_date) {
    fieldChanges.push(target.renewal_date ? `Renewal ${target.renewal_date} → ${account.renewalDate}` : `Renewal date set to ${account.renewalDate}`)
  }
  if (cost !== null && cost !== toNumber(target.hosting_cost)) {
    fieldChanges.push(`Cost ${toNumber(target.hosting_cost) ?? '—'} → ${cost}`)
  }
  if (currency && currency !== target.currency) fieldChanges.push(`Currency ${target.currency ?? '—'} → ${currency}`)
  if (account.autoRenew !== null && account.autoRenew !== target.auto_renew) {
    fieldChanges.push(`Auto-renew ${account.autoRenew ? 'on' : 'off'}`)
  }
  if (status && status !== target.status) fieldChanges.push(`Status ${target.status} → ${status}`)
  if (!target.start_date && startDate) fieldChanges.push(`Start date set to ${startDate}`)
  if (target.provider_status && target.provider_status !== account.orderStatus) {
    fieldChanges.push(`Hostinger status: ${account.orderStatus}`)
  }
  const idChanged =
    target.hostinger_order_id !== account.orderId ||
    (account.subscriptionId !== null && target.hostinger_subscription_id !== account.subscriptionId) ||
    target.provider_status !== account.orderStatus
  changes.unshift(...fieldChanges)

  if (!existing) {
    changes.unshift(`Link "${target.plan_name}" to this Hostinger order`)
    return { kind: 'link', changes, notes, missing, domains, args }
  }
  if (fieldChanges.length === 0 && domainIds.length === 0 && !idChanged) {
    return { kind: 'unchanged', changes: [], notes, missing, domains }
  }
  return { kind: 'update', changes, notes, missing, domains, args }
}
