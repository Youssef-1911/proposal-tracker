import Avatar from '../ui/Avatar.jsx'
import { optionLabel } from '../../domain/lists.js'
import { useLists } from '../../data/hooks.js'
import Badge from '../ui/Badge.jsx'
import Card from '../ui/Card.jsx'
import StatusBadge from '../ui/StatusBadge.jsx'
import { PROPOSAL_STATUS, getStatus, lostReasonLabel, shareChannelLabel } from '../../domain/status.js'
import { roleLabel } from '../../domain/roles.js'
import { timeline } from '../../domain/proposals.js'
import { formatCurrency, formatDate, formatDateTime, formatRelativeTime } from '../../lib/format.js'

// Codes chosen with an action, shown in words on its history entry.
const REASON_LISTS = { awaiting_bd_info: 'whatsMissing', revision_requested: 'whatShouldChange', postponed: 'postponeWhy' }
const REASON_TITLES = { awaiting_bd_info: "What's missing", revision_requested: 'What should change', postponed: 'Why' }

function describe(entry) {
  if (entry.isOrigin) return entry.status === PROPOSAL_STATUS.DRAFT ? 'created the request as a draft' : 'created the request'
  return 'changed the status to'
}

/**
 * From statusHistory, newest first, with the request's other recorded events (a BD owner
 * transferred with its client) in between. Shows who, in which role, what, when, and any note.
 */
export default function ActivityTimeline({ request, usersById }) {
  const lists = useLists().data
  const entries = timeline(request)
  const events = (request.events ?? []).map((ev) => ({ ...ev, key: `event-${ev.id}`, isEvent: true }))
  // Newest first; status entries keep their own order (they are already newest first).
  const items = [...entries]
  for (const ev of events) {
    const at = items.findIndex((e) => e.changedAt < ev.changedAt)
    items.splice(at === -1 ? items.length : at, 0, ev)
  }
  return (
    <Card title="Activity" subtitle={`${entries.length} status ${entries.length === 1 ? 'change' : 'changes'} · newest first`}>
      <ol className="timeline">
        {items.map((e) => {
          const user = usersById[e.changedBy]
          if (e.isEvent) return <EventItem key={e.key} event={e} user={user} usersById={usersById} />
          return (
            <li key={e.key} className={`timeline__item${e.isOrigin ? ' timeline__item--origin' : ''}`}>
              <span className="timeline__marker">
                <Avatar initials={e.imported ? '↧' : user?.initials ?? '?'} tone={e.imported ? 1 : user?.avatarTone} size="sm" />
              </span>
              <div className="timeline__body">
                <div className="timeline__line">
                  {e.imported ? (
                    // who ran the import (or closed the history) is stored, never shown
                    <strong>{e.status?.startsWith('closed_') && e.note ? e.note : 'Imported from the 2026 tracker'}</strong>
                  ) : (
                    <>
                      <strong>{user?.name ?? 'Unknown user'}</strong>
                      <span className="muted"> ({roleLabel(e.role, user)})</span> {describe(e)}
                    </>
                  )}{' '}
                  <StatusBadge kind="proposal" status={e.status} version={e.version} />
                  {e.isOrigin && <Badge tone="neutral">Origin</Badge>}
                </div>
                {e.onBehalfOf && (
                  <div className="timeline__detail">On behalf of {usersById[e.onBehalfOf]?.name ?? 'the BD owner'} (BD owner)</div>
                )}
                {e.requiredBy && (
                  <div className="timeline__detail">
                    New proposal deadline {formatDate(e.requiredBy)}
                    {e.previousRequiredBy && ` (was ${formatDate(e.previousRequiredBy)})`}
                  </div>
                )}
                {e.status === PROPOSAL_STATUS.READY_FOR_BD && (
                  <div className="timeline__detail">
                    Version {e.version} ·{' '}
                    {e.amPrice !== null && e.amPrice !== undefined ? `AM price ${formatCurrency(e.amPrice)}` : 'price not recorded'}
                  </div>
                )}
                {e.status === PROPOSAL_STATUS.IN_PROGRESS && e.version > 1 && !e.isOrigin && (
                  <div className="timeline__detail">Work started on version {e.version}</div>
                )}
                {e.lostReason && <div className="timeline__detail">Lost reason: {lostReasonLabel(e.lostReason)}</div>}
                {e.followUpOn && <div className="timeline__detail">Follow up on {formatDate(e.followUpOn)}</div>}
                {e.reasons?.length > 0 && REASON_LISTS[e.status] && (
                  <div className="timeline__detail">
                    {REASON_TITLES[e.status]}: {e.reasons.map((c) => optionLabel(lists, REASON_LISTS[e.status], c)).join(', ')}
                  </div>
                )}
                {e.channel && <div className="timeline__detail">Sent via {shareChannelLabel(e.channel)}</div>}
                {e.note && !e.imported && <blockquote className="timeline__note">{e.note}</blockquote>}
                <time className="timeline__time" dateTime={e.changedAt} title={getStatus('proposal', e.status).description}>
                  {formatDateTime(e.changedAt)} · {formatRelativeTime(e.changedAt)}
                </time>
              </div>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

/** A recorded event that is not a status change: the BD owner moved with a client transfer, the assigned
 * AM changed when an Account Manager was deactivated, or the request moved when its client was merged. */
function EventItem({ event, user, usersById }) {
  return (
    <li className="timeline__item">
      <span className="timeline__marker">
        <Avatar initials={user?.initials ?? '?'} tone={user?.avatarTone} size="sm" />
      </span>
      <div className="timeline__body">
        <div className="timeline__line">
          <strong>{user?.name ?? 'Unknown user'}</strong>
          <span className="muted"> ({roleLabel(event.role, user)})</span>{' '}
          {event.event === 'bd_owner_transferred'
            ? <>moved the BD owner from {usersById[event.fromUser]?.name ?? event.fromUser} to {usersById[event.toUser]?.name ?? event.toUser}</>
            : event.event === 'assigned_am_changed'
              ? <>moved the request from {usersById[event.fromUser]?.name ?? event.fromUser} to {usersById[event.toUser]?.name ?? event.toUser} (Account Manager)</>
              : event.event === 'client_merged' ? <>merged its client into another</>
                : event.event === 'waiting_on_set' ? <>set who it is waiting on</>
                  : event.event === 'waiting_on_cleared' ? <>marked it done (waiting on is automatic again)</> : event.event}
        </div>
        {event.note && <blockquote className="timeline__note">{event.note}</blockquote>}
        <time className="timeline__time" dateTime={event.changedAt}>
          {formatDateTime(event.changedAt)} · {formatRelativeTime(event.changedAt)}
        </time>
      </div>
    </li>
  )
}
