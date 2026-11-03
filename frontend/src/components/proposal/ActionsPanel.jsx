import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Card from '../ui/Card.jsx'
import ConfirmDialog from '../ui/ConfirmDialog.jsx'
import Icon from '../ui/Icon.jsx'
import StatusBadge from '../ui/StatusBadge.jsx'
import { useCurrentUser, useLists, useLookups, useRequestActions } from '../../data/hooks.js'
import MoreMenu from '../ui/MoreMenu.jsx'
import { effectiveWaiting, waitingLabel } from '../../domain/waiting.js'
import { LIST_DEFS, OTHER, visibleOptions } from '../../domain/lists.js'
import { API_MODE } from '../../data/source.js'
import { editDraftLink } from '../../lib/links.js'
import { LOST_REASONS_FOR_FORMS, LOST_REASON_OTHER, SHARE_CHANNELS, getStatus } from '../../domain/status.js'
import { todayISO } from '../../domain/metrics.js'
import { formatCurrency } from '../../lib/format.js'
import { celebrate } from '../ui/Celebration.jsx'

const EMPTY_INPUT = {
  note: '', amPrice: '', newRequiredBy: '', followUpOn: '', confirmShared: false, lostReason: '', channel: '', reasons: [],
  eventDate: '', eventEndDate: '', finalParticipants: '', finalPrice: '', venue: '', teamNotes: '', eventStatus: 'confirmed',
}
const LIST_MULTI = Object.fromEntries(LIST_DEFS.map((d) => [d.id, d.multi]))
const LIST_TITLES = { whatsMissing: "What's missing", whatShouldChange: 'What should change', postponeWhy: 'Why' }
const FORM_FIELDS = Object.keys(EMPTY_INPUT)

// The main step first, then up to two more as visible buttons; "More" keeps only rare actions.
// "Ask BD and pause" and "Change needed" live in the conversation composer instead.
const PRIORITY = ['set_outcome_confirmed', 'set_outcome_lost', 'submit', 'start_work', 'start_revision', 'provide_bd_info', 'mark_ready', 'share_with_client', 'resume',
  'record_accepted', 'record_rejected', 'request_revision', 'postpone', 'take_back', 'cancel']
// "Change needed" in the conversation records these (before sharing: internal; after: client revision).
const IN_COMPOSER = ['request_changes', 'request_revision', 'request_bd_info']
const RARE = ['cancel', 'take_back']
const VISIBLE_MAX = 3
const MORE_MAX = 4
const YOUR_TURN = {
  submit: 'submit the request to the Account Manager',
  start_work: 'start preparing the proposal',
  start_revision: 'start the revised version',
  provide_bd_info: 'answer the Account Manager and send it back',
  mark_ready: 'finish the proposal and mark it ready',
  share_with_client: 'share the proposal with the client',
  resume: 'follow up with the client',
  record_accepted: "record the client's answer (Mark confirmed when the event is on)",
}
const DOING = {
  draft: 'finishing the draft', submitted: 'starting the proposal', in_progress: 'preparing the proposal',
  awaiting_bd_info: 'answering the Account Manager', ready_for_bd: 'sharing the proposal with the client',
  shared_with_client: "the client's answer", postponed: 'the client (postponed)', revision_requested: 'starting the revised version',
}

/**
 * "What do I need to do?": the viewer's next step with one main button (others under "More"), or who it waits on.
 * The actions (and their reasons) come from useRequestActions: domain/workflow.js in demo mode,
 * the server's allowedActions in API mode. This component only collects input.
 * Writes may be async: one pending state blocks double submissions, and success is shown only
 * after the change has been saved.
 */
