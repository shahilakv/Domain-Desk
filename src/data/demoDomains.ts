import type { Domain, PaymentStatus } from '../types/domain'

/*
 * DEMO DATA ONLY.
 * Fictional clients and domains used to preview the dashboard until the
 * database is connected. Expiry dates are generated relative to today so the
 * demo always shows a realistic mix of statuses.
 */

function daysFromToday(days: number): string {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + days)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

type DemoRow = [name: string, client: string, registrar: string, expiresInDays: number, payment: PaymentStatus]

const rows: DemoRow[] = [
  ['harbourbakery.com.au', 'Harbour Bakery Co.', 'VentraIP', -12, 'pending'],
  ['northwindlegal.com', 'Northwind Legal', 'GoDaddy', -3, 'paid'],
  ['bluegumdental.com.au', 'Bluegum Dental', 'Crazy Domains', 4, 'paid'],
  ['summitphysio.com.au', 'Summit Physio', 'VentraIP', 9, 'pending'],
  ['oakandiron.co', 'Oak & Iron Furniture', 'Namecheap', 17, 'paid'],
  ['greenleafcafe.com', 'Greenleaf Café', 'Cloudflare', 26, 'pending'],
  ['meridianaccounting.com.au', 'Meridian Accounting', 'Crazy Domains', 41, 'paid'],
  ['coastalyoga.studio', 'Coastal Yoga Studio', 'Namecheap', 58, 'paid'],
  ['brightsparkelectrical.com.au', 'Bright Spark Electrical', 'VentraIP', 96, 'paid'],
  ['harbourbakery.shop', 'Harbour Bakery Co.', 'VentraIP', 133, 'paid'],
  ['ridgelinebuilders.com.au', 'Ridgeline Builders', 'GoDaddy', 187, 'paid'],
  ['northwindlegal.com.au', 'Northwind Legal', 'VentraIP', 244, 'paid'],
  ['lumenarchitects.com', 'Lumen Architects', 'Cloudflare', 301, 'paid'],
  ['pawsandclaws.vet', 'Paws & Claws Vet', 'Namecheap', 352, 'paid'],
]

export const demoDomains: Domain[] = rows.map(([name, client, registrar, days, paymentStatus], index) => ({
  id: `demo-${index + 1}`,
  name,
  client,
  registrar,
  expiryDate: daysFromToday(days),
  paymentStatus,
}))
