import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { PageHeader } from '../components/PageHeader'

interface SettingsPageProps {
  email: string
  signingOut: boolean
  onSignOut: () => void
}

export function SettingsPage({ email, signingOut, onSignOut }: SettingsPageProps) {
  return (
    <>
      <PageHeader eyebrow="Settings" title="Preferences for your workspace." subtitle="Manage the account you're signed in with." />

      <section className="card section-card" aria-labelledby="account-title">
        <header className="section-header">
          <div className="section-title">
            <span className="icon-chip tone-sunny">
              <Icon name="users" />
            </span>
            <div>
              <h2 id="account-title">Account</h2>
              <p className="section-subtitle">
                Signed in as <strong>{email}</strong>
              </p>
            </div>
          </div>
          <Button variant="secondary" icon="logout" onClick={onSignOut} disabled={signingOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </Button>
        </header>
        <p className="section-subtitle">
          Your records are private to this account. Password changes and new users are managed in Supabase.
        </p>
      </section>
    </>
  )
}
