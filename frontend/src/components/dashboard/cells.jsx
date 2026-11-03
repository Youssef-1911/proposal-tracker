import Avatar from '../ui/Avatar.jsx'
import Badge from '../ui/Badge.jsx'
import { daysFromToday, formatDate } from '../../lib/format.js'

/**
 * A date with an "overdue / today / in N days" hint.
 * Pass active=false when the date no longer matters (e.g. proposal deadline already met).
 */
export function DueDate({ date, active = true }) {
  if (!date) return <span className="muted">—</span>
  const diff = daysFromToday(date)
  let hint = null
  if (active && diff < 0) hint = <Badge tone="danger" icon="alert">{-diff === 1 ? '1 day overdue' : `${-diff} days overdue`}</Badge>
  else if (active && diff === 0) hint = <Badge tone="warning">Today</Badge>
  else if (active && diff <= 7) hint = <span className="muted">in {diff === 1 ? '1 day' : `${diff} days`}</span>
  return (
    <span className="due-date">
      <span className="tabular">{formatDate(date)}</span>
      {hint}
    </span>
  )
}

/** "Client · Event name": the event name in grey, cut short when there is no room (full text on hover). */
export function ClientEvent({ name, eventName }) {
  return (
    <span className="client-event">
      <span className="client-event__client">{name ?? '—'}</span>
      {eventName && <span className="client-event__name" title={eventName}>· {eventName}</span>}
    </span>
  )
}

export function Person({ user, suffix }) {
  if (!user) return <span className="muted">—</span>
  return (
    <span className="person">
      <Avatar initials={user.initials} tone={user.avatarTone} size="sm" />
      <span>
        {user.name}
        {suffix && <span className="person__suffix">{suffix}</span>}
      </span>
    </span>
  )
}