export default function ActionsPanel({ request, extras = [] }) {
  const { actions, perform, validate, editable, reload } = useRequestActions(request)
  const { user, activeRole } = useCurrentUser()
  const { usersById, clientsById } = useLookups()
  const lists = useLists().data
  const [selected, setSelected] = useState(null) // transition being filled in
  const [input, setInput] = useState(EMPTY_INPUT)
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [stale, setStale] = useState(false) // 409: changed by someone else (typed values are kept)
  const [success, setSuccess] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false) // blocks a second submit before React re-renders

  const allowed = actions.filter((a) => a.allowed)
  const closed = getStatus('proposal', request.status).closed

  function open(action, preset = {}) {
    setSelected({ ...action, preset })
    // "Mark confirmed": prefilled with the event date(s), participants and the latest AM price.
    const asText = (v) => (v === null || v === undefined ? '' : String(v))
    setInput(action.requires?.confirmEvent ? {
      ...EMPTY_INPUT,
      eventDate: request.eventDatePrecision === 'day' ? asText(request.eventDate) : '',
      eventEndDate: asText(request.eventEndDate), finalParticipants: asText(request.participants), finalPrice: asText(request.amPrice),
      ...preset,
    } : { ...EMPTY_INPUT, ...preset })
    setErrors({})
    setError(null)
    setStale(false)
    setSuccess(null)
  }

  function close() {
    setSelected(null)
    setConfirming(false)
    setErrors({})
    setError(null)
    setStale(false)
  }

  async function run() {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    let result
    try {
      result = await perform(selected.action, input)
    } finally {
      pendingRef.current = false
      setPending(false)
    }
    setConfirming(false)
    if (!result.ok) {
      // Keep everything the user typed; show what to fix.
      setErrors(result.errors ?? {})
      setError(result.error)
      setStale(Boolean(result.stale))
      return
    }
    // Saved (demo store updated, or the server answered 2xx) before we get here.
    setSelected(null)
    setStale(false)
    // Confirmed: the proposal is now an Event (it leaves Proposals and is listed under Events).
    const becameEvent = selected.action === 'record_accepted'
    if (becameEvent) {
      celebrate(clientsById[request.clientId]?.name ?? request.clientName, { initial: input.eventStatus === 'initial' })
    }
    setSuccess({ message: becameEvent ? 'This proposal is now an event.' : result.message, event: becameEvent,
      warnings: (result.warnings ?? []).map((w) => w.message) })
  }

  async function submit(e) {
    e.preventDefault()
    if (pendingRef.current) return
    if (selected.confirm) {
      const check = await validate(selected.action, input)
      if (!check.ok) {
        setErrors(check.errors ?? {})
        setError(check.error)
        return
      }
      setErrors({})
      setError(null)
      setConfirming(true)
      return
    }
    run()
  }

  function reloadRequest() {
    setStale(false)
    setError(null)
    reload()
  }

  const set = (field) => (e) =>
    setInput((prev) => ({ ...prev, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  return (
    <Card title="Next step">
      {success && (
        <div className="action-feedback action-feedback--success" role="status">
          <Icon name="checkmark" size={16} strokeWidth={2.25} />
          <span>
            {success.message}
            {success.event && <> <Link to={`/events/${encodeURIComponent(request.id)}`}>Open the event page</Link></>}
            {success.warnings.map((w) => <span key={w} className="action-feedback__warning">{w}</span>)}
            {!API_MODE && <span className="action-feedback__note">Demo: kept in memory only; resets when you reload.</span>}
          </span>
        </div>
      )}

      {selected ? (
        <form className="action-form" onSubmit={submit} noValidate>
          <div className="action-form__title">
            {selected.preset?.eventStatus === 'initial' ? 'Mark initially confirmed' : selected.label}
            <Icon name="arrowUp" size={14} className="action-form__arrow" />{' '}
            <StatusBadge kind="proposal" status={selected.to} version={request.version} />
          </div>

          {selected.requires.note && (
            <label className="form-field">
              <span className="form-field__label">{selected.notePrompt} *</span>
              <textarea rows={3} value={input.note} onChange={set('note')} aria-invalid={Boolean(errors.note)} />
              {errors.note && <span className="form-field__error">{errors.note}</span>}
            </label>
          )}
          {selected.requires.lostReason && (
            <label className="form-field">
              <span className="form-field__label">Why was it lost? *</span>
              <select value={input.lostReason} onChange={set('lostReason')} aria-invalid={Boolean(errors.lostReason)}>
                <option value="">Choose a reason…</option>
                {LOST_REASONS_FOR_FORMS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
              {errors.lostReason && <span className="form-field__error">{errors.lostReason}</span>}
            </label>
          )}
          {selected.requires.confirmEvent && (
            <>
              {!selected.preset?.eventStatus && <fieldset className="form-field choice-group">
                <legend className="form-field__label">The event is</legend>
                <label className="choice">
                  <input type="radio" name="event-status" value="confirmed" checked={input.eventStatus !== 'initial'} onChange={set('eventStatus')} />
                  <span><strong>Confirmed</strong> — approved for execution</span>
                </label>
                <label className="choice">
                  <input type="radio" name="event-status" value="initial" checked={input.eventStatus === 'initial'} onChange={set('eventStatus')} />
                  <span><strong>Initially confirmed</strong> — planning only; details or payment pending</span>
                </label>
                {errors.eventStatus && <span className="form-field__error">{errors.eventStatus}</span>}
              </fieldset>}
              {selected.preset?.eventStatus === 'initial' && (
                <p className="muted">Planning only: details or payment still pending. Only the event date is needed now.</p>
              )}
              <label className="form-field">
                <span className="form-field__label">Event date *</span>
                <input type="date" value={input.eventDate} onChange={set('eventDate')} aria-invalid={Boolean(errors.eventDate)} />
                {errors.eventDate && <span className="form-field__error">{errors.eventDate}</span>}
              </label>
              <label className="form-field">
                <span className="form-field__label">End date (optional)</span>
                <input type="date" value={input.eventEndDate} onChange={set('eventEndDate')} aria-invalid={Boolean(errors.eventEndDate)} />
                {errors.eventEndDate && <span className="form-field__error">{errors.eventEndDate}</span>}
              </label>
              {input.eventStatus !== 'initial' && <>
              <label className="form-field">
                <span className="form-field__label">Final participants</span>
                <input type="number" min="1" step="1" inputMode="numeric" value={input.finalParticipants} onChange={set('finalParticipants')}
                  aria-invalid={Boolean(errors.finalParticipants)} />
                {errors.finalParticipants && <span className="form-field__error">{errors.finalParticipants}</span>}
              </label>
              <label className="form-field">
                <span className="form-field__label">Final price (EGP)</span>
                <input type="number" min="0" step="1" inputMode="numeric" value={input.finalPrice} onChange={set('finalPrice')}
                  aria-invalid={Boolean(errors.finalPrice)} />
                {errors.finalPrice && <span className="form-field__error">{errors.finalPrice}</span>}
              </label>
              <label className="form-field">
                <span className="form-field__label">Venue (optional)</span>
                <input maxLength={200} value={input.venue} onChange={set('venue')} />
              </label>
              <label className="form-field">
                <span className="form-field__label">Notes for the team (optional)</span>
                <textarea rows={2} maxLength={1000} value={input.teamNotes} onChange={set('teamNotes')} />
                {errors.teamNotes && <span className="form-field__error">{errors.teamNotes}</span>}
              </label>
              </>}
            </>
          )}
          {selected.requires.reasons && (
            <ReasonPicker listId={selected.requires.reasons} options={visibleOptions(lists, selected.requires.reasons)}
              value={input.reasons} error={errors.reasons}
              onChange={(reasons) => { setInput((prev) => ({ ...prev, reasons })); setErrors((prev) => ({ ...prev, reasons: undefined, note: undefined })) }} />
          )}
          {!selected.requires.note && (
            <label className="form-field">
              <span className="form-field__label">
                {selected.requires.lostReason
                  ? input.lostReason === LOST_REASON_OTHER ? 'Details *' : 'Details (optional)'
                  : selected.requires.reasons
                    ? (input.reasons.includes(OTHER) || (LIST_MULTI[selected.requires.reasons] && !input.reasons.length)
                      ? `${LIST_MULTI[selected.requires.reasons] && !input.reasons.length ? 'Or describe it' : 'Describe "Other"'} *`
                      : 'Note (optional)')
                    : 'Note (optional)'}
              </span>
              <textarea rows={2} value={input.note} onChange={set('note')} aria-invalid={Boolean(errors.note)} />
              {errors.note && <span className="form-field__error">{errors.note}</span>}
            </label>
          )}

          {selected.requires.amPrice && (
            <label className="form-field">
              <span className="form-field__label">AM price (EGP) for version {request.version} *</span>
              <input type="number" inputMode="numeric" min="1" step="1" value={input.amPrice}
                onChange={set('amPrice')} aria-invalid={Boolean(errors.amPrice)} />
              {input.amPrice && !errors.amPrice && Number.isInteger(Number(input.amPrice)) && Number(input.amPrice) > 0 && (
                <span className="form-field__hint">{formatCurrency(Number(input.amPrice))}</span>
              )}
              {errors.amPrice && <span className="form-field__error">{errors.amPrice}</span>}
            </label>
          )}

          {selected.requires.newRequiredBy && (
            <label className="form-field">
              <span className="form-field__label">New proposal deadline *</span>
              <input type="date" min={todayISO()} value={input.newRequiredBy} onChange={set('newRequiredBy')}
                aria-invalid={Boolean(errors.newRequiredBy)} />
              <span className="form-field__hint">When the AM must send the revised proposal to BD.</span>
              {errors.newRequiredBy && <span className="form-field__error">{errors.newRequiredBy}</span>}
            </label>
          )}

          {selected.requires.followUpOn && (
            <label className="form-field">
              <span className="form-field__label">Follow up on *</span>
              <input type="date" min={todayISO()} value={input.followUpOn} onChange={set('followUpOn')}
                aria-invalid={Boolean(errors.followUpOn)} />
              <span className="form-field__hint">When to contact the client again. Until then it is not counted as waiting on you.</span>
              {errors.followUpOn && <span className="form-field__error">{errors.followUpOn}</span>}
            </label>
          )}

          {selected.requires.channel && (
            <label className="form-field">
              <span className="form-field__label">How was it sent? *</span>
              <select value={input.channel} onChange={set('channel')} aria-invalid={Boolean(errors.channel)}>
                <option value="">Choose a channel…</option>
                {SHARE_CHANNELS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              {errors.channel && <span className="form-field__error">{errors.channel}</span>}
            </label>
          )}

          {selected.requires.confirmShared && (
            <label className="form-check">
              <input type="checkbox" checked={input.confirmShared} onChange={set('confirmShared')}
                aria-invalid={Boolean(errors.confirmShared)} />
              <span>I have actually sent this proposal to the client.</span>
              {errors.confirmShared && <span className="form-field__error">{errors.confirmShared}</span>}
            </label>
          )}

          {error && (
            <div className="form-error" role="alert">
              {error}
              {/* Errors about the request itself (e.g. missing fields when submitting a draft). */}
              {Object.entries(errors).filter(([k, v]) => v && !FORM_FIELDS.includes(k)).length > 0 && (
                <ul className="form-error__list">
                  {Object.entries(errors).filter(([k, v]) => v && !FORM_FIELDS.includes(k)).map(([k, v]) => <li key={k}>{v}</li>)}
                </ul>
              )}
              {editable && Object.keys(errors).some((k) => !FORM_FIELDS.includes(k)) && (
                <Link to={editDraftLink(request.id)} className="form-error__link">Edit the draft to complete it</Link>
              )}
              {stale && (
                <button type="button" className="btn form-error__reload" onClick={reloadRequest}>Reload</button>
              )}
            </div>
          )}

          <div className="action-form__buttons">
            <button type="button" className="btn" onClick={close} disabled={pending}>Back</button>
            <button type="submit" className={`btn ${selected.tone === 'danger' ? 'btn--danger' : 'btn--primary'}`}
              disabled={pending} aria-busy={pending}>
              {pending ? 'Saving…' : selected.label}
            </button>
          </div>
        </form>
      ) : (
        <>
          {editable && (
            <Link to={editDraftLink(request.id)} className="btn action-edit">Edit draft</Link>
          )}
          <NextStep request={request} allowed={allowed.filter((a) => !IN_COMPOSER.includes(a.action))} onOpen={open}
            closed={closed} usersById={usersById} viewer={{ userId: user.id, activeRole }} extras={extras} />
        </>
      )}

      <ConfirmDialog
        open={confirming}
        title={selected ? `${selected.label}?` : ''}
        confirmLabel={pending ? 'Saving…' : selected?.label ?? 'Confirm'}
        busy={pending}
        tone={selected?.tone === 'danger' ? 'danger' : 'primary'}
        onConfirm={run}
        onCancel={() => setConfirming(false)}
      >
        {selected && (
          <p>
            {request.id} will change to <StatusBadge kind="proposal" status={selected.to} version={request.version} />. This is recorded in the
            activity history{selected.opportunity ? ' and may update the linked opportunity' : ''}.
          </p>
        )}
      </ConfirmDialog>
    </Card>
  )
}

/** Choices instead of typing: several (checkboxes) for a multi list, one (select) otherwise. */
function ReasonPicker({ listId, options, value, error, onChange }) {
  const title = LIST_TITLES[listId] ?? 'Reason'
  if (!LIST_MULTI[listId]) {
    return (
      <label className="form-field">
        <span className="form-field__label">{title} (optional)</span>
        <select value={value[0] ?? ''} onChange={(e) => onChange(e.target.value ? [e.target.value] : [])} aria-invalid={Boolean(error)}>
          <option value="">Choose…</option>
          {options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
        </select>
        {error && <span className="form-field__error">{error}</span>}
      </label>
    )
  }
  const toggle = (code) => onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code])
  return (
    <fieldset className="form-field reason-picker">
      <legend className="form-field__label">{title}</legend>
      <div className="reason-picker__options">
        {options.map((o) => (
          <label key={o.code} className={`chip-toggle${value.includes(o.code) ? ' is-on' : ''}`}>
            <input type="checkbox" checked={value.includes(o.code)} onChange={() => toggle(o.code)} />
            {o.label}
          </label>
        ))}
      </div>
      {error && <span className="form-field__error">{error}</span>}
    </fieldset>
  )
}

/**
 * "Your turn: …" with the actions that fit this stage as visible buttons (at most 3, one primary);
 * "More" keeps only rare actions (cancel, take back, update details). "Mark confirmed" and
 * "Initially confirmed" are two equal buttons. extras: [{ label, onSelect, visible? }] from the page.
 */
function NextStep({ request, allowed, onOpen, closed, usersById, viewer, extras }) {
  const sorted = [...allowed].sort((a, b) => (PRIORITY.indexOf(a.action) + 1 || 99) - (PRIORITY.indexOf(b.action) + 1 || 99))
  const common = sorted.filter((a) => !RARE.includes(a.action))
  const rare = sorted.filter((a) => RARE.includes(a.action))
  const asItem = (a) => ({ label: a.label, tone: a.tone === 'danger' ? 'danger' : undefined, onSelect: () => onOpen(a) })
  const shown = extras.filter((x) => x.visible)
  // The page's own step (e.g. "Upload proposal") leads when no status step is possible yet.
  const main = common[0] ?? null
  const buttons = [...common.slice(1).map(asItem), ...shown.map(({ visible, ...x }) => x)]
  const primaryExtra = !main && buttons.length ? buttons.shift() : null
  const room = VISIBLE_MAX - 1
  const more = [...buttons.slice(room), ...rare.map(asItem), ...extras.filter((x) => !x.visible)].slice(0, MORE_MAX)
  const secondary = buttons.slice(0, room)
  const w = effectiveWaiting(request)
  const moreMenu = more.length > 0 ? <MoreMenu items={more} /> : null
  const who = waitingLabel(w, usersById)
  const secondaryButtons = secondary.map((x) => (
    <button key={x.label} type="button" className="btn" onClick={x.onSelect}>{x.label}</button>
  ))
  if (closed && !main) return <p className="next-step">This request is closed. Nothing more to do.</p>
  if (closed) {
    return (
      <div className="next-step next-step--turn">
        <p>Closed without a recorded outcome. If you know it, set it.</p>
        <div className="next-step__buttons">
          {sorted.map((a) => <button key={a.action} type="button" className="btn" onClick={() => onOpen(a)}>{a.label}</button>)}
        </div>
      </div>
    )
  }
  if (!main && !primaryExtra) {
    return (
      <div className="next-step">
        <p>{who === '—' ? 'Nothing is waiting.' : <>Waiting on <strong>{who}</strong>{DOING[request.status] ? ` — ${DOING[request.status]}` : ''}.</>}</p>
        {(secondaryButtons.length > 0 || moreMenu) && <div className="next-step__buttons">{secondaryButtons}{moreMenu}</div>}
      </div>
    )
  }
  const turn = main ? YOUR_TURN[main.action] ?? main.label.toLowerCase() : primaryExtra.label.toLowerCase()
  const bdInfo = main?.action === 'provide_bd_info' ? bdInfoAsked(request, usersById) : null
  return (
    <div className="next-step next-step--turn">
      <p><strong>Your turn:</strong> {bdInfo ?? turn}</p>
      <div className="next-step__buttons">
        {main?.action === 'record_accepted' ? (
          <>
            <button type="button" className="btn btn--primary" onClick={() => onOpen(main, { eventStatus: 'confirmed' })}>Mark confirmed</button>
            <button type="button" className="btn btn--primary" onClick={() => onOpen(main, { eventStatus: 'initial' })}>Initially confirmed</button>
          </>
        ) : main ? (
          <button type="button" className={`btn ${main.tone === 'danger' ? 'btn--danger' : 'btn--primary'}`} onClick={() => onOpen(main)}>
            {main.label}
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={primaryExtra.onSelect}>{primaryExtra.label}</button>
        )}
        {secondaryButtons}
        {moreMenu}
      </div>
    </div>
  )
}

/** On BD's side while the AM waits for information: "Mariam needs this before she can continue: …". */
function bdInfoAsked(request, usersById) {
  const asked = [...(request.statusHistory ?? [])].reverse().find((e) => e.status === 'awaiting_bd_info')
  const first = usersById[asked?.changedBy ?? request.assignedAM]?.name?.split(' ')[0] ?? 'The Account Manager'
  return `${first} needs this before continuing${asked?.note ? `: "${asked.note}"` : ''}. Answer and send it back.`
}
