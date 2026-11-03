/** Formats an amount in its currency, e.g. "A$24.95". Falls back for unknown codes. */
export function formatMoney(amount: number | null, currency: string): string {
  if (amount === null) return '—'
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

/** Parses an optional, non-negative money amount. undefined means invalid. */
export function parseAmount(input: string): number | null | undefined {
  const trimmed = input.trim().replace(/,/g, '')
  if (trimmed === '') return null
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n * 100) / 100
}

/** Sums amounts per currency, so different currencies are never added together. */
export function sumByCurrency(items: { amount: number | null; currency: string }[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const { amount, currency } of items) {
    if (amount === null) continue
    totals.set(currency, (totals.get(currency) ?? 0) + amount)
  }
  return totals
}

export function formatTotals(totals: Map<string, number>): string {
  return [...totals].map(([currency, amount]) => formatMoney(amount, currency)).join(' · ')
}

/** Lowercases and strips a pasted URL down to its host, e.g. "https://www.Example.com/" → "www.example.com". */
export function normalizeDomainName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '')
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/

export function isValidDomainName(name: string): boolean {
  return DOMAIN_PATTERN.test(name)
}

/** Case-insensitive "contains" across several fields. */
export function matchesSearch(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return fields.some((field) => field?.toLowerCase().includes(q))
}

/** Empty strings become null so optional columns stay NULL rather than "". */
export function nullIfEmpty(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
