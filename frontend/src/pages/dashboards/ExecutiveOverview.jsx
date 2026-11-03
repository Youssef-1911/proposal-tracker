import { Link } from 'react-router-dom'
import PageLayout from '../../components/layout/PageLayout.jsx'
import Card from '../../components/ui/Card.jsx'
import KpiCard from '../../components/dashboard/KpiCard.jsx'
import { ClientEvent } from '../../components/dashboard/cells.jsx'
import DashboardLoading from './DashboardLoading.jsx'
import { RadarCount } from './FocusedHome.jsx'
import { useAnalyticsData, useEvents, useLookups } from '../../data/hooks.js'
import { getBrand } from '../../domain/brands.js'
import { cairoTodayISO, eventStatusOf, eventTiming } from '../../domain/events.js'
import { executiveOverview } from '../../domain/scorecard.js'
import { PROPOSAL_STATUS as PS, getStatus } from '../../domain/status.js'
import { effectiveWaiting, waitingDays } from '../../domain/waiting.js'
import { formatCurrency, formatShortDate, formatTotal } from '../../lib/format.js'

const STUCK_DAYS = 3
const UPCOMING_DAYS = 30

const versus = (now, before) => {
  if (!before || !before.priced || !now.priced) return before ? 'No prices to compare with last year' : 'No data last year to compare'
  const diff = now.value - before.value
  return `${diff >= 0 ? '+' : '−'}${formatCurrency(Math.abs(diff))} vs the same time last year (${formatCurrency(before.value)})`
}

/**
 * Executives (Doaa, Tony): the company on one screen. No operational lists. The same definitions as
 * Analytics (domain/scorecard.js): confirmed value, pipeline value, confirmation rate, lost reasons.
 */
export default function ExecutiveOverview({ subtitle }) {
  const analytics = useAnalyticsData()
  const events = useEvents()
  const { clientsById } = useLookups()
  if (!analytics.data) return <DashboardLoading subtitle={subtitle} error={analytics.error} />
  const today = cairoTodayISO()
  const requests = analytics.data.requests
  const o = executiveOverview(requests, today)
  const now = new Date()
  const stuck = requests.filter((r) => r.status !== PS.DRAFT && !getStatus('proposal', r.status).closed && !r.needsReview
    && (waitingDays(effectiveWaiting(r), now) ?? 0) >= STUCK_DAYS).length
  const until = new Date(`${today}T00:00:00Z`)
  until.setUTCDate(until.getUTCDate() + UPCOMING_DAYS)
  const last = until.toISOString().slice(0, 10)
  const upcoming = (events.data?.items ?? [])
    .filter((e) => eventTiming(e, today) === 'upcoming' && e.eventDatePrecision !== 'month' && e.eventDate && e.eventDate <= last)
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate))
  const clientName = (id, fallback) => clientsById[id]?.name ?? fallback ?? '—'
  const priced = (v) => `${v.priced} of ${v.count} confirmed ${v.count === 1 ? 'proposal has' : 'proposals have'} a price`

  return (
    <PageLayout title="Overview" subtitle={subtitle}>
      <div className="kpi-grid">
        <KpiCard label="Confirmed value · this month" icon="chart" value={formatTotal(o.month.value, o.month.priced)}
          note={`${versus(o.month, o.month.lastYear)} · ${priced(o.month)}`} />
        <KpiCard label="Confirmed value · this year" icon="chart" value={formatTotal(o.year.value, o.year.priced)}
          note={`${versus(o.year, o.year.lastYear)} · ${priced(o.year)}`} />
        <KpiCard label="Pipeline value" icon="document" value={formatTotal(o.pipeline.value, o.pipeline.priced)}
          note={`${o.pipeline.count} proposals sent, not yet decided`} />
        <KpiCard label={`Stuck for ${STUCK_DAYS}+ days`} icon="clock" value={String(stuck)} tone={stuck ? 'danger' : 'default'}
          note="No change for 3 days or more · open My Work" to="/" />
      </div>
      <RadarCount />
      <div className="dash-grid">
        <div className="span-6">
          <Card title="Confirmation rate by brand" subtitle="This year · confirmed of confirmed + lost">
            <ul className="short-list">
              {o.byBrand.map((b) => (
                <li key={b.brand}><strong>{getBrand(b.brand)?.name ?? b.brand}</strong>
                  <span className="tabular">{b.rate.value === null ? '—' : `${b.rate.value}%`} · {b.rate.part} of {b.rate.whole}</span></li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="span-6">
          <Card title="Upcoming events" subtitle={`Next ${UPCOMING_DAYS} days`}
            actions={upcoming.length > 5 ? <Link to="/events?tab=confirmed">View all ({upcoming.length})</Link> : null}>
            {upcoming.length === 0 ? <p className="muted">No events in the next {UPCOMING_DAYS} days.</p> : (
              <ul className="short-list">
                {upcoming.slice(0, 5).map((e) => (
                  <li key={e.id}>
                    <Link to={`/events/${encodeURIComponent(e.id)}`}><ClientEvent name={e.clientName} eventName={e.eventName} /></Link>
                    <span className="muted">{formatShortDate(e.eventDate)}{eventStatusOf(e) === 'initial' ? ' · initially confirmed' : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="span-6">
          <Card title="Top clients by confirmed value" subtitle="This year">
            {o.topClients.length === 0 ? <p className="muted">Nothing confirmed this year yet.</p> : (
              <ul className="short-list">
                {o.topClients.map((c) => (
                  <li key={c.clientId}><strong>{clientName(c.clientId, c.clientName)}</strong>
                    <span className="tabular">{c.priced ? `${formatCurrency(c.value)} · ` : ''}{c.count} confirmed</span></li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="span-6">
          <Card title="Lost reasons" subtitle="This year · top 3">
            {o.lostReasons.length === 0 ? <p className="muted">Nothing lost this year.</p> : (
              <ul className="short-list">
                {o.lostReasons.map((r) => <li key={r.key}><strong>{r.label}</strong><span className="tabular">{r.count}</span></li>)}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </PageLayout>
  )
}
