import type { Tone } from '../types/tone'
import { Icon, type IconName } from './Icon'

interface SummaryCardProps {
  label: string
  value: number
  icon: IconName
  tone: Tone
  hint?: string
}

export function SummaryCard({ label, value, icon, tone, hint }: SummaryCardProps) {
  return (
    <article className={`summary-card summary-${tone}`}>
      <span className={`icon-chip tone-${tone}`}>
        <Icon name={icon} />
      </span>
      <div>
        <p className="summary-value">{value}</p>
        <p className="summary-label">{label}</p>
        {hint && <p className="summary-hint">{hint}</p>}
      </div>
    </article>
  )
}
