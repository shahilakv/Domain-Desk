import { useEffect, useMemo, useRef, useState } from 'react'
import { ownershipTypes } from '../data/options'
import {
  fetchHostingerPreview,
  HostingerImportError,
  importHostingerDomains,
  type HostingerImportResult,
  type HostingerPreview,
  type HostingerPreviewItem,
  type MatchKind,
} from '../lib/hostinger'
import type { OwnershipType } from '../types/domain'
import { daysUntil, formatDate } from '../utils/domainStatus'
import { matchesSearch } from '../utils/format'
import { Button } from './Button'
import { Icon } from './Icon'

type Phase =
  | { step: 'loading' }
  | { step: 'error'; message: string }
  | { step: 'preview'; preview: HostingerPreview }
  | { step: 'importing'; preview: HostingerPreview }
  | { step: 'done'; preview: HostingerPreview; result: HostingerImportResult }

interface HostingerImportProps {
  /** Called once after any import that wrote rows, so the workspace reloads. */
  onImported: () => void
  onClose: () => void
}

const matchLabels: Record<MatchKind, string> = {
  new: 'New',
  update: 'Will update',
  unchanged: 'Up to date',
}

const matchBadge: Record<MatchKind, string> = {
  new: 'badge-plan',
  update: 'badge-soon',
  unchanged: 'badge-calm',
}

