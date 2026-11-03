import { Link, useSearchParams } from 'react-router-dom'
import PageLayout from '../components/layout/PageLayout.jsx'
import Card from '../components/ui/Card.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import SegmentedControl from '../components/ui/SegmentedControl.jsx'
import DueByDate from '../components/proposal/DueByDate.jsx'
import DashboardLoading from './dashboards/DashboardLoading.jsx'
import { useAllRequests, useCurrentUser, useLookups } from '../data/hooks.js'
import { cairoTodayISO } from '../domain/events.js'
import { deadlineSummary, deadlineTone } from '../domain/deadlines.js'
import { queueBoard } from '../domain/queue.js'
import { ROLE } from '../domain/roles.js'
import { waitingLabel } from '../domain/waiting.js'
import { formatShortDate } from '../lib/format.js'
import { proposalLink } from '../lib/links.js'
import { brandEdge } from '../components/ui/BrandTag.jsx'
import { SkeletonList } from '../components/ui/Skeleton.jsx'
import { usePeekLink } from '../lib/peek.js'

const SUBTITLE = 'Every proposal assigned to you, by stage.'
const daysText = (n) => (n === null ? '—' : n === 0 ? 'today' : n === 1 ? '1 day' : `${n} days`)

/**
 * My queue — board (Account Managers only): every open proposal assigned to me, by where it is in
 * production: New · Preparing · Waiting · Ready for BD · With client. Clicking a card opens the
 * request; stages change only through actions. "Due by date" groups the same proposals by deadline.
 */
export default function QueueBoardPage() {
  const { user, activeRole } = useCurrentUser()
  if (activeRole !== ROLE.ACCOUNT_MANAGER) {
    return (
      <PageLayout title="My queue — board" subtitle={SUBTITLE}>
        <Card><EmptyState icon="clipboard" title="For Account Managers">
          {user.roles.includes(ROLE.ACCOUNT_MANAGER) ? 'Switch to Account Manager to see your board.' : 'This board shows the proposals assigned to an Account Manager.'}
        </EmptyState></Card>
      </PageLayout>
    )
  }
  return <Board />
}

function Board() {
  const { user } = useCurrentUser()
  const { clientsById, usersById } = useLookups()
  const { data, error } = useAllRequests()
  const [params, setParams] = useSearchParams()
  const peekLink = usePeekLink()
  const today = cairoTodayISO()
  if (!data && !error) return <PageLayout title="My queue — board" subtitle={SUBTITLE}><SkeletonList /></PageLayout>
  if (!data) return <DashboardLoading subtitle={SUBTITLE} error={error} />

  const view = params.get('view') === 'due' ? 'due' : 'board'
  const setView = (v) => {
    const next = new URLSearchParams(params)
    if (v === 'due') next.set('view', 'due')
    else next.delete('view')
    setParams(next, { replace: true })
  }
  const columns = queueBoard(data, user.id)
  const mine = columns.flatMap((c) => c.cards.map((x) => x.request))
  const sum = deadlineSummary(mine, today)

  return (
    <PageLayout title="My queue — board" subtitle={SUBTITLE}
      actions={<SegmentedControl label="Show as" value={view} onChange={setView}
        options={[{ value: 'board', label: 'Board' }, { value: 'due', label: 'Due by date' }]} />}>
      <p className="queue-summary" role="status">
        {sum.total} {sum.total === 1 ? 'proposal' : 'proposals'} · <span className={sum.overdue ? 'is-overdue-text' : undefined}>{sum.overdue} overdue</span> · {sum.dueThisWeek} due this week
      </p>
      {view === 'due' ? <DueByDate requests={mine} today={today} /> : (
        <div className="queue-board">
          {columns.map((c) => (
            <section key={c.id} className="queue-column" aria-label={`${c.label}: ${c.count}`}>
              <h2 className="queue-column__title">{c.label} <span className="tabular muted">{c.count}</span></h2>
              <ul className="queue-column__cards">
                {c.cards.map(({ request: r, days, waiting }) => {
                  const tone = deadlineTone(r, today)
                  return (
                    <li key={r.id}>
                      <Link to={proposalLink(r.id)} onClick={peekLink(r.id)} className={`queue-card ${brandEdge(r.brand)}${r.newForYou ? ' is-new' : ''}`}>
                        <span className="queue-card__client">
                          {r.newForYou && <span className="new-dot" aria-label="New for you" />}
                          {clientsById[r.clientId]?.name ?? r.clientName ?? '—'}
                        </span>
                        <span className="queue-card__event">{r.eventName ?? '—'}</span>
                        <span className={`queue-card__deadline${tone ? ` queue-card__deadline--${tone}` : ''}`}>
                          Due {r.requiredBy ? formatShortDate(r.requiredBy) : '—'}
                        </span>
                        <span className="muted">{daysText(days)} in {c.label}</span>
                        {waiting && <span className="waiting-tag waiting-tag--team">On {waitingLabel(waiting, usersById)}</span>}
                      </Link>
                    </li>
                  )
                })}
                {c.cards.length === 0 && <li className="muted queue-column__empty">—</li>}
              </ul>
            </section>
          ))}
        </div>
      )}
    </PageLayout>
  )
}
