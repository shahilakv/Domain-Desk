import type { IconName } from './components/Icon'
import type { Tone } from './types/tone'

export type PageId = 'dashboard' | 'domains' | 'hosting' | 'renewals' | 'clients' | 'notifications' | 'settings'

export interface NavItem {
  id: PageId
  label: string
  icon: IconName
  tone: Tone
  description: string
}

export const navItems: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', tone: 'sky', description: 'Your overview' },
  { id: 'domains', label: 'Domains', icon: 'globe', tone: 'lavender', description: 'Every domain you manage' },
  { id: 'hosting', label: 'Hosting Plans', icon: 'server', tone: 'coral', description: 'Hosting and the domains it covers' },
  { id: 'renewals', label: 'Renewals', icon: 'refresh', tone: 'peach', description: 'Upcoming renewals and invoices' },
  { id: 'clients', label: 'Clients', icon: 'users', tone: 'mint', description: 'The people behind the domains' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', tone: 'sky', description: 'Email and WhatsApp renewal reminders' },
  { id: 'settings', label: 'Settings', icon: 'settings', tone: 'sunny', description: 'Preferences for your workspace' },
]
