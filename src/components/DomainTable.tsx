import type { Domain } from '../types/domain'
import { daysUntilExpiry, describeExpiry, formatDate, getExpiryUrgency } from '../utils/domainStatus'
import { RowActions } from './DeleteButton'
import { DomainBadges } from './DomainBadges'
import { DomainName } from './DomainName'

interface DomainTableProps {
  domains: Domain[]
  caption: string
  emptyMessage?: string
  onEdit?: (domain: Domain) => void
  onDelete: (domain: Domain) => void
  /** Plan names by id; when given, each domain shows the hosting plan it is on. */
  planNames?: Map<string, string>
}

export function DomainTable({
  domains,
  caption,
  emptyMessage = 'No domains to show yet.',
  onEdit,
  onDelete,
  planNames,
}: DomainTableProps) {
  if (domains.length === 0) {
    return <p className="empty-state">{emptyMessage}</p>
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
            // Transferred/cancelled domains no longer need renewing.
            const urgency = domain.lifecycle === 'active' ? getExpiryUrgency(days) : 'calm'
            return (
              <tr key={domain.id} className={`urgency-${urgency}`}>
                {/* data-label is shown as a field label in the card layouts. */}
                <td className="cell-domain">
                  <DomainName name={domain.name} />
                  {planNames && (
                    <span className="cell-sub">
                      {domain.hostingPlanId
                        ? `Hosting: ${planNames.get(domain.hostingPlanId) ?? 'linked plan'}`
                        : 'No hosting plan'}
                    </span>
                  )}
                </td>
                <td className="cell-client" data-label="Client">
                  {domain.client || <span className="cell-muted">No client</span>}
                </td>
                <td className="cell-registrar cell-muted" data-label="Registrar">
                  {domain.registrar || '—'}
                </td>
                <td className="cell-expiry" data-label="Expiry">
                  <span className="countdown">{describeExpiry(days)}</span>
                  {domain.expiryDate && <time dateTime={domain.expiryDate}>{formatDate(domain.expiryDate)}</time>}
                </td>
                <td className="cell-status" data-label="Status">
                  <DomainBadges domain={domain} />
                </td>
                <td className="cell-actions">
                  <RowActions
                    itemName={domain.name}
                    onEdit={onEdit && (() => onEdit(domain))}
                    onDelete={() => onDelete(domain)}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
