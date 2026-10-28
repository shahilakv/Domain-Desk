import { useEffect, useState } from 'react'
import { ConfirmDialog } from './components/ConfirmDialog'
import { LogoMark } from './components/Decorations'
import { Icon } from './components/Icon'
import { PlaceholderPage } from './components/PlaceholderPage'
import { Sidebar } from './components/Sidebar'
import { demoDomains } from './data/demoDomains'
import { navItems, type PageId } from './navigation'
import { Dashboard } from './pages/Dashboard'
import type { Domain } from './types/domain'
import './App.css'

function App() {
  const [activePage, setActivePage] = useState<PageId>('dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // Single source of truth for domains. Demo records live in memory only.
  const [domains, setDomains] = useState<Domain[]>(demoDomains)
  const [pendingDelete, setPendingDelete] = useState<Domain | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3500)
    return () => window.clearTimeout(timer)
  }, [notice])

  const navigate = (page: PageId) => {
    setActivePage(page)
    setSidebarOpen(false)
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    const { id, name } = pendingDelete
    setDomains((current) => current.filter((domain) => domain.id !== id))
    setPendingDelete(null)
    setNotice(`Deleted ${name}. Demo changes reset when you reload.`)
  }

  const activeItem = navItems.find((item) => item.id === activePage) ?? navItems[0]

  return (
    <div className="app-shell">
      <Sidebar
        activePage={activePage}
        onNavigate={navigate}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
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

        <main className="page">
          {activePage === 'dashboard' ? (
            <Dashboard
              domains={domains}
              onAddDomain={() => setNotice('Adding domains will be available once the database is connected.')}
              onViewAllDomains={() => navigate('domains')}
              onDeleteDomain={setPendingDelete}
            />
          ) : (
            <PlaceholderPage item={activeItem} />
          )}
        </main>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this domain?"
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      >
        {pendingDelete && (
          <p>
            <strong>{pendingDelete.name}</strong> ({pendingDelete.client}) will be removed. This action cannot be
            undone.
          </p>
        )}
      </ConfirmDialog>

      <div className="toast-region" role="status" aria-live="polite">
        {notice && <div className="toast">{notice}</div>}
      </div>
    </div>
  )
}

export default App
