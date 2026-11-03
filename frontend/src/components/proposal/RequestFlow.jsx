import { useEffect, useRef, useState } from 'react'
import Avatar from '../ui/Avatar.jsx'
import Badge from '../ui/Badge.jsx'
import Card from '../ui/Card.jsx'
import SegmentedControl from '../ui/SegmentedControl.jsx'
import SidePanel from '../ui/SidePanel.jsx'
import { Field, FormAlert, PanelButtons, successText, usePanelForm } from '../crm/formParts.jsx'
import {
  useConversation, useCurrentUser, useDetailsActions, useLists, useLookups, useRequestActions,
} from '../../data/hooks.js'
import {
  CHANGE_KIND_LABELS, MESSAGE_MAX_LENGTH, canAskQuestion, canPostMessage, changeKind, detailsChangedFor, openChangeIds, openQuestionIds,
  pendingChangeKind, validateDetailsUpdate, validateMessage,
} from '../../domain/conversation.js'
import { optionLabel, visibleOptions } from '../../domain/lists.js'
import { todayISO } from '../../domain/metrics.js'
import { PROPOSAL_STATUS as PS, getStatus } from '../../domain/status.js'
import { effectiveWaiting, getTeam, waitingDays, waitingLabel } from '../../domain/waiting.js'
import { EVENT_NAME_MAX } from '../../domain/workflow.js'
import RelTime from '../ui/RelTime.jsx'

const daysText = (n) => (n === null ? '' : n === 0 ? 'today' : n === 1 ? '1 day' : `${n} days`)

// ---------------------------------------------------------------------------
// A. "Where is it?" — Request → Preparing → Ready → With client → Result
// ---------------------------------------------------------------------------

const STEPS = ['Request', 'Preparing', 'Ready', 'With client', 'Result']
const STEP_OF = {
  [PS.DRAFT]: 0, [PS.SUBMITTED]: 0, [PS.IN_PROGRESS]: 1, [PS.AWAITING_BD_INFO]: 1, [PS.REVISION_REQUESTED]: 1,
  [PS.READY_FOR_BD]: 2, [PS.SHARED_WITH_CLIENT]: 3, [PS.POSTPONED]: 3,
  [PS.ACCEPTED]: 4, [PS.REJECTED]: 4, [PS.CANCELLED]: 4, [PS.CLOSED_UNRECORDED]: 4, [PS.CLOSED_POSTPONED]: 4,
}
const HISTORY_LABELS = { [PS.CLOSED_UNRECORDED]: 'Closed · not recorded', [PS.CLOSED_POSTPONED]: 'Closed · postponed' }

/** The small label on the current step (postponed, a change, waiting on Marketing…). */
function stepNote(request, lists) {
  const w = effectiveWaiting(request)
  if (w?.kind === 'manual' && w.team !== 'bd' && w.team !== 'am') {
    return `Waiting on ${getTeam(w.team).label}${w.reason ? ` · ${optionLabel(lists, getTeam(w.team).reasons, w.reason)}` : ''}`
  }
  if (request.status === PS.DRAFT) return 'Draft'
  if (request.status === PS.POSTPONED) return 'Postponed'
  if (request.status === PS.AWAITING_BD_INFO) return 'Needs BD info'
  if (request.status === PS.REVISION_REQUESTED) return CHANGE_KIND_LABELS[pendingChangeKind(request)]
  if (request.status === PS.IN_PROGRESS && request.version > 1) {
    return `Version ${request.version} · ${CHANGE_KIND_LABELS[changeKind(request, request.version)] ?? 'Revision'}`
  }
  return null
}

