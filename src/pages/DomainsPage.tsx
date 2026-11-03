import { useMemo, useState } from 'react'
import { Button } from '../components/Button'
import { DomainTable } from '../components/DomainTable'
import { Icon } from '../components/Icon'
import { PageHeader, SearchBox } from '../components/PageHeader'
import { lifecycleLabels } from '../data/options'
import type { Domain, HostingPlan } from '../types/domain'
import { compareByExpiry } from '../utils/domainStatus'
import { matchesSearch } from '../utils/format'

interface DomainsPageProps {
  domains: Domain[]
  /** Null when hosting plans couldn't be loaded; hosting details are then hidden. */
  hostingPlans: HostingPlan[] | null
  onAdd: () => void
  onImport: () => void
  onEdit: (domain: Domain) => void
  onDelete: (domain: Domain) => void
}

type HostingFilter = 'all' | 'hosted' | 'unhosted'

export function DomainsPage({ domains, hostingPlans, onAdd, onImport, onEdit, onDelete }: DomainsPageProps) {
  const [query, setQuery] = useState('')
  const [hosting, setHosting] = useState<HostingFilter>('all')

  const planNames = useMemo(
    () => (hostingPlans ? new Map(hostingPlans.map((p) => [p.id, p.planName])) : undefined),
    [hostingPlans],
  )
  const unhosted = useMemo(() => domains.filter((d) => !d.hostingPlanId).length, [domains])

  const visible = useMemo(
    () =>
      domains
        .filter(
          (d) =>
            (hosting === 'all' || (hosting === 'hosted') === Boolean(d.hostingPlanId)) &&
            matchesSearch(
              query,
              d.name,
              d.client,
              d.registrar,
              d.notes,
              lifecycleLabels[d.lifecycle],
              d.hostingPlanId ? planNames?.get(d.hostingPlanId) : undefined,
            ),
        )
        .sort(compareByExpiry),
    [domains, query, hosting, planNames],
  )
  const filtered = query !== '' || hosting !== 'all'

  return (
    <>
      <PageHeader
        eyebrow="Domains"
        title="Every domain you manage."
        subtitle="Search, update and track expiry for each domain."
        action={
          <div className="hero-actions">
            <Button icon="plus" onClick={onAdd}>
              Add Domain
            </Button>
            <Button variant="secondary" icon="download" onClick={onImport}>
              Import from Hostinger
            </Button>
          </div>
        }
      />

      <section className="card section-card" aria-labelledby="domains-title">
        <header className="section-header">
          <div className="section-title">
            <span className="icon-chip tone-lavender">
              <Icon name="globe" />
            </span>
            <div>
              <h2 id="domains-title">All Domains</h2>
              <p className="section-subtitle">
                {filtered ? `${visible.length} of ${domains.length} shown` : `${domains.length} total, soonest expiry first`}
              </p>
            </div>
          </div>
          <div className="toolbar">
            {planNames && (
              <>
                <label htmlFor="domain-hosting-filter" className="visually-hidden">
                  Filter by hosting
                </label>
                <select
                  id="domain-hosting-filter"
                  className="select-pill"
                  value={hosting}
                  onChange={(e) => setHosting(e.target.value as HostingFilter)}
                >
                  <option value="all">All domains</option>
                  <option value="hosted">On a hosting plan</option>
                  <option value="unhosted">No hosting plan ({unhosted})</option>
                </select>
              </>
            )}
            <SearchBox
              id="domain-search"
              label="Search domains"
              value={query}
              onChange={setQuery}
              placeholder="Search domain, client or registrar"
            />
          </div>
        </header>
        <DomainTable
          domains={visible}
          caption="All domains ordered by expiry date"
          emptyMessage={domains.length === 0 ? 'No domains yet. Add your first domain to get started.' : 'No domains match your filters.'}
          planNames={planNames}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </section>
    </>
  )
}
