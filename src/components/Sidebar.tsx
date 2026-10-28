import { navItems, type PageId } from '../navigation'
import { CubeCluster, LogoMark } from './Decorations'
import { Icon } from './Icon'

interface SidebarProps {
  activePage: PageId
  onNavigate: (page: PageId) => void
  isOpen: boolean
  onClose: () => void
}

export function Sidebar({ activePage, onNavigate, isOpen, onClose }: SidebarProps) {
  return (
    <>
      <div
        className={`sidebar-backdrop${isOpen ? ' is-visible' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className={`sidebar${isOpen ? ' is-open' : ''}`} aria-label="Main navigation">
        <div className="sidebar-brand">
          <LogoMark />
          <span className="brand-name">DomainDesk</span>
          <button type="button" className="icon-button sidebar-close" onClick={onClose} aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>

        <nav>
          <p className="nav-heading">Menu</p>
          <ul className="nav-list">
            {navItems.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`nav-link${item.id === activePage ? ' is-active' : ''}`}
                  aria-current={item.id === activePage ? 'page' : undefined}
                  onClick={() => onNavigate(item.id)}
                >
                  <span className={`icon-chip icon-chip-sm tone-${item.tone}`}>
                    <Icon name={item.icon} size={18} />
                  </span>
                  <span>{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="sidebar-card" aria-hidden="true">
          <CubeCluster
            className="sidebar-cubes"
            tone="blue"
            cubes={[
              [0, 0, 0],
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ]}
          />
        </div>

        <p className="sidebar-footer">Internal tool · v0.1</p>
      </aside>
    </>
  )
}