export function ProgressSteps({ request, onChangeWaiting, canChangeWaiting }) {
  const { usersById } = useLookups()
  const lists = useLists().data
  const current = STEP_OF[request.status] ?? 0
  const w = effectiveWaiting(request)
  const result = request.status === PS.ACCEPTED ? 'won' : [PS.REJECTED, PS.CANCELLED].includes(request.status) ? 'lost' : null
  const note = stepNote(request, lists)
  return (
    <section className="progress" aria-label="Where is it?">
      <ol className="progress__steps">
        {STEPS.map((label, i) => {
          const state = i < current ? 'done' : i === current ? 'current' : 'next'
          const tone = i === 4 && result ? ` progress__step--${result}` : ''
          return (
            <li key={label} className={`progress__step progress__step--${state}${tone}`} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="progress__dot" aria-hidden="true" />
              <span className="progress__label">
                {i === 4 && result ? (result === 'won' ? 'Confirmed' : request.status === PS.CANCELLED ? 'Cancelled' : 'Lost')
                  : i === 4 && HISTORY_LABELS[request.status] ? HISTORY_LABELS[request.status] : label}
              </span>
              {state === 'current' && !result && (
                <span className="progress__who">
                  {w ? `${waitingLabel(w, usersById)} · ${daysText(waitingDays(w)) || 'today'}` : null}
                </span>
              )}
              {state === 'current' && note && <span className="progress__note">{note}</span>}
              {state === 'current' && canChangeWaiting && !result && (
                <button type="button" className="link-btn progress__change" onClick={onChangeWaiting}>Change who it waits on</button>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The assigned AM's "Details changed" banner
// ---------------------------------------------------------------------------

const show = (v) => (v === null || v === undefined || v === '' ? '—' : String(v))

export function DetailsBanner({ request }) {
  const { user, activeRole } = useCurrentUser()
  const viewer = { userId: user.id, activeRole }
  const details = useDetailsActions(request)
  const { perform } = useRequestActions(request)
  // Captured when the page opens: the banner stays for this visit even after "seen" is recorded.
  const [visible] = useState(() => detailsChangedFor(request, viewer))
  const [done, setDone] = useState(null)
  const [busy, setBusy] = useState(false)
  const last = [...(request.events ?? [])].reverse().find((e) => e.event === 'details_updated')
  const ready = request.status === PS.READY_FOR_BD
  if (!visible || !last) return null

  const act = async (fn, text) => {
    setBusy(true)
    const result = await fn()
    setBusy(false)
    setDone(result.ok ? text : result.error)
  }
  return (
    <div className="details-banner" role="status">
      <strong>Details changed</strong>
      <ul>
        {(last.details?.changes ?? []).map((c) => <li key={c.field}>{c.label}: {show(c.from)} → {show(c.to)}</li>)}
      </ul>
      {last.note && <p className="muted">{last.note}</p>}
      {done ? <p className="muted">{done}</p> : ready ? (
        <div className="details-banner__buttons">
          <span>Does the proposal need updating?</span>
          <button type="button" className="btn btn--primary btn--sm" disabled={busy}
            onClick={() => act(() => perform('take_back', { note: 'Details changed' }), 'Back in preparation as a new version.')}>
            Update the proposal
          </button>
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => act(details.seen, 'Noted: no change needed.')}>
            No change needed
          </button>
        </div>
      ) : <SeenOnOpen seen={details.seen} />}
    </div>
  )
}

/** Opening the request counts as seeing the change (when there is no proposal to update yet). */
function SeenOnOpen({ seen }) {
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current) return
    sent.current = true
    seen()
  }, [seen])
  return null
}

// ---------------------------------------------------------------------------
// "Update details" (BD owner, Commercial Head)
// ---------------------------------------------------------------------------

const FORM_ID = 'details-form'

export function UpdateDetailsPanel({ request, onClose, onSaved }) {
  const details = useDetailsActions(request)
  const lists = useLists().data
  const asText = (v) => (v === null || v === undefined ? '' : String(v))
  const form = usePanelForm({
    eventName: asText(request.eventName), eventDatePrecision: request.eventDatePrecision ?? 'day',
    eventDate: asText(request.eventDate), eventEndDate: asText(request.eventEndDate), participants: asText(request.participants),
    requirementsSummary: asText(request.requirementsSummary), specificRequirements: asText(request.specificRequirements),
    requiredBy: asText(request.requiredBy), note: '',
  })
  const { values, set, setValues, errors, failure, busy, submit, fieldProps } = form
  const onSubmit = (e) => {
    e.preventDefault()
    const { note, ...fields } = values
    const checked = validateDetailsUpdate(request, fields, { today: todayISO(), lists })
    const local = { ...checked.errors, ...(checked.changes.length ? {} : { eventName: 'Change at least one detail.' }) }
    const changed = Object.fromEntries(checked.changes.map((c) => [c.field, values[c.field]]))
    if (changed.eventDate !== undefined || changed.eventDatePrecision !== undefined) {
      Object.assign(changed, { eventDatePrecision: values.eventDatePrecision, eventDate: values.eventDate, eventEndDate: values.eventEndDate })
    }
    submit(local, () => details.update({ ...changed, note }), (result) => onSaved(result, successText(result)))
  }
  return (
    <SidePanel open title="Update details" subtitle={`${request.id} · the Account Manager will see what changed`} onClose={onClose}
      busy={busy} footer={<PanelButtons formId={FORM_ID} busy={busy} onCancel={onClose} submitLabel="Save changes" />}>
      <form id={FORM_ID} className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={failure} />
        <Field id="ud-name" label="Event name" error={errors.eventName}>
          <input maxLength={EVENT_NAME_MAX} {...fieldProps('ud-name', 'eventName')} value={values.eventName} onChange={set('eventName')} />
        </Field>
        <Field id="ud-date" label="Event date" error={errors.eventDate}>
          <SegmentedControl label="Event date precision" value={values.eventDatePrecision}
            onChange={(v) => setValues((p) => ({ ...p, eventDatePrecision: v, eventDate: '', eventEndDate: '' }))}
            options={[{ value: 'day', label: 'Exact date' }, { value: 'month', label: 'Month only' }, { value: 'unset', label: 'Not set yet' }]} />
          {values.eventDatePrecision === 'day' && <input type="date" {...fieldProps('ud-date', 'eventDate')} value={values.eventDate} onChange={set('eventDate')} />}
          {values.eventDatePrecision === 'month' && <input type="month" {...fieldProps('ud-date', 'eventDate')} value={values.eventDate} onChange={set('eventDate')} />}
        </Field>
        {values.eventDatePrecision === 'day' && (
          <Field id="ud-end" label="End date (optional)" error={errors.eventEndDate}>
            <input type="date" {...fieldProps('ud-end', 'eventEndDate')} value={values.eventEndDate} onChange={set('eventEndDate')} />
          </Field>
        )}
        <Field id="ud-people" label="Participants" error={errors.participants}>
          <input type="number" min="1" step="1" inputMode="numeric" {...fieldProps('ud-people', 'participants')} value={values.participants}
            onChange={set('participants')} />
        </Field>
        <Field id="ud-deadline" label="Proposal deadline" error={errors.requiredBy}>
          <input type="date" {...fieldProps('ud-deadline', 'requiredBy')} value={values.requiredBy} onChange={set('requiredBy')} />
        </Field>
        <Field id="ud-brief" label="Brief" error={errors.requirementsSummary}>
          <textarea rows={3} {...fieldProps('ud-brief', 'requirementsSummary')} value={values.requirementsSummary} onChange={set('requirementsSummary')} />
        </Field>
        <Field id="ud-specific" label="Specific requirements" error={errors.specificRequirements}>
          <textarea rows={2} {...fieldProps('ud-specific', 'specificRequirements')} value={values.specificRequirements}
            onChange={set('specificRequirements')} />
        </Field>
        <Field id="ud-note" label="Note for the Account Manager (optional)">
          <textarea rows={2} maxLength={300} value={values.note} onChange={set('note')} />
        </Field>
      </form>
    </SidePanel>
  )
}

// ---------------------------------------------------------------------------
// C. "What's been said?" — one conversation thread
// ---------------------------------------------------------------------------

const STATUS_LINES = {
  [PS.DRAFT]: 'started the request',
  [PS.SUBMITTED]: 'submitted the request',
  [PS.IN_PROGRESS]: 'started preparing the proposal',
  [PS.AWAITING_BD_INFO]: 'needs an answer to continue',
  [PS.READY_FOR_BD]: 'marked the proposal ready',
  [PS.SHARED_WITH_CLIENT]: 'shared the proposal with the client',
  [PS.REVISION_REQUESTED]: 'recorded that the client wants changes',
  [PS.POSTPONED]: 'recorded that the client postponed',
  [PS.ACCEPTED]: 'confirmed the event',
  [PS.REJECTED]: 'recorded the result: Lost',
  [PS.CANCELLED]: 'cancelled the request',
}
const REASON_LISTS = { [PS.AWAITING_BD_INFO]: 'whatsMissing', [PS.REVISION_REQUESTED]: 'whatShouldChange', [PS.POSTPONED]: 'postponeWhy' }
const EVENT_LINES = {
  details_updated: 'updated the details', details_seen: 'saw the changed details', waiting_on_set: 'changed who it is waiting on',
  waiting_on_cleared: 'marked it done', bd_owner_transferred: 'moved the BD owner', assigned_am_changed: 'moved it to another Account Manager',
  client_merged: 'merged its client',
}

/** Status history, events and messages in one list, oldest first. */
function threadItems(request, lists) {
  const history = request.statusHistory ?? request.history ?? []
  const items = history.map((e, i) => {
    let line = e.imported ? null : STATUS_LINES[e.status] ?? e.status
    const prev = history[i - 1]
    if (e.status === PS.REVISION_REQUESTED && prev?.status === PS.READY_FOR_BD) line = 'requested changes before sharing'
    if (e.status === PS.IN_PROGRESS && e.version > 1) line = prev?.status === PS.READY_FOR_BD ? `took the proposal back to edit (version ${e.version})` : `started version ${e.version}`
    if (e.status === PS.READY_FOR_BD && e.version > 1) line = `marked version ${e.version} ready`
    if (e.corrected) line = e.note // "Status corrected from With client to Lost — …" (by this person)
    const reasons = (e.reasons ?? []).map((c) => optionLabel(lists, REASON_LISTS[e.status], c)).join(', ')
    return { key: `h${i}`, type: 'system', at: e.changedAt, who: e.imported ? null : e.changedBy, imported: e.imported, line,
      // From the 2026 tracker or added by hand before IEE: the step and where it came from, never a name.
      importedText: e.imported ? `${HISTORY_LABELS[e.status] ?? getStatus('proposal', e.status).label} · ${e.note ?? 'From the 2026 tracker'}` : null,
      detail: e.corrected ? '' : [reasons, e.note && !e.imported ? e.note : null].filter(Boolean).join(' — ') }
  })
  for (const ev of request.events ?? []) {
    const changes = (ev.details?.changes ?? []).map((c) => `${c.label} ${show(c.from)} → ${show(c.to)}`).join(' · ')
    items.push({ key: `e${ev.id}`, type: 'system', at: ev.changedAt, who: ev.changedBy, line: EVENT_LINES[ev.event] ?? ev.event,
      detail: [changes, ev.note].filter(Boolean).join(' — ') })
  }
  for (const m of request.comments ?? []) items.push({ key: `m${m.id}`, type: 'message', at: m.createdAt, message: m })
  return items.sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

const ORIGIN_LABELS = { client: 'Client asked', internal: 'Internal' }
const AFTER_SHARING = [PS.SHARED_WITH_CLIENT, PS.POSTPONED]
const time = (v) => (v ? new Date(v).getTime() : 0)

/**
 * Open questions and open "Change needed" cards: at the top until answered / picked up. A question is
 * answered right on its card by the people who may; the AM picks a change up from its card.
 */
export function OpenCards({ request, lastReadAt }) {
  const { user, activeRole } = useCurrentUser()
  const viewer = { userId: user.id, activeRole }
  const { usersById } = useLookups()
  const lists = useLists().data
  const conversation = useConversation(request)
  const messages = request.comments ?? []
  const questions = messages.filter((m) => openQuestionIds(messages).includes(m.id))
  const changes = messages.filter((m) => openChangeIds(messages).includes(m.id))
  const canAnswer = canAskQuestion(request, viewer, usersById).allowed
  const canPickUp = canPostMessage('picked_up', request, viewer, usersById).allowed
  const [answers, setAnswers] = useState({})
  const [error, setError] = useState(null)
  if (!questions.length && !changes.length) return null

  const send = async (message) => {
    setError(null)
    const result = await conversation.post(message)
    if (!result.ok) setError(Object.values(result.errors ?? {})[0] ?? result.error)
    else setAnswers((a) => ({ ...a, [message.parentId]: '' }))
  }
  const isNew = (m) => m.author !== user.id && time(m.createdAt) > time(lastReadAt)
  return (
    <div className="open-cards">
      {changes.map((m) => (
        <div key={m.id} className={`open-card open-card--change${isNew(m) ? ' is-new' : ''}`} data-new={isNew(m) || undefined}>
          <div className="open-card__meta">
            <strong>Change needed</strong> · {ORIGIN_LABELS[m.about] ?? m.about} · {usersById[m.author]?.name ?? 'Someone'}
            {' · '}<RelTime value={m.createdAt} />
            {isNew(m) && <Badge tone="info">New</Badge>}
          </div>
          <p className="open-card__text">
            {(m.reasons ?? []).map((c) => optionLabel(lists, 'whatShouldChange', c)).join(', ')}
            {m.body && m.body !== 'Change needed' ? ` — ${m.body}` : ''}
          </p>
          {canPickUp && <button type="button" className="btn btn--sm" onClick={() => send({ kind: 'picked_up', parentId: m.id })}>Pick it up</button>}
        </div>
      ))}
      {questions.map((m) => (
        <div key={m.id} className={`open-card${isNew(m) ? ' is-new' : ''}`} data-new={isNew(m) || undefined}>
          <div className="open-card__meta">
            <strong>Question</strong> from {usersById[m.author]?.name ?? 'Someone'}
            {m.about && ` · about ${optionLabel(lists, 'questionAbout', m.about)}`}
            {' · '}<RelTime value={m.createdAt} />
            {isNew(m) && <Badge tone="info">New</Badge>}
          </div>
          <p className="open-card__text">{m.body}</p>
          {canAnswer && m.author !== user.id && (
            <form className="open-card__answer" onSubmit={(e) => { e.preventDefault(); send({ kind: 'answer', body: answers[m.id] ?? '', parentId: m.id }) }}>
              <textarea rows={2} aria-label="Your answer" placeholder="Your answer" value={answers[m.id] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [m.id]: e.target.value }))} />
              <div className="composer__buttons">
                <button type="button" className="link-btn" onClick={() => send({ kind: 'answered', parentId: m.id })}>Mark as answered</button>
                <button type="submit" className="btn btn--primary btn--sm">Send answer</button>
              </div>
            </form>
          )}
        </div>
      ))}
      {error && <p className="form-field__error" role="alert">{error}</p>}
    </div>
  )
}

/**
 * The conversation: messages, answered questions and changes picked up, and grey system lines, oldest
 * first; everything new since the person's last visit is highlighted and the page scrolls to it.
 * Composer: three clear buttons, one line of help each:
 *   Send message — a note or a question; nothing stops.
 *   Ask BD and pause (the assigned AM) — the request goes to BD until they answer.
 *   Change needed (the BD owner or the Commercial Head) — the proposal goes back to the AM.
 */
export function Conversation({ request, lastReadAt }) {
  const { user, activeRole } = useCurrentUser()
  const viewer = { userId: user.id, activeRole }
  const { usersById } = useLookups()
  const lists = useLists().data
  const conversation = useConversation(request)
  const { actions: requestActions, perform } = useRequestActions(request)
  const canAskBd = requestActions.some((a) => a.action === 'request_bd_info' && a.allowed)
  const messages = request.comments ?? []
  const openIds = new Set([...openQuestionIds(messages), ...openChangeIds(messages)])
  const byId = Object.fromEntries(messages.map((m) => [m.id, m]))
  const canChange = canPostMessage('change', request, viewer, usersById).allowed
  const [mode, setMode] = useState('comment') // 'change' shows what should change before sending
  const [text, setText] = useState('')
  const [about, setAbout] = useState('')
  const [codes, setCodes] = useState([])
  const [origin, setOrigin] = useState('client')
  const [deadline, setDeadline] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const items = threadItems(request, lists).filter((it) => !(it.type === 'message' && openIds.has(it.message.id)))
  const isNew = (it) => (it.type === 'message' ? it.message.author : it.who) !== user.id && time(it.at) > time(lastReadAt)
  const listRef = useRef(null)
  const scrolled = useRef(false)
  useEffect(() => {
    if (scrolled.current) return
    scrolled.current = true
    const first = document.querySelector('[data-new]')
    first?.scrollIntoView?.({ block: 'center' })
  }, [])

  async function askBd() {
    setError(null)
    if (!text.trim()) { setError('Write what you need from BD.'); return }
    setBusy(true)
    const result = await perform('request_bd_info', { note: text.trim(), reasons: [] })
    setBusy(false)
    if (!result.ok) { setError(Object.values(result.errors ?? {})[0] ?? result.error); return }
    setText('')
  }

  async function send(e) {
    e.preventDefault()
    setError(null)
    // A message with a "?" is a question (it shows as open until answered); nothing stops either way.
    const asks = mode !== 'change' && text.includes('?') && canAskQuestion(request, viewer, usersById).allowed
    const message = mode === 'change'
      ? { kind: 'change', body: text, about: origin, reasons: codes, newRequiredBy: AFTER_SHARING.includes(request.status) ? deadline : undefined }
      : { kind: asks ? 'question' : 'comment', body: text, about: asks && about ? about : null }
    const local = validateMessage(message, { lists, messages })
    if (Object.keys(local.errors).length) { setError(Object.values(local.errors)[0]); return }
    setBusy(true)
    const result = await conversation.post(message)
    setBusy(false)
    if (!result.ok) { setError(Object.values(result.errors ?? {})[0] ?? result.error); return }
    setText('')
    setAbout('')
    setCodes([])
    setDeadline('')
    setMode('comment')
  }

  return (
    <Card title="Conversation">
      <ol className="thread" ref={listRef}>
        {items.map((it) => (it.type === 'system' ? (
          <li key={it.key} className={`thread__system${isNew(it) ? ' is-new' : ''}`} data-new={isNew(it) || undefined}>
            <span>
              {it.imported ? it.importedText ?? 'Imported from the 2026 tracker' : <><strong>{usersById[it.who]?.name ?? 'Someone'}</strong> {it.line}</>}
              {it.detail && <span className="thread__detail"> — {it.detail}</span>}
            </span>
            <RelTime value={it.at} />
          </li>
        ) : (
          <Message key={it.key} m={it.message} author={usersById[it.message.author]} parent={byId[it.message.parentId]} lists={lists}
            fresh={isNew(it)} />
        )))}
        {items.length === 0 && <li className="thread__system">Nothing yet.</li>}
      </ol>

      <form className="composer" onSubmit={send}>
        {mode === 'change' && (
          <>
            <div className="reason-picker__options" role="group" aria-label="What should change">
              {visibleOptions(lists, 'whatShouldChange').map((o) => (
                <label key={o.code} className={`chip-toggle${codes.includes(o.code) ? ' is-on' : ''}`}>
                  <input type="checkbox" checked={codes.includes(o.code)}
                    onChange={() => setCodes((c) => (c.includes(o.code) ? c.filter((x) => x !== o.code) : [...c, o.code]))} />
                  {o.label}
                </label>
              ))}
            </div>
            <SegmentedControl label="Who asked for it" value={origin} onChange={setOrigin}
              options={[{ value: 'client', label: 'Client asked' }, { value: 'internal', label: 'Internal' }]} />
            {AFTER_SHARING.includes(request.status) && (
              <label className="form-field composer__about">
                <span className="form-field__label">New proposal deadline *</span>
                <input type="date" min={todayISO()} value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </label>
            )}
          </>
        )}
        <textarea rows={2} maxLength={MESSAGE_MAX_LENGTH} value={text} onChange={(e) => setText(e.target.value)} aria-label="Message"
          placeholder={mode === 'change' ? 'What exactly? (required for "Other")' : 'Write a message — @Name to tell someone else'} />
        {error && <p className="form-field__error" role="alert">{error}</p>}
        {mode === 'change' ? (
          <div className="composer__choices">
            <div className="composer__choice">
              <button type="submit" className="btn btn--primary btn--sm" disabled={busy} aria-busy={busy}>{busy ? 'Sending…' : 'Send change'}</button>
              <button type="button" className="btn btn--sm" disabled={busy} onClick={() => { setMode('comment'); setCodes([]); setError(null) }}>Back</button>
            </div>
          </div>
        ) : (
          <div className="composer__choices">
            <div className="composer__choice">
              <button type="submit" className="btn btn--primary btn--sm" disabled={busy} aria-busy={busy}>{busy ? 'Sending…' : 'Send message'}</button>
              <span className="composer__help">A note or a question; nothing stops.</span>
            </div>
            {canAskBd && (
              <div className="composer__choice">
                <button type="button" className="btn btn--sm" disabled={busy} onClick={askBd}>Ask BD and pause</button>
                <span className="composer__help">The request goes to BD until they answer.</span>
              </div>
            )}
            {canChange && (
              <div className="composer__choice">
                <button type="button" className="btn btn--sm" disabled={busy} onClick={() => { setMode('change'); setError(null) }}>Change needed</button>
                <span className="composer__help">Choose what should change; the proposal goes back to the AM.</span>
              </div>
            )}
          </div>
        )}
      </form>
    </Card>
  )
}

function Message({ m, author, parent, lists, fresh }) {
  if (m.kind === 'answered' || m.kind === 'picked_up') {
    return (
      <li className={`thread__system${fresh ? ' is-new' : ''}`} data-new={fresh || undefined}>
        <span><strong>{author?.name ?? 'Someone'}</strong> {m.kind === 'answered' ? 'marked a question as answered' : 'picked up the change'}
          {parent ? `: “${parent.body.slice(0, 60)}”` : ''}</span>
        <RelTime value={m.createdAt} />
      </li>
    )
  }
  const label = m.kind === 'question' ? 'Question' : m.kind === 'change' ? `Change needed · ${ORIGIN_LABELS[m.about] ?? ''}` : null
  return (
    <li className={`bubble${m.kind === 'change' ? ' bubble--change' : ''}${fresh ? ' is-new' : ''}`} data-new={fresh || undefined}>
      <span className="bubble__avatar"><Avatar initials={author?.initials ?? '?'} tone={author?.avatarTone} size="sm" /></span>
      <div className="bubble__body">
        <div className="bubble__meta">
          <strong>{author?.name ?? 'Someone'}</strong>
          {label && <Badge tone="neutral">{label}</Badge>}
          {m.kind === 'answer' && parent && <span className="muted">answered “{parent.body.slice(0, 50)}”</span>}
          {fresh && <Badge tone="info">New</Badge>}
          <RelTime value={m.createdAt} className="muted" />
        </div>
        <p className="bubble__text">
          {m.kind === 'change' ? `${(m.reasons ?? []).map((c) => optionLabel(lists, 'whatShouldChange', c)).join(', ')}${m.body && m.body !== 'Change needed' ? ` — ${m.body}` : ''}` : m.body}
        </p>
      </div>
    </li>
  )
}
