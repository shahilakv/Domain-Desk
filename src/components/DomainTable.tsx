import type { Domain } from '../types/domain'
import { daysUntilExpiry, describeExpiry, formatDate, getExpiryUrgency } from '../utils/domainStatus'
import { DeleteButton } from './DeleteButton'
import { DomainBadges } from './DomainBadges'
import { DomainName } from './DomainName'

interface DomainTableProps {
  domains: Domain[]
  caption: string
  onDelete: (domain: Domain) => void
}

export function DomainTable({ domains, caption, onDelete }: DomainTableProps) {
  if (domains.length === 0) {
    return <p className="empty-state">No domains to show yet.</p>
  }

  return (
    <div className="table-scroll">
      <table className="domain-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Domain name</th>
            <th scope="col">Client</th>
            <th scope="col">Registrar</th>
            <th scope="col">Expiry date</th>
            <th scope="col">Status</th>
            <th scope="col" className="cell-actions">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {domains.map((domain) => {
            const days = daysUntilExpiry(domain)
            const urgency = getExpiryUrgency(days)
            return (
              <tr key={domain.id} className={`urgency-${urgency}`}>
                {/* data-label is shown as a field label in the card layouts. */}
                <td className="cell-domain">
                  <DomainName name={domain.name} />
                </td>
                <td className="cell-client" data-label="Client">
                  {domain.client}
                </td>
                <td className="cell-registrar cell-muted" data-label="Registrar">
                  {domain.registrar}
                </td>
                <td className="cell-expiry" data-label="Expiry">
                  <span className="countdown">{describeExpiry(days)}</span>
                  <time dateTime={domain.expiryDate}>{formatDate(domain.expiryDate)}</time>
                </td>
                <td className="cell-status" data-label="Status">
                  <DomainBadges domain={domain} />
                </td>
                <td className="cell-actions">
                  <DeleteButton domainName={domain.name} onClick={() => onDelete(domain)} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
