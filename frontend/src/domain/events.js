/**
 * Events: a proposal request that is Won. The Events page and the client page's Events tab only
 * list them (each keeps its own history, files and comments). Pure rules; the backend
 * (app/domain/events.py) gives the same answers, checked by the contract file.
 */

import { PROPOSAL_STATUS } from './status.js'
import { actsAsBusinessDevelopment, canSeeRequest, seesProposalData } from './access.js'
import { checkCodes, OTHER } from './lists.js'
import { ROLE } from './roles.js'

export const EVENT_TIMING = { DONE: 'done', UPCOMING: 'upcoming', UNDATED: 'undated', CANCELLED: 'cancelled', POSTPONED: 'postponed' }

/**
 * The event's own status, separate from the proposal's (set once the client accepted):
 * Initially confirmed (planning only; details or payment pending) · Confirmed (go ahead) · Postponed · Cancelled.
 */
export const EVENT_STATUS = { INITIAL: 'initial', CONFIRMED: 'confirmed', POSTPONED: 'postponed', CANCELLED: 'cancelled' }
export const EVENT_STATUS_LABELS = {
  initial: 'Initially confirmed', confirmed: 'Confirmed', postponed: 'Postponed', cancelled: 'Cancelled',
}

/** null for anything not accepted; events confirmed before event statuses existed count as Confirmed. */
export function eventStatusOf(request) {
  if (request.status !== PROPOSAL_STATUS.ACCEPTED) return null
  if (request.eventStatus) return request.eventStatus
  return request.eventCancelledAt ? EVENT_STATUS.CANCELLED : EVENT_STATUS.CONFIRMED
}

const COMPLETED = 'event completed' // the 2026 tracker's own status for events that took place

/**
 * Done · Upcoming · Undated ("Date not set", listed at the bottom of Upcoming), or null when the
 * request is not Won. today = "YYYY-MM-DD" (Cairo).
 *   Done:      imported as "Event Completed", or the event (end) date is before today
 *   Upcoming:  the event date is today or later (month only: this month or later)
 *   Undated:   no event date yet (an imported "Approved" without a date lands here too)
 */
export function eventTiming(request, today) {
  if (request.status !== PROPOSAL_STATUS.ACCEPTED) return null
  const status = eventStatusOf(request)
  if (status === EVENT_STATUS.CANCELLED) return EVENT_TIMING.CANCELLED // never Done: "Cancelled after confirmation"
  if (status === EVENT_STATUS.POSTPONED) return EVENT_TIMING.POSTPONED
  if (request.imported && (request.originalStatus ?? '').trim().toLowerCase() === COMPLETED) return EVENT_TIMING.DONE
  const last = request.eventEndDate || request.eventDate
  if (!last || request.eventDatePrecision === 'unset') return EVENT_TIMING.UNDATED
  if (/^\d{4}-\d{2}$/.test(last)) return last < today.slice(0, 7) ? EVENT_TIMING.DONE : EVENT_TIMING.UPCOMING
  return last < today ? EVENT_TIMING.DONE : EVENT_TIMING.UPCOMING
}

export const EVENT_TIMING_LABELS = {
  done: 'Done', upcoming: 'Upcoming', undated: 'Date not set', cancelled: 'Cancelled after confirmation', postponed: 'Postponed',
}

/** The pill a confirmed event shows: "Confirmed · Upcoming" (blue) · "Done" (green) · "Cancelled" (red, muted). */
export function eventPill(timing, status = EVENT_STATUS.CONFIRMED) {
  if (timing === EVENT_TIMING.DONE) return { kind: 'won', label: 'Done' }
  if (timing === EVENT_TIMING.CANCELLED) return { kind: 'lost', label: 'Cancelled' }
  if (timing === EVENT_TIMING.POSTPONED) return { kind: 'closed', label: 'Postponed' }
  if (status === EVENT_STATUS.INITIAL) return { kind: 'initial', label: 'Initially confirmed' }
  return { kind: 'turn', label: 'Confirmed · Upcoming' }
}

/** Today in Cairo as "YYYY-MM-DD" (the Events page decides Done / Upcoming by Cairo's date). */
export function cairoTodayISO(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** The date an event is filed under: its last day, else its start (a month), else when it was submitted. */
export function eventDay(request) {
  return request.eventEndDate || request.eventDate || request.submittedAt?.slice(0, 10) || null
}

export const EVENT_TABS = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
]

