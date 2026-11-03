import type { ReactNode } from 'react'
import { Icon } from './Icon'

interface PageHeaderProps {
  eyebrow: string
  title: string
  subtitle: string
  action?: ReactNode
}

/** Compact hero used at the top of every page except the dashboard. */
export function PageHeader({ eyebrow, title, subtitle, action }: PageHeaderProps) {
  return (
    <header className="hero hero-compact">
      <div className="hero-content">
        <p className="hero-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="hero-subtitle">{subtitle}</p>
        {action && <div className="hero-action">{action}</div>}
      </div>
    </header>
  )
}

interface SearchBoxProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

export function SearchBox({ id, label, value, onChange, placeholder }: SearchBoxProps) {
  return (
    <div className="search-box">
      <label htmlFor={id} className="visually-hidden">
        {label}
      </label>
      <Icon name="search" size={18} />
      <input
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
      />
    </div>
  )
}
