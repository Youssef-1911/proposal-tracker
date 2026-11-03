import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import PageLayout from '../components/layout/PageLayout.jsx'
import Card from '../components/ui/Card.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import MoreMenu from '../components/ui/MoreMenu.jsx'
import SidePanel from '../components/ui/SidePanel.jsx'
import StatusPill from '../components/ui/StatusPill.jsx'
import Toast, { useRouteToast } from '../components/ui/Toast.jsx'
import { Person } from '../components/dashboard/cells.jsx'
import { Field, FormAlert, PanelButtons, successText, usePanelForm } from '../components/crm/formParts.jsx'
import { useCurrentUser, useEvent, useEventActions, useLists, useLookups, useSampleTasks } from '../data/hooks.js'
import { api } from '../api/client.js'
import { getBrand, serviceLabel } from '../domain/brands.js'
import {
  EVENT_STATUS, EVENT_STATUS_LABELS, EVENT_TIMING_LABELS, PRELIMINARY, eventPill, validateEventCancel, validateEventDateChange, validateEventPostpone,
} from '../domain/events.js'
import { confirmEventErrors } from '../domain/workflow.js'
import { ROLE } from '../domain/roles.js'

import { optionLabel, visibleOptions } from '../domain/lists.js'
import { formatCurrency, formatEventDate, formatNumber, formatShortDate } from '../lib/format.js'
import { proposalLink } from '../lib/links.js'
import { CorrectStatusPanel } from '../components/proposal/DataFixes.jsx'
import BrandTag from '../components/ui/BrandTag.jsx'
import RelTime from '../components/ui/RelTime.jsx'
import { SkeletonRequest } from '../components/ui/Skeleton.jsx'
import { celebrate } from '../components/ui/Celebration.jsx'
import { downloadEventSheet } from '../lib/eventSheet.js'
import { LinkedTodos } from '../components/Todos.jsx'
import { EventStaffingCard } from '../components/staffing/Staffing.jsx'

const show = (v) => (v === null || v === undefined || v === '' ? '—' : v)

const CHANGE_TEXT = {
  event_status_set: (c) => `marked it ${EVENT_STATUS_LABELS[c.details?.status]?.toLowerCase() ?? 'confirmed'}`,
  event_confirmed: () => 'confirmed the event',
  event_postponed: () => 'marked the event postponed',
  event_cancelled: () => 'marked the event cancelled',
}

/**
 * One event (accepted request): left, everything about it (dates, venue, participants, brief, tags,
 * requirements, contact, BD owner, AM, final proposal file); right, its status, Operations tasks and
 * comments. Marketing and Operations see it without the price, may comment, and never change its
 * status. "Confirm event" (Initially confirmed or Postponed) is the one main button for the BD owner
 * or the Commercial Head; "Event postponed", "Change date" and "Event cancelled" sit under "More".
 */
