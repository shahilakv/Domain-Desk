import { useMemo, useState } from 'react'
import { Button } from '../components/Button'
import { RowActions } from '../components/DeleteButton'
import { DomainName } from '../components/DomainName'
import { Icon } from '../components/Icon'
import { PageHeader, SearchBox } from '../components/PageHeader'
import { renewalStatuses, renewalStatusLabels } from '../data/options'
import type { Renewal, RenewalKind, RenewalStatus } from '../types/domain'
import { daysUntil, describeDue, formatDate, getExpiryUrgency } from '../utils/domainStatus'
import { formatMoney, formatTotals, matchesSearch, sumByCurrency } from '../utils/format'

interface RenewalsPageProps {
  renewals: Renewal[]
  canAdd: boolean
  /** Why nothing can be added yet; shown on the disabled Add button. */
  addHint?: string
  onAdd: () => void
  onEdit: (renewal: Renewal) => void
  onDelete: (renewal: Renewal) => void
}

const statusBadge: Record<RenewalStatus, string> = {
  scheduled: 'badge-plan',
  invoiced: 'badge-soon',
  paid: 'badge-calm',
  cancelled: 'badge-calm',
}

const costLabels: Record<RenewalKind | 'all', string> = {
  all: 'Cost',
  domain: 'Registrar cost',
  hosting: 'Hosting cost',
}

function margin(r: Renewal): number | null {
  return r.clientCharge !== null && r.registrarCost !== null ? r.clientCharge - r.registrarCost : null
}

export function RenewalsPage({ renewals, canAdd, addHint, onAdd, onEdit, onDelete }: RenewalsPageProps) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<RenewalStatus | 'all'>('all')
  const [kind, setKind] = useState<RenewalKind | 'all'>('all')

  const visible = useMemo(
    () =>
      renewals.filter(
        (r) =>
          (kind === 'all' || r.kind === kind) &&
          (status === 'all' || r.status === status) &&
          matchesSearch(
            query,
            r.targetName,
            r.provider,
            r.clientName,
            r.notes,
            r.currency,
            renewalStatusLabels[r.status],
          ),
      ),
    [renewals, query, status, kind],
  )

  // Totals per currency; registrar cost and client charge stay separate.
  const totals = useMemo(() => {
    const counted = visible.filter((r) => r.status !== 'cancelled')
    return {
      cost: formatTotals(sumByCurrency(counted.map((r) => ({ amount: r.registrarCost, currency: r.currency })))),
      charge: formatTotals(sumByCurrency(counted.map((r) => ({ amount: r.clientCharge, currency: r.currency })))),
      margin: formatTotals(sumByCurrency(counted.map((r) => ({ amount: margin(r), currency: r.currency })))),
    }
  }, [visible])

  return (
    <>
      <PageHeader
        eyebrow="Renewals"
        title="Upcoming renewals and invoices."
        subtitle="Track what each domain and hosting renewal costs you and what you bill the client."
        action={
          <Button icon="plus" onClick={onAdd} disabled={!canAdd} title={canAdd ? undefined : addHint}>
            Add Renewal
          </Button>
        }
      />

      <section className="card section-card" aria-labelledby="renewals-title">
        <header className="section-header">
          <div className="section-title">
            <span className="icon-chip tone-peach">
              <Icon name="refresh" />
            </span>
            <div>
              <h2 id="renewals-title">Renewal Records</h2>
              <p className="section-subtitle">
                {visible.length === renewals.length
                  ? `${renewals.length} total, latest first`
                  : `${visible.length} of ${renewals.length} shown`}
              </p>
            </div>
          </div>
          <div className="toolbar">
            <label htmlFor="renewal-kind" className="visually-hidden">
              Filter by type
            </label>
            <select
              id="renewal-kind"
              className="select-pill"
              value={kind}
              onChange={(e) => setKind(e.target.value as RenewalKind | 'all')}
            >
              <option value="all">All types</option>
              <option value="domain">Domains</option>
              <option value="hosting">Hosting</option>
            </select>
            <label htmlFor="renewal-filter" className="visually-hidden">
              Filter by status
            </label>
            <select
              id="renewal-filter"
              className="select-pill"
              value={status}
              onChange={(e) => setStatus(e.target.value as RenewalStatus | 'all')}
            >
              <option value="all">All statuses</option>
              {renewalStatuses.map((o) => (
                <option key={o.value} value={o.value}>
                  {renewalStatusLabels[o.value]}
                </option>
              ))}
            </select>
            <SearchBox
              id="renewal-search"
              label="Search renewals"
              value={query}
              onChange={setQuery}
              placeholder="Search domain, plan or client"
            />
          </div>
        </header>

        {visible.length > 0 && totals.charge && (
          <dl className="totals-strip">
            <div>
              <dt>{costLabels[kind]}</dt>
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
            {renewals.length === 0
              ? canAdd
                ? 'No renewals recorded yet. Add one to track costs and client charges.'
                : 'Add a domain or hosting plan first, then record its renewals here.'
              : 'No renewals match your filters.'}
          </p>
        ) : (
          <div className="table-scroll">
            <table className="domain-table data-table">
              <caption className="visually-hidden">Renewal records</caption>
              <thead>
                <tr>
                  <th scope="col">Renewal for</th>
                  <th scope="col">Renewal date</th>
                  <th scope="col">{costLabels[kind]}</th>
                  <th scope="col">Client charge</th>
                  <th scope="col">Margin</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="cell-actions">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const days = r.renewalDate ? daysUntil(r.renewalDate) : null
                  const open = r.status === 'scheduled' || r.status === 'invoiced'
                  const urgency = days !== null && open ? getExpiryUrgency(days) : 'calm'
                  const m = margin(r)
                  return (
                    <tr key={r.id} className={`urgency-${urgency}`}>
                      {r.kind === 'hosting' ? (
                        <td className="cell-domain cell-wrap">
                          {r.targetName}
                          <span className="cell-sub">
                            Hosting{r.provider && ` · ${r.provider}`}
                            {r.clientName && ` · ${r.clientName}`}
                          </span>
                        </td>
                      ) : (
                        <td className="cell-domain">
                          <DomainName name={r.targetName} />
                          {r.clientName && <span className="cell-sub">{r.clientName}</span>}
                        </td>
                      )}
                      <td className="cell-expiry" data-label="Date">
                        {open && days !== null && <span className="countdown">{describeDue(days)}</span>}
                        <time dateTime={r.renewalDate ?? undefined}>{formatDate(r.renewalDate)}</time>
                      </td>
                      <td data-label="Cost" className="cell-money">
                        {formatMoney(r.registrarCost, r.currency)}
                      </td>
                      <td data-label="Charge" className="cell-money">
                        {formatMoney(r.clientCharge, r.currency)}
                      </td>
                      <td data-label="Margin" className={`cell-money${m !== null && m < 0 ? ' is-negative' : ''}`}>
                        {formatMoney(m, r.currency)}
                      </td>
                      <td data-label="Status" className="cell-status">
                        <span className={`badge ${statusBadge[r.status]}`}>{renewalStatusLabels[r.status]}</span>
                      </td>
                      <td className="cell-actions">
                        <RowActions
                          itemName={`renewal for ${r.targetName}`}
                          onEdit={() => onEdit(r)}
                          onDelete={() => onDelete(r)}
                        />
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
