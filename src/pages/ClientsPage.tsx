import { useMemo, useState } from 'react'
import { Button } from '../components/Button'
import { RowActions } from '../components/DeleteButton'
import { Icon } from '../components/Icon'
import { PageHeader, SearchBox } from '../components/PageHeader'
import type { Client } from '../types/domain'
import { matchesSearch } from '../utils/format'

interface ClientsPageProps {
  clients: Client[]
  onAdd: () => void
  onEdit: (client: Client) => void
  onDelete: (client: Client) => void
}

export function ClientsPage({ clients, onAdd, onEdit, onDelete }: ClientsPageProps) {
  const [query, setQuery] = useState('')

  const visible = useMemo(
    () => clients.filter((c) => matchesSearch(query, c.name, c.contactName, c.email, c.phone, c.notes)),
    [clients, query],
  )

  return (
    <>
      <PageHeader
        eyebrow="Clients"
        title="The people behind the domains."
        subtitle="Keep contact details for every client in one place."
        action={
          <Button icon="plus" onClick={onAdd}>
            Add Client
          </Button>
        }
      />

      <section className="card section-card" aria-labelledby="clients-title">
        <header className="section-header">
          <div className="section-title">
            <span className="icon-chip tone-mint">
              <Icon name="users" />
            </span>
            <div>
              <h2 id="clients-title">All Clients</h2>
              <p className="section-subtitle">
                {query ? `${visible.length} of ${clients.length} shown` : `${clients.length} total`}
              </p>
            </div>
          </div>
          <SearchBox
            id="client-search"
            label="Search clients"
            value={query}
            onChange={setQuery}
            placeholder="Search name, contact, email or phone"
          />
        </header>

        {visible.length === 0 ? (
          <p className="empty-state">
            {clients.length === 0 ? 'No clients yet. Add your first client to get started.' : 'No clients match your search.'}
          </p>
        ) : (
          <div className="table-scroll">
            <table className="domain-table data-table">
              <caption className="visually-hidden">Clients</caption>
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Contact</th>
                  <th scope="col">Email</th>
                  <th scope="col">Phone</th>
                  <th scope="col">Domains</th>
                  <th scope="col" className="cell-actions">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((client) => (
                  <tr key={client.id}>
                    <td className="cell-domain cell-wrap">{client.name}</td>
                    <td data-label="Contact">{client.contactName || '—'}</td>
                    <td data-label="Email" className="cell-wrap">
                      {client.email ? <a href={`mailto:${client.email}`}>{client.email}</a> : '—'}
                    </td>
                    <td data-label="Phone">{client.phone ? <a href={`tel:${client.phone}`}>{client.phone}</a> : '—'}</td>
                    <td data-label="Domains">{client.domainCount}</td>
                    <td className="cell-actions">
                      <RowActions itemName={client.name} onEdit={() => onEdit(client)} onDelete={() => onDelete(client)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
