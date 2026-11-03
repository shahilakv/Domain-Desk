import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchHostingerHostingPreview,
  HostingerImportError,
  importHostingerHosting,
  type DomainLinkState,
  type HostingerHostingImportResult,
  type HostingerHostingItem,
  type HostingerHostingPreview,
  type HostingMatch,
} from '../lib/hostinger'
import { formatDate } from '../utils/domainStatus'
import { formatMoney, matchesSearch } from '../utils/format'
import { Button } from './Button'
import { Icon } from './Icon'

type Phase =
  | { step: 'loading' }
  | { step: 'error'; message: string }
  | { step: 'preview'; preview: HostingerHostingPreview }
  | { step: 'importing'; preview: HostingerHostingPreview }
  | { step: 'done'; preview: HostingerHostingPreview; result: HostingerHostingImportResult }

interface HostingerHostingImportProps {
  /** Called once after any import that wrote rows, so the workspace reloads. */
  onImported: () => void
  onClose: () => void
}

const matchLabels: Record<HostingMatch, string> = {
  new: 'New',
  link: 'Will link',
  update: 'Will update',
  unchanged: 'Up to date',
}

const matchBadge: Record<HostingMatch, string> = {
  new: 'badge-plan',
  link: 'badge-plan',
  update: 'badge-soon',
  unchanged: 'badge-calm',
}

const domainStateLabels: Record<DomainLinkState, string> = {
  link: 'will link',
  linked: 'linked',
  other_plan: 'on another plan, kept',
  not_in_domaindesk: 'not in DomainDesk',
}

/** Shown to explain what an import keeps current. */
const SYNC_RULE =
  'Imports keep the renewal date, cost, currency, auto-renew and status current. Plan name, client, client charge, notes and renewal records are never changed.'

