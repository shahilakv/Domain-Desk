import { useMemo, useState } from 'react'
import { DEFAULT_CURRENCY, hostingStatuses } from '../../data/options'
import { describeError, saveHostingPlan } from '../../lib/api'
import type { Client, Domain, HostingPlan, HostingStatus } from '../../types/domain'
import { formatMoney, matchesSearch, nullIfEmpty, parseAmount } from '../../utils/format'
import { Field, FormDialog } from '../FormDialog'

interface HostingPlanFormProps {
  plan?: HostingPlan
  clients: Client[]
  domains: Domain[]
  /** Every plan, to show which plan a domain is currently on. */
  plans: HostingPlan[]
  onSaved: (message: string) => void
  onClose: () => void
}

/** Above this many domains the checklist gets a filter box. */
const FILTER_THRESHOLD = 8

export function HostingPlanForm({ plan, clients, domains, plans, onSaved, onClose }: HostingPlanFormProps) {
  const [provider, setProvider] = useState(plan?.provider ?? '')
  const [planName, setPlanName] = useState(plan?.planName ?? '')
  const [clientId, setClientId] = useState(plan?.clientId ?? '')
  const [status, setStatus] = useState<HostingStatus>(plan?.status ?? 'active')
  const [startDate, setStartDate] = useState(plan?.startDate ?? '')
  const [renewalDate, setRenewalDate] = useState(plan?.renewalDate ?? '')
  const [hostingCost, setHostingCost] = useState(plan?.hostingCost?.toString() ?? '')
  const [clientCharge, setClientCharge] = useState(plan?.clientCharge?.toString() ?? '')
  const [currency, setCurrency] = useState(plan?.currency ?? DEFAULT_CURRENCY)
  const [autoRenew, setAutoRenew] = useState(plan?.autoRenew ?? false)
  const [notes, setNotes] = useState(plan?.notes ?? '')
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(plan ? domains.filter((d) => d.hostingPlanId === plan.id).map((d) => d.id) : []),
  )
  const [domainQuery, setDomainQuery] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cost = parseAmount(hostingCost)
  const charge = parseAmount(clientCharge)
  const code = currency.trim().toUpperCase()
  const margin = typeof cost === 'number' && typeof charge === 'number' ? charge - cost : null

  const planNames = useMemo(() => new Map(plans.map((p) => [p.id, p.planName])), [plans])

  // The chosen client's domains first, then the rest (each group already sorted by name).
  const listed = useMemo(() => {
    const matching = domains.filter((d) => matchesSearch(domainQuery, d.name, d.client))
    if (!clientId) return matching
    return [...matching.filter((d) => d.clientId === clientId), ...matching.filter((d) => d.clientId !== clientId)]
  }, [domains, domainQuery, clientId])

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const submit = async () => {
    if (!provider.trim()) return setError('Enter the hosting provider.')
    if (!planName.trim()) return setError('Enter the plan name.')
    if (!renewalDate) return setError('Enter the renewal date.')
    if (startDate && startDate > renewalDate) return setError('The renewal date must be on or after the start date.')
    if (cost === undefined) return setError('Hosting cost must be a positive amount, e.g. 120.00.')
    if (charge === undefined) return setError('Client charge must be a positive amount, e.g. 240.00.')
    if (!/^[A-Z]{3}$/.test(code)) return setError('Currency must be a 3-letter code such as AUD or USD.')

    setError(null)
    setSubmitting(true)
    try {
      await saveHostingPlan(
        {
          provider: provider.trim(),
          plan_name: planName.trim(),
          client_id: clientId || null,
          start_date: startDate || null,
          renewal_date: renewalDate,
          hosting_cost: cost,
          client_charge: charge,
          currency: code,
          auto_renew: autoRenew,
          status,
          notes: nullIfEmpty(notes),
        },
        [...selected],
        plan?.id,
      )
      const name = planName.trim()
      onSaved(plan ? `Saved ${name}.` : `Added ${name}.`)
    } catch (err) {
      setError(describeError(err))
      setSubmitting(false)
    }
  }

  return (
    <FormDialog
      title={plan ? 'Edit hosting plan' : 'Add hosting plan'}
      submitLabel={plan ? 'Save changes' : 'Add hosting plan'}
      editing={Boolean(plan)}
      submitting={submitting}
      error={error}
      onSubmit={submit}
      onClose={onClose}
    >
      <Field label="Provider *" htmlFor="hosting-provider">
        <input
          id="hosting-provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          placeholder="e.g. Hostinger"
          maxLength={200}
          required
          autoFocus
        />
      </Field>
      <Field label="Plan name *" htmlFor="hosting-plan-name">
        <input
          id="hosting-plan-name"
          value={planName}
          onChange={(e) => setPlanName(e.target.value)}
          placeholder="e.g. Business Web Hosting"
          maxLength={200}
          required
        />
      </Field>
      <Field label="Client" htmlFor="hosting-client" hint={clients.length === 0 ? 'Add clients on the Clients page.' : undefined}>
        <select id="hosting-client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">No client</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Status" htmlFor="hosting-status">
        <select id="hosting-status" value={status} onChange={(e) => setStatus(e.target.value as HostingStatus)}>
          {hostingStatuses.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Start date" htmlFor="hosting-start">
        <input id="hosting-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
      </Field>
      <Field label="Renewal date *" htmlFor="hosting-renewal">
        <input
          id="hosting-renewal"
          type="date"
          value={renewalDate}
          onChange={(e) => setRenewalDate(e.target.value)}
          required
        />
      </Field>
      <Field label="Hosting cost" htmlFor="hosting-cost" hint="What the provider charges you">
        <input
          id="hosting-cost"
          inputMode="decimal"
          value={hostingCost}
          onChange={(e) => setHostingCost(e.target.value)}
          placeholder="0.00"
        />
      </Field>
      <Field label="Client charge" htmlFor="hosting-charge" hint="What you bill the client">
        <input
          id="hosting-charge"
          inputMode="decimal"
          value={clientCharge}
          onChange={(e) => setClientCharge(e.target.value)}
          placeholder="0.00"
        />
      </Field>
      <Field
        label="Currency"
        htmlFor="hosting-currency"
        hint={margin !== null && /^[A-Z]{3}$/.test(code) ? `Margin: ${formatMoney(margin, code)}` : undefined}
      >
        <input
          id="hosting-currency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          maxLength={3}
          autoCapitalize="characters"
          spellCheck={false}
        />
      </Field>
      <div className="field field-checkbox">
        <label>
          <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
          Auto-renew is on at the provider
        </label>
      </div>

      <fieldset className="field field-full check-list-field">
        <legend>
          Linked domains <span className="field-hint">({selected.size} selected)</span>
        </legend>
        {domains.length > FILTER_THRESHOLD && (
          <input
            type="search"
            aria-label="Filter domains"
            value={domainQuery}
            onChange={(e) => setDomainQuery(e.target.value)}
            placeholder="Filter domains"
          />
        )}
        {domains.length === 0 ? (
          <span className="field-hint">Add domains on the Domains page, then link them here.</span>
        ) : (
          <ul className="check-list">
            {listed.map((d) => {
              const otherPlan = d.hostingPlanId && d.hostingPlanId !== plan?.id ? planNames.get(d.hostingPlanId) : null
              return (
                <li key={d.id}>
                  <label>
                    <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                    <span>
                      {d.name}
                      {(d.client || otherPlan) && (
                        <span className="cell-sub">
                          {[d.client, otherPlan && `on ${otherPlan}${selected.has(d.id) ? ', will move here' : ''}`]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              )
            })}
            {listed.length === 0 && <li className="field-hint">No domains match.</li>}
          </ul>
        )}
      </fieldset>

      <Field label="Notes" htmlFor="hosting-notes" full>
        <textarea
          id="hosting-notes"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Server, login URL, billing term…"
        />
      </Field>
    </FormDialog>
  )
}
