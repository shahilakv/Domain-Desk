import { useMemo } from 'react'
import { Button } from '../components/Button'
import { CubeCluster, Gem } from '../components/Decorations'
import { Icon } from '../components/Icon'
import { NeedsAttention } from '../components/NeedsAttention'
import { SummaryCard } from '../components/SummaryCard'
import { UpcomingExpiries } from '../components/UpcomingExpiries'
import { useMediaQuery } from '../hooks/useMediaQuery'
import type { Domain, Renewal } from '../types/domain'
import { compareByExpiry, daysUntilExpiry, getDomainStatus, isExpired, isRenewalDue } from '../utils/domainStatus'
import { formatTotals, sumByCurrency } from '../utils/format'

const TABLE_ROW_LIMIT = 8
const ATTENTION_LIMIT = 6
/** Keep in sync with the phone breakpoint in App.css. */
const PHONE_QUERY = '(max-width: 640px)'

/** Decorative 3D accents for the hero (reduced to one small cluster on phones). */
function HeroArt() {
  return (
    <div className="hero-art" aria-hidden="true">
      <span className="orb orb-lavender" />
      <span className="orb orb-peach" />
      <CubeCluster
        className="hero-cubes-blue"
        tone="blue"
        unit={26}
        cubes={[
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
          [0, 1, 0],
          [1, 1, 0],
          [0, 0, 1],
          [1, 0, 1],
          [0, 0, 2],
        ]}
      />
      <CubeCluster
        className="hero-cubes-copper"
        tone="copper"
        unit={20}
        cubes={[
          [0, 0, 0],
          [0, 0, 1],
          [1, 0, 1],
          [0, 0, 2],
        ]}
      />
      <Gem className="hero-gem" />
    </div>
  )
}

interface DashboardProps {
  domains: Domain[]
  renewals: Renewal[]
  onAddDomain: () => void
  onViewAllDomains: () => void
  onEditDomain: (domain: Domain) => void
  onDeleteDomain: (domain: Domain) => void
  /** Reminder activity; null hides the section (reminders not set up or unavailable). */
  reminders?: { upcoming: number; blocked: number; sent: number; failed: number } | null
  onViewNotifications?: () => void
}

export function Dashboard({
  domains,
  renewals,
  onAddDomain,
  onViewAllDomains,
  onEditDomain,
  onDeleteDomain,
  reminders,
  onViewNotifications,
}: DashboardProps) {
  const { stats, attention, upcoming } = useMemo(() => {
    // Transferred or cancelled domains no longer need renewing.
    const active = domains.filter((d) => d.lifecycle === 'active')
    const byExpiry = [...active].sort(compareByExpiry)
    // Domain renewals only: this card counts domains, so hosting invoices stay out of its total.
    const outstanding = sumByCurrency(
      renewals
        .filter((r) => r.kind === 'domain' && r.status === 'invoiced')
        .map((r) => ({ amount: r.clientCharge, currency: r.currency })),
    )
    return {
      stats: {
        total: domains.length,
        renewalsDue: active.filter((d) => isRenewalDue(d)).length,
        paymentsPending: domains.filter((d) => d.paymentStatus === 'pending').length,
        outstanding: outstanding.size > 0 ? `${formatTotals(outstanding)} outstanding` : undefined,
        expired: active.filter((d) => isExpired(d)).length,
      },
      attention: byExpiry.filter((d) => getDomainStatus(d) !== 'active').slice(0, ATTENTION_LIMIT),
      upcoming: byExpiry.filter((d) => daysUntilExpiry(d) >= 0 && d.expiryDate).slice(0, TABLE_ROW_LIMIT),
    }
  }, [domains, renewals])

  // On phones, upcoming expiries come straight after the summary. Reordering
  // in the DOM (not just CSS) keeps reading and focus order consistent.
  const isPhone = useMediaQuery(PHONE_QUERY)
  const attentionSection = <NeedsAttention domains={attention} onEdit={onEditDomain} onDelete={onDeleteDomain} />
  const upcomingSection = (
    <UpcomingExpiries domains={upcoming} onViewAll={onViewAllDomains} onEdit={onEditDomain} onDelete={onDeleteDomain} />
  )

  return (
    <>
      <header className="hero">
        <div className="hero-content">
          <p className="hero-eyebrow">Dashboard</p>
          <h1>Your domain universe.</h1>
          <p className="hero-subtitle">Everything your agency manages, all in one place.</p>
          <Button icon="plus" onClick={onAddDomain}>
            Add Domain
          </Button>
        </div>
        <HeroArt />
      </header>

      <section className="summary-grid" aria-label="Summary">
        <SummaryCard label="Total Domains" value={stats.total} icon="globe" tone="sky" />
        <SummaryCard
          label="Renewals Due Within 30 Days"
          value={stats.renewalsDue}
          icon="calendar"
          tone="lavender"
        />
        <SummaryCard
          label="Payments Pending"
          value={stats.paymentsPending}
          icon="wallet"
          tone="sunny"
          hint={stats.outstanding}
        />
        <SummaryCard label="Expired Domains" value={stats.expired} icon="alert" tone="coral" />
      </section>

      {reminders && (
        <section className="card section-card reminders-card" aria-labelledby="reminders-summary-title">
          <header className="section-header">
            <div className="section-title">
              <span className="icon-chip tone-sky">
                <Icon name="bell" />
              </span>
              <div>
                <h2 id="reminders-summary-title">Renewal reminders</h2>
                <p className="section-subtitle">Email and WhatsApp reminders to clients</p>
              </div>
            </div>
            {onViewNotifications && (
              <Button variant="secondary" onClick={onViewNotifications}>
                View notifications
              </Button>
            )}
          </header>
          <dl className="totals-strip">
            <div>
              <dt>Due in 7 days</dt>
              <dd>{reminders.upcoming}</dd>
            </div>
            <div>
              <dt>Can't be sent</dt>
              <dd>{reminders.blocked}</dd>
            </div>
            <div>
              <dt>Sent, last 7 days</dt>
              <dd>{reminders.sent}</dd>
            </div>
            <div className={reminders.failed > 0 ? 'is-error' : undefined}>
              <dt>Failed</dt>
              <dd>{reminders.failed}</dd>
            </div>
          </dl>
        </section>
      )}

      {isPhone ? (
        <>
          {upcomingSection}
          {attentionSection}
        </>
      ) : (
        <>
          {attentionSection}
          {upcomingSection}
        </>
      )}
    </>
  )
}
