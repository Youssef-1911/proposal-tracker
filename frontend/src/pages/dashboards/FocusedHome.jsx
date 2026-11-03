import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import PageLayout from '../../components/layout/PageLayout.jsx'
import Badge from '../../components/ui/Badge.jsx'
import Card from '../../components/ui/Card.jsx'
import DataTable from '../../components/ui/DataTable.jsx'
import EmptyState from '../../components/ui/EmptyState.jsx'
import Icon from '../../components/ui/Icon.jsx'
import KpiCard from '../../components/dashboard/KpiCard.jsx'
import { ClientEvent, DueDate } from '../../components/dashboard/cells.jsx'
import DashboardLoading from './DashboardLoading.jsx'
import { useAllRequests, useCurrentUser, useEvents, useLists, useLookups, useNewCount, useRadar, useStaffing, useToRate, useTodos, useWaitingOnMe } from '../../data/hooks.js'
import MorningSummary from '../../components/MorningSummary.jsx'
import { MyTodos } from '../../components/Todos.jsx'
import { todosDueToday } from '../../domain/todos.js'
import { operationsSections } from '../../domain/events.js'
import { cairoTodayISO, eventCounts } from '../../domain/events.js'
import RemindButton from '../../components/proposal/RemindButton.jsx'
import { optionLabel } from '../../domain/lists.js'
import { isDeadlineUpcoming, isRequestOverdue } from '../../domain/metrics.js'
import { ROLE } from '../../domain/roles.js'
import { PERIODS, PERIOD_IDS, funnel, funnelChange, results } from '../../domain/scorecard.js'
import CountUp from '../../components/ui/CountUp.jsx'
import { PROPOSAL_STATUS as PS, getStage, getStatus, stageOf, subLabelFor } from '../../domain/status.js'
import { followUpDue } from '../../domain/tracker.js'
import { effectiveWaiting, getTeam, viewerPill, waitingDays } from '../../domain/waiting.js'
import { rowMarkers } from '../../domain/conversation.js'
import StatusPill, { RowMarkers } from '../../components/ui/StatusPill.jsx'
import { formatShortDate } from '../../lib/format.js'
import { proposalLink, proposalsLink } from '../../lib/links.js'

const NEEDS_ATTENTION_MAX = 5
const isOpen = (r) => r.status !== PS.DRAFT && !getStatus('proposal', r.status).closed
const daysText = (n) => (n === null ? '—' : n === 0 ? 'today' : n === 1 ? '1 day' : `${n} days`)

/** The period of the funnel strip (Home: this year by default), kept in the URL. */
function usePeriod() {
  const [params, setParams] = useSearchParams()
  const period = PERIOD_IDS.includes(params.get('period')) ? params.get('period') : 'year'
  const setPeriod = (p) => {
    const next = new URLSearchParams(params)
    if (p === 'year') next.delete('period')
    else next.set('period', p)
    setParams(next, { replace: true })
  }
  return [period, setPeriod]
}