export const EVENT_PERIODS = [
  { id: 'all', label: 'Any time' },
  { id: 'year', label: 'This year' },
  { id: 'quarter', label: 'This quarter' },
  { id: 'month', label: 'This month' },
]

function inPeriod(day, period, today) {
  if (period === 'all' || !day) return true // an event without a date stays listed
  if (period === 'year') return day.slice(0, 4) === today.slice(0, 4)
  if (period === 'month') return day.slice(0, 7) === today.slice(0, 7)
  const quarter = (iso) => `${iso.slice(0, 4)}-Q${Math.ceil(Number(iso.slice(5, 7)) / 3)}`
  return quarter(day) === quarter(today)
}

/**
 * The Events page: Won requests this viewer may see (the caller passes only those), filtered and
 * sorted for one tab.
 *   filters: { brand, ownerId (BD "Mine"), period } · today: Cairo "YYYY-MM-DD"
 *   -> { rows: [{ request, timing }], counts: { upcoming, done, all }, doneThisYear }
 * Upcoming: soonest first, "Date not set" after the dated ones. Done and All won: newest first.
 * counts follow the filters; doneThisYear and counts.upcoming (the top line) ignore the period.
 */
export function eventsPage(requests, { tab = 'upcoming', brand = '', ownerId = '', period = 'all' } = {}, today) {
  const won = requests
    .map((request) => ({ request, timing: eventTiming(request, today) }))
    .filter((e) => e.timing && (!brand || e.request.brand === brand) && (!ownerId || e.request.bdOwner === ownerId))
  const isUpcoming = (e) => e.timing === EVENT_TIMING.UPCOMING || e.timing === EVENT_TIMING.UNDATED
  const doneThisYear = won.filter((e) => e.timing === EVENT_TIMING.DONE && eventDay(e.request)?.slice(0, 4) === today.slice(0, 4)).length
  const upcomingAll = won.filter(isUpcoming).length
  const shown = won.filter((e) => e.timing === EVENT_TIMING.UNDATED || inPeriod(eventDay(e.request), period, today))
  const counts = {
    upcoming: shown.filter(isUpcoming).length,
    done: shown.filter((e) => e.timing === EVENT_TIMING.DONE).length,
    cancelled: shown.filter((e) => e.timing === EVENT_TIMING.CANCELLED).length,
    all: shown.length,
  }
  const day = (e) => (e.timing === EVENT_TIMING.UNDATED ? null : eventDay(e.request))
  const byDay = (dir) => (a, b) => {
    const [x, y] = [day(a), day(b)]
    if (x === y) return a.request.id.localeCompare(b.request.id)
    if (!x) return 1 // no date: last
    if (!y) return -1
    return dir * x.localeCompare(y)
  }
  const rows = tab === 'upcoming' ? shown.filter(isUpcoming).sort(byDay(1))
    : tab === 'done' ? shown.filter((e) => e.timing === EVENT_TIMING.DONE).sort(byDay(-1))
      : [...shown].sort(byDay(-1))
  return { rows, counts, doneThisYear, upcoming: upcomingAll }
}

/**
 * The client page's Events tab: one row per submitted request for this client, newest first,
 * with Won / Lost / Open counts. A Won row's label is its event timing (Done · Upcoming · Date not set).
 */
export function clientEvents(requests, today) {
  const rows = requests
    .filter((r) => r.status !== PROPOSAL_STATUS.DRAFT)
    .map((request) => ({ request, timing: eventTiming(request, today) }))
    .sort((a, b) => (eventDay(b.request) ?? '').localeCompare(eventDay(a.request) ?? '') || b.request.id.localeCompare(a.request.id))
  const closedLost = [PROPOSAL_STATUS.REJECTED, PROPOSAL_STATUS.CANCELLED]
  return {
    rows,
    counts: {
      won: rows.filter((e) => e.request.status === PROPOSAL_STATUS.ACCEPTED).length,
      lost: rows.filter((e) => closedLost.includes(e.request.status)).length,
      open: rows.filter((e) => e.request.status !== PROPOSAL_STATUS.ACCEPTED && !closedLost.includes(e.request.status)
        && ![PROPOSAL_STATUS.CLOSED_UNRECORDED, PROPOSAL_STATUS.CLOSED_POSTPONED].includes(e.request.status)).length,
    },
  }
}