function errorMessage(error: unknown): string {
  if (error instanceof HostingerImportError) return error.message
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

function hostingerStatusBadge(item: HostingerPreviewItem): { label: string; className: string } {
  if (item.status === 'expired' || (item.expiryDate && daysUntil(item.expiryDate) < 0)) {
    return { label: 'Expired', className: 'badge-expired' }
  }
  if (item.status === 'active') return { label: 'Active', className: 'badge-calm' }
  return { label: item.status.replace(/_/g, ' '), className: 'badge-soon' }
}

/** Selected by default: anything the import would change. Up-to-date rows are opt-in. */
function defaultSelection(preview: HostingerPreview): Set<string> {
  return new Set(preview.items.filter((i) => i.match !== 'unchanged').map((i) => i.name))
}

/**
 * Hostinger portfolio import: fetch → preview & select → import → summary.
 * Mount only while open (like FormDialog).
 */
export function HostingerImport({ onImported, onClose }: HostingerImportProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [phase, setPhase] = useState<Phase>({ step: 'loading' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [ownership, setOwnership] = useState<Record<string, OwnershipType>>({})
  const [query, setQuery] = useState('')
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  // Bumped by "Refresh"; each change refetches the preview (same pattern as useWorkspaceData).
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let active = true
    fetchHostingerPreview()
      .then((preview) => {
        if (!active) return
        setSelected(defaultSelection(preview))
        setOwnership({})
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
    () => (preview ? preview.items.filter((i) => matchesSearch(query, i.name, matchLabels[i.match], i.status)) : []),
    [preview, query],
  )

  const counts = useMemo(() => {
    const c: Record<MatchKind, number> = { new: 0, update: 0, unchanged: 0 }
    for (const item of preview?.items ?? []) c[item.match]++
    return c
  }, [preview])

  const toggle = (name: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const allVisibleSelected = visible.length > 0 && visible.every((i) => selected.has(i.name))
  const toggleAllVisible = () =>
    setSelected((current) => {
      const next = new Set(current)
      for (const item of visible) {
        if (allVisibleSelected) next.delete(item.name)
        else next.add(item.name)
      }
      return next
    })

  const ownershipFor = (item: HostingerPreviewItem): OwnershipType => ownership[item.name] ?? 'agency'

  const runImport = async () => {
    if (phase.step !== 'preview') return
    const items = phase.preview.items.filter((i) => selected.has(i.name))
    if (items.length === 0) return setImportError('Select at least one domain to import.')
    setImportError(null)
    setPhase({ step: 'importing', preview: phase.preview })
    try {
      const result = await importHostingerDomains(items.map((i) => ({ name: i.name, ownershipType: ownershipFor(i) })))
      setPhase({ step: 'done', preview: phase.preview, result })
      if (result.summary.inserted + result.summary.updated > 0) onImported()
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
      aria-labelledby="import-dialog-title"
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="confirm-panel import-panel">
        <header className="import-header">
          <div className="section-title">
            <span className="icon-chip tone-sky">
              <Icon name="download" />
            </span>
            <div>
              <h2 id="import-dialog-title">Import from Hostinger</h2>
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
              <p>Fetching your Hostinger domain portfolio…</p>
            </div>
          )}

          {phase.step === 'error' && (
            <div className="status-card" role="alert">
              <span className="icon-chip tone-coral">
                <Icon name="alert" />
              </span>
              <h3>Couldn't load your Hostinger domains</h3>
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
                    <code>20261102000000_hostinger_import.sql</code> has been run in Supabase. The preview below is
                    read-only.
                  </span>
                </p>
              )}

              <div className="import-toolbar">
                <p className="import-counts">
                  <span className="badge badge-plan">{counts.new} new</span>
                  <span className="badge badge-soon">{counts.update} to update</span>
                  <span className="badge badge-calm">{counts.unchanged} up to date</span>
                </p>
                <div className="search-box">
                  <label htmlFor="import-search" className="visually-hidden">
                    Filter Hostinger domains
                  </label>
                  <Icon name="search" size={18} />
                  <input
                    id="import-search"
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter domains"
                    autoComplete="off"
                  />
                </div>
              </div>

              {phase.preview.items.length === 0 ? (
                <p className="empty-state">Your Hostinger account has no domains to import.</p>
              ) : (
                <div className="import-scroll">
                  <table className="import-table">
                    <caption className="visually-hidden">Domains in your Hostinger account</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="cell-select">
                          <input
                            type="checkbox"
                            checked={allVisibleSelected}
                            onChange={toggleAllVisible}
                            disabled={busy || visible.length === 0}
                            aria-label={allVisibleSelected ? 'Deselect all shown domains' : 'Select all shown domains'}
                          />
                        </th>
                        <th scope="col">Domain</th>
                        <th scope="col">Registered</th>
                        <th scope="col">Expires</th>
                        <th scope="col">Hostinger</th>
                        <th scope="col">DomainDesk</th>
                        <th scope="col">Ownership</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((item) => (
                        <PreviewRow
                          key={item.name}
                          item={item}
                          checked={selected.has(item.name)}
                          disabled={busy}
                          ownership={ownershipFor(item)}
                          onToggle={() => toggle(item.name)}
                          onOwnership={(value) => setOwnership((o) => ({ ...o, [item.name]: value }))}
                        />
                      ))}
                      {visible.length === 0 && (
                        <tr>
                          <td colSpan={7} className="empty-state">
                            No domains match your filter.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              <PreviewNotices preview={phase.preview} />
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
                <Button
                  icon="download"
                  onClick={runImport}
                  disabled={busy || selected.size === 0 || !preview.schemaReady}
                >
                  {phase.step === 'importing'
                    ? 'Importing…'
                    : `Import ${selected.size} domain${selected.size === 1 ? '' : 's'}`}
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
      <span className="status-dot" aria-hidden="true" /> Connected · {n} domain{n === 1 ? '' : 's'} found · fetched{' '}
      {time}
    </p>
  )
}

interface PreviewRowProps {
  item: HostingerPreviewItem
  checked: boolean
  disabled: boolean
  ownership: OwnershipType
  onToggle: () => void
  onOwnership: (value: OwnershipType) => void
}

function PreviewRow({ item, checked, disabled, ownership, onToggle, onOwnership }: PreviewRowProps) {
  const status = hostingerStatusBadge(item)
  const checkboxId = `import-${item.name}`
  const existingOwnership = ownershipTypes.find((o) => o.value === item.existing?.ownershipType)
  return (
    <tr className={checked ? 'is-selected' : undefined}>
      <td className="cell-select">
        <input id={checkboxId} type="checkbox" checked={checked} onChange={onToggle} disabled={disabled} />
      </td>
      <td className="cell-domain">
        <label htmlFor={checkboxId}>{item.name}</label>
        <span className="cell-sub">
          {item.type.startsWith('free_') ? 'Free domain (hosting plan)' : 'Registration'}
          {item.entryCount > 1 && ` · listed ${item.entryCount}× in Hostinger`}
          {item.existing?.hasClient && ' · has a client'}
        </span>
      </td>
      <td className="cell-muted" data-label="Registered">
        {item.registeredDate ? formatDate(item.registeredDate) : '—'}
      </td>
      <td data-label="Expires">
        {item.expiryDate ? <time dateTime={item.expiryDate}>{formatDate(item.expiryDate)}</time> : <span className="cell-muted">No expiry date</span>}
      </td>
      <td data-label="Hostinger">
        <span className={`badge ${status.className}`}>{status.label}</span>
      </td>
      <td className="cell-match" data-label="DomainDesk">
        <span className={`badge ${matchBadge[item.match]}`}>{matchLabels[item.match]}</span>
        {item.match === 'update' && item.changes.length > 0 && <span className="cell-sub">{item.changes.join(' · ')}</span>}
        {item.notes.map((note) => (
          <span key={note} className="cell-sub import-note">
            {note}
          </span>
        ))}
      </td>
      <td data-label="Ownership">
        {item.ownershipEditable ? (
          <select
            className="select-pill"
            value={ownership}
            onChange={(e) => onOwnership(e.target.value as OwnershipType)}
            disabled={disabled}
            aria-label={`Ownership for ${item.name}`}
          >
            {ownershipTypes.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="cell-muted">{existingOwnership?.label ?? '—'} (kept)</span>
        )}
      </td>
    </tr>
  )
}

function PreviewNotices({ preview }: { preview: HostingerPreview }) {
  if (preview.warnings.length === 0 && preview.skipped.length === 0) return null
  return (
    <div className="import-notices">
      {preview.warnings.map((w) => (
        <p key={w} className="import-note">
          <Icon name="info" size={16} /> {w}
        </p>
      ))}
      {preview.skipped.length > 0 && (
        <details>
          <summary>
            {preview.skipped.length} Hostinger entr{preview.skipped.length === 1 ? 'y' : 'ies'} can't be imported
          </summary>
          <ul>
            {preview.skipped.map((s, i) => (
              <li key={`${s.entry}-${i}`}>
                <strong>{s.entry}</strong>: {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function ImportSummary({ result }: { result: HostingerImportResult }) {
  const { summary } = result
  const failed = result.results.filter((r) => r.outcome === 'failed')
  const updated = result.results.filter((r) => r.outcome === 'updated')
  const skipped = result.results.filter((r) => r.outcome === 'unchanged')
  return (
    <div className="import-summary" role="status">
      <dl className="totals-strip import-totals">
        <div>
          <dt>Added</dt>
          <dd>{summary.inserted}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{summary.updated}</dd>
        </div>
        <div>
          <dt>Skipped duplicates</dt>
          <dd>{summary.unchanged}</dd>
        </div>
        <div className={summary.failed > 0 ? 'is-error' : undefined}>
          <dt>Failed</dt>
          <dd>{summary.failed}</dd>
        </div>
      </dl>

      {failed.length > 0 && (
        <section className="import-result-list" aria-labelledby="import-failed-title">
          <h3 id="import-failed-title">Not imported</h3>
          <ul>
            {failed.map((r) => (
              <li key={r.name} className="is-error">
                <strong>{r.name}</strong>: {r.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      {updated.length > 0 && (
        <section className="import-result-list" aria-labelledby="import-updated-title">
          <h3 id="import-updated-title">Updated</h3>
          <ul>
            {updated.map((r) => (
              <li key={r.name}>
                <strong>{r.name}</strong>: {r.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      {skipped.length > 0 && (
        <details className="import-result-list">
          <summary>{skipped.length} already up to date (skipped)</summary>
          <ul>
            {skipped.map((r) => (
              <li key={r.name}>
                <strong>{r.name}</strong>: {r.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {result.warnings.map((w) => (
        <p key={w} className="import-note">
          <Icon name="info" size={16} /> {w}
        </p>
      ))}
      <p className="section-subtitle">
        Imported domains have no client and no renewals. Assign clients and review ownership from the Domains list.
      </p>
    </div>
  )
}
