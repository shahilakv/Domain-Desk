import { currencies } from '../data/options'

interface CurrencySelectProps {
  id: string
  /** 3-letter currency code. */
  value: string
  onChange: (code: string) => void
}

/**
 * Currency dropdown for money forms. A saved code that isn't in the list is
 * kept as its own option, so editing a record never silently changes it.
 */
export function CurrencySelect({ id, value, onChange }: CurrencySelectProps) {
  const known = currencies.some((c) => c.value === value)
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {!known && value && <option value={value}>{value} (saved currency)</option>}
      {currencies.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  )
}