// ---------------------------------------------------------------------------
// Who sees a confirmed event, its price, and who manages it
// ---------------------------------------------------------------------------

const PRICE_ROLES = [ROLE.BUSINESS_DEVELOPMENT, ROLE.ACCOUNT_MANAGER, ROLE.COMMERCIAL_HEAD, ROLE.EXECUTIVE]

/**
 * A confirmed event: whoever may see the request, plus Marketing and Operations (both brands).
 * Unconfirmed proposals are never events.
 */
export function canSeeEvent(request, viewer, usersById = {}) {
  if (request.status !== PROPOSAL_STATUS.ACCEPTED) return false
  if (seesProposalData(viewer.activeRole)) return canSeeRequest(request, viewer, usersById)
  // HR (staffing): initially confirmed or confirmed events (done ones for ratings), nothing else.
  if (viewer.activeRole === ROLE.HR) return [EVENT_STATUS.INITIAL, EVENT_STATUS.CONFIRMED].includes(eventStatusOf(request))
  return [ROLE.MARKETING, ROLE.OPERATIONS].includes(viewer.activeRole)
}

/** The final price: BD, AM, the Commercial Head and Executives; never Marketing or Operations. */
export const canSeeEventPrice = (viewer) => PRICE_ROLES.includes(viewer.activeRole)

/** "Change date" and "Event cancelled": the BD owner (acting as BD) or the Commercial Head, while it is still on. */
export function canManageEvent(request, viewer, usersById = {}) {
  if (request.status !== PROPOSAL_STATUS.ACCEPTED) return { allowed: false, reason: 'Only confirmed events can be changed here.' }
  if (eventStatusOf(request) === EVENT_STATUS.CANCELLED) return { allowed: false, reason: 'This event was cancelled.' }
  if (viewer.activeRole === ROLE.COMMERCIAL_HEAD) return { allowed: true, reason: null }
  if (viewer.userId === request.bdOwner && actsAsBusinessDevelopment(viewer, usersById[viewer.userId])) return { allowed: true, reason: null }
  return { allowed: false, reason: 'Only the BD owner or the Commercial Head can change a confirmed event.' }
}

const realDay = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

/** "Change date": input = { eventDate, eventEndDate, note } -> { errors, values }. It stays Upcoming. */
export function validateEventDateChange(request, input = {}) {
  const values = {
    eventDate: input.eventDate ?? null,
    eventEndDate: input.eventEndDate === '' || input.eventEndDate === undefined ? null : input.eventEndDate,
    note: typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 300) : null,
  }
  const errors = {}
  if (!realDay(values.eventDate)) errors.eventDate = 'Enter the event date.'
  if (values.eventEndDate !== null) {
    if (!realDay(values.eventEndDate)) errors.eventEndDate = 'Enter a valid end date.'
    else if (!errors.eventDate && values.eventEndDate < values.eventDate) errors.eventEndDate = 'The end date cannot be before the start date.'
  }
  if (!Object.keys(errors).length && values.eventDate === request.eventDate && values.eventEndDate === (request.eventEndDate ?? null)) {
    errors.eventDate = 'Choose a different date.'
  }
  return { errors, values }
}

/** "Event cancelled": input = { reason, note } (reason from eventCancelReasons; a note for "other"). */
export function validateEventCancel(input = {}, lists) {
  const errors = {}
  const values = { reason: input.reason ?? null, note: typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null }
  if (!values.reason) errors.reason = 'Choose why it was cancelled.'
  else if (checkCodes(lists, 'eventCancelReasons', [values.reason], { multi: false })) errors.reason = 'Choose from the list.'
  else if (values.reason === OTHER && !values.note) errors.note = 'Add a note when choosing "Other".'
  if (values.note && values.note.length > 300) errors.note = 'Use at most 300 characters.'
  return { errors, values }
}