function errorMessage(error: unknown): string {
  if (error instanceof HostingerImportError) return error.message
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

const isGone = (item: HostingerHostingItem) => item.orderStatus === 'deleted' || item.orderStatus === 'deleting'

/** Selected by default: plans the import would add or change, except orders Hostinger has deleted. */
function defaultSelection(preview: HostingerHostingPreview): Set<string> {
  return new Set(preview.items.filter((i) => i.match !== 'unchanged' && !isGone(i)).map((i) => i.orderId))
}

function orderStatusBadge(item: HostingerHostingItem): { label: string; className: string } {
  if (item.orderStatus === 'active') return { label: 'Active', className: 'badge-calm' }
  if (item.orderStatus === 'suspended') return { label: 'Suspended', className: 'badge-urgent' }
  if (isGone(item)) return { label: 'Deleted', className: 'badge-expired' }
  return { label: item.orderStatus.replace(/_/g, ' '), className: 'badge-soon' }
}

/**
 * Hostinger hosting import: fetch → preview & select → import → summary.
 * Mount only while open (like FormDialog).
 */
export function HostingerHostingImport({ onImported, onClose }: HostingerHostingImportProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [phase, setPhase] = useState<Phase>({ step: 'loading' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** orderId → manual plan id to link instead of creating a new plan. */
  const [linkTo, setLinkTo] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  useEffect(() => {
    let active = true
    fetchHostingerHostingPreview()
      .then((preview) => {
        if (!active) return
        setSelected(defaultSelection(preview))
        setLinkTo({})
        setPhase({ step: 'preview', preview })
      })
      .catch((error: unknown) => {
        if (active) setPhase({ step: 'error', message: errorMessage(error) })
      })
    return () => {
      active = false
    }
  }, [version])

  const load = () => {
    setPhase({ step: 'loading' })
    setImportError(null)
    setVersion((v) => v + 1)
  }

  const busy = phase.step === 'loading' || phase.step === 'importing'
  const preview = phase.step === 'loading' || phase.step === 'error' ? null : phase.preview

  const visible = useMemo(
    () =>
      preview
        ? preview.items.filter((i) =>
            matchesSearch(query, i.planName, i.planCode ?? '', i.orderId, matchLabels[i.match], ...i.domains.map((d) => d.name)),
          )
        : [],
    [preview, query],
  )

  const counts = useMemo(() => {
    const c = { imported: 0, toImport: 0, missing: 0 }
    for (const item of preview?.items ?? []) {
      if (item.existing) c.imported++
      else c.toImport++
      if (item.missing.length > 0) c.missing++
    }
    return c
  }, [preview])

  const toggle = (orderId: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(orderId)) next.delete(orderId)
      else next.add(orderId)
      return next
    })

  const allVisibleSelected = visible.length > 0 && visible.every((i) => selected.has(i.orderId))
  const toggleAllVisible = () =>
    setSelected((current) => {
      const next = new Set(current)
      for (const item of visible) {
        if (allVisibleSelected) next.delete(item.orderId)
        else next.add(item.orderId)
      }
      return next
    })

  // A manual plan can be the link target of only one order.
  const takenLinks = useMemo(() => new Set(Object.values(linkTo).filter(Boolean)), [linkTo])

  const runImport = async () => {
    if (phase.step !== 'preview') return
    const items = phase.preview.items.filter((i) => selected.has(i.orderId))
    if (items.length === 0) return setImportError('Select at least one hosting plan to import.')
    setImportError(null)
    setPhase({ step: 'importing', preview: phase.preview })
    try {
      const result = await importHostingerHosting(
        items.map((i) => ({ orderId: i.orderId, linkPlanId: i.existing ? null : linkTo[i.orderId] || null })),
      )
      setPhase({ step: 'done', preview: phase.preview, result })
      const { inserted, linked, updated } = result.summary
      if (inserted + linked + updated > 0) onImported()
    } catch (error) {
      setImportError(errorMessage(error))
      setPhase({ step: 'preview', preview: phase.preview })
    }
  }

  const close = () => {
    if (!busy) onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog import-dialog"
      aria-labelledby="hosting-import-title"
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="confirm-panel import-panel">
        <header className="import-header">
          <div className="section-title">
            <span className="icon-chip tone-coral">
              <Icon name="server" />
            </span>
            <div>
              <h2 id="hosting-import-title">Import hosting from Hostinger</h2>
              <ConnectionStatus phase={phase} />
            </div>
          </div>
          <button type="button" className="icon-button" onClick={close} disabled={busy} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        <div className="import-body">
          {phase.step === 'loading' && (
            <div className="status-card" role="status">
              <span className="spinner" aria-hidden="true" />
              <p>Fetching your Hostinger hosting plans…</p>
            </div>
          )}

          {phase.step === 'error' && (
            <div className="status-card" role="alert">
              <span className="icon-chip tone-coral">
                <Icon name="alert" />
              </span>
              <h3>Couldn't load your Hostinger hosting plans</h3>
              <p className="section-subtitle">{phase.message}</p>
              <Button variant="secondary" icon="refresh" onClick={load}>
                Try again
              </Button>
            </div>
          )}

          {phase.step === 'done' && <ImportSummary result={phase.result} />}

          {(phase.step === 'preview' || phase.step === 'importing') && (
            <>
              {!phase.preview.schemaReady && (
                <p className="import-alert" role="alert">
                  <Icon name="alert" size={18} />
                  <span>
                    Importing is disabled until the database migration{' '}
                    <code>20261105000000_hostinger_hosting_sync.sql</code> has been run in Supabase. The preview below
                    is read-only.
                  </span>
                </p>
              )}

              <div className="import-toolbar">
                <p className="import-counts">
                  <span className="badge badge-plan">{counts.toImport} not imported</span>
                  <span className="badge badge-calm">{counts.imported} imported</span>
                  {counts.missing > 0 && <span className="badge badge-soon">{counts.missing} missing info</span>}
                </p>
                <div className="search-box">
                  <label htmlFor="hosting-import-search" className="visually-hidden">
                    Filter Hostinger hosting plans
                  </label>
                  <Icon name="search" size={18} />
                  <input
                    id="hosting-import-search"
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter plans or domains"
                    autoComplete="off"
                  />
                </div>
              </div>

              {phase.preview.items.length === 0 ? (
                <p className="empty-state">
                  Your Hostinger account has no Web or Cloud hosting plans. (Agency Plan and VPS orders are not listed by
                  this part of the Hostinger API.)
                </p>
              ) : (
                <div className="import-scroll">
                  <table className="import-table">
                    <caption className="visually-hidden">Hosting plans in your Hostinger account</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="cell-select">
                          <input
                            type="checkbox"
                            checked={allVisibleSelected}
                            onChange={toggleAllVisible}
                            disabled={busy || visible.length === 0}
                            aria-label={allVisibleSelected ? 'Deselect all shown plans' : 'Select all shown plans'}
                          />
                        </th>
                        <th scope="col">Hosting plan</th>
                        <th scope="col">Renews</th>
                        <th scope="col">Domains</th>
                        <th scope="col">DomainDesk</th>
                        <th scope="col">Save as</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((item) => (
                        <PreviewRow
                          key={item.orderId}
                          item={item}
                          checked={selected.has(item.orderId)}
                          disabled={busy}
                          manualPlans={phase.preview.manualPlans}
                          linkTo={linkTo[item.orderId] ?? ''}
                          takenLinks={takenLinks}
                          onToggle={() => toggle(item.orderId)}
                          onLinkTo={(id) => setLinkTo((l) => ({ ...l, [item.orderId]: id }))}
                        />
                      ))}
                      {visible.length === 0 && (
                        <tr>
                          <td colSpan={6} className="empty-state">
                            No hosting plans match your filter.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="import-notices">
                <p className="import-note">
                  <Icon name="info" size={16} /> {SYNC_RULE} Domains are linked only when Hostinger lists them on the
                  plan, they are already in DomainDesk and not on another plan.
                </p>
                {phase.preview.warnings.map((w) => (
                  <p key={w} className="import-note">
                    <Icon name="alert" size={16} /> {w}
                  </p>
                ))}
                {phase.preview.skipped.length > 0 && (
                  <details>
                    <summary>
                      {phase.preview.skipped.length} Hostinger entr{phase.preview.skipped.length === 1 ? 'y' : 'ies'}{' '}
                      can't be imported
                    </summary>
                    <ul>
                      {phase.preview.skipped.map((s, i) => (
                        <li key={`${s.entry}-${i}`}>
                          <strong>{s.entry}</strong>: {s.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </>
          )}
        </div>

        {importError && (
          <p className="form-error" role="alert">
            {importError}
          </p>
        )}

        <footer className="confirm-actions import-actions">
          {phase.step === 'done' ? (
            <>
              <Button variant="secondary" icon="refresh" onClick={load}>
                Refresh from Hostinger
              </Button>
              <Button icon="check" onClick={onClose} autoFocus>
                Done
              </Button>
            </>
          ) : (
            <>
              {preview && (
                <Button variant="secondary" icon="refresh" onClick={load} disabled={busy}>
                  Refresh
                </Button>
              )}
              <Button variant="secondary" onClick={close} disabled={busy}>
                Cancel
              </Button>
              {preview && (
                <Button icon="download" onClick={runImport} disabled={busy || selected.size === 0 || !preview.schemaReady}>
                  {phase.step === 'importing'
                    ? 'Importing…'
                    : `Import ${selected.size} plan${selected.size === 1 ? '' : 's'}`}
                </Button>
              )}
            </>
          )}
        </footer>
      </div>
    </dialog>
  )
}

function ConnectionStatus({ phase }: { phase: Phase }) {
  if (phase.step === 'loading') return <p className="section-subtitle">Connecting…</p>
  if (phase.step === 'error') {
    return (
      <p className="section-subtitle import-status is-error">
        <span className="status-dot" aria-hidden="true" /> Not connected
      </p>
    )
  }
  const n = phase.preview.items.length
  const time = new Date(phase.preview.fetchedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return (
    <p className="section-subtitle import-status is-ok">
      <span className="status-dot" aria-hidden="true" /> Connected · {n} hosting plan{n === 1 ? '' : 's'} found ·
      fetched {time}
    </p>
  )
}

interface PreviewRowProps {
  item: HostingerHostingItem
  checked: boolean
  disabled: boolean
  manualPlans: HostingerHostingPreview['manualPlans']
  linkTo: string
  takenLinks: Set<string>
  onToggle: () => void
  onLinkTo: (planId: string) => void
}

function PreviewRow({ item, checked, disabled, manualPlans, linkTo, takenLinks, onToggle, onLinkTo }: PreviewRowProps) {
  const status = orderStatusBadge(item)
  const checkboxId = `hosting-import-${item.orderId}`
  const match: HostingMatch = !item.existing && linkTo ? 'link' : item.match
  return (
    <tr className={checked ? 'is-selected' : undefined}>
      <td className="cell-select">
        <input id={checkboxId} type="checkbox" checked={checked} onChange={onToggle} disabled={disabled} />
      </td>
      <td className="cell-domain">
        <label htmlFor={checkboxId}>{item.planName}</label>
        <span className="cell-sub">
          Order #{item.orderId}
          {item.billingPeriod && ` · billed every ${item.billingPeriod}`}
        </span>
        <span className={`badge ${status.className}`}>{status.label}</span>
      </td>
      <td data-label="Renews">
        {item.renewalDate ? (
          <time dateTime={item.renewalDate}>{formatDate(item.renewalDate)}</time>
        ) : (
          <span className="cell-muted">No date from Hostinger</span>
        )}
        <span className="cell-sub">
          {item.renewalPrice !== null && item.currency
            ? formatMoney(item.renewalPrice, item.currency)
            : 'No price from Hostinger'}
          {item.autoRenew !== null && (item.autoRenew ? ' · auto-renew on' : ' · auto-renew off')}
        </span>
      </td>
      <td data-label="Domains">
        {item.domains.length === 0 ? (
          <span className="cell-muted">None listed</span>
        ) : (
          item.domains.map((d) => (
            <span key={d.name} className="cell-sub">
              {d.name} <span className="cell-muted">({d.state === 'other_plan' ? `on ${d.otherPlan}, kept` : domainStateLabels[d.state]})</span>
            </span>
          ))
        )}
      </td>
      <td className="cell-match" data-label="DomainDesk">
        <span className={`badge ${matchBadge[match]}`}>{matchLabels[match]}</span>
        {item.existing && <span className="cell-sub">{item.existing.planName}</span>}
        {(item.match === 'update' || item.match === 'new') && item.changes.length > 0 && (
          <span className="cell-sub">{item.changes.join(' · ')}</span>
        )}
        {item.missing.length > 0 && (
          <span className="cell-sub import-note">Missing from Hostinger: {item.missing.join(', ')}. Enter it by hand.</span>
        )}
        {item.notes.map((note) => (
          <span key={note} className="cell-sub import-note">
            {note}
          </span>
        ))}
      </td>
      <td data-label="Save as">
        {item.existing ? (
          <span className="cell-muted">Already imported</span>
        ) : (
          <select
            className="select-pill"
            value={linkTo}
            onChange={(e) => onLinkTo(e.target.value)}
            disabled={disabled}
            aria-label={`Save ${item.planName} as`}
          >
            <option value="">New plan</option>
            {manualPlans.map((p) => (
              <option key={p.id} value={p.id} disabled={takenLinks.has(p.id) && linkTo !== p.id}>
                Link to {p.planName} ({p.provider})
              </option>
            ))}
          </select>
        )}
      </td>
    </tr>
  )
}

const outcomeLabels = {
  inserted: 'Added',
  linked: 'Linked',
  updated: 'Updated',
  unchanged: 'Up to date',
  failed: 'Failed',
} as const

function ImportSummary({ result }: { result: HostingerHostingImportResult }) {
  const { summary } = result
  const linkedDomains = result.results.reduce((n, r) => n + r.linkedDomains, 0)
  const listed = result.results.filter((r) => r.outcome !== 'unchanged')
  const unchanged = result.results.filter((r) => r.outcome === 'unchanged')
  return (
    <div className="import-summary" role="status">
      <dl className="totals-strip import-totals">
        <div>
          <dt>Added</dt>
          <dd>{summary.inserted}</dd>
        </div>
        <div>
          <dt>Linked / updated</dt>
          <dd>{summary.linked + summary.updated}</dd>
        </div>
        <div>
          <dt>Domains linked</dt>
          <dd>{linkedDomains}</dd>
        </div>
        <div className={summary.failed > 0 ? 'is-error' : undefined}>
          <dt>Failed</dt>
          <dd>{summary.failed}</dd>
        </div>
      </dl>

      {listed.length > 0 && (
        <section className="import-result-list" aria-labelledby="hosting-import-results-title">
          <h3 id="hosting-import-results-title">Results</h3>
          <ul>
            {listed.map((r) => (
              <li key={r.orderId} className={r.outcome === 'failed' ? 'is-error' : undefined}>
                <strong>{r.planName}</strong> ({outcomeLabels[r.outcome]}){r.message ? `: ${r.message}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
      {unchanged.length > 0 && (
        <details className="import-result-list">
          <summary>{unchanged.length} already up to date</summary>
          <ul>
            {unchanged.map((r) => (
              <li key={r.orderId}>
                <strong>{r.planName}</strong>: {r.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {result.warnings.map((w) => (
        <p key={w} className="import-note">
          <Icon name="alert" size={16} /> {w}
        </p>
      ))}
      <p className="section-subtitle">
        Hostinger doesn't know your clients or what you charge them: set the client and client charge on each plan from
        the Hosting Plans list.
      </p>
    </div>
  )
}
