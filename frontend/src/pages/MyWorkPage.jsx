import { useState } from 'react'
import PageLayout from '../components/layout/PageLayout.jsx'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import DataTable from '../components/ui/DataTable.jsx'
import { ClientEvent, DueDate } from '../components/dashboard/cells.jsx'
import SegmentedControl from '../components/ui/SegmentedControl.jsx'
import RemindButton from '../components/proposal/RemindButton.jsx'
import { WaitingBar } from '../components/proposal/WaitingOn.jsx'
import DueByDate from '../components/proposal/DueByDate.jsx'
import DashboardLoading from './dashboards/DashboardLoading.jsx'
import { WaitingOnYouHome } from './dashboards/FocusedHome.jsx'
import { usePageDescription } from './PlaceholderPage.jsx'
import { useAllRequests, useCurrentUser, useLists, useLookups, useTodos } from '../data/hooks.js'
import MorningSummary from '../components/MorningSummary.jsx'
import { MyTodos } from '../components/Todos.jsx'
import { findNavItem } from '../navigation.js'
import { cairoTodayISO } from '../domain/events.js'
import { optionLabel } from '../domain/lists.js'
import { isRequestOverdue } from '../domain/metrics.js'
import { followUpDue } from '../domain/tracker.js'
import { daysWithMe, foldsGroups, myWorkSection, neededAction, sentBy, stuckDays, waitingOnOthers } from '../domain/myWork.js'
import RelTime from '../components/ui/RelTime.jsx'
import { ROLE } from '../domain/roles.js'
import { PROPOSAL_STATUS as PS, getStage, getStatus, stageOf, subLabelFor } from '../domain/status.js'
import { todosDueToday } from '../domain/todos.js'
import { effectiveWaiting, getTeam, waitingDays } from '../domain/waiting.js'
import { formatShortDate } from '../lib/format.js'
import { proposalLink } from '../lib/links.js'

const RECENT = 5
const daysText = (n) => (n === null || n === undefined ? '—' : n === 0 ? 'today' : n === 1 ? '1 day' : `${n} days`)
const isClosed = (r) => getStatus('proposal', r.status).closed
const HISTORY = [PS.CLOSED_UNRECORDED, PS.CLOSED_POSTPONED]

/** What is needed now (for "Waiting on others"): the reason set by hand, else the detailed stage. */
function needed(r, lists) {
  const w = effectiveWaiting(r)
  if (w?.kind === 'manual') return optionLabel(lists, getTeam(w.team).reasons, w.reason)
  return subLabelFor(r.status, r.version) ?? getStage(stageOf(r.status)).label
}

