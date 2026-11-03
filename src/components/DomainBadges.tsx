import { lifecycleLabels } from '../data/options'
import type { Domain, PaymentStatus } from '../types/domain'
import { daysUntilExpiry, getExpiryUrgency, urgencyLabels, type ExpiryUrgency } from '../utils/domainStatus'
import { Icon } from './Icon'

export function ExpiryBadge({ urgency }: { urgency: ExpiryUrgency }) {
  return <span className={`badge badge-${urgency}`}>{urgencyLabels[urgency]}</span>
}

/** Only shown when something is owed, so it never hides the expiry badge. */
export function PaymentBadge({ status }: { status: PaymentStatus }) {
  if (status !== 'pending') return null
  return (
    <span className="badge badge-payment">
      <Icon name="wallet" size={14} />
      Payment pending
    </span>
  )
}

/** Expiry urgency and payment status side by side. */
export function DomainBadges({ domain }: { domain: Domain }) {
  return (
    <span className="badge-group">
      {domain.lifecycle === 'active' ? (
        domain.expiryDate && <ExpiryBadge urgency={getExpiryUrgency(daysUntilExpiry(domain))} />
      ) : (
        <span className="badge badge-calm">{lifecycleLabels[domain.lifecycle]}</span>
      )}
      <PaymentBadge status={domain.paymentStatus} />
    </span>
  )
}