export default function EventPage() {
  const { id } = useParams()
  const { data: ev, isLoading, error, notFound } = useEvent(id)
  const { usersById } = useLookups()
  const { activeRole } = useCurrentUser()
  const lists = useLists().data
  const actions = useEventActions(ev)
  const tasks = useSampleTasks().data
  const toast = useRouteToast()
  const [panel, setPanel] = useState(null) // 'confirm' | 'postpone' | 'date' | 'cancel'
  const [comment, setComment] = useState('')
  const [commentError, setCommentError] = useState(null)
  const [seen, setSeen] = useState(null)
  const { markRead } = actions
  useEffect(() => { // opening the event clears its "New" mark
    if (!ev || seen === ev.id) return
    setSeen(ev.id)
    markRead()
  }, [ev, seen, markRead])

  if (!ev && isLoading) return <PageLayout title="Event"><SkeletonRequest /></PageLayout>
  if (notFound || error || !ev) {
    return (
      <PageLayout title="Event">
        <Card>
          <EmptyState icon="calendar" title="Event not available" meta={<Link to="/events" className="btn">Back to events</Link>}>
            {error ? error.message : 'Only confirmed and initially confirmed events you may see are shown here.'}
          </EmptyState>
        </Card>
      </PageLayout>
    )
  }
  const can = new Set(actions.available ? ev.eventActions ?? [] : [])
  const status = ev.eventStatus ?? EVENT_STATUS.CONFIRMED
  const more = [
    ...(can.has('postpone') ? [{ label: 'Event postponed', onSelect: () => setPanel('postpone') }] : []),
    ...(can.has('changeDate') ? [{ label: 'Change date', onSelect: () => setPanel('date') }] : []),
    ...(can.has('cancel') ? [{ label: 'Event cancelled', tone: 'danger', onSelect: () => setPanel('cancel') }] : []),
    ...(actions.available && ev.correctStatus?.allowed ? [{ label: 'Correct status (data fix)', onSelect: () => setPanel('correct') }] : []),
  ]
  const opsTasks = (tasks ?? []).filter((t) => t.related?.proposalRequestId === ev.id
    && usersById[t.owner]?.roles?.includes(ROLE.OPERATIONS))
  const done = (_r, text) => { setPanel(null); toast.show(text) }
  const confirmed = (r, text) => { done(r, text); celebrate(ev.clientName) }
  // The sheet for the day: HR and Operations also see who is assigned; prices never appear on it.
  const sheet = () => downloadEventSheet(ev, { lists, showFacilitators: [ROLE.HR, ROLE.OPERATIONS].includes(activeRole) })
  const send = async (e) => {
    e.preventDefault()
    if (!comment.trim()) { setCommentError('Write a message.'); return }
    const result = await actions.comment(comment)
    if (result.ok) { setComment(''); setCommentError(null) } else setCommentError(result.error)
  }

  return (
    <PageLayout
      title={ev.clientName ?? ev.id}
      subtitle={[ev.eventName, formatEventDate(ev.eventDate, ev.eventEndDate, ev.eventDatePrecision), getBrand(ev.brand)?.name]
        .filter(Boolean).join(' · ')}
      actions={<button type="button" className="btn" onClick={sheet}>Download event sheet (PDF)</button>}
    >
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/events">Events</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{ev.id}</span>
      </nav>
      <LinkedTodos kind="event" id={ev.id} />
      {ev.timing === 'cancelled' && (
        <p className="details-banner">
          <strong>{EVENT_TIMING_LABELS.cancelled}</strong>: {optionLabel(lists, 'eventCancelReasons', ev.eventCancelReason)}
          {ev.eventCancelNote ? ` — ${ev.eventCancelNote}` : ''}
        </p>
      )}
      {ev.timing === 'postponed' && (
        <p className="details-banner">
          <strong>Postponed</strong>: {optionLabel(lists, 'postponeWhy', ev.eventPostponeReason)}
          {ev.eventPostponeNote ? ` — ${ev.eventPostponeNote}` : ''}
        </p>
      )}
      <div className="request-columns">
        <div className="request-columns__left">
        <Card title="The event">
          <dl className="field-list">
            <div className="field"><dt>Date(s)</dt><dd>{ev.eventDate ? formatEventDate(ev.eventDate, ev.eventEndDate, ev.eventDatePrecision) : '—'}</dd></div>
            <div className="field"><dt>Brand · Service</dt><dd><BrandTag brand={ev.brand} /> · {serviceLabel(ev.brand, ev.service) ?? '—'}</dd></div>
            <div className="field"><dt>Participants</dt><dd className="tabular">{ev.participants ? formatNumber(ev.participants) : '—'}</dd></div>
            <div className="field"><dt>Venue</dt><dd>{show(ev.venue)}</dd></div>
            {'finalPrice' in ev && <div className="field"><dt>Final price</dt><dd className="tabular">{ev.finalPrice ? formatCurrency(ev.finalPrice) : '—'}</dd></div>}
            <div className="field"><dt>BD owner</dt><dd><Person user={usersById[ev.bdOwner]} /></dd></div>
            <div className="field"><dt>Account Manager</dt><dd><Person user={usersById[ev.assignedAM]} /></dd></div>
            <div className="field"><dt>Client contact</dt><dd>{ev.contact ? [ev.contact.name, ev.contact.phone, ev.contact.email].filter(Boolean).join(' · ') : '—'}</dd></div>
            <div className="field"><dt>Confirmed by</dt><dd>{ev.confirmedBy ? usersById[ev.confirmedBy]?.name ?? '—' : ev.imported ? 'Imported from the 2026 tracker' : '—'}</dd></div>
          </dl>
        </Card>
        <Card title="Brief and requirements">
          <p className="prose">{ev.brief || <span className="muted">No brief recorded.</span>}</p>
          <p className="muted">Quick tags: {ev.briefTags?.length ? ev.briefTags.map((c) => optionLabel(lists, 'briefTags', c)).join(' · ') : '—'}</p>
          <h3 className="section-label">Requirements</h3>
          <p className="prose">{ev.specificRequirements || '—'}</p>
          {ev.teamNotes && <><h3 className="section-label">Notes for the team</h3><p className="prose">{ev.teamNotes}</p></>}
          <div className="card-actions">
            {ev.file && actions.fileUrl && (
              <button type="button" className="btn" onClick={() => api.download(actions.fileUrl, `${ev.id}-v${ev.file.version}`)}>
                Download the final proposal (v{ev.file.version})
              </button>
            )}
            {!ev.file && <span className="muted">No proposal file.</span>}
            {ev.canOpenRequest && <Link to={proposalLink(ev.id)} className="btn">Proposal history</Link>}
          </div>
        </Card>
        </div>
        <div className="request-columns__right">
        <Card title="Status">
          <div className="next-step__buttons">
            <StatusPill pill={eventPill(ev.timing, status)} />
            {can.has('confirm') && <button type="button" className="btn btn--primary btn--sm" onClick={() => setPanel('confirm')}>Confirm event</button>}
            {more.length > 0 && <MoreMenu items={more} />}
          </div>
          {status === EVENT_STATUS.INITIAL && ev.timing !== 'done' && <p className="preliminary">{PRELIMINARY}</p>}
          {!can.size && (
            <p className="muted">{ev.timing === 'cancelled' ? 'This event was cancelled.'
              : 'Only the BD owner or the Commercial Head changes the event status.'}</p>
          )}
        </Card>
        <Card title="Operations tasks">
          {opsTasks.length ? (
            <ul className="plain-list">
              {opsTasks.map((t) => (
                <li key={t.id}>
                  <span className={t.done ? 'muted' : undefined}>{t.done ? '✓ ' : ''}{t.title}</span>
                  <span className="muted"> · {usersById[t.owner]?.name ?? '—'} · {t.dueDate ? formatShortDate(t.dueDate) : '—'}</span>
                </li>
              ))}
            </ul>
          ) : <p className="muted">No Operations tasks for this event.</p>}
          <p className="quiet-line">Tasks are sample data for now; completing them comes with the task feature.</p>
        </Card>
        <EventStaffingCard event={ev} />
        <Card title="Notes and changes">
          <ol className="thread">
            {(ev.changes ?? []).map((c, i) => (
              <li key={`c${i}`} className="thread__system">
                <span><strong>{usersById[c.changedBy]?.name ?? 'Someone'}</strong>{' '}
                  {CHANGE_TEXT[c.event]?.(c) ?? `changed the date${c.details?.from?.eventDate ? ` from ${formatEventDate(c.details.from.eventDate, c.details.from.eventEndDate)}` : ''}`}
                  {c.note ? ` — ${c.note}` : ''}</span>
                <RelTime value={c.changedAt} />
              </li>
            ))}
            {(ev.comments ?? []).map((m) => (
              <li key={`m${m.id}`} className="bubble">
                <div className="bubble__body">
                  <div className="bubble__meta"><strong>{usersById[m.author]?.name ?? 'Someone'}</strong>
                    <RelTime value={m.createdAt} className="muted" /></div>
                  <p className="bubble__text">{m.body}</p>
                </div>
              </li>
            ))}
            {!(ev.changes?.length || ev.comments?.length) && <li className="thread__system">Nothing yet.</li>}
          </ol>
          {actions.available && activeRole !== ROLE.HR && (
            <form className="composer" onSubmit={send}>
              <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" placeholder="Write a comment" />
              {commentError && <p className="form-field__error" role="alert">{commentError}</p>}
              <div className="composer__buttons"><button type="submit" className="btn btn--primary btn--sm">Send</button></div>
            </form>
          )}
        </Card>
        </div>
      </div>
      {panel === 'correct' && <CorrectStatusPanel request={ev} onClose={() => setPanel(null)} onSaved={done} />}
      {panel === 'confirm' && <ConfirmPanel ev={ev} actions={actions} onClose={() => setPanel(null)} onSaved={confirmed} />}
      {panel === 'postpone' && <PostponePanel ev={ev} actions={actions} lists={lists} onClose={() => setPanel(null)} onSaved={done} />}
      {panel === 'date' && <ChangeDatePanel ev={ev} actions={actions} onClose={() => setPanel(null)} onSaved={done} />}
      {panel === 'cancel' && <CancelPanel ev={ev} actions={actions} lists={lists} onClose={() => setPanel(null)} onSaved={done} />}
      <Toast message={toast.message} />
    </PageLayout>
  )
}

