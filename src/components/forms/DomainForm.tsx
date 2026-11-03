import { useState } from 'react'
import { DEFAULT_OWNERSHIP, domainLifecycles, ownershipTypes } from '../../data/options'
import { describeError, saveDomain } from '../../lib/api'
import type { DomainInput } from '../../types/db'
import type { Client, Domain, DomainLifecycle, OwnershipType } from '../../types/domain'
import { isValidDomainName, normalizeDomainName, nullIfEmpty } from '../../utils/format'
import { Field, FormDialog } from '../FormDialog'

interface DomainFormProps {
  userId: string
  domain?: Domain
  clients: Client[]
  /** Existing names, used to catch duplicates before the database does. */
  existingNames: string[]
  onSaved: (message: string) => void
  onClose: () => void
}

export function DomainForm({ userId, domain, clients, existingNames, onSaved, onClose }: DomainFormProps) {
  const [name, setName] = useState(domain?.name ?? '')
  const [clientId, setClientId] = useState(domain?.clientId ?? '')
  const [registrar, setRegistrar] = useState(domain?.registrar ?? '')
  const [expiryDate, setExpiryDate] = useState(domain?.expiryDate ?? '')
  const [lifecycle, setLifecycle] = useState<DomainLifecycle>(domain?.lifecycle ?? 'active')
  const [autoRenew, setAutoRenew] = useState(domain?.autoRenew ?? false)
  const [ownership, setOwnership] = useState<OwnershipType>(domain?.ownershipType ?? DEFAULT_OWNERSHIP)
  const [notes, setNotes] = useState(domain?.notes ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const normalized = normalizeDomainName(name)
    if (!normalized) return setError('Enter the domain name.')
    if (!isValidDomainName(normalized)) return setError(`"${normalized}" doesn't look like a valid domain name.`)
    if (normalized !== domain?.name && existingNames.includes(normalized)) {
      return setError(`${normalized} is already in your list.`)
    }
    // Registrar-imported domains may have no expiry (e.g. Hostinger free-domain entitlements).
    if (!expiryDate && !domain?.provider) return setError('Enter the expiry date.')

    setError(null)
    setSubmitting(true)
    try {
      const values: DomainInput = {
        domain_name: normalized,
        client_id: clientId || null,
        registrar: nullIfEmpty(registrar),
        expiry_date: expiryDate || null,
        status: lifecycle,
        auto_renew: autoRenew,
        notes: nullIfEmpty(notes),
        ownership_type: ownership,
      }
      await saveDomain(userId, values, domain?.id)
      onSaved(domain ? `Saved ${normalized}.` : `Added ${normalized}.`)
    } catch (err) {
      setError(describeError(err))
      setSubmitting(false)
    }
  }

  return (
    <FormDialog
      title={domain ? 'Edit domain' : 'Add domain'}
      submitLabel={domain ? 'Save changes' : 'Add domain'}
      editing={Boolean(domain)}
      submitting={submitting}
      error={error}
      onSubmit={submit}
      onClose={onClose}
    >
      <Field label="Domain name *" htmlFor="domain-name" full>
        <input
          id="domain-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="example.com.au"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
        />
      </Field>
      <Field label="Client" htmlFor="domain-client" full hint={clients.length === 0 ? 'Add clients on the Clients page.' : undefined}>
        <select id="domain-client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">No client</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Registrar" htmlFor="domain-registrar">
        <input
          id="domain-registrar"
          value={registrar}
          onChange={(e) => setRegistrar(e.target.value)}
          placeholder="e.g. VentraIP"
          maxLength={200}
        />
      </Field>
      <Field label={domain?.provider ? 'Expiry date' : 'Expiry date *'} htmlFor="domain-expiry">
        <input
          id="domain-expiry"
          type="date"
          value={expiryDate}
          onChange={(e) => setExpiryDate(e.target.value)}
          required={!domain?.provider}
        />
      </Field>
      <Field label="Status" htmlFor="domain-status">
        <select id="domain-status" value={lifecycle} onChange={(e) => setLifecycle(e.target.value as DomainLifecycle)}>
          {domainLifecycles.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Ownership" htmlFor="domain-ownership">
        <select id="domain-ownership" value={ownership} onChange={(e) => setOwnership(e.target.value as OwnershipType)}>
          {ownershipTypes.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="field field-checkbox">
        <label>
          <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
          Auto-renew is on at the registrar
        </label>
      </div>
      <Field label="Notes" htmlFor="domain-notes" full>
        <textarea id="domain-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </FormDialog>
  )
}
