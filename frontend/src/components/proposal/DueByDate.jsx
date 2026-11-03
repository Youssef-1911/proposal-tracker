import Card from '../ui/Card.jsx'
import DataTable from '../ui/DataTable.jsx'
import StatusBadge from '../ui/StatusBadge.jsx'
import { ClientEvent, DueDate } from '../dashboard/cells.jsx'
import { WaitingBar } from './WaitingOn.jsx'
import { useLookups } from '../../data/hooks.js'
import { dueGroups } from '../../domain/deadlines.js'
import { proposalLink } from '../../lib/links.js'

/**
 * "Due by date": open requests grouped by their proposal deadline ("Overdue · 2", "Today · 3",
 * "Thu 29 Oct · 2", "Next week · 5"), overdue first and in red. Requests waiting on others are included.
 */
export default function DueByDate({ requests, today }) {
  const { clientsById } = useLookups()
  const groups = dueGroups(requests, today)
  const columns = [
    {
      key: 'client', header: 'Client',
      render: (r) => (
        <span className="stack">
          <span>{r.newForYou && <span className="new-dot" aria-label="New for you" />}
            <ClientEvent name={clientsById[r.clientId]?.name ?? r.clientName} eventName={r.eventName} /></span>
        </span>
      ),
    },
    { key: 'status', header: 'Stage', nowrap: true, render: (r) => <StatusBadge kind="proposal" status={r.status} version={r.version} compact /> },
    { key: 'who', header: 'Waiting on', render: (r) => <WaitingBar request={r} small /> },
    { key: 'deadline', header: 'Deadline', nowrap: true, render: (r) => <DueDate date={r.requiredBy} active /> },
  ]
  if (!groups.length) return <Card><p className="data-table__empty">No open requests.</p></Card>
  return (
    <div className="due-by-date">
      {groups.map((g) => (
        <Card key={g.key} flush title={<span className={g.overdue ? 'due-group--overdue' : undefined}>{g.label} · {g.count}</span>}>
          <DataTable caption={`Due: ${g.label}`} rows={g.requests} rowKey={(r) => r.id} rowHref={(r) => proposalLink(r.id)} rowPeek={(r) => r.id} rowBrand={(r) => r.brand} columns={columns}
            rowClassName={(r) => (r.newForYou ? 'is-new' : undefined)} />
        </Card>
      ))}
    </div>
  )
}
