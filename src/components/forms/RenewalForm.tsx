import { useState } from 'react'
import { DEFAULT_CURRENCY, renewalStatuses } from '../../data/options'
import { describeError, HOSTING_RENEWALS_MIGRATION_MESSAGE, isMissingColumn, saveRenewal } from '../../lib/api'
import type { Domain, HostingPlan, Renewal, RenewalKind, RenewalStatus } from '../../types/domain'
import { formatMoney, nullIfEmpty, parseAmount } from '../../utils/format'
import { CurrencySelect } from '../CurrencySelect'
import { Field, FormDialog } from '../FormDialog'

interface RenewalFormProps {
  userId: string
  renewal?: Renewal
  domains: Domain[]
  hostingPlans: HostingPlan[]
  /** Why hosting plans can't be chosen (e.g. not loaded); null when they can. */
  hostingUnavailable: string | null
  onSaved: (message: string) => void
  onClose: () => void
}

export function RenewalForm({
  userId,
  renewal,
  domains,
  hostingPlans,
  hostingUnavailable,
  onSaved,
  onClose,
}: RenewalFormProps) {
  const canPickHosting = hostingUnavailable === null && hostingPlans.length > 0
  const [kind, setKind] = useState<RenewalKind>(
    renewal?.kind ?? (domains.length === 0 && canPickHosting ? 'hosting' : 'domain'),
  )
  const [domainId, setDomainId] = useState(renewal?.domainId ?? '')
  const [hostingPlanId, setHostingPlanId] = useState(renewal?.hostingPlanId ?? '')
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
  const isHosting = kind === 'hosting'

  const pickDomain = (id: string) => {
    setDomainId(id)
    // Default the renewal date to the domain's current expiry.
    const domain = domains.find((d) => d.id === id)
    if (!renewalDate && domain?.expiryDate) setRenewalDate(domain.expiryDate)
  }

  const pickPlan = (id: string) => {
    setHostingPlanId(id)
    // Default empty fields to the plan's renewal date and pricing.
    const plan = hostingPlans.find((p) => p.id === id)
    if (!plan) return
    if (!renewalDate && plan.renewalDate) setRenewalDate(plan.renewalDate)
    if (!renewal && !registrarCost && !clientCharge) {
      if (plan.hostingCost !== null) setRegistrarCost(plan.hostingCost.toString())
      if (plan.clientCharge !== null) setClientCharge(plan.clientCharge.toString())
      setCurrency(plan.currency)
    }
  }

  const submit = async () => {
    if (isHosting ? !hostingPlanId : !domainId) {
      return setError(isHosting ? 'Choose the hosting plan being renewed.' : 'Choose the domain being renewed.')
    }
    if (!renewalDate) return setError('Enter the renewal date.')
    if (cost === undefined) return setError(`${isHosting ? 'Hosting' : 'Registrar'} cost must be a positive amount, e.g. 24.95.`)
    if (charge === undefined) return setError('Client charge must be a positive amount, e.g. 49.00.')
    if (!/^[A-Z]{3}$/.test(code)) return setError('Currency must be a 3-letter code such as AUD or USD.')

    setError(null)
    setSubmitting(true)
    const fields = {
      renewal_date: renewalDate,
      registrar_cost: cost,
      client_charge: charge,
      currency: code,
      status,
      notes: nullIfEmpty(notes),
    }
    try {
      // The type can't change on edit, so only the target column for this type is sent.
      await saveRenewal(
        userId,
        isHosting ? { ...fields, hosting_plan_id: hostingPlanId } : { ...fields, domain_id: domainId },
        renewal?.id,
      )
      const name = isHosting
        ? (hostingPlans.find((p) => p.id === hostingPlanId)?.planName ?? 'hosting plan')
        : (domains.find((d) => d.id === domainId)?.name ?? 'domain')
      onSaved(renewal ? `Saved renewal for ${name}.` : `Added renewal for ${name}.`)
    } catch (err) {
      setError(isHosting && isMissingColumn(err) ? HOSTING_RENEWALS_MIGRATION_MESSAGE : describeError(err))
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
      <Field
        label="Renewal for"
        htmlFor="renewal-kind"
        hint={renewal ? 'Fixed once the renewal is saved' : (hostingUnavailable ?? undefined)}
      >
        <select
          id="renewal-kind"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as RenewalKind)
            setError(null)
          }}
          disabled={Boolean(renewal)}
        >
          <option value="domain" disabled={domains.length === 0}>
            Domain
          </option>
          <option value="hosting" disabled={!canPickHosting && kind !== 'hosting'}>
            Hosting plan
          </option>
        </select>
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
      {isHosting ? (
        <Field label="Hosting plan *" htmlFor="renewal-plan" full>
          <select id="renewal-plan" value={hostingPlanId} onChange={(e) => pickPlan(e.target.value)} required autoFocus>
            <option value="" disabled>
              Choose a hosting plan…
            </option>
            {hostingPlans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.planName} ({p.provider}){p.client ? ` — ${p.client}` : ''}
              </option>
            ))}
          </select>
        </Field>
      ) : (
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
      )}
      <Field label="Renewal date *" htmlFor="renewal-date">
        <input id="renewal-date" type="date" value={renewalDate} onChange={(e) => setRenewalDate(e.target.value)} required />
      </Field>
      <Field
        label="Currency"
        htmlFor="renewal-currency"
        hint={margin !== null && /^[A-Z]{3}$/.test(code) ? `Margin: ${formatMoney(margin, code)}` : undefined}
      >
        <CurrencySelect id="renewal-currency" value={currency} onChange={setCurrency} />
      </Field>
      <Field
        label={isHosting ? 'Hosting cost' : 'Registrar cost'}
        htmlFor="renewal-cost"
        hint={isHosting ? 'What the hosting provider charges you' : 'What the registrar charges you'}
      >
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