function ChangeDatePanel({ ev, actions, onClose, onSaved }) {
  const form = usePanelForm({ eventDate: ev.eventDatePrecision === 'day' ? ev.eventDate ?? '' : '', eventEndDate: ev.eventEndDate ?? '', note: '' })
  const { values, set, errors, failure, busy, submit, fieldProps } = form
  const onSubmit = (e) => {
    e.preventDefault()
    const { errors: local } = validateEventDateChange(ev, values)
    submit(local, () => actions.changeDate(values), (result) => onSaved(result, successText(result)))
  }
  return (
    <SidePanel open title="Change date" subtitle={`${ev.clientName ?? ev.id} · Operations is told`} onClose={onClose} busy={busy}
      footer={<PanelButtons formId="event-date" busy={busy} onCancel={onClose} submitLabel="Save date" />}>
      <form id="event-date" className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={failure} />
        <Field id="ed-start" label="Event date" required error={errors.eventDate}>
          <input type="date" {...fieldProps('ed-start', 'eventDate')} value={values.eventDate} onChange={set('eventDate')} />
        </Field>
        <Field id="ed-end" label="End date (optional)" error={errors.eventEndDate}>
          <input type="date" {...fieldProps('ed-end', 'eventEndDate')} value={values.eventEndDate} onChange={set('eventEndDate')} />
        </Field>
        <Field id="ed-note" label="Note (optional)"><textarea rows={2} maxLength={300} value={values.note} onChange={set('note')} /></Field>
      </form>
    </SidePanel>
  )
}

