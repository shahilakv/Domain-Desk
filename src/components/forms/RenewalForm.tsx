import { useState } from 'react'
import { DEFAULT_CURRENCY, renewalStatuses } from '../../data/options'
import { describeError, saveRenewal } from '../../lib/api'
import type { Domain, Renewal, RenewalStatus } from '../../types/domain'
import { formatMoney, nullIfEmpty, parseAmount } from '../../utils/format'
import { Field, FormDialog } from '../FormDialog'

interface RenewalFormProps {
  userId: string
  renewal?: Renewal
  domains: Domain[]
  onSaved: (message: string) => void
  onClose: () => void
}

export function RenewalForm({ userId, renewal, domains, onSaved, onClose }: RenewalFormProps) {
  const [domainId, setDomainId] = useState(renewal?.domainId ?? '')
  const [renewalDate, setRenewalDate] = useState(renewal?.renewalDate ?? '')
  const [registrarCost, setRegistrarCost] = useState(renewal?.registrarCost?.toString() ?? '')
  const [clientCharge, setClientCharge] = useState(renewal?.clientCharge?.toString() ?? '')
  const [currency, setCurrency] = useState(renewal?.currency ?? DEFAULT_CURRENCY)
  const [status, setStatus] = useState<RenewalStatus>(renewal?.status ?? 'scheduled')
  const [notes, setNotes] = useState(renewal?.notes ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cost = parseAmount(registrarCost)
  const charge = parseAmount(clientCharge)
  const code = currency.trim().toUpperCase()
  const margin = typeof cost === 'number' && typeof charge === 'number' ? charge - cost : null

  const pickDomain = (id: string) => {
    setDomainId(id)
    // Default the renewal date to the domain's current expiry.
    const domain = domains.find((d) => d.id === id)
    if (!renewalDate && domain?.expiryDate) setRenewalDate(domain.expiryDate)
  }

  const submit = async () => {
    if (!domainId) return setError('Choose the domain being renewed.')
    if (!renewalDate) return setError('Enter the renewal date.')
    if (cost === undefined) return setError('Registrar cost must be a positive amount, e.g. 24.95.')
    if (charge === undefined) return setError('Client charge must be a positive amount, e.g. 49.00.')
    if (!/^[A-Z]{3}$/.test(code)) return setError('Currency must be a 3-letter code such as AUD or USD.')

    setError(null)
    setSubmitting(true)
    try {
      await saveRenewal(
        userId,
        {
          domain_id: domainId,
          renewal_date: renewalDate,
          registrar_cost: cost,
          client_charge: charge,
          currency: code,
          status,
          notes: nullIfEmpty(notes),
        },
        renewal?.id,
      )
      const name = domains.find((d) => d.id === domainId)?.name ?? 'domain'
      onSaved(renewal ? `Saved renewal for ${name}.` : `Added renewal for ${name}.`)
    } catch (err) {
      setError(describeError(err))
      setSubmitting(false)
    }
  }

  return (
    <FormDialog
      title={renewal ? 'Edit renewal' : 'Add renewal'}
      submitLabel={renewal ? 'Save changes' : 'Add renewal'}
      editing={Boolean(renewal)}
      submitting={submitting}
      error={error}
      onSubmit={submit}
      onClose={onClose}
    >
      <Field label="Domain *" htmlFor="renewal-domain" full>
        <select id="renewal-domain" value={domainId} onChange={(e) => pickDomain(e.target.value)} required autoFocus>
          <option value="" disabled>
            Choose a domain…
          </option>
          {domains.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.client ? ` — ${d.client}` : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Renewal date *" htmlFor="renewal-date">
        <input id="renewal-date" type="date" value={renewalDate} onChange={(e) => setRenewalDate(e.target.value)} required />
      </Field>
      <Field label="Status" htmlFor="renewal-status">
        <select id="renewal-status" value={status} onChange={(e) => setStatus(e.target.value as RenewalStatus)}>
          {renewalStatuses.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Registrar cost" htmlFor="renewal-cost" hint="What the registrar charges you">
        <input
          id="renewal-cost"
          inputMode="decimal"
          value={registrarCost}
          onChange={(e) => setRegistrarCost(e.target.value)}
          placeholder="0.00"
        />
      </Field>
      <Field label="Client charge" htmlFor="renewal-charge" hint="What you bill the client">
        <input
          id="renewal-charge"
          inputMode="decimal"
          value={clientCharge}
          onChange={(e) => setClientCharge(e.target.value)}
          placeholder="0.00"
        />
      </Field>
      <Field
        label="Currency"
        htmlFor="renewal-currency"
        hint={margin !== null && /^[A-Z]{3}$/.test(code) ? `Margin: ${formatMoney(margin, code)}` : undefined}
      >
        <input
          id="renewal-currency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          maxLength={3}
          autoCapitalize="characters"
          spellCheck={false}
        />
      </Field>
      <Field label="Notes" htmlFor="renewal-notes" full>
        <textarea
          id="renewal-notes"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Invoice number, renewal term…"
        />
      </Field>
    </FormDialog>
  )
}
