import { useMemo, useState } from 'react'
import { Button } from '../components/Button'
import { RowActions } from '../components/DeleteButton'
import { Icon } from '../components/Icon'
import { PageHeader, SearchBox } from '../components/PageHeader'
import { hostingStatuses, hostingStatusLabels } from '../data/options'
import type { HostingPlan, HostingStatus } from '../types/domain'
import { daysUntil, describeDue, formatDate, getExpiryUrgency } from '../utils/domainStatus'
import { formatMoney, formatTotals, matchesSearch, sumByCurrency } from '../utils/format'

interface HostingPageProps {
  plans: HostingPlan[]
  /** Why hosting plans could not be loaded; null when they loaded. */
  unavailable: string | null
  onAdd: () => void
  onEdit: (plan: HostingPlan) => void
  onDelete: (plan: HostingPlan) => void
}

const statusBadge: Record<HostingStatus, string> = {
  active: 'badge-calm',
  suspended: 'badge-urgent',
  cancelled: 'badge-calm',
}

/** How many linked domain names to show before "+N more". */
const DOMAINS_SHOWN = 2

function margin(p: HostingPlan): number | null {
  return p.clientCharge !== null && p.hostingCost !== null ? p.clientCharge - p.hostingCost : null
}

export function HostingPage({ plans, unavailable, onAdd, onEdit, onDelete }: HostingPageProps) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<HostingStatus | 'all'>('all')

  const visible = useMemo(
    () =>
      plans.filter(
        (p) =>
          (status === 'all' || p.status === status) &&
          matchesSearch(query, p.planName, p.provider, p.client, p.notes, ...p.domainNames),
      ),
    [plans, query, status],
  )

  // Totals per currency; cancelled plans are left out.
  const totals = useMemo(() => {
    const counted = visible.filter((p) => p.status !== 'cancelled')
    return {
      cost: formatTotals(sumByCurrency(counted.map((p) => ({ amount: p.hostingCost, currency: p.currency })))),
      charge: formatTotals(sumByCurrency(counted.map((p) => ({ amount: p.clientCharge, currency: p.currency })))),
      margin: formatTotals(sumByCurrency(counted.map((p) => ({ amount: margin(p), currency: p.currency })))),
    }
  }, [visible])

  return (
    <>
      <PageHeader
        eyebrow="Hosting Plans"
        title="Hosting and the domains it covers."
        subtitle="Track each plan's renewal date, what it costs you and what you bill the client."
        action={
          <Button
            icon="plus"
            onClick={onAdd}
            disabled={unavailable !== null}
            title={unavailable ?? undefined}
          >
            Add Hosting Plan
          </Button>
        }
      />

      <section className="card section-card" aria-labelledby="hosting-title">
        <header className="section-header">
          <div className="section-title">
            <span className="icon-chip tone-coral">
              <Icon name="server" />
            </span>
            <div>
              <h2 id="hosting-title">All Hosting Plans</h2>
              <p className="section-subtitle">
                {visible.length === plans.length
                  ? `${plans.length} total, soonest renewal first`
                  : `${visible.length} of ${plans.length} shown`}
              </p>
            </div>
          </div>
          <div className="toolbar">
            <label htmlFor="hosting-filter" className="visually-hidden">
              Filter by status
            </label>
            <select
              id="hosting-filter"
              className="select-pill"
              value={status}
              onChange={(e) => setStatus(e.target.value as HostingStatus | 'all')}
            >
              <option value="all">All statuses</option>
              {hostingStatuses.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <SearchBox
              id="hosting-search"
              label="Search hosting plans"
              value={query}
              onChange={setQuery}
              placeholder="Search plan, provider, client or domain"
            />
          </div>
        </header>

        {visible.length > 0 && totals.charge && (
          <dl className="totals-strip">
            <div>
              <dt>Hosting cost</dt>
              <dd>{totals.cost || '—'}</dd>
            </div>
            <div>
              <dt>Client charges</dt>
              <dd>{totals.charge}</dd>
            </div>
            <div>
              <dt>Margin</dt>
              <dd>{totals.margin || '—'}</dd>
            </div>
          </dl>
        )}

        {visible.length === 0 ? (
          <p className="empty-state">
            {unavailable
              ? unavailable
              : plans.length === 0
                ? 'No hosting plans yet. Add one to track its renewal and the domains it covers.'
                : 'No hosting plans match your filters.'}
          </p>
        ) : (
          <div className="table-scroll">
            <table className="domain-table data-table">
              <caption className="visually-hidden">Hosting plans ordered by renewal date</caption>
              <thead>
                <tr>
                  <th scope="col">Plan</th>
                  <th scope="col">Client</th>
                  <th scope="col">Domains</th>
                  <th scope="col">Renewal date</th>
                  <th scope="col">Hosting cost</th>
                  <th scope="col">Client charge</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="cell-actions">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => {
                  const days = p.renewalDate ? daysUntil(p.renewalDate) : null
                  const open = p.status !== 'cancelled'
                  const urgency = days !== null && open ? getExpiryUrgency(days) : 'calm'
                  const extra = p.domainNames.length - DOMAINS_SHOWN
                  return (
                    <tr key={p.id} className={`urgency-${urgency}`}>
                      <td className="cell-domain cell-wrap">
                        {p.planName}
                        <span className="cell-sub">
                          {p.provider}
                          {p.autoRenew ? ' · Auto-renew' : ''}
                        </span>
                      </td>
                      <td data-label="Client" className="cell-wrap">
                        {p.client || '—'}
                      </td>
                      <td data-label="Domains" className="cell-wrap">
                        {p.domainNames.length === 0
                          ? '—'
                          : p.domainNames.slice(0, DOMAINS_SHOWN).join(', ') + (extra > 0 ? ` +${extra} more` : '')}
                      </td>
                      <td className="cell-expiry" data-label="Renews">
                        {open && days !== null && <span className="countdown">{describeDue(days)}</span>}
                        <time dateTime={p.renewalDate ?? undefined}>{formatDate(p.renewalDate)}</time>
                      </td>
                      <td data-label="Cost" className="cell-money">
                        {formatMoney(p.hostingCost, p.currency)}
                      </td>
                      <td data-label="Charge" className="cell-money">
                        {formatMoney(p.clientCharge, p.currency)}
                      </td>
                      <td data-label="Status" className="cell-status">
                        <span className={`badge ${statusBadge[p.status]}`}>{hostingStatusLabels[p.status]}</span>
                      </td>
                      <td className="cell-actions">
                        <RowActions itemName={p.planName} onEdit={() => onEdit(p)} onDelete={() => onDelete(p)} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