/** Received → Prepared → Sent → Won · Lost · Postponed | In progress, with the period selector. */
export function FunnelStrip({ requests, period, onPeriod, today, scopeLabel }) {
  const f = funnel(requests, period, today)
  const ev = eventCounts(requests, today) // shown separately: never mixed into Done
  // "↑ 3 vs last month": the same days of the previous period; hidden when there is nothing to compare.
  const change = funnelChange(requests, period, today)
  const step = (label, value, tone, key, upIsGood = true) => (
    <span className={`funnel__step${tone ? ` funnel__step--${tone}` : ''}`}>
      <span className="funnel__value tabular"><CountUp value={value} id={`funnel:${scopeLabel}:${label}`} /></span>
      <span className="funnel__label">{label}</span>
      {change && key && <Change n={change[key]} label={change.label} upIsGood={upIsGood} />}
    </span>
  )
  return (
    <section className="funnel" aria-label={`Funnel: ${scopeLabel}`}>
      <div className="funnel__steps">
        {step('Received', f.received, null, 'received')}
        <Icon name="arrowRight" size={14} className="funnel__arrow" />
        {step('Prepared', f.prepared, null, 'prepared')}
        <Icon name="arrowRight" size={14} className="funnel__arrow" />
        {step('Sent', f.sent, null, 'sent')}
        <Icon name="arrowRight" size={14} className="funnel__arrow" />
        {step('Confirmed', f.won, 'won', 'won')}
        {step('Lost', f.lost, null, 'lost', false)}
        {step('Postponed', f.postponed, null, 'postponed', false)}
        <span className="funnel__divider" aria-hidden="true" />
        {step('In progress', f.inProgress)}
      </div>
      <p className="funnel__events">
        Events: {ev.upcoming} confirmed upcoming · {ev.initial} initially confirmed · {ev.done} done · {ev.cancelled} cancelled after confirmation
      </p>
      <label className="funnel__period">
        <span className="sr-only">Period</span>
        <select value={period} onChange={(e) => onPeriod(e.target.value)}>
          {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
    </section>
  )
}

/** "↑ 3 vs last month" (green when that is good news, red when not; "= vs last month" when unchanged). */
function Change({ n, label, upIsGood }) {
  if (n === 0) return <span className="funnel__change">= {label}</span>
  const good = n > 0 === upIsGood
  return (
    <span className={`funnel__change funnel__change--${good ? 'good' : 'bad'}`}>
      {n > 0 ? '↑' : '↓'} {Math.abs(n)} {label}
    </span>
  )
}

/** What's blocking it: the reason set by hand, else the detailed stage ("Preparing", "Awaiting reply"…). */
function blocking(r, lists) {
  const w = effectiveWaiting(r)
  if (w?.kind === 'manual') {
    const reason = optionLabel(lists, getTeam(w.team).reasons, w.reason)
    return w.expectedBy ? `${reason} · expected ${formatShortDate(w.expectedBy)}` : reason
  }
  return subLabelFor(r.status, r.version) ?? getStage(stageOf(r.status)).label
}

/**
 * Needs Attention: open requests in this Home's scope, overdue first then the longest wait.
 * At most 5 rows, then "View all (N)". Chips: Waiting on me · Overdue · All.
 */
export function NeedsAttention({ requests, today, defaultChip = 'me' }) {
  const { user, activeRole } = useCurrentUser()
  const viewer = { userId: user.id, activeRole }
  const { usersById, clientsById } = useLookups()
  const lists = useLists().data
  const [chip, setChip] = useState(defaultChip)
  const open = requests.filter((r) => isOpen(r) && !r.needsReview)
  const byChip = {
    me: open.filter((r) => effectiveWaiting(r)?.userId === user.id),
    overdue: open.filter((r) => isRequestOverdue(r, today)),
    all: open,
  }
  const now = new Date()
  const rows = [...byChip[chip]].sort((a, b) =>
    Number(isRequestOverdue(b, today)) - Number(isRequestOverdue(a, today))
    || (waitingDays(effectiveWaiting(b), now) ?? 0) - (waitingDays(effectiveWaiting(a), now) ?? 0))
  const links = { me: proposalsLink({ waiting: 'me' }), overdue: proposalsLink({ deadline: 'overdue' }), all: proposalsLink({ open: 'true' }) }
  const chips = [{ id: 'me', label: 'Waiting on me' }, { id: 'overdue', label: 'Overdue' }, { id: 'all', label: 'All' }]
  return (
    <Card title="Needs attention" flush
      actions={rows.length > NEEDS_ATTENTION_MAX ? <Link to={links[chip]}>View all ({rows.length})</Link> : null}>
      <div className="waiting-chips card-pad" role="group" aria-label="Show">
        {chips.map((c) => (
          <button key={c.id} type="button" aria-pressed={chip === c.id} className={`chip-toggle${chip === c.id ? ' is-on' : ''}`}
            onClick={() => setChip(c.id)}>
            {c.label} <span className="tabular muted">{byChip[c.id].length}</span>
          </button>
        ))}
      </div>
      <DataTable
        caption="Needs attention"
        rows={rows.slice(0, NEEDS_ATTENTION_MAX)}
        rowKey={(r) => r.id}
        rowHref={(r) => proposalLink(r.id)}
        emptyMessage={chip === 'me' ? 'Nothing waiting on you.' : chip === 'overdue' ? 'Nothing overdue.' : 'No open requests.'}
        columns={[
          {
            key: 'client', header: 'Client',
            render: (r) => (
              <span className="stack">
                <span>{r.newForYou && <span className="new-dot" aria-label="New for you" />}
                  <ClientEvent name={clientsById[r.clientId]?.name ?? r.clientName} eventName={r.eventName} /></span>
                {r.newForYou && <span className="new-line">{r.newForYou.line}</span>}
                <RowMarkers markers={rowMarkers(r, viewer)} />
              </span>
            ),
          },
          {
            key: 'blocking', header: "What's blocking it",
            render: (r) => (
              <span>
                {blocking(r, lists)}
                {isRequestOverdue(r, today) && <> <Badge tone="danger" icon="alert">Overdue</Badge></>}
              </span>
            ),
          },
          { key: 'who', header: 'Who acts next', nowrap: true, render: (r) => <StatusPill pill={viewerPill(r, viewer, usersById, today)} request={r} /> },
          {
            key: 'wait', header: 'Waiting', nowrap: true,
            render: (r) => (
              <span className="stack">
                <span className="tabular">{daysText(waitingDays(effectiveWaiting(r), now))}</span>
                <RemindButton request={r} compact />
              </span>
            ),
          },
          { key: 'deadline', header: 'Deadline', nowrap: true, render: (r) => <DueDate date={r.requiredBy} active={isRequestOverdue(r, today) || isDeadlineUpcoming(r, today)} /> },
        ]}
      />
    </Card>
  )
}

function Cards({ items }) {
  return (
    <div className="kpi-grid kpi-grid--3">
      {items.map((c) => <KpiCard key={c.label} {...c} value={String(c.value)} tone={c.tone ?? 'default'} />)}
    </div>
  )
}

/** One small list card (Due this week · Last 5 results), at most 5 rows. */
function ShortList({ title, rows, empty, render, viewAll }) {
  const { clientsById } = useLookups()
  return (
    <Card title={title} actions={viewAll ?? null}>
      {rows.length === 0 ? <p className="muted">{empty}</p> : (
        <ul className="short-list">
          {rows.slice(0, 5).map((r) => (
            <li key={r.id}>
              <Link to={proposalLink(r.id)}><ClientEvent name={clientsById[r.clientId]?.name ?? r.clientName} eventName={r.eventName} /></Link>
              <span className="muted">{render(r)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function useHomeData() {
  const res = useAllRequests()
  return { requests: res.data, error: res.error, today: cairoTodayISO() }
}

// ---------------------------------------------------------------------------
// One Home per role
// ---------------------------------------------------------------------------

export function BdHome({ subtitle }) {
  const { user } = useCurrentUser()
  const { requests: all, error, today } = useHomeData()
  const [period, setPeriod] = usePeriod()
  if (!all) return <DashboardLoading subtitle={subtitle} error={error} />
  const mine = all.filter((r) => r.bdOwner === user.id)
  const open = mine.filter(isOpen)
  const mineLink = (extra) => proposalsLink({ bdOwner: user.id, ...extra })
  return (
    <PageLayout title="Dashboard" subtitle={subtitle}>
      <FunnelStrip requests={mine} period={period} onPeriod={setPeriod} today={today} scopeLabel="your requests" />
      <RadarCount />
      <NeedsAttention requests={mine} today={today} />
      <Cards items={[
        { label: 'Ready to send', icon: 'document', value: open.filter((r) => r.status === PS.READY_FOR_BD).length,
          note: 'Proposals the AM finished', to: mineLink({ status: PS.READY_FOR_BD }) },
        { label: 'Waiting for client reply', icon: 'clock', value: open.filter((r) => r.status === PS.SHARED_WITH_CLIENT).length,
          note: 'Shared with the client', to: mineLink({ status: PS.SHARED_WITH_CLIENT }) },
        { label: 'Postponed follow-ups due', icon: 'calendar', value: open.filter((r) => followUpDue(r)).length,
          note: 'Follow-up date reached', to: mineLink({ status: PS.POSTPONED }) },
      ]} />
    </PageLayout>
  )
}

export function AmHome({ subtitle }) {
  const { user } = useCurrentUser()
  const { requests: all, error, today } = useHomeData()
  const [period, setPeriod] = usePeriod()
  if (!all) return <DashboardLoading subtitle={subtitle} error={error} />
  const mine = all.filter((r) => r.assignedAM === user.id)
  const open = mine.filter(isOpen)
  const overdue = open.filter((r) => isRequestOverdue(r, today))
  const dueThisWeek = open.filter((r) => isDeadlineUpcoming(r, today)).sort((a, b) => a.requiredBy.localeCompare(b.requiredBy))
  const mineLink = (extra) => proposalsLink({ assignedAM: user.id, ...extra })
  return (
    <PageLayout title="Dashboard" subtitle={subtitle}>
      <FunnelStrip requests={mine} period={period} onPeriod={setPeriod} today={today} scopeLabel="requests assigned to you" />
      <NeedsAttention requests={mine} today={today} />
      <Cards items={[
        { label: 'New in my queue', icon: 'document', value: open.filter((r) => r.status === PS.SUBMITTED).length,
          note: 'Submitted, not started', to: mineLink({ status: PS.SUBMITTED }) },
        { label: 'Revisions', icon: 'clipboard', value: open.filter((r) => r.status === PS.REVISION_REQUESTED).length,
          note: 'The client wants changes', to: mineLink({ status: PS.REVISION_REQUESTED }) },
        { label: 'Overdue', icon: 'alert', value: overdue.length, tone: overdue.length ? 'danger' : 'default',
          note: 'Past the proposal deadline', to: mineLink({ deadline: 'overdue' }) },
      ]} />
      <ShortList title="Due this week" rows={dueThisWeek} empty="Nothing due in the next 7 days."
        render={(r) => `due ${formatShortDate(r.requiredBy)}`}
        viewAll={dueThisWeek.length > 5 ? <Link to={mineLink({ deadline: 'upcoming' })}>View all ({dueThisWeek.length})</Link> : null} />
    </PageLayout>
  )
}

export function HeadHome({ subtitle }) {
  const { requests: all, error, today } = useHomeData()
  const [period, setPeriod] = usePeriod()
  if (!all) return <DashboardLoading subtitle={subtitle} error={error} />
  const open = all.filter((r) => isOpen(r) && !r.needsReview)
  const waitingOn = (team) => open.filter((r) => effectiveWaiting(r)?.team === team).length
  const overdue = open.filter((r) => isRequestOverdue(r, today)).length
  const last = results(all, 'all', today, 5)
  const lastFive = [...last.won, ...last.lost].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5)
  return (
    <PageLayout title="Dashboard" subtitle={subtitle}>
      <FunnelStrip requests={all} period={period} onPeriod={setPeriod} today={today} scopeLabel="the company" />
      <NeedsAttention requests={all} today={today} defaultChip="all" />
      <RadarCount />
      <Cards items={[
        { label: 'Waiting on BD', icon: 'users', value: waitingOn('bd'), note: 'Open requests BD must move', to: proposalsLink({ waiting: 'bd' }) },
        { label: 'Waiting on AM', icon: 'clipboard', value: waitingOn('am'), note: 'Open requests an AM must move', to: proposalsLink({ waiting: 'am' }) },
        { label: 'Overdue', icon: 'alert', value: overdue, tone: overdue ? 'danger' : 'default', note: 'Past the proposal deadline',
          to: proposalsLink({ deadline: 'overdue' }) },
      ]} />
      <ShortList title="Last 5 results" rows={lastFive.map((x) => ({ ...x.request, resultAt: x.at }))} empty="No results yet."
        render={(r) => `${r.status === PS.ACCEPTED ? 'Confirmed' : 'Lost'} · ${formatShortDate(r.resultAt)}`} />
    </PageLayout>
  )
}

/** Marketing / Operations: "Waiting on you (N)", each with a one-click "Done — back to …". */
export function WaitingOnYouHome({ subtitle }) {
  const { activeRole } = useCurrentUser()
  const { items, isLoading, error, done } = useWaitingOnMe()
  const [busy, setBusy] = useState(null)
  const [message, setMessage] = useState(null)
  const finish = async (item) => {
    setBusy(item.id)
    const result = await done(item)
    setBusy(null)
    setMessage(result.ok ? result.message : result.error)
  }
  const team = activeRole === ROLE.MARKETING ? 'Marketing' : activeRole === ROLE.OPERATIONS ? 'Operations' : null
  const toRate = useToRate()
  const events = useEvents().data
  const newCount = useNewCount()
  const week = events ? operationsSections(events.items ?? [], [], {}, events.today ?? cairoTodayISO()).week.length : 0
  const isHR = activeRole === ROLE.HR
  const todos = useTodos()
  return (
    <PageLayout title="My Work" subtitle={subtitle}>
      <MorningSummary counts={{ newItems: newCount, eventsThisWeek: week, todosDueToday: todosDueToday(todos.items, cairoTodayISO()) }} />
      <MyTodos />
      {toRate.length > 0 && (
        <Card title={`Rate facilitators (${toRate.length})`} subtitle="Done events: stars, attended yes / no, and feedback (you can change it for 7 days)">
          <ul className="short-list">
            {toRate.map((e) => (
              <li key={e.id}>
                <Link to={`/events/${encodeURIComponent(e.id)}#staffing`}><ClientEvent name={e.clientName} eventName={e.eventName} /></Link>
                <span className="muted">{e.eventDate ? formatShortDate(e.eventDate) : '—'} · {e.missing} to rate</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {isHR && <StaffingAttention />}
      {!isHR && (
      <Card title={`Waiting on you (${items.length})`} subtitle={team ? `Requests that need ${team} or you by name` : null}>
        {error && <p className="form-error" role="alert">{error.message}</p>}
        {message && <p className="muted" role="status">{message}</p>}
        {!isLoading && items.length === 0 ? (
          <EmptyState icon="check" title="Nothing is waiting on you">When someone needs you on a request, it shows here.</EmptyState>
        ) : (
          <ul className="short-list short-list--actions">
            {items.map((it) => (
              <li key={it.id}>
                <span className="stack">
                  {it.canOpen
                    ? <Link to={proposalLink(it.id)}><ClientEvent name={it.clientName} eventName={it.eventName} /></Link>
                    : <ClientEvent name={it.clientName} eventName={it.eventName} />}
                  <span className="muted">
                    {it.id} · {it.reasonLabel}{it.expectedBy ? ` · expected ${formatShortDate(it.expectedBy)}` : ''}
                    {it.note ? ` · ${it.note}` : ''}
                  </span>
                </span>
                <button type="button" className="btn btn--sm" disabled={busy === it.id} aria-busy={busy === it.id}
                  onClick={() => finish(it)}>
                  Done — back to {it.backTo}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      )}
      <UpcomingEvents />
    </PageLayout>
  )
}

/** Marketing / Operations: confirmed events in the next 14 days (at most 5), soonest first. */
function UpcomingEvents() {
  const { data } = useEvents()
  const today = cairoTodayISO()
  const limit = new Date(`${today}T00:00:00Z`)
  limit.setUTCDate(limit.getUTCDate() + 14)
  const until = limit.toISOString().slice(0, 10)
  const soon = (data?.items ?? [])
    .filter((e) => e.timing === 'upcoming' && /^\d{4}-\d{2}-\d{2}$/.test(e.eventDate ?? '') && e.eventDate <= until)
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate))
  return (
    <Card title="Upcoming events (next 14 days)" actions={soon.length > 5 ? <Link to="/events?tab=confirmed">View all ({soon.length})</Link> : null}>
      {soon.length === 0 ? <p className="muted">No events in the next 14 days.</p> : (
        <ul className="short-list">
          {soon.slice(0, 5).map((e) => (
            <li key={e.id}>
              <Link to={`/events/${encodeURIComponent(e.id)}`}><ClientEvent name={e.clientName} eventName={e.eventName} /></Link>
              <span className="muted">{formatShortDate(e.eventDate)}{e.participants ? ` · ${e.participants} people` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/** HR: events in the next 4 weeks still missing facilitators (the Staffing page has everything). */
function StaffingAttention() {
  const { data } = useStaffing()
  const short = (data?.items ?? []).filter((e) => (e.facilitatorsNeeded ?? 0) > (e.assignedCount ?? 0))
  return (
    <Card title={`Missing facilitators (${short.length})`} actions={<Link to="/staffing">Staffing</Link>}>
      {short.length === 0 ? <p className="muted">Every event with a number needed is staffed.</p> : (
        <ul className="short-list">
          {short.slice(0, 5).map((e) => (
            <li key={e.id}>
              <Link to={`/events/${encodeURIComponent(e.id)}#staffing`}><ClientEvent name={e.clientName} eventName={e.eventName} /></Link>
              <span className="text-danger">{e.facilitatorsNeeded - e.assignedCount} missing</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/** "Radar: N clients · M turned into requests" (BD: their clients; Noha: all). */
export function RadarCount() {
  const radar = useRadar()
  if (!radar.available || !radar.data) return null
  return (
    <p className="quiet-line">
      <Link to="/clients?tab=radar">Likely to book soon: {radar.data.clients} {radar.data.clients === 1 ? 'client' : 'clients'}</Link>
      {' · '}{radar.data.turnedIntoRequests} turned into requests this year
    </p>
  )
}
