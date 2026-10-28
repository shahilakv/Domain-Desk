import type { Domain } from '../types/domain'
import { Button } from './Button'
import { DemoTag } from './DemoTag'
import { DomainTable } from './DomainTable'
import { Icon } from './Icon'

interface UpcomingExpiriesProps {
  /** Already sorted earliest expiry first. */
  domains: Domain[]
  onViewAll: () => void
  onDelete: (domain: Domain) => void
}

export function UpcomingExpiries({ domains, onViewAll, onDelete }: UpcomingExpiriesProps) {
  return (
    <section className="card section-card upcoming-card" aria-labelledby="upcoming-title">
      <header className="section-header">
        <div className="section-title">
          <span className="icon-chip tone-sky">
            <Icon name="calendar" />
          </span>
          <div>
            <h2 id="upcoming-title" className="heading-with-tag">
              Upcoming Expiries <DemoTag />
            </h2>
            <p className="section-subtitle">
              {domains.length > 0 ? `Next ${domains.length} domains, soonest first` : 'No upcoming expiries'}
            </p>
          </div>
        </div>
        <Button variant="secondary" icon="arrowRight" iconPosition="end" onClick={onViewAll}>
          View All Domains
        </Button>
      </header>
      <DomainTable domains={domains} caption="Domains ordered by upcoming expiry date" onDelete={onDelete} />
    </section>
  )
}
