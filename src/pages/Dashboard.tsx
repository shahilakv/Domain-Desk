import { useMemo } from 'react'
import { Button } from '../components/Button'
import { CubeCluster, Gem } from '../components/Decorations'
import { DemoNotice } from '../components/DemoNotice'
import { NeedsAttention } from '../components/NeedsAttention'
import { SummaryCard } from '../components/SummaryCard'
import { UpcomingExpiries } from '../components/UpcomingExpiries'
import { useMediaQuery } from '../hooks/useMediaQuery'
import type { Domain } from '../types/domain'
import { daysUntilExpiry, getDomainStatus, isExpired, isRenewalDue } from '../utils/domainStatus'

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
  onAddDomain: () => void
  onViewAllDomains: () => void
  onDeleteDomain: (domain: Domain) => void
}

export function Dashboard({ domains, onAddDomain, onViewAllDomains, onDeleteDomain }: DashboardProps) {
  const { stats, attention, upcoming } = useMemo(() => {
    const byExpiry = [...domains].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))
    return {
      stats: {
        total: domains.length,
        renewalsDue: domains.filter((d) => isRenewalDue(d)).length,
        paymentsPending: domains.filter((d) => d.paymentStatus === 'pending').length,
        expired: domains.filter((d) => isExpired(d)).length,
      },
      attention: byExpiry.filter((d) => getDomainStatus(d) !== 'active').slice(0, ATTENTION_LIMIT),
      upcoming: byExpiry.filter((d) => daysUntilExpiry(d) >= 0).slice(0, TABLE_ROW_LIMIT),
    }
  }, [domains])

  // On phones, upcoming expiries come straight after the summary. Reordering
  // in the DOM (not just CSS) keeps reading and focus order consistent.
  const isPhone = useMediaQuery(PHONE_QUERY)
  const attentionSection = <NeedsAttention domains={attention} onDelete={onDeleteDomain} />
  const upcomingSection = (
    <UpcomingExpiries domains={upcoming} onViewAll={onViewAllDomains} onDelete={onDeleteDomain} />
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

      <DemoNotice />

      <section className="summary-grid" aria-label="Summary">
        <SummaryCard label="Total Domains" value={stats.total} icon="globe" tone="sky" />
        <SummaryCard
          label="Renewals Due Within 30 Days"
          value={stats.renewalsDue}
          icon="calendar"
          tone="lavender"
        />
        <SummaryCard label="Payments Pending" value={stats.paymentsPending} icon="wallet" tone="sunny" />
        <SummaryCard label="Expired Domains" value={stats.expired} icon="alert" tone="coral" />
      </section>

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
