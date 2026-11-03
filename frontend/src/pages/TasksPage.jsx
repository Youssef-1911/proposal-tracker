import { Link } from 'react-router-dom'
import PageLayout from '../components/layout/PageLayout.jsx'
import Badge from '../components/ui/Badge.jsx'
import Card from '../components/ui/Card.jsx'
import CalmNote from '../components/ui/CalmNote.jsx'
import { DueDate } from '../components/dashboard/cells.jsx'
import { usePageDescription } from './PlaceholderPage.jsx'
import { useAllRequests, useCurrentUser, useLookups, useSampleTasks } from '../data/hooks.js'
import { findNavItem } from '../navigation.js'
import { TASK_TYPES } from '../domain/catalog.js'
import { ROLE } from '../domain/roles.js'
import { isTaskDueToday, isTaskOverdue, todayISO } from '../domain/metrics.js'
import { clientLink, opportunityLink, proposalLink } from '../lib/links.js'

function TaskGroup({ title, tasks, empty, clientsById, usersById, showOwner, visibleRequestIds }) {
  return (
    <Card title={title} subtitle={`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`}>
      {tasks.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="history-list">
          {tasks.map((t) => (
            <li key={t.id}>
              <div><strong>{t.title}</strong></div>
              <div className="muted">
                {TASK_TYPES[t.type]?.label ?? t.type} · <DueDate date={t.dueDate} />
                {showOwner && ` · ${usersById[t.owner]?.name ?? t.owner}`}
              </div>
              <div className="muted">
                {t.related.clientId && clientsById[t.related.clientId] && (
                  <Link to={clientLink(t.related.clientId)}>{clientsById[t.related.clientId].name}</Link>
                )}
                {t.related.opportunityId && <> · <Link to={opportunityLink(t.related.opportunityId)}>{t.related.opportunityId}</Link></>}
                {/* Only requests this viewer may see (never someone else's draft). */}
                {t.related.proposalRequestId && visibleRequestIds.has(t.related.proposalRequestId) && <> · follow-up on <Link to={proposalLink(t.related.proposalRequestId)}>{t.related.proposalRequestId}</Link></>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/**
 * Tasks (PREVIEW): how the task list will be organised, shown with sample tasks. Nothing here
 * can be ticked off, edited or created yet; links only open the related client, opportunity
 * or request, which are real.
 */
export default function TasksPage() {
  const { user, activeRole } = useCurrentUser()
  const { clientsById, usersById } = useLookups()
  const subtitle = usePageDescription(findNavItem('/tasks'))
  const all = useSampleTasks().data.filter((t) => !t.done)
  const isHead = activeRole === ROLE.COMMERCIAL_HEAD
  const tasks = isHead ? all : all.filter((t) => t.owner === user.id)
  const today = todayISO()
  const byDate = (a, b) => a.dueDate.localeCompare(b.dueDate)
  const overdue = tasks.filter((t) => isTaskOverdue(t, today)).sort(byDate)
  const dueToday = tasks.filter((t) => isTaskDueToday(t, today))
  const upcoming = tasks.filter((t) => t.dueDate > today).sort(byDate)
  const visibleRequestIds = new Set((useAllRequests().data ?? []).map((r) => r.id))
  const props = { clientsById, usersById, showOwner: isHead, visibleRequestIds }

  return (
    <PageLayout title="Tasks" subtitle={subtitle} actions={<Badge tone="info" icon="info">Preview — coming next</Badge>}>
      <CalmNote>
        Preview with sample tasks{isHead ? ' for the whole team' : ''}. Creating, completing and assigning tasks comes next.
      </CalmNote>
      <div className="dash-grid">
        <div className="span-4"><TaskGroup title="Overdue" tasks={overdue} empty="Nothing overdue." {...props} /></div>
        <div className="span-4"><TaskGroup title="Today" tasks={dueToday} empty="Nothing due today." {...props} /></div>
        <div className="span-4"><TaskGroup title="Upcoming" tasks={upcoming} empty="Nothing coming up." {...props} /></div>
      </div>
    </PageLayout>
  )
}
