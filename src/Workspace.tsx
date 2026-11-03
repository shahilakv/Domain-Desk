import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { Button } from './components/Button'
import { ConfirmDialog } from './components/ConfirmDialog'
import { LogoMark } from './components/Decorations'
import { ClientForm } from './components/forms/ClientForm'
import { DomainForm } from './components/forms/DomainForm'
import { HostingerImport } from './components/HostingerImport'
import { RenewalForm } from './components/forms/RenewalForm'
import { Icon } from './components/Icon'
import { Sidebar } from './components/Sidebar'
import { useWorkspaceData } from './hooks/useWorkspaceData'
import { deleteClient, deleteDomain, deleteRenewal, describeError } from './lib/api'
import { supabase } from './lib/supabase'
import { type PageId } from './navigation'
import { ClientsPage } from './pages/ClientsPage'
import { Dashboard } from './pages/Dashboard'
import { DomainsPage } from './pages/DomainsPage'
import { RenewalsPage } from './pages/RenewalsPage'
import { SettingsPage } from './pages/SettingsPage'
import type { Client, Domain, Renewal } from './types/domain'
import { formatDate } from './utils/domainStatus'
import { formatMoney } from './utils/format'

type Editor =
  | { kind: 'domain'; domain?: Domain }
  | { kind: 'hostinger-import' }
  | { kind: 'client'; client?: Client }
  | { kind: 'renewal'; renewal?: Renewal }

type PendingDelete =
  | { kind: 'domain'; item: Domain }
  | { kind: 'client'; item: Client }
  | { kind: 'renewal'; item: Renewal }

