import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import PageLayout from '../components/layout/PageLayout.jsx'
import RoleGate from '../components/layout/RoleGate.jsx'
import Card from '../components/ui/Card.jsx'
import DataTable from '../components/ui/DataTable.jsx'
import KpiCard from '../components/dashboard/KpiCard.jsx'
import { SkeletonCards, SkeletonList } from '../components/ui/Skeleton.jsx'
import Tabs from '../components/ui/Tabs.jsx'
import { ClientEvent } from '../components/dashboard/cells.jsx'
import { FunnelStrip, RadarCount } from './dashboards/FocusedHome.jsx'
import { usePageDescription } from './PlaceholderPage.jsx'
import { useAnalyticsData, useCurrentUser, useLists, useLookups } from '../data/hooks.js'
import { findNavItem } from '../navigation.js'
import { isManagementView } from '../domain/access.js'
import { BRANDS, getBrand } from '../domain/brands.js'
import { cairoTodayISO, eventCounts } from '../domain/events.js'
import { optionLabel } from '../domain/lists.js'
import {
  PERIODS, PERIOD_IDS, amScorecard, amTable, bdScorecard, bdTable, changeCounts, companyScorecard, daysText, lostReasons,
  measuresOf, monthly, onTimeRate, results, scorecardCsv, turnaround, valueCards,
} from '../domain/scorecard.js'
import { getTeam } from '../domain/waiting.js'
import { formatCurrency, formatShortDate, formatTotal } from '../lib/format.js'
import { proposalLink } from '../lib/links.js'
import useTab from '../lib/useTab.js'

const monthLabel = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })
const RESULT_TABS = [{ id: 'won', label: 'Confirmed' }, { id: 'lost', label: 'Lost' }, { id: 'postponed', label: 'Postponed' }]
export const ANALYTICS_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'proposals', label: 'Proposals' },
  { id: 'events', label: 'Events' },
  { id: 'bd', label: 'BD' },
  { id: 'am', label: 'AM' },
  { id: 'lost', label: 'Lost reasons' },
]

/**
 * Analytics ("See analytics": Noha, Doaa, Tony), one page with tabs in the URL:
 *   Overview · Proposals · Events · BD · AM · Lost reasons
 * The period (default This year), brand and person picker sit above the tabs. Every number comes from
 * domain/scorecard.js and domain/events.js (the same functions as My Work, the Dashboard and the screen).
 * `mine`: BD's and an AM's "My numbers" on their Dashboard (their own scorecard; Overview and Proposals only).
 */
