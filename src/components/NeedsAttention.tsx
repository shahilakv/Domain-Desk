import type { Domain, DomainStatus } from '../types/domain'
import type { Tone } from '../types/tone'
import { describeExpiry, daysUntilExpiry, getDomainStatus, getExpiryUrgency } from '../utils/domainStatus'
import { DeleteButton } from './DeleteButton'
import { DemoTag } from './DemoTag'
import { DomainBadges } from './DomainBadges'
import { DomainName } from './DomainName'
import { Icon, type IconName } from './Icon'

interface NeedsAttentionProps {
  domains: Domain[]
  onDelete: (domain: Domain) => void
}

const statusVisuals: Record<DomainStatus, { icon: IconName; tone: Tone }> = {
  expired: { icon: 'alert', tone: 'coral' },
  'payment-pending': { icon: 'wallet', tone: 'sunny' },
  'renewal-due': { icon: 'calendar', tone: 'lavender' },
  active: { icon: 'globe', tone: 'mint' },
}

export function NeedsAttention({ domains, onDelete }: NeedsAttentionProps) {
  return (
    <section className="card section-card" aria-labelledby="needs-attention-title">
      <header className="section-header">
        <div className="section-title">
          <span className="icon-chip tone-coral">
            <Icon name="alert" />
          </span>
          <div>
            <h2 id="needs-attention-title" className="heading-with-tag">
              Needs Attention <DemoTag />
            </h2>
            <p className="section-subtitle">Expired, unpaid or renewing within 30 days</p>
          </div>
        </div>
      </header>

      {domains.length === 0 ? (
        <p className="empty-state">Nothing needs attention right now.</p>
      ) : (
        <ul className="attention-list">
          {domains.map((domain) => {
            const status = getDomainStatus(domain)
            const visual = statusVisuals[status]
            const days = daysUntilExpiry(domain)
            return (
              <li key={domain.id} className="attention-item">
                <span className={`icon-chip icon-chip-sm tone-${visual.tone}`} aria-hidden="true">
                  <Icon name={visual.icon} size={18} />
                </span>
                <div className="attention-main">
                  <span className="attention-domain">
                    <DomainName name={domain.name} />
                  </span>
                  <span className="attention-meta">
                    <span className="attention-client">{domain.client}</span>
                    <span className={`attention-expiry countdown urgency-${getExpiryUrgency(days)}`}>
                      {describeExpiry(days)}
                    </span>
                  </span>
                </div>
                <div className="attention-actions">
                  <DomainBadges domain={domain} />
                  <DeleteButton domainName={domain.name} onClick={() => onDelete(domain)} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
