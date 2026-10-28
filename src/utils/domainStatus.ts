import type { Domain, DomainStatus } from '../types/domain'

export const RENEWAL_WINDOW_DAYS = 30

const MS_PER_DAY = 24 * 60 * 60 * 1000

function startOfDay(date: Date): Date {
  const copy = new Date(date)
  copy.setHours(0, 0, 0, 0)
  return copy
}

/** Parses a YYYY-MM-DD string as a local date (not UTC). */
export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Whole days until expiry. Negative once the domain has expired. */
export function daysUntilExpiry(domain: Domain, today: Date = new Date()): number {
  const expiry = parseISODate(domain.expiryDate)
  return Math.round((expiry.getTime() - startOfDay(today).getTime()) / MS_PER_DAY)
}

export function isExpired(domain: Domain, today?: Date): boolean {
  return daysUntilExpiry(domain, today) < 0
}

export function isRenewalDue(domain: Domain, today?: Date): boolean {
  const days = daysUntilExpiry(domain, today)
  return days >= 0 && days <= RENEWAL_WINDOW_DAYS
}

/**
 * Single status for display. Order matters: an expired domain is the most
 * urgent, then an unpaid renewal, then an upcoming renewal.
 */
export function getDomainStatus(domain: Domain, today?: Date): DomainStatus {
  if (isExpired(domain, today)) return 'expired'
  if (domain.paymentStatus === 'pending') return 'payment-pending'
  if (isRenewalDue(domain, today)) return 'renewal-due'
  return 'active'
}

/** How close a domain is to expiry. Independent of payment status. */
export type ExpiryUrgency = 'expired' | 'urgent' | 'soon' | 'plan' | 'calm'

export const URGENT_WINDOW_DAYS = 7
export const PLAN_AHEAD_WINDOW_DAYS = 60

export function getExpiryUrgency(days: number): ExpiryUrgency {
  if (days < 0) return 'expired'
  if (days <= URGENT_WINDOW_DAYS) return 'urgent' // includes "expires today"
  if (days <= RENEWAL_WINDOW_DAYS) return 'soon'
  if (days <= PLAN_AHEAD_WINDOW_DAYS) return 'plan'
  return 'calm'
}

export const urgencyLabels: Record<ExpiryUrgency, string> = {
  expired: 'Expired',
  urgent: 'Urgent',
  soon: 'Renew soon',
  plan: 'Plan ahead',
  calm: 'On track',
}

export function formatDate(iso: string): string {
  return parseISODate(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function describeExpiry(days: number): string {
  if (days < 0) return `Expired ${Math.abs(days)} day${days === -1 ? '' : 's'} ago`
  if (days === 0) return 'Expires today'
  return `Expires in ${days} day${days === 1 ? '' : 's'}`
}