export function Analytics({ mine = false }) {
  const [params, setParams] = useSearchParams()
  const { user, activeRole } = useCurrentUser()
  const viewer = { userId: user.id, activeRole }
  const management = !mine && isManagementView(viewer, user)
  const [tab, setTab] = useTab(ANALYTICS_TABS.map((t) => t.id))
  const person = management ? params.get('person') : null
  const as = management ? params.get('as') : null
  const period = PERIOD_IDS.includes(params.get('period')) ? params.get('period') : 'year'
  const brand = BRANDS.some((b) => b.id === params.get('brand')) ? params.get('brand') : ''
  const analytics = useAnalyticsData({ person, as })
  const lists = useLists().data
  const [resultTab, setResultTab] = useState('won')
  const today = cairoTodayISO()
  const set = (patch) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace: true })
  }

  if (!analytics.data) return analytics.error ? <p className="muted" role="status">{analytics.error.message}</p> : <><SkeletonCards /><SkeletonList rows={4} /></>
  const { scope, people = [] } = analytics.data
  const requests = analytics.data.requests.filter((r) => !brand || r.brand === brand)
  const reasonLabel = (team, code) => `${getTeam(team)?.label ?? team}: ${optionLabel(lists, getTeam(team)?.reasons, code)}`
  const card = scope.kind === 'bd' ? bdScorecard(requests, period, today)
    : scope.kind === 'am' ? amScorecard(requests, period, today)
      : companyScorecard(requests, period, today, { reasonLabel })
  const months = monthly(requests, period, today)
  const max = Math.max(1, ...months.flatMap((m) => [m.received, m.won, m.lost]))
  const list = results(requests, period, today, 10)
  const scopeName = scope.kind === 'company' ? 'the company'
    : people.find((p) => p.id === scope.userId)?.name ?? (scope.userId === user.id ? 'you' : scope.userId)
  const periodLabel = PERIODS.find((p) => p.id === period).label
  const company = management && scope.kind === 'company'
  const bdRows = company ? bdTable(requests, people, period, today) : []
  const amRows = company ? amTable(requests, people, period, today) : []
  const shown = mine ? ['overview', 'proposals'] : company ? ANALYTICS_TABS.map((t) => t.id) : ['overview', 'proposals', 'events', 'lost']
  const active = shown.includes(tab) ? tab : 'overview'

  const download = () => {
    const blob = new Blob([scorecardCsv(bdRows, amRows, periodLabel)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `iee-scorecards-${period}-${today}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }
  const personValue = person ? `${person}:${as}` : ''
  const nameOf = (p) => (p.active ? p.name : `${p.name} (Former team member)`)
  const ev = eventCounts(requests, today)
  const changes = changeCounts(requests, period, today)
  const decided = requests.filter((r) => measuresOf(r, period, today).sent)
  const lost = lostReasons(requests, period, today)
  const lostRows = requests.filter((r) => measuresOf(r, period, today).lost)

  return (
    <>
      <div className="page-toolbar analytics-toolbar">
        <label className="form-field">
          <span className="form-field__label">Period</span>
          <select value={period} onChange={(e) => set({ period: e.target.value === 'year' ? '' : e.target.value })}>
            {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        {scope.kind === 'company' && (
          <label className="form-field">
            <span className="form-field__label">Brand</span>
            <select value={brand} onChange={(e) => set({ brand: e.target.value })}>
              <option value="">Both brands</option>
              {(analytics.data.brands ?? BRANDS.map((b) => b.id)).map((id) => <option key={id} value={id}>{getBrand(id)?.name}</option>)}
            </select>
          </label>
        )}
        {management && (
          <label className="form-field">
            <span className="form-field__label">Scorecard</span>
            <select value={personValue} onChange={(e) => {
              const [id, kind] = e.target.value.split(':')
              set({ person: id || '', as: kind || '' })
            }}>
              <option value="">The company</option>
              <optgroup label="Business Development">
                {people.filter((p) => p.as === 'bd').map((p) => <option key={`${p.id}:bd`} value={`${p.id}:bd`}>{nameOf(p)}</option>)}
              </optgroup>
              <optgroup label="Account Managers">
                {people.filter((p) => p.as === 'am').map((p) => <option key={`${p.id}:am`} value={`${p.id}:am`}>{nameOf(p)}</option>)}
              </optgroup>
            </select>
          </label>
        )}
        {company && ['bd', 'am'].includes(active) && <button type="button" className="btn" onClick={download}>Download CSV</button>}
      </div>
      {shown.length > 1 && (
        <Tabs label="Analytics" value={active} onChange={setTab} tabs={ANALYTICS_TABS.filter((t) => shown.includes(t.id))} />
      )}

      {active === 'overview' && (
        <>
          <FunnelStrip requests={requests} period={period} onPeriod={(p) => set({ period: p === 'year' ? '' : p })} today={today} scopeLabel={scopeName} />
          <div className="kpi-grid">
            {card.headline.map((h) => (
              <KpiCard key={h.id} label={h.label} icon="chart" value={h.money ? formatTotal(h.value, h.priced) : String(h.value)} note={h.note} />
            ))}
          </div>
          <div className="kpi-grid">
            {valueCards(requests, period, today).map((v) => (
              <KpiCard key={v.id} label={v.label} icon="chart" value={formatTotal(v.value, v.priced)} note={`Based on ${v.priced} of ${v.count} with a price`} />
            ))}
          </div>
          {!mine && <RadarCount />}
          <Card title="By month" subtitle={`Received, confirmed and lost · ${periodLabel.toLowerCase()}`}>
            <div className="mini-bars mini-bars--three" role="img"
              aria-label={months.map((m) => `${monthLabel(m.month)}: ${m.received} received, ${m.won} confirmed, ${m.lost} lost`).join('; ')}>
              {months.map((m) => (
                <div key={m.month} className="mini-bars__month" title={`${monthLabel(m.month)}: ${m.received} received · ${m.won} confirmed · ${m.lost} lost`}>
                  <div className="mini-bars__pair">
                    <span className="mini-bars__bar mini-bars__bar--received" style={{ height: `${(m.received / max) * 100}%` }} />
                    <span className="mini-bars__bar mini-bars__bar--won" style={{ height: `${(m.won / max) * 100}%` }} />
                    <span className="mini-bars__bar" style={{ height: `${(m.lost / max) * 100}%` }} />
                  </div>
                  <span className="mini-bars__label">{monthLabel(m.month)}</span>
                </div>
              ))}
            </div>
            <p className="mini-bars__legend">
              <span className="legend-dot legend-dot--received" /> Received <span className="legend-dot legend-dot--won" /> Confirmed{' '}
              <span className="legend-dot" /> Lost
            </p>
          </Card>
        </>
      )}

      {active === 'proposals' && (
        <>
          <div className="kpi-grid">
            <KpiCard label="AM turnaround" icon="clock" value={daysText(turnaround(decided)).split(' · ')[0]} note={daysText(turnaround(decided))} />
            <KpiCard label="On time" icon="calendar" value={onTimeRate(decided).text} />
            <KpiCard label="Internal changes" icon="clipboard" value={String(changes.internal)} note="Before the client saw it" />
            <KpiCard label="Client revisions" icon="clipboard" value={String(changes.client)} note="After sharing" />
          </div>
          {card.extra && <p className="quiet-line">{card.extra.label}: {card.extra.value}</p>}
          <div className="dash-grid">
            {card.breakdowns.map((b) => (
              <div key={b.id} className="span-6"><Breakdown title={b.title} rows={b.rows} brand={b.id === 'brand'} /></div>
            ))}
          </div>
          <Card title="Results" flush>
            <div className="card-pad">
              <Tabs label="Results" value={resultTab} onChange={setResultTab} tabs={RESULT_TABS.map((t) => ({ ...t, count: list.counts[t.id] }))} />
            </div>
            <ResultsTable rows={list[resultTab]} />
          </Card>
        </>
      )}

      {active === 'events' && (
        <div className="kpi-grid">
          <KpiCard label="Confirmed · upcoming" icon="calendar" value={String(ev.upcoming)} to="/events?tab=confirmed" />
          <KpiCard label="Initially confirmed" icon="calendar" value={String(ev.initial)} note="Not approved for execution yet" to="/events?tab=initial" />
          <KpiCard label="Done" icon="check" value={String(ev.done)} to="/events?tab=done" />
          <KpiCard label="Postponed" icon="clock" value={String(ev.postponed)} to="/events?tab=off" />
          <KpiCard label="Cancelled after confirmation" icon="alert" value={String(ev.cancelled)} to="/events?tab=off" />
        </div>
      )}

      {active === 'bd' && (
        <Card title="Business Development" subtitle="Listed alphabetically, not ranked" flush>
          <DataTable caption="Business Development" rows={bdRows} rowKey={(r) => r.id} emptyMessage="No one yet."
            columns={[
              { key: 'name', header: 'Person', render: (r) => <PersonLink person={r} /> },
              { key: 'requests', header: 'Requests', align: 'end', render: (r) => <span className="tabular">{r.requests}</span> },
              { key: 'sent', header: 'Sent', align: 'end', render: (r) => <span className="tabular">{r.sent}</span> },
              { key: 'won', header: 'Confirmed', align: 'end', render: (r) => <span className="tabular">{r.won}</span> },
              { key: 'lost', header: 'Lost', align: 'end', render: (r) => <span className="tabular">{r.lost}</span> },
              { key: 'rate', header: 'Confirmation rate', align: 'end', nowrap: true, render: (r) => <span className="tabular">{r.winRate}</span> },
            ]} />
        </Card>
      )}

      {active === 'am' && (
        <Card title="Account Managers" subtitle="Listed alphabetically, not ranked" flush>
          <DataTable caption="Account Managers" rows={amRows} rowKey={(r) => r.id} emptyMessage="No one yet."
            columns={[
              { key: 'name', header: 'Person', render: (r) => <PersonLink person={r} /> },
              { key: 'received', header: 'Received', align: 'end', render: (r) => <span className="tabular">{r.received}</span> },
              { key: 'prepared', header: 'Prepared', align: 'end', render: (r) => <span className="tabular">{r.prepared}</span> },
              { key: 'turnaround', header: 'Average turnaround', nowrap: true, render: (r) => r.turnaround },
              { key: 'onTime', header: 'On time', nowrap: true, render: (r) => r.onTime },
              { key: 'changes', header: 'Changes', nowrap: true, render: (r) => r.changes },
            ]} />
        </Card>
      )}

      {active === 'lost' && (
        <div className="dash-grid">
          <div className="span-6">
            <Breakdown title="Lost: rejected or cancelled" rows={[
              { key: 'rejected', label: 'Rejected by the client', count: lostRows.filter((r) => r.status === 'rejected').length },
              { key: 'cancelled', label: 'Cancelled', count: lostRows.filter((r) => r.status !== 'rejected').length },
            ]} />
          </div>
          <div className="span-6"><Breakdown title="Lost reasons" rows={lost} /></div>
        </div>
      )}
      {scope.kind !== 'company' && management && (
        <p className="quiet-line"><Link to="/analytics">Back to the company numbers</Link></p>
      )}
    </>
  )
}

function Breakdown({ title, rows, brand = false }) {
  const top = Math.max(1, ...rows.map((x) => x.count))
  return (
    <Card title={title}>
      {rows.length === 0 ? <p className="muted">Nothing to show for this period.</p> : (
        <ul className="breakdown">
          {rows.map((r) => (
            <li key={r.key}>
              <span>{brand ? getBrand(r.key)?.name ?? r.label : r.label}</span>
              <span className="breakdown__bar"><span style={{ width: `${(r.count / top) * 100}%` }} /></span>
              <span className="tabular">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function PersonLink({ person }) {
  return (
    <Link className="link-btn" to={`/analytics?person=${encodeURIComponent(person.id)}&as=${person.as}`}>
      {person.name}{!person.active && <span className="muted"> · Former team member</span>}
    </Link>
  )
}

function ResultsTable({ rows }) {
  const { clientsById } = useLookups()
  return (
    <DataTable caption="Results" rows={rows} rowKey={(x) => x.request.id} rowHref={(x) => proposalLink(x.request.id)}
      emptyMessage="Nothing for this period."
      columns={[
        { key: 'client', header: 'Client', render: ({ request: r }) => <ClientEvent name={clientsById[r.clientId]?.name ?? r.clientName} eventName={r.eventName} /> },
        { key: 'brand', header: 'Brand', nowrap: true, render: ({ request: r }) => getBrand(r.brand)?.name ?? '—' },
        { key: 'when', header: 'When', nowrap: true, render: ({ at }) => formatShortDate(at) },
        { key: 'price', header: 'Proposal price', align: 'end', nowrap: true,
          render: ({ request: r }) => (r.amPrice ? formatCurrency(r.amPrice) : '—') },
      ]} />
  )
}

export default function AnalyticsPage() {
  const subtitle = usePageDescription(findNavItem('/analytics'))
  return (
    <RoleGate path="/analytics">
      <PageLayout title="Analytics" subtitle={subtitle}>
        <Analytics />
      </PageLayout>
    </RoleGate>
  )
}

