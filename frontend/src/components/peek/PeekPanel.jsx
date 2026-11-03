import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../ui/Icon.jsx'
import BrandTag from '../ui/BrandTag.jsx'
import RelTime from '../ui/RelTime.jsx'
import StatusPill from '../ui/StatusPill.jsx'
import { SkeletonRequest } from '../ui/Skeleton.jsx'
import { celebrate } from '../ui/Celebration.jsx'
import { Person, DueDate } from '../dashboard/cells.jsx'
import ActionsPanel from '../proposal/ActionsPanel.jsx'
import { ProgressSteps } from '../proposal/RequestFlow.jsx'
import { WaitingBar } from '../proposal/WaitingOn.jsx'
import { ConfirmPanel } from '../../pages/EventPage.jsx'
import { useCurrentUser, useEvent, useEventActions, useLookups, useProposalRequest } from '../../data/hooks.js'
import { serviceLabel } from '../../domain/brands.js'
import { EVENT_STATUS, PRELIMINARY, eventPill } from '../../domain/events.js'
import { canViewRequest } from '../../domain/proposals.js'
import { formatEventDate, formatNumber } from '../../lib/format.js'
import { usePeek } from '../../lib/peek.js'
import { proposalLink } from '../../lib/links.js'

const MESSAGES = 3

/**
 * The quick peek (right side; full screen on phones): progress, who it waits on, the key details,
 * the latest 3 messages and the one main action, with "Open full page" at the top. Esc, the close
 * button or a click outside closes it; the list underneath keeps its scroll and filters.
 */
export default function PeekPanel() {
  const { peek, close } = usePeek()
  const ref = useRef(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (peek && !dialog.open) dialog.showModal()
    if (!peek && dialog.open) dialog.close()
  }, [peek])
  return (
    <dialog
      ref={ref}
      className="side-panel side-panel--peek"
      aria-label="Quick peek"
      onCancel={(e) => { e.preventDefault(); close() }}
      // A click on the backdrop lands on the dialog itself (its content fills the inner box).
      onClick={(e) => { if (e.target === ref.current) close() }}
    >
      {peek?.kind === 'proposal' && <ProposalPeek key={peek.id} id={peek.id} onClose={close} />}
      {peek?.kind === 'event' && <EventPeek key={peek.id} id={peek.id} onClose={close} />}
    </dialog>
  )
}

function Frame({ title, subtitle, to, onClose, children }) {
  return (
    <div className="side-panel__inner">
      <header className="side-panel__header">
        <div>
          {to && <Link to={to} className="peek__open">Open full page <Icon name="arrowRight" size={14} /></Link>}
          <h2 className="side-panel__title">{title}</h2>
          {subtitle && <p className="side-panel__subtitle">{subtitle}</p>}
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={18} />
        </button>
      </header>
      <div className="side-panel__body peek">{children}</div>
    </div>
  )
}

function Unavailable({ onClose, what }) {
  return (
    <Frame title={`${what} not available`} onClose={onClose}>
      <p className="muted">It may not exist, or it is not part of what you can see.</p>
    </Frame>
  )
}