/** Confirmed upcoming · Done · Cancelled after confirmation (Home and Analytics). */
export function eventCounts(requests, today) {
  // upcoming = confirmed and still to come; initial = initially confirmed (counted apart); postponed apart too.
  const out = { upcoming: 0, initial: 0, done: 0, postponed: 0, cancelled: 0 }
  for (const r of requests) {
    const t = eventTiming(r, today)
    if (t === EVENT_TIMING.DONE) out.done += 1
    else if (t === EVENT_TIMING.CANCELLED) out.cancelled += 1
    else if (t === EVENT_TIMING.POSTPONED) out.postponed += 1
    else if (t && eventStatusOf(r) === EVENT_STATUS.INITIAL) out.initial += 1
    else if (t) out.upcoming += 1
  }
  return out
}


// ---------------------------------------------------------------------------
// Event status changes (BD owner or Commercial Head; never Operations)
// ---------------------------------------------------------------------------

/** Which event-status changes this viewer may make now: confirm · postpone · changeDate · cancel. */
export function eventActions(request, viewer, usersById = {}) {
  if (!canManageEvent(request, viewer, usersById).allowed) return []
  const status = eventStatusOf(request)
  return [
    ...([EVENT_STATUS.INITIAL, EVENT_STATUS.POSTPONED].includes(status) ? ['confirm'] : []),
    ...([EVENT_STATUS.INITIAL, EVENT_STATUS.CONFIRMED].includes(status) ? ['postpone'] : []),
    'changeDate',
    'cancel',
  ]
}

/** "Event postponed": a reason from the postponeWhy list (a note for "Other"); an optional new date. */
export function validateEventPostpone(input = {}, lists) {
  const errors = {}
  const values = { reason: input.reason ?? null, note: typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null }
  if (!values.reason) errors.reason = 'Choose why it was postponed.'
  else if (checkCodes(lists, 'postponeWhy', [values.reason], { multi: false })) errors.reason = 'Choose from the list.'
  else if (values.reason === OTHER && !values.note) errors.note = 'Add a note when choosing "Other".'
  if (values.note && values.note.length > 300) errors.note = 'Use at most 300 characters.'
  return { errors, values }
}

// ---------------------------------------------------------------------------
// The pipeline on the Operations page: awareness only
// ---------------------------------------------------------------------------

const PIPELINE = [PROPOSAL_STATUS.IN_PROGRESS, PROPOSAL_STATUS.AWAITING_BD_INFO, PROPOSAL_STATUS.REVISION_REQUESTED,
  PROPOSAL_STATUS.READY_FOR_BD, PROPOSAL_STATUS.SHARED_WITH_CLIENT]

/** The stage a pipeline row shows. */
export function pipelineStage(status) {
  if (status === PROPOSAL_STATUS.READY_FOR_BD) return 'Ready for BD'
  if (status === PROPOSAL_STATUS.SHARED_WITH_CLIENT) return 'With client'
  return 'In progress'
}

/** Proposals still being prepared or with the client. Marketing and Operations see them (no drafts, ever). */
export function canSeePipelineItem(request, viewer, usersById = {}) {
  if (!PIPELINE.includes(request.status) || request.needsReview) return false
  return viewer.activeRole === ROLE.OPERATIONS // the "Coming up (proposals)" tab: Operations only
}

/** The only fields a pipeline row carries: no price, no files, no conversation. */
export const PIPELINE_FIELDS = ['id', 'clientId', 'clientName', 'eventName', 'eventDate', 'eventEndDate', 'eventDatePrecision',
  'participants', 'brand', 'status']

export function pipelineItem(request, clientName = null) {
  return Object.fromEntries(PIPELINE_FIELDS.map((k) => [k, k === 'clientName' ? clientName ?? request.clientName ?? null : request[k] ?? null]))
}

// ---------------------------------------------------------------------------
// The Operations page: six sections, each soonest first (Done: newest first)
// ---------------------------------------------------------------------------

export const OPS_SECTIONS = [
  { id: 'week', label: 'This week' },
  { id: 'confirmed', label: 'Confirmed · Upcoming' },
  { id: 'initial', label: 'Initially confirmed' },
  { id: 'pipeline', label: 'In the pipeline' },
  { id: 'done', label: 'Done' },
  { id: 'off', label: 'Postponed / Cancelled' },
]
export const OPS_DONE_LIMIT = 20
/** The amber label on every Initially confirmed event (planning only). */
export const PRELIMINARY = 'Preliminary — not approved for execution'

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * events: the /api/events items (accepted requests); pipeline: the awareness rows. Filters: brand and
 * period (as on the events page). "This week" = confirmed or initially confirmed events overlapping the
 * next 7 days (today included). Done keeps the last OPS_DONE_LIMIT; `doneTotal` counts them all.
 */