function CancelPanel({ ev, actions, lists, onClose, onSaved }) {
  const form = usePanelForm({ reason: '', note: '' })
  const { values, set, errors, failure, busy, submit, fieldProps } = form
  const onSubmit = (e) => {
    e.preventDefault()
    const { errors: local } = validateEventCancel(values, lists)
    submit(local, () => actions.cancel(values), (result) => onSaved(result, successText(result)))
  }
  return (
    <SidePanel open title="Event cancelled" subtitle={`${ev.clientName ?? ev.id} · counted as "Cancelled after confirmation", never Done`}
      onClose={onClose} busy={busy}
      footer={<PanelButtons formId="event-cancel" busy={busy} onCancel={onClose} submitLabel="Mark cancelled" tone="danger" />}>
      <form id="event-cancel" className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={failure} />
        <Field id="ec-reason" label="Why" required error={errors.reason}>
          <select {...fieldProps('ec-reason', 'reason')} value={values.reason} onChange={set('reason')}>
            <option value="">Choose…</option>
            {visibleOptions(lists, 'eventCancelReasons').map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
          </select>
        </Field>
        <Field id="ec-note" label={values.reason === 'other' ? 'Note' : 'Note (optional)'} required={values.reason === 'other'} error={errors.note}>
          <textarea rows={2} maxLength={300} {...fieldProps('ec-note', 'note')} value={values.note} onChange={set('note')} />
        </Field>
      </form>
    </SidePanel>
  )
}

/** Initially confirmed (or Postponed) -> Confirmed, with the "Mark confirmed" fields (price only for those who see it). */
export function ConfirmPanel({ ev, actions, onClose, onSaved }) {
  const form = usePanelForm({
    eventDate: ev.eventDatePrecision === 'day' ? ev.eventDate ?? '' : '', eventEndDate: ev.eventEndDate ?? '',
    finalParticipants: ev.participants ?? '', finalPrice: ev.finalPrice ?? '', venue: ev.venue ?? '', teamNotes: ev.teamNotes ?? '',
  })
  const { values, set, errors, failure, busy, submit, fieldProps } = form
  const seesPrice = 'finalPrice' in ev
  const onSubmit = (e) => {
    e.preventDefault()
    const input = seesPrice ? values : { ...values, finalPrice: '' }
    submit(confirmEventErrors(input), () => actions.confirm(input), (result) => onSaved(result, successText(result)))
  }
  return (
    <SidePanel open title="Confirm event" subtitle={`${ev.clientName ?? ev.id} · approved for execution`} onClose={onClose} busy={busy}
      footer={<PanelButtons formId="event-confirm" busy={busy} onCancel={onClose} submitLabel="Confirm event" />}>
      <form id="event-confirm" className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={failure} />
        <Field id="cf-start" label="Event date" required error={errors.eventDate}>
          <input type="date" {...fieldProps('cf-start', 'eventDate')} value={values.eventDate} onChange={set('eventDate')} />
        </Field>
        <Field id="cf-end" label="End date (optional)" error={errors.eventEndDate}>
          <input type="date" {...fieldProps('cf-end', 'eventEndDate')} value={values.eventEndDate} onChange={set('eventEndDate')} />
        </Field>
        <Field id="cf-people" label="Participants (optional)" error={errors.finalParticipants}>
          <input inputMode="numeric" {...fieldProps('cf-people', 'finalParticipants')} value={values.finalParticipants} onChange={set('finalParticipants')} />
        </Field>
        {seesPrice && (
          <Field id="cf-price" label="Final price, EGP (optional)" error={errors.finalPrice}>
            <input inputMode="numeric" {...fieldProps('cf-price', 'finalPrice')} value={values.finalPrice} onChange={set('finalPrice')} />
          </Field>
        )}
        <Field id="cf-venue" label="Venue (optional)" error={errors.venue}>
          <input maxLength={200} {...fieldProps('cf-venue', 'venue')} value={values.venue} onChange={set('venue')} />
        </Field>
        <Field id="cf-notes" label="Notes for the team (optional)" error={errors.teamNotes}>
          <textarea rows={3} maxLength={1000} {...fieldProps('cf-notes', 'teamNotes')} value={values.teamNotes} onChange={set('teamNotes')} />
        </Field>
      </form>
    </SidePanel>
  )
}

function PostponePanel({ ev, actions, lists, onClose, onSaved }) {
  const form = usePanelForm({ reason: '', note: '' })
  const { values, set, errors, failure, busy, submit, fieldProps } = form
  const onSubmit = (e) => {
    e.preventDefault()
    const { errors: local } = validateEventPostpone(values, lists)
    submit(local, () => actions.postpone(values), (result) => onSaved(result, successText(result)))
  }
  return (
    <SidePanel open title="Event postponed" subtitle={`${ev.clientName ?? ev.id} · on hold until "Confirm event"`} onClose={onClose} busy={busy}
      footer={<PanelButtons formId="event-postpone" busy={busy} onCancel={onClose} submitLabel="Mark postponed" />}>
      <form id="event-postpone" className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={failure} />
        <Field id="ep-reason" label="Why" required error={errors.reason}>
          <select {...fieldProps('ep-reason', 'reason')} value={values.reason} onChange={set('reason')}>
            <option value="">Choose…</option>
            {visibleOptions(lists, 'postponeWhy').map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
          </select>
        </Field>
        <Field id="ep-note" label={values.reason === 'other' ? 'Note' : 'Note (optional)'} required={values.reason === 'other'} error={errors.note}>
          <textarea rows={2} maxLength={300} {...fieldProps('ep-note', 'note')} value={values.note} onChange={set('note')} />
        </Field>
      </form>
    </SidePanel>
  )
}