/** Within the next 3 days (or today): highlighted in the AM queue. */
function dueSoon(r, today) {
  if (!r.requiredBy || isRequestOverdue(r, today)) return false
  const d = (new Date(`${r.requiredBy}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000
  return d >= 0 && d <= 3
}

/** The last time anything happened on it: every section lists the most recent activity first. */
const lastAt = (r) => [r.lastUpdated, (r.statusHistory ?? []).at(-1)?.changedAt, r.newForYou?.at].filter(Boolean).sort().at(-1) ?? ''
const newestFirst = (a, b) => String(lastAt(b)).localeCompare(String(lastAt(a)))

/**
 * My Work: everyone's first page. The same records as everywhere else (no copies), in sections that
 * need no filters: New · Your turn · My to-dos · Waiting on others (the team, by person; the client) ·
 * Recently finished. A section with nothing in it is not shown. Which request goes where is one shared
 * rule (domain/myWork.js). Noha and the Executives: Waiting on others covers every open request in the
 * company, folded to one line per person, with "Stuck · N days" and "Sent by you" on the rows.
 * Account Managers can switch to "Due by date". Marketing, Operations and HR see what is waiting on them.
 */
export default function MyWorkPage() {
  const { user, activeRole } = useCurrentUser()
  const subtitle = usePageDescription(findNavItem('/'))
  if ([ROLE.MARKETING, ROLE.OPERATIONS, ROLE.HR].includes(activeRole)) return <WaitingOnYouHome subtitle={subtitle} />
  return <MyWork key={`${user.id}:${activeRole}`} subtitle={subtitle} />
}

function MyWork({ subtitle }) {
  const { user, activeRole } = useCurrentUser()
  const { usersById, clientsById } = useLookups()
  const lists = useLists().data
  const { data, error } = useAllRequests()
  const todos = useTodos()
  const [view, setView] = useState('inbox')
  const today = cairoTodayISO()
  if (!data) return <DashboardLoading title="My Work" subtitle={subtitle} error={error} />

  const me = user.id
  const now = new Date()
  const viewer = { userId: me, activeRole }
  const isAM = activeRole === ROLE.ACCOUNT_MANAGER
  const followUpNow = (r) => r.status === PS.POSTPONED && r.bdOwner === me && !isAM && followUpDue(r, now)
  const involved = (r) => r.bdOwner === me || r.assignedAM === me || r.createdBy === me

  const fresh = data.filter((r) => r.newForYou).sort((a, b) => String(b.newForYou.at).localeCompare(String(a.newForYou.at)))
  const myTurn = data.filter((r) => myWorkSection(r, viewer, now) === 'turn').sort(newestFirst)
  const others = waitingOnOthers(data, viewer, usersById, now, newestFirst)
  const finished = data.filter((r) => involved(r) && isClosed(r) && !HISTORY.includes(r.status) && !r.imported)
    .sort(newestFirst).slice(0, RECENT)
  const stuck = [...others.team.flatMap((g) => g.requests), ...others.client].filter((r) => stuckDays(r, viewer, now) !== null)
  const folded = foldsGroups(viewer)

  // The morning summary: at most 3 facts for this role (domain/morning.js).
  const longest = [...myTurn].sort((a, b) => (waitingDays(effectiveWaiting(b), now) ?? 0) - (waitingDays(effectiveWaiting(a), now) ?? 0))[0]
  const counts = {
    newItems: fresh.length,
    overdue: myTurn.filter((r) => isRequestOverdue(r, today)).length,
    dueToday: myTurn.filter((r) => r.requiredBy === today).length,
    todosDueToday: todosDueToday(todos.items, today),
    longestWait: longest ? { name: clientsById[longest.clientId]?.name ?? longest.clientName ?? longest.id,
      days: waitingDays(effectiveWaiting(longest), now) ?? 0, to: proposalLink(longest.id) } : null,
    questions: myTurn.filter((r) => (r.openQuestions ?? 0) > 0).length,
    stuck: stuck.length,
  }

  const client = {
    key: 'client', header: 'Client',
    render: (r) => (
      <span className="stack">
        {r.newForYou && <span className="new-dot" aria-label="New for you" />}
        <ClientEvent name={clientsById[r.clientId]?.name ?? r.clientName} eventName={r.eventName} />
      </span>
    ),
  }
  // "Your turn": what to do, how long it has been with me, the deadline (never my own name as "Waiting on").
  const turnColumns = [
    client,
    { key: 'what', header: "What's needed", render: (r) => neededAction(r, viewer, usersById, lists) },
    {
      key: 'days', header: 'Days with me', nowrap: true,
      render: (r) => {
        const { days, late } = daysWithMe(r, today, now)
        return <span className={`tabular${late ? ' text-danger' : ''}`}>{daysText(days)}</span>
      },
    },
    {
      key: 'deadline', header: 'Deadline', nowrap: true,
      render: (r) => (r.requiredBy ? <DueDate date={r.requiredBy} active={!isClosed(r)} /> : <span className="muted">No deadline set</span>),
    },
  ]
  const columns = (what, { remind = false } = {}) => [
    client,
    {
      key: 'what', header: what,
      render: (r) => {
        const days = stuckDays(r, viewer, now)
        const text = r.newForYou && what === "What's new" ? r.newForYou.line
          : followUpNow(r) ? `Follow up with the client (due ${formatShortDate(r.followUpOn)})` : needed(r, lists)
        const mine = what !== "What's new" && sentBy(r, viewer)
        if (days === null && !mine) return text
        return (
          <span className="stack">
            <span className="badge-row">
              {days !== null && <Badge tone="danger">Stuck · {days} days</Badge>}
              {mine && <Badge tone="info">Sent by you</Badge>}
            </span>
            <span>{text}</span>
          </span>
        )
      },
    },
    { key: 'who', header: 'Waiting on', render: (r) => <WaitingBar request={r} small /> },
    { key: 'deadline', header: 'Deadline', nowrap: true, render: (r) => <DueDate date={r.requiredBy} active={!isClosed(r)} /> },
    ...(remind ? [{ key: 'remind', header: '', nowrap: true, render: (r) => <RemindButton request={r} compact /> }] : []),
  ]
  const table = (rows, what, caption, opts) => (
    <DataTable caption={caption} rows={rows} rowKey={(r) => r.id} rowHref={(r) => proposalLink(r.id)} rowPeek={(r) => r.id} rowBrand={(r) => r.brand} columns={columns(what, opts)}
      rowClassName={(r) => [r.newForYou && 'is-new', isRequestOverdue(r, today) && 'is-overdue', dueSoon(r, today) && 'is-due-soon']
        .filter(Boolean).join(' ')} />
  )
  // The AM's "Due by date": every open request of their brand (and any assigned to them), waiting on others too.
  const brandOpen = data.filter((r) => r.status !== PS.DRAFT && !isClosed(r) && !r.needsReview
    && (r.assignedAM === me || (user.brand && r.brand === user.brand)))

  return (
    <PageLayout title="My Work" subtitle={subtitle}
      actions={isAM ? (
        <SegmentedControl label="Show" value={view} onChange={setView}
          options={[{ value: 'inbox', label: 'My Work' }, { value: 'due', label: 'Due by date' }]} />
      ) : null}>
      {isAM && view === 'due' ? (
        <DueByDate requests={brandOpen} today={today} />
      ) : (
        <div className="my-work">
          <MorningSummary counts={counts} />
          {fresh.length > 0 && (
            <Card id="new" title={`New (${fresh.length})`} flush>
              {table(fresh, "What's new", 'New for you')}
            </Card>
          )}
          {myTurn.length > 0 && (
            <Card id="your-turn" title={`Your turn (${myTurn.length})`} flush>
              <DataTable caption="Your turn" rows={myTurn} rowKey={(r) => r.id} rowHref={(r) => proposalLink(r.id)} rowPeek={(r) => r.id} rowBrand={(r) => r.brand} columns={turnColumns}
                rowClassName={(r) => [r.newForYou && 'is-new', isRequestOverdue(r, today) && 'is-overdue'].filter(Boolean).join(' ')} />
            </Card>
          )}
          <MyTodos />
          {others.total > 0 && (
            <Card id="waiting" title={`Waiting on others (${others.total})`} flush>
              {others.team.length > 0 && <h3 className="table-group-title table-group-title--major">The team</h3>}
              {/* Noha and the Executives: one line per person (click to open); everyone else sees the rows. */}
              {others.team.map((g) => (
                <details key={g.key} className="wait-group" open={!folded}>
                  <summary className="table-group-title wait-group__line">
                    <span className="wait-group__name">{g.label} · {g.count}</span>
                    <span className="muted tabular">longest {daysText(g.longestDays)}</span>
                    {folded && g.newest && (
                      <span className="muted wait-group__newest">
                        newest: {usersById[g.newest.bdOwner]?.name ?? 'Someone'}&apos;s request for {clientsById[g.newest.clientId]?.name ?? g.newest.clientName ?? g.newest.id},{' '}
                        <RelTime value={effectiveWaiting(g.newest)?.since} />
                      </span>
                    )}
                  </summary>
                  {table(g.requests, "What's needed", g.label, { remind: true })}
                </details>
              ))}
              {others.client.length > 0 && (
                <details className="wait-group" open={!folded}>
                  <summary className="table-group-title table-group-title--major wait-group__line">
                    <span className="wait-group__name">The client · {others.client.length}</span>
                    <span className="muted">Shared or postponed; postponed ones come back to the BD owner on their follow-up date</span>
                  </summary>
                  {table(others.client, "What's needed", 'The client')}
                </details>
              )}
            </Card>
          )}
          {finished.length > 0 && (
            <Card title="Recently finished" flush>
              {table(finished, 'Result', 'Recently finished')}
            </Card>
          )}
        </div>
      )}
      <p className="quiet-line">Due dates in red are overdue; due within 3 days is highlighted. {formatShortDate(today)}.</p>
    </PageLayout>
  )
}