export function Workspace({ session }: { session: Session }) {
  const userId = session.user.id
  const { state, reload, retry } = useWorkspaceData(userId)
  const [activePage, setActivePage] = useState<PageId>('dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const navigate = (page: PageId) => {
    setActivePage(page)
    setSidebarOpen(false)
  }

  const signOut = async () => {
    setSigningOut(true)
    const { error } = await supabase.auth.signOut()
    // On success the auth listener swaps this screen for the login page.
    if (error) {
      setSigningOut(false)
      setNotice(`Sign out failed: ${describeError(error)}`)
    }
  }

  const handleSaved = (message: string) => {
    setEditor(null)
    setNotice(message)
    reload()
  }

  const data = state.status === 'ready' ? state.data : null

  /** Deleting a parent with linked rows is blocked instead of relying on FK cascade behaviour. */
  const requestDelete = (request: PendingDelete) => {
    if (request.kind === 'client' && request.item.domainCount > 0) {
      const n = request.item.domainCount
      setNotice(`${request.item.name} still has ${n} domain${n === 1 ? '' : 's'}. Reassign or delete them first.`)
      return
    }
    if (request.kind === 'domain' && data) {
      const n = data.renewals.filter((r) => r.domainId === request.item.id).length
      if (n > 0) {
        setNotice(`${request.item.name} has ${n} renewal record${n === 1 ? '' : 's'}. Delete them on the Renewals page first.`)
        return
      }
    }
    setPendingDelete(request)
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      const { kind, item } = pendingDelete
      if (kind === 'domain') await deleteDomain(userId, item.id)
      if (kind === 'client') await deleteClient(userId, item.id)
      if (kind === 'renewal') await deleteRenewal(userId, item.id)
      setNotice(kind === 'renewal' ? `Deleted renewal for ${item.domainName}.` : `Deleted ${item.name}.`)
      setPendingDelete(null)
      reload()
    } catch (error) {
      setNotice(`Delete failed: ${describeError(error)}`)
    } finally {
      setDeleting(false)
    }
  }

  const editDomain = (domain?: Domain) => setEditor({ kind: 'domain', domain })

  let content
  if (state.status === 'loading') {
    content = (
      <div className="card section-card status-card" role="status">
        <span className="spinner" aria-hidden="true" />
        <p>Loading your workspace…</p>
      </div>
    )
  } else if (state.status === 'error') {
    content = (
      <div className="card section-card status-card" role="alert">
        <span className="icon-chip tone-coral">
          <Icon name="alert" />
        </span>
        <h2>Couldn't load your data</h2>
        <p className="section-subtitle">{state.error}</p>
        <Button variant="secondary" icon="refresh" onClick={retry}>
          Try again
        </Button>
      </div>
    )
  } else if (activePage === 'dashboard') {
    content = (
      <Dashboard
        domains={state.data.domains}
        renewals={state.data.renewals}
        onAddDomain={() => editDomain()}
        onViewAllDomains={() => navigate('domains')}
        onEditDomain={editDomain}
        onDeleteDomain={(item) => requestDelete({ kind: 'domain', item })}
      />
    )
  } else if (activePage === 'domains') {
    content = (
      <DomainsPage
        domains={state.data.domains}
        onAdd={() => editDomain()}
        onImport={() => setEditor({ kind: 'hostinger-import' })}
        onEdit={editDomain}
        onDelete={(item) => requestDelete({ kind: 'domain', item })}
      />
    )
  } else if (activePage === 'clients') {
    content = (
      <ClientsPage
        clients={state.data.clients}
        onAdd={() => setEditor({ kind: 'client' })}
        onEdit={(client) => setEditor({ kind: 'client', client })}
        onDelete={(item) => requestDelete({ kind: 'client', item })}
      />
    )
  } else if (activePage === 'renewals') {
    content = (
      <RenewalsPage
        renewals={state.data.renewals}
        canAdd={state.data.domains.length > 0}
        onAdd={() => setEditor({ kind: 'renewal' })}
        onEdit={(renewal) => setEditor({ kind: 'renewal', renewal })}
        onDelete={(item) => requestDelete({ kind: 'renewal', item })}
      />
    )
  } else {
    content = <SettingsPage email={session.user.email ?? ''} signingOut={signingOut} onSignOut={signOut} />
  }

  return (
    <div className="app-shell">
      <Sidebar
        activePage={activePage}
        onNavigate={navigate}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        userEmail={session.user.email ?? ''}
        signingOut={signingOut}
        onSignOut={signOut}
      />

      <div className="app-main">
        <header className="topbar">
          <button
            type="button"
            className="icon-button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Icon name="menu" />
          </button>
          <LogoMark size={30} />
          <span className="brand-name">DomainDesk</span>
        </header>

        <main className="page">{content}</main>
      </div>

      {data && editor?.kind === 'domain' && (
        <DomainForm
          userId={userId}
          domain={editor.domain}
          clients={data.clients}
          existingNames={data.domains.map((d) => d.name)}
          onSaved={handleSaved}
          onClose={() => setEditor(null)}
        />
      )}
      {data && editor?.kind === 'hostinger-import' && (
        <HostingerImport onImported={reload} onClose={() => setEditor(null)} />
      )}
      {data && editor?.kind === 'client' && (
        <ClientForm userId={userId} client={editor.client} onSaved={handleSaved} onClose={() => setEditor(null)} />
      )}
      {data && editor?.kind === 'renewal' && (
        <RenewalForm
          userId={userId}
          renewal={editor.renewal}
          domains={data.domains}
          onSaved={handleSaved}
          onClose={() => setEditor(null)}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete this ${pendingDelete?.kind ?? 'record'}?`}
        confirmLabel="Delete"
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      >
        {pendingDelete?.kind === 'domain' && (
          <p>
            <strong>{pendingDelete.item.name}</strong>
            {pendingDelete.item.client && ` (${pendingDelete.item.client})`} will be permanently removed. This action
            cannot be undone.
          </p>
        )}
        {pendingDelete?.kind === 'client' && (
          <p>
            <strong>{pendingDelete.item.name}</strong> will be permanently removed. This action cannot be undone.
          </p>
        )}
        {pendingDelete?.kind === 'renewal' && (
          <p>
            The renewal for <strong>{pendingDelete.item.domainName}</strong> on {formatDate(pendingDelete.item.renewalDate)} (
            {formatMoney(pendingDelete.item.clientCharge, pendingDelete.item.currency)}) will be permanently removed.
          </p>
        )}
      </ConfirmDialog>

      <div className="toast-region" role="status" aria-live="polite">
        {notice && <div className="toast">{notice}</div>}
      </div>
    </div>
  )
}