export function operationsSections(events, pipeline, { brand = '', period = 'all' } = {}, today) {
  const keep = (r) => (!brand || r.brand === brand) && inPeriod(r.eventDate ? eventDay(r) : null, period, today)
  const rows = events.filter(keep).map((request) => ({ request, timing: eventTiming(request, today), status: eventStatusOf(request) }))
    .filter((e) => e.timing)
  const start = (r) => (r.eventDatePrecision === 'month' || !r.eventDate ? null : r.eventDate)
  const soonest = (a, b) => {
    const [x, y] = [start(a.request), start(b.request)]
    if (x === y) return a.request.id.localeCompare(b.request.id)
    if (!x) return 1
    if (!y) return -1
    return x.localeCompare(y)
  }
  const live = (e) => e.timing === EVENT_TIMING.UPCOMING || e.timing === EVENT_TIMING.UNDATED
  const weekEnd = addDays(today, 6)
  const inWeek = (e) => {
    const s = start(e.request)
    return Boolean(s) && s <= weekEnd && (e.request.eventEndDate || s) >= today
  }
  const done = rows.filter((e) => e.timing === EVENT_TIMING.DONE).sort((a, b) => soonest(b, a))
  return {
    week: rows.filter((e) => live(e) && inWeek(e)).sort(soonest),
    confirmed: rows.filter((e) => live(e) && e.status === EVENT_STATUS.CONFIRMED).sort(soonest),
    initial: rows.filter((e) => live(e) && e.status === EVENT_STATUS.INITIAL).sort(soonest),
    pipeline: pipeline.filter(keep).map((request) => ({ request, timing: null, status: null })).sort(soonest),
    done: done.slice(0, OPS_DONE_LIMIT),
    doneAll: done,
    doneTotal: done.length,
    off: rows.filter((e) => e.timing === EVENT_TIMING.POSTPONED || e.timing === EVENT_TIMING.CANCELLED).sort(soonest),
  }
}

// ---------------------------------------------------------------------------
// The Operations calendar: every confirmed and initially confirmed event with a date
// ---------------------------------------------------------------------------

/** Confirmed and initially confirmed events (upcoming, undated or done; never postponed or cancelled). Brand only: no period, no limit. */
export function calendarEvents(events, { brand = '' } = {}, today) {
  return events.filter((r) => !brand || r.brand === brand)
    .map((request) => ({ request, timing: eventTiming(request, today), status: eventStatusOf(request) }))
    .filter((e) => [EVENT_STATUS.CONFIRMED, EVENT_STATUS.INITIAL].includes(e.status) && e.timing && e.timing !== EVENT_TIMING.CANCELLED)
}

const plusDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * One month ('YYYY-MM') of the calendar: byDay { 'YYYY-MM-DD': [event] } for exact dates (every day a
 * multi-day event covers), and monthOnly: events dated only by this month ("Date not set this month").
 */
export function calendarMonth(rows, month) {
  const byDay = {}
  const monthOnly = []
  for (const e of rows) {
    const r = e.request
    if (!r.eventDate) continue
    if (r.eventDatePrecision === 'month') {
      if (r.eventDate.slice(0, 7) === month) monthOnly.push(e)
      continue
    }
    const end = r.eventEndDate && r.eventEndDate > r.eventDate ? r.eventEndDate : r.eventDate
    for (let d = r.eventDate, i = 0; d <= end && i < 62; d = plusDays(d, 1), i += 1) (byDay[d] ??= []).push(e)
  }
  return { byDay, monthOnly }
}

/** The count each Events page shows in the menu (Calendar has none). data: GET /api/events. */
export function eventSectionCounts(data, today) {
  const s = operationsSections(data?.items ?? [], data?.pipeline ?? [], {}, today)
  return { week: s.week.length, confirmed: s.confirmed.length, initial: s.initial.length, pipeline: s.pipeline.length,
    done: s.doneTotal, off: s.off.length }
}
