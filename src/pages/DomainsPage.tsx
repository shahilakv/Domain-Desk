import { useMemo, useState } from 'react'
import { Button } from '../components/Button'
import { DomainTable } from '../components/DomainTable'
import { Icon } from '../components/Icon'
import { PageHeader, SearchBox } from '../components/PageHeader'
import { lifecycleLabels } from '../data/options'
import type { Domain } from '../types/domain'
import { compareByExpiry } from '../utils/domainStatus'
import { matchesSearch } from '../utils/format'

interface DomainsPageProps {
  domains: Domain[]
  onAdd: () => void
  onImport: () => void
  onEdit: (domain: Domain) => void
  onDelete: (domain: Domain) => void
}

export function DomainsPage({ domains, onAdd, onImport, onEdit, onDelete }: DomainsPageProps) {
  const [query, setQuery] = useState('')

  const visible = useMemo(
    () =>
      domains
        .filter((d) => matchesSearch(query, d.name, d.client, d.registrar, d.notes, lifecycleLabels[d.lifecycle]))
        .sort(compareByExpiry),
    [domains, query],
  )

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
                {query ? `${visible.length} of ${domains.length} shown` : `${domains.length} total, soonest expiry first`}
              </p>
            </div>
          </div>
          <SearchBox
            id="domain-search"
            label="Search domains"
            value={query}
            onChange={setQuery}
            placeholder="Search domain, client or registrar"
          />
        </header>
        <DomainTable
          domains={visible}
          caption="All domains ordered by expiry date"
          emptyMessage={domains.length === 0 ? 'No domains yet. Add your first domain to get started.' : 'No domains match your search.'}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </section>
    </>
  )
}
