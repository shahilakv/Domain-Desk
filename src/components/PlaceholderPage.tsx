import type { NavItem } from '../navigation'
import { CubeCluster } from './Decorations'
import { Icon } from './Icon'

interface PlaceholderPageProps {
  item: NavItem
}

export function PlaceholderPage({ item }: PlaceholderPageProps) {
  return (
    <>
      <header className="hero hero-compact">
        <div className="hero-content">
          <p className="hero-eyebrow">{item.label}</p>
          <h1>{item.description}.</h1>
          <p className="hero-subtitle">This section hasn't been built yet.</p>
        </div>
      </header>
      <section className="card section-card placeholder-card">
        <CubeCluster
          className="placeholder-cubes"
          tone="lavender"
          cubes={[
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ]}
        />
        <span className={`icon-chip tone-${item.tone}`}>
          <Icon name={item.icon} />
        </span>
        <h2>{item.label} is coming soon</h2>
        <p className="section-subtitle">We'll build this page in a later step.</p>
      </section>
    </>
  )
}