function Messages({ items, usersById }) {
  const latest = items.slice(-MESSAGES).reverse()
  return (
    <section className="peek__section">
      <h3 className="section-label">Latest messages</h3>
      {latest.length === 0 ? <p className="muted">No messages yet.</p> : (
        <ul className="peek__messages">
          {latest.map((m) => (
            <li key={m.id}>
              <span className="peek__meta"><strong>{usersById[m.author]?.name ?? 'Someone'}</strong> <RelTime value={m.createdAt} className="muted" /></span>
              <span className="peek__text">{m.body}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const Field = ({ label, children }) => <div className="field"><dt>{label}</dt><dd>{children}</dd></div>

function ProposalPeek({ id, onClose }) {
  const { user, activeRole } = useCurrentUser()
  const { data: request, isLoading, notFound } = useProposalRequest(id)
  const { clientsById, usersById } = useLookups()
  if (!request && isLoading) return <Frame title={id} onClose={onClose}><SkeletonRequest /></Frame>
  if (notFound || !request || !canViewRequest(request, user.id)) return <Unavailable onClose={onClose} what="Proposal" />
  const client = clientsById[request.clientId]?.name ?? request.clientName ?? '—'
  const messages = (request.comments ?? []).filter((m) => ['comment', 'question', 'answer', 'change'].includes(m.kind) && m.body)
  return (
    <Frame title={client} subtitle={[request.eventName, request.id].filter(Boolean).join(' · ')} to={proposalLink(request.id)} onClose={onClose}>
      <WaitingBar request={request} />
      <ProgressSteps request={request} />
      <dl className="field-list peek__fields">
        <Field label="Brand · Service"><BrandTag brand={request.brand} /> · {serviceLabel(request.brand, request.service)}</Field>
        <Field label="Event date">{formatEventDate(request.eventDate, request.eventEndDate, request.eventDatePrecision)}</Field>
        <Field label="Participants">{request.participants ? formatNumber(request.participants) : '—'}</Field>
        <Field label="Deadline"><DueDate date={request.requiredBy} /></Field>
        <Field label="BD owner"><Person user={usersById[request.bdOwner]} /></Field>
        <Field label="Account Manager"><Person user={usersById[request.assignedAM]} /></Field>
      </dl>
      <Messages items={messages} usersById={usersById} />
      {/* The same "Next step" card as the full page: one main button, the rest under "More". */}
      <ActionsPanel key={`${user.id}:${activeRole}`} request={request} />
    </Frame>
  )
}

function EventPeek({ id, onClose }) {
  const { data: ev, isLoading, notFound, error } = useEvent(id)
  const { usersById } = useLookups()
  const actions = useEventActions(ev)
  const [confirming, setConfirming] = useState(false)
  if (!ev && isLoading) return <Frame title="Event" onClose={onClose}><SkeletonRequest /></Frame>
  if (notFound || error || !ev) return <Unavailable onClose={onClose} what="Event" />
  const status = ev.eventStatus ?? EVENT_STATUS.CONFIRMED
  const canConfirm = actions.available && (ev.eventActions ?? []).includes('confirm')
  return (
    <Frame title={ev.clientName ?? ev.id} subtitle={[ev.eventName, ev.id].filter(Boolean).join(' · ')}
      to={`/events/${encodeURIComponent(ev.id)}`} onClose={onClose}>
      <div className="next-step__buttons">
        <StatusPill pill={eventPill(ev.timing, status)} />
        {canConfirm && <button type="button" className="btn btn--primary btn--sm" onClick={() => setConfirming(true)}>Confirm event</button>}
      </div>
      {status === EVENT_STATUS.INITIAL && ev.timing !== 'done' && <p className="preliminary">{PRELIMINARY}</p>}
      <dl className="field-list peek__fields">
        <Field label="Brand"><BrandTag brand={ev.brand} /></Field>
        <Field label="Date(s)">{ev.eventDate ? formatEventDate(ev.eventDate, ev.eventEndDate, ev.eventDatePrecision) : '—'}</Field>
        <Field label="Venue">{ev.venue || '—'}</Field>
        <Field label="Participants">{ev.participants ? formatNumber(ev.participants) : '—'}</Field>
        {ev.staffing && (
          <Field label="Facilitators">
            {ev.staffing.needed === null ? 'Number needed not set yet'
              : `${ev.staffing.needed} needed · ${ev.staffing.assigned} assigned · ${ev.staffing.missing} missing`}
          </Field>
        )}
        <Field label="BD owner"><Person user={usersById[ev.bdOwner]} /></Field>
        <Field label="Account Manager"><Person user={usersById[ev.assignedAM]} /></Field>
      </dl>
      <Messages items={ev.comments ?? []} usersById={usersById} />
      {confirming && (
        <ConfirmPanel ev={ev} actions={actions} onClose={() => setConfirming(false)}
          onSaved={() => { setConfirming(false); celebrate(ev.clientName) }} />
      )}
    </Frame>
  )
}
