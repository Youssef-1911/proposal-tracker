/**
 * Proposal request lifecycle: THE single definition of every status change.
 * Framework-independent (no React, no store); the same rules can later move to
 * a FastAPI service unchanged in meaning.
 *
 * Components never decide workflow themselves; they ask getActions() what this
 * viewer may do and call applyAction() through the store.
 *
 * Who may act is checked by domain/permissions.js; who may view by
 * domain/proposals.js. This file only says which responsibility each step needs.
 */

import {
  LOST_REASONS_FOR_FORMS, LOST_REASON_OTHER, OPPORTUNITY_STAGE, PROPOSAL_STATUS as PS, SHARE_CHANNELS, getStatus,
} from './status.js'
import { ACTOR, canOpenRequestForm, checkActors, clientsForCreator } from './permissions.js'
import { getBrand } from './brands.js'
import { hasProposalFile } from './proposals.js'
import { canSeeRequest } from './access.js'
import { resolveAssignedAM } from './routing.js'
import { ROLE } from './roles.js'
import { DEFAULT_LISTS, LIST_DEFS, OTHER, checkCodes } from './lists.js'
import { isOpenRequest, openStatusIds, todayISO } from './metrics.js'

export const ACTION = {
  SUBMIT: 'submit',
  START_WORK: 'start_work',
  REQUEST_BD_INFO: 'request_bd_info',
  PROVIDE_BD_INFO: 'provide_bd_info',
  MARK_READY: 'mark_ready',
  SHARE_WITH_CLIENT: 'share_with_client',
  REQUEST_REVISION: 'request_revision',
  START_REVISION: 'start_revision',
  RECORD_ACCEPTED: 'record_accepted',
  RECORD_REJECTED: 'record_rejected',
  POSTPONE: 'postpone',
  RESUME: 'resume',
  REQUEST_CHANGES: 'request_changes',
  SET_OUTCOME_CONFIRMED: 'set_outcome_confirmed',
  SET_OUTCOME_LOST: 'set_outcome_lost',
  TAKE_BACK: 'take_back',
  CANCEL: 'cancel',
}

/**
 * from: statuses the action starts from · to: resulting status
 * actors: responsibilities allowed to perform it (any one is enough)
 * requires: inputs that must be provided
 *   note           non-empty text (notePrompt says what it is for)
 *   amPrice        whole EGP amount > 0
 *   newRequiredBy  ISO date, today or later
 *   confirmShared  explicit confirmation the proposal really reached the client
 *   channel        how it was sent, one of SHARE_CHANNELS (status.js)
 *   lostReason     one of LOST_REASONS_FOR_FORMS (status.js); a note is then required only for "other"
 *   followUpOn     ISO date, today or later (when BD follows up on a postponed proposal)
 * requiresFile: a proposal file must already be uploaded for the current version (else not allowed, 409).
 *   Imported requests are exempt (the 2026 sheet never had files or prices), and their price is optional.
 * changeNoteFromVersion: from this version on, a "what changed" note is required
 * completeRequest: the request's own fields must pass submit validation (validateRequestFields)
 * confirm: ask for confirmation before applying (consequential actions)
 * opportunity: effect on the linked opportunity (see opportunityEffect), with the history
 *   reason code recorded on the opportunity (reopenReasonCode when it leaves a closed stage)
 */
export const TRANSITIONS = [
  {
    action: ACTION.SUBMIT, label: 'Submit to Account Manager',
    from: [PS.DRAFT], to: PS.SUBMITTED, actors: [ACTOR.CREATOR],
    requires: {}, completeRequest: true,
    opportunity: { advanceTo: OPPORTUNITY_STAGE.PROPOSAL_REQUESTED, reasonCode: 'proposal_requested' },
  },
  {
    action: ACTION.START_WORK, label: 'Start work on proposal',
    from: [PS.SUBMITTED], to: PS.IN_PROGRESS, actors: [ACTOR.ASSIGNED_AM], requires: {},
  },
  {
    action: ACTION.REQUEST_BD_INFO, label: 'Ask BD for information',
    from: [PS.IN_PROGRESS], to: PS.AWAITING_BD_INFO, actors: [ACTOR.ASSIGNED_AM],
    // What's missing: chosen from the list, or written in the note (one of the two).
    requires: { reasons: 'whatsMissing' }, notePrompt: 'What information is missing?',
  },
  {
    action: ACTION.PROVIDE_BD_INFO, label: 'Send information to AM',
    from: [PS.AWAITING_BD_INFO], to: PS.SUBMITTED, actors: [ACTOR.BD_OWNER],
    requires: { note: true }, notePrompt: 'Your answer for the Account Manager',
  },
  {
    action: ACTION.MARK_READY, label: 'Mark Ready for BD',
    from: [PS.IN_PROGRESS], to: PS.READY_FOR_BD, actors: [ACTOR.ASSIGNED_AM],
    requires: { amPrice: true }, requiresFile: true, changeNoteFromVersion: 2,
  },
  {
    action: ACTION.SHARE_WITH_CLIENT, label: 'Record: shared with client',
    from: [PS.READY_FOR_BD], to: PS.SHARED_WITH_CLIENT, actors: [ACTOR.BD_OWNER],
    requires: { confirmShared: true, channel: true },
    opportunity: { advanceTo: OPPORTUNITY_STAGE.NEGOTIATION, reasonCode: 'proposal_shared' },
  },
  {
    action: ACTION.REQUEST_REVISION, label: 'Record: client wants a revision',
    from: [PS.SHARED_WITH_CLIENT], to: PS.REVISION_REQUESTED, actors: [ACTOR.BD_OWNER],
    requires: { reasons: 'whatShouldChange', newRequiredBy: true }, notePrompt: 'What does the client want changed?',
  },
  {
    // Before the client sees it: back to the AM as an "Internal change" (the next version starts with start_revision).
    action: ACTION.REQUEST_CHANGES, label: 'Request changes',
    from: [PS.READY_FOR_BD], to: PS.REVISION_REQUESTED, actors: [ACTOR.BD_OWNER],
    requires: { reasons: 'whatShouldChange' }, notePrompt: 'What should change?',
  },
  {
    // The AM reopens a ready proposal before it is shared: a new version, an "Internal change".
    action: ACTION.TAKE_BACK, label: 'Take back to edit',
    from: [PS.READY_FOR_BD], to: PS.IN_PROGRESS, actors: [ACTOR.ASSIGNED_AM],
    requires: {}, newVersion: true, notePrompt: 'Note (optional)',
  },
  {
    action: ACTION.START_REVISION, label: 'Start revised version',
    from: [PS.REVISION_REQUESTED], to: PS.IN_PROGRESS, actors: [ACTOR.ASSIGNED_AM],
    requires: {}, newVersion: true,
  },
  {
    action: ACTION.POSTPONE, label: 'Record: client postponed',
    from: [PS.SHARED_WITH_CLIENT], to: PS.POSTPONED, actors: [ACTOR.BD_OWNER],
    requires: { followUpOn: true, reasons: 'postponeWhy' }, notePrompt: 'Note (optional)',
  },
  {
    action: ACTION.RESUME, label: 'Record: back to awaiting reply',
    from: [PS.POSTPONED], to: PS.SHARED_WITH_CLIENT, actors: [ACTOR.BD_OWNER], requires: {},
  },
  {
    action: ACTION.RECORD_ACCEPTED, label: 'Mark confirmed',
    from: [PS.SHARED_WITH_CLIENT, PS.POSTPONED], to: PS.ACCEPTED, actors: [ACTOR.BD_OWNER],
    // Other open requests on the same opportunity are NOT changed; the result warns about them.
    // The event is confirmed: its date(s) are required; final participants, final price, venue and notes are optional.
    requires: { confirmEvent: true }, confirm: true, warnOtherOpenRequests: true,
    opportunity: {
      setTo: OPPORTUNITY_STAGE.WON, reasonCode: 'proposal_accepted', reopenReasonCode: 'reopened_after_acceptance',
    },
  },
  {
    // History without a result ("Closed · outcome not recorded"): set it once it is known.
    action: ACTION.SET_OUTCOME_CONFIRMED, label: 'Set outcome: Confirmed',
    from: [PS.CLOSED_UNRECORDED], to: PS.ACCEPTED, actors: [ACTOR.BD_OWNER, ACTOR.COMMERCIAL_HEAD],
    requires: { confirmEvent: true }, confirm: true,
    opportunity: {
      setTo: OPPORTUNITY_STAGE.WON, reasonCode: 'proposal_accepted', reopenReasonCode: 'reopened_after_acceptance',
    },
  },
  {
    action: ACTION.SET_OUTCOME_LOST, label: 'Set outcome: Lost',
    from: [PS.CLOSED_UNRECORDED], to: PS.REJECTED, actors: [ACTOR.BD_OWNER, ACTOR.COMMERCIAL_HEAD],
    requires: { lostReason: true }, notePrompt: 'Details (required for "Other")', confirm: true,
    opportunity: {
      setTo: OPPORTUNITY_STAGE.LOST, keepIfWon: true, unlessOtherOpenRequests: true, reasonCode: 'proposal_rejected',
    },
  },
  {
    action: ACTION.RECORD_REJECTED, label: 'Mark lost',
    from: [PS.SHARED_WITH_CLIENT, PS.POSTPONED], to: PS.REJECTED, actors: [ACTOR.BD_OWNER],
    // A lost reason from LOST_REASONS is required; the note is optional except for "Other".
    requires: { lostReason: true }, notePrompt: 'Details (required for "Other")', confirm: true,
    // A Won opportunity stays Won (the lost reason is kept on the request's history only).
    opportunity: {
      setTo: OPPORTUNITY_STAGE.LOST, keepIfWon: true, unlessOtherOpenRequests: true, reasonCode: 'proposal_rejected',
    },
  },
  {
    action: ACTION.CANCEL, label: 'Cancel request',
    from: openStatusIds(), to: PS.CANCELLED, actors: [ACTOR.BD_OWNER, ACTOR.COMMERCIAL_HEAD],
    requires: { note: true }, notePrompt: 'Reason for cancelling', confirm: true, tone: 'danger',
  },
]

export function getTransition(action) {
  return TRANSITIONS.find((t) => t.action === action) ?? null
}

/**
 * Actions that apply to the request's CURRENT status, each with
 * { allowed, reason }. Nothing is returned for viewers who cannot view the request.
 * viewer = { userId, activeRole }
 */
export function getActions(request, viewer, usersById = {}) {
  if (!canSeeRequest(request, viewer, usersById)) return []
  return TRANSITIONS.filter((t) => t.from.includes(request.status)).map((t) => {
    const permission = checkActors(t.actors, request, viewer, usersById)
    const blocked = permission.allowed ? preconditionFailure(t, request) : null
    return {
      ...t,
      ...(changeNoteRequired(t, request) ? { requires: { ...t.requires, note: true }, notePrompt: CHANGE_NOTE_PROMPT } : {}),
      allowed: permission.allowed && !blocked,
      reason: blocked ?? permission.reason,
    }
  })
}

export const CHANGE_NOTE_PROMPT = 'What changed in this version?'
const CHANGE_NOTE_ERROR = 'Describe what changed in this version, e.g. "Removed transport, price down EGP 40,000".'

/** Mark ready on version 2+ needs a short "what changed" note. */
function changeNoteRequired(t, request) {
  return Boolean(t.changeNoteFromVersion) && request.version >= t.changeNoteFromVersion
}

/** Why an otherwise permitted action cannot happen yet (409), or null. */
function preconditionFailure(t, request) {
  if (t.requiresFile && !request.imported && !hasProposalFile(request, request.version)) {
    return 'Upload the proposal file before marking it ready.'
  }
  return null
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const noPriceGiven = (v) => v === '' || v === null || v === undefined

const LIST_MULTI = Object.fromEntries(LIST_DEFS.map((d) => [d.id, d.multi]))

const blankInput = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
const trimmed = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/** "Mark confirmed": the checks on the event details (same messages as the server). */
export function confirmEventErrors(input = {}) {
  const errors = {}
  const start = input.eventDate
  const end = blankInput(input.eventEndDate) ? null : input.eventEndDate
  if (typeof start !== 'string' || !isRealDate(start)) errors.eventDate = 'Enter the event date.'
  if (end !== null) {
    if (typeof end !== 'string' || !isRealDate(end)) errors.eventEndDate = 'Enter a valid end date.'
    else if (!errors.eventDate && end < start) errors.eventEndDate = 'The end date cannot be before the start date.'
  }
  if (!blankInput(input.finalParticipants)) {
    const n = Number(input.finalParticipants)
    if (!Number.isInteger(n) || n <= 0) errors.finalParticipants = 'Enter a whole number of participants greater than 0.'
  }
  if (!blankInput(input.finalPrice)) {
    const n = Number(input.finalPrice)
    if (!Number.isInteger(n) || n < 0) errors.finalPrice = 'Enter the final price as a whole number of EGP.'
  }
  if (typeof input.venue === 'string' && input.venue.trim().length > 200) errors.venue = 'Use at most 200 characters.'
  if (typeof input.teamNotes === 'string' && input.teamNotes.trim().length > 1000) errors.teamNotes = 'Use at most 1000 characters.'
  if (!blankInput(input.eventStatus) && !['initial', 'confirmed'].includes(input.eventStatus)) {
    errors.eventStatus = 'Choose initially confirmed or confirmed.'
  }
  return errors
}

/** What "Mark confirmed" stores on the request. */
export function confirmedFields(input = {}) {
  return {
    eventDatePrecision: 'day', eventDate: input.eventDate, eventEndDate: blankInput(input.eventEndDate) ? null : input.eventEndDate,
    confirmedParticipants: blankInput(input.finalParticipants) ? null : Number(input.finalParticipants),
    finalPrice: blankInput(input.finalPrice) ? null : Number(input.finalPrice),
    venue: trimmed(input.venue, 200), teamNotes: trimmed(input.teamNotes, 1000),
    // "Initially confirmed": planning only (details or payment pending) · "Confirmed": go ahead.
    eventStatus: input.eventStatus === 'initial' ? 'initial' : 'confirmed',
  }
}

function validateInput(t, input, today, request, lists = DEFAULT_LISTS) {
  const errors = {}
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (t.requires.note && !note) errors.note = `${t.notePrompt ?? 'A note'} is required.`
  if (changeNoteRequired(t, request) && !note) errors.note = CHANGE_NOTE_ERROR
  const noPrice = noPriceGiven(input.amPrice)
  if (t.requires.amPrice && !(request.imported && noPrice)) { // imported requests may stay without a price
    const price = Number(input.amPrice)
    if (noPrice || !Number.isFinite(price)) {
      errors.amPrice = 'Enter the AM price in EGP.'
    } else if (!Number.isInteger(price) || price <= 0) {
      errors.amPrice = 'The AM price must be a whole number of EGP greater than 0.'
    }
  }
  if (t.requires.newRequiredBy) {
    const d = input.newRequiredBy
    if (typeof d !== 'string' || !isRealDate(d)) errors.newRequiredBy = 'Choose the new proposal deadline.'
    else if (d < today) errors.newRequiredBy = 'The new deadline cannot be in the past.'
  }
  if (t.requires.confirmShared && input.confirmShared !== true) {
    errors.confirmShared = 'Confirm that the proposal has actually been sent to the client.'
  }
  if (t.requires.channel && !SHARE_CHANNELS.some((c) => c.id === input.channel)) {
    errors.channel = 'Choose how the proposal was sent to the client.'
  }
  if (t.requires.followUpOn) {
    const d = input.followUpOn
    if (typeof d !== 'string' || !isRealDate(d)) errors.followUpOn = 'Choose when to follow up with the client.'
    else if (d < today) errors.followUpOn = 'The follow-up date cannot be in the past.'
  }
  if (t.requires.lostReason) {
    if (!LOST_REASONS_FOR_FORMS.some((r) => r.id === input.lostReason)) errors.lostReason = 'Choose why the proposal was lost.'
    else if (input.lostReason === LOST_REASON_OTHER && !note) errors.note = 'Describe the reason when choosing "Other".'
  }
  if (t.requires.confirmEvent) Object.assign(errors, confirmEventErrors(input))
  if (t.requires.reasons) {
    const codes = input.reasons ?? []
    const multi = LIST_MULTI[t.requires.reasons]
    const problem = Array.isArray(codes) && codes.length === 0 ? null : checkCodes(lists, t.requires.reasons, codes, { multi })
    if (problem) errors.reasons = problem
    else if (multi && codes.length === 0 && !note) errors.note = `${t.notePrompt ?? 'A note'} is required.` // the list or the note
    else if (codes.includes(OTHER) && !note) errors.note = 'Describe "Other" in the note.'
  }
  return { errors, note: note || null }
}

// ---------------------------------------------------------------------------
// Opportunity effects
// ---------------------------------------------------------------------------

const stageOrder = (stage) => getStatus('opportunity', stage).order

/** Other OPEN requests on the same opportunity (never the request itself). */
function otherOpenRequests(request, opportunityId, allRequests) {
  return allRequests.filter((r) => r.opportunityId === opportunityId && r.id !== request.id && isOpenRequest(r))
}

/**
 * Returns { stage, reasonCode, message } for the linked opportunity, or null for no change
 * (stage null = deliberately unchanged, with a message saying why).
 * t.opportunity:
 *   { advanceTo }                         move forward only; never reopen a closed opportunity
 *   { setTo }                             set the stage (Accepted -> Won)
 *   { setTo, unlessOtherOpenRequests }    set it only if no other request for it is open (Rejected -> Lost)
 * reasonCode is the opportunity history reason; leaving a closed stage uses reopenReasonCode if set.
 */
function opportunityEffect(t, request, opportunity, allRequests) {
  const rule = t.opportunity
  if (!rule || !opportunity) return null
  const current = opportunity.stage
  const label = (stage) => getStatus('opportunity', stage).label
  const closed = getStatus('opportunity', current).closed

  if (rule.advanceTo) {
    if (closed || stageOrder(current) >= stageOrder(rule.advanceTo)) return null
    return {
      stage: rule.advanceTo, reasonCode: rule.reasonCode,
      message: `Opportunity ${opportunity.id} moved to ${label(rule.advanceTo)}.`,
    }
  }
  if (rule.keepIfWon && current === OPPORTUNITY_STAGE.WON) {
    return { stage: null, reasonCode: null, message: `Opportunity ${opportunity.id} stays Won.` }
  }
  if (rule.unlessOtherOpenRequests) {
    const otherOpen = otherOpenRequests(request, opportunity.id, allRequests)
    if (otherOpen.length) {
      return {
        stage: null, reasonCode: null,
        message: `Opportunity ${opportunity.id} stays ${label(current)}: ${otherOpen.map((r) => r.id).join(', ')} is still open.`,
      }
    }
  }
  if (rule.setTo) {
    if (current === rule.setTo) return null
    return {
      stage: rule.setTo, reasonCode: (closed && rule.reopenReasonCode) || rule.reasonCode,
      message: `Opportunity ${opportunity.id} marked ${label(rule.setTo)}.`,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Failure codes (the API maps them to HTTP statuses):
 *   not_found 404 · unknown_action 422 · invalid_transition 409 · forbidden 403 ·
 *   precondition 409 (e.g. no proposal file yet) · validation 422
 */
export const FAILURE = {
  NOT_FOUND: 'not_found',
  UNKNOWN_ACTION: 'unknown_action',
  INVALID_TRANSITION: 'invalid_transition',
  FORBIDDEN: 'forbidden',
  PRECONDITION: 'precondition',
  VALIDATION: 'validation',
}

/**
 * Validates and applies one action. Pure: returns new objects, never mutates.
 *
 * ctx = { viewer, usersById, opportunities, allRequests, clients, now: Date }
 * -> { ok: true, request, opportunity (updated or null), opportunityChange, warnings, message }
 *      opportunityChange = { id, from, to, reasonCode, lostReason } | null
 *      warnings = [{ code, message, requests: [{ id, status, bdOwner }] }]
 * -> { ok: false, code (FAILURE), error, errors: { field: message } }
 */
export function applyAction(request, action, input = {}, ctx) {
  const { viewer, usersById = {}, opportunities = [], allRequests = [], now = new Date() } = ctx
  const fail = (code, error, errors = {}) => ({ ok: false, code, error, errors })
  // Someone else's draft is reported exactly like a request that does not exist.
  if (!canSeeRequest(request, viewer, usersById)) return fail(FAILURE.NOT_FOUND, `Request ${request.id} not found.`)
  const t = getTransition(action)
  if (!t) return fail(FAILURE.UNKNOWN_ACTION, `Unknown action "${action}".`, { action: 'Unknown action.' })

  if (!t.from.includes(request.status)) {
    return fail(
      FAILURE.INVALID_TRANSITION,
      `"${t.label}" is not possible while the request is ${getStatus('proposal', request.status).label}.`,
    )
  }

  const permission = checkActors(t.actors, request, viewer, usersById)
  if (!permission.allowed) return fail(FAILURE.FORBIDDEN, permission.reason)
  const blocked = preconditionFailure(t, request)
  if (blocked) return fail(FAILURE.PRECONDITION, blocked)

  const { errors, note } = validateInput(t, input, todayISO(now), request, ctx.lists ?? DEFAULT_LISTS)
  if (Object.keys(errors).length) return fail(FAILURE.VALIDATION, 'Please fix the highlighted fields.', errors)

  // Submitting needs a complete, valid request (the same rules as the request form).
  if (t.completeRequest) {
    const check = validateRequestFields(requestFields(request), {
      mode: 'submit', today: todayISO(now), clients: ctx.clients, opportunities: ctx.opportunities,
    })
    if (Object.keys(check.errors).length) {
      return fail(FAILURE.VALIDATION, 'Complete the request before submitting it.', check.errors)
    }
  }

  const changedAt = now.toISOString()
  const version = t.newVersion ? request.version + 1 : request.version
  const entry = {
    status: t.to,
    changedBy: viewer.userId,
    role: viewer.activeRole,
    changedAt,
    note,
    version,
  }
  // Any workflow action clears "Needs review" (someone has now looked at the imported request).
  // Any workflow action also returns "Waiting on" to automatic (a status change moves it on).
  const next = { ...request, status: t.to, lastUpdated: changedAt, version, needsReview: false, waiting: null }

  if (action === ACTION.SUBMIT) {
    if (viewer.userId !== request.bdOwner) entry.onBehalfOf = request.bdOwner
    next.submittedAt = request.submittedAt ?? changedAt
    next.submittedBy = request.submittedBy ?? viewer.userId
  }
  if (action === ACTION.MARK_READY) {
    const price = noPriceGiven(input.amPrice) ? null : Number(input.amPrice) // null only for imported requests
    entry.amPrice = price
    next.amPrice = price
  }
  if (action === ACTION.POSTPONE) {
    entry.followUpOn = input.followUpOn
    next.followUpOn = input.followUpOn
  }
  if (request.status === PS.POSTPONED && t.to !== PS.POSTPONED) next.followUpOn = null
  if (action === ACTION.START_REVISION || action === ACTION.TAKE_BACK) {
    // The previous version's price stays in history; the new version has no price until Ready.
    next.amPrice = null
  }
  if (action === ACTION.REQUEST_REVISION) {
    entry.previousRequiredBy = request.requiredBy
    entry.requiredBy = input.newRequiredBy
    next.requiredBy = input.newRequiredBy
  }
  if (t.requires.lostReason) entry.lostReason = input.lostReason
  if (t.requires.channel) entry.channel = input.channel
  if (t.requires.reasons && input.reasons?.length) entry.reasons = [...input.reasons]
  if (t.requires.confirmEvent) Object.assign(next, confirmedFields(input)) // kept on the request, not in its history entry
  next.statusHistory = [...request.statusHistory, entry]

  const opportunity = request.opportunityId ? opportunities.find((o) => o.id === request.opportunityId) : null
  const effect = opportunityEffect(t, request, opportunity, allRequests)
  // A Lost opportunity carries the chosen lost reason; any other stage clears it (history keeps it).
  const lostReason = effect?.stage === OPPORTUNITY_STAGE.LOST ? input.lostReason : null
  const updatedOpportunity = effect?.stage ? { ...opportunity, stage: effect.stage, lostReason } : null
  const opportunityChange = effect?.stage
    ? { id: opportunity.id, from: opportunity.stage, to: effect.stage, reasonCode: effect.reasonCode, lostReason }
    : null

  // Mark won: other open requests on the opportunity are left alone, but reported.
  const warnings = []
  if (t.warnOtherOpenRequests && opportunity) {
    const others = otherOpenRequests(request, opportunity.id, allRequests)
    if (others.length) {
      warnings.push({
        code: 'other_open_requests',
        message: `Opportunity ${opportunity.id} is Won, but ${others.map((r) => r.id).join(', ')} ${others.length === 1 ? 'is' : 'are'} still open. Nothing was changed on ${others.length === 1 ? 'it' : 'them'}; cancel ${others.length === 1 ? 'it' : 'them'} if no longer needed.`,
        requests: others.map((r) => ({ id: r.id, status: r.status, bdOwner: r.bdOwner })),
      })
    }
  }

  const message = [`${request.id} is now ${getStatus('proposal', t.to).label}.`, effect?.message].filter(Boolean).join(' ')
  return { ok: true, request: next, opportunity: updatedOpportunity, opportunityChange, warnings, message }
}

// ---------------------------------------------------------------------------
// Request fields: create, edit, and completeness for submission
// ---------------------------------------------------------------------------

/** The optional event name on a request (and its opportunity), e.g. "Summer team day". */
export const EVENT_NAME_MAX = 80

/** Exact date (with an optional end date), month only, or not set yet. */
export const EVENT_DATE_PRECISION = { DAY: 'day', MONTH: 'month', UNSET: 'unset' }

const FIELD_LABELS = {
  clientId: 'Client', brand: 'Brand', service: 'Service', eventDate: 'Event date',
  requiredBy: 'Proposal deadline', participants: 'Expected participants', requirementsSummary: 'Event brief',
}
const ALWAYS_REQUIRED = ['clientId', 'brand', 'service']
const SUBMIT_REQUIRED = [...ALWAYS_REQUIRED, 'eventDate', 'requiredBy', 'participants', 'requirementsSummary']

function isRealDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

function isRealMonth(ym) {
  if (!/^\d{4}-\d{2}$/.test(ym)) return false
  const m = Number(ym.slice(5))
  return m >= 1 && m <= 12
}

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

/** Trims strings, turns blanks into null, participants into a number. */
export function normalizeRequestFields(input = {}) {
  const text = (v) => (blank(v) ? null : String(v).trim())
  const precision = [EVENT_DATE_PRECISION.MONTH, EVENT_DATE_PRECISION.UNSET].includes(input.eventDatePrecision)
    ? input.eventDatePrecision : EVENT_DATE_PRECISION.DAY
  return {
    clientId: text(input.clientId),
    brand: text(input.brand),
    service: text(input.service),
    opportunityId: text(input.opportunityId),
    eventName: text(input.eventName), // optional, e.g. "Ramadan Iftar Riders – Alex"
    eventDatePrecision: precision,
    // "Not set yet" has no date; an end date exists only for an exact start date.
    eventDate: precision === EVENT_DATE_PRECISION.UNSET ? null : text(input.eventDate),
    eventEndDate: precision === EVENT_DATE_PRECISION.DAY ? text(input.eventEndDate) : null,
    requiredBy: text(input.requiredBy),
    participants: blank(input.participants) ? null : Number(input.participants),
    requirementsSummary: text(input.requirementsSummary),
    specificRequirements: text(input.specificRequirements),
    // Optional quick tags (codes from the "briefTags" list); the brief itself stays free text.
    briefTags: input.briefTags === undefined || input.briefTags === null ? [] : input.briefTags,
  }
}

/** First day the event could take place: the day itself, or the 1st of the month. */
export function eventStartDate(eventDate, precision) {
  if (!eventDate) return null
  return precision === EVENT_DATE_PRECISION.MONTH ? `${eventDate}-01` : eventDate
}

/**
 * THE validation for request fields.
 * mode 'draft': client, brand and service required; anything else entered must still be valid.
 * mode 'submit': all request fields required (specific requirements and opportunity stay optional).
 * Lists in options (clients, opportunities) enable the relational checks.
 * -> { errors: { field: message }, values }
 */
export function validateRequestFields(input, { mode = 'draft', today, clients, opportunities, lists = DEFAULT_LISTS } = {}) {
  const v = normalizeRequestFields(input)
  const errors = {}
  const required = mode === 'submit' ? SUBMIT_REQUIRED : ALWAYS_REQUIRED
  for (const f of required) {
    if (f === 'eventDate' && v.eventDatePrecision === EVENT_DATE_PRECISION.UNSET) continue // "Not set yet" is an answer
    if (blank(v[f])) errors[f] = f === 'eventDate' ? 'Enter the event date, or choose "Not set yet".' : `${FIELD_LABELS[f]} is required.`
  }

  if (v.clientId && clients && !clients.some((c) => c.id === v.clientId)) errors.clientId = 'Choose a client from the list.'
  const brand = v.brand ? getBrand(v.brand) : null
  if (v.brand && !brand) errors.brand = 'Choose Grasshoppers or Team Up.'
  if (v.service && brand && !brand.services.some((s) => s.id === v.service)) {
    errors.service = `Choose a ${brand.name} service.`
  }

  if (v.opportunityId && opportunities) {
    const opp = opportunities.find((o) => o.id === v.opportunityId)
    if (!opp || opp.clientId !== v.clientId || opp.brand !== v.brand || getStatus('opportunity', opp.stage).closed) {
      errors.opportunityId = 'Choose an open opportunity for this client and brand, or none.'
    }
  }

  // Event date: exact day or month + year, not in the past.
  if (v.eventDate) {
    if (v.eventDatePrecision === EVENT_DATE_PRECISION.MONTH) {
      if (!isRealMonth(v.eventDate)) errors.eventDate = 'Enter a valid month and year.'
      else if (v.eventDate < today.slice(0, 7)) errors.eventDate = 'The event month cannot be in the past.'
    } else if (!isRealDate(v.eventDate)) errors.eventDate = 'Enter a valid event date.'
    else if (v.eventDate < today) errors.eventDate = 'The event date cannot be in the past.'
  }
  if (v.eventEndDate) {
    if (!v.eventDate) errors.eventEndDate = 'Enter the start date first.'
    else if (!isRealDate(v.eventEndDate)) errors.eventEndDate = 'Enter a valid end date.'
    else if (!errors.eventDate && v.eventEndDate < v.eventDate) errors.eventEndDate = 'The end date cannot be before the start date.'
  }

  // Proposal deadline: a real date, today or later, and before the event starts.
  if (v.requiredBy) {
    const start = !errors.eventDate ? eventStartDate(v.eventDate, v.eventDatePrecision) : null
    if (!isRealDate(v.requiredBy)) errors.requiredBy = 'Enter a valid proposal deadline.'
    else if (v.requiredBy < today) errors.requiredBy = 'The proposal deadline cannot be in the past.'
    else if (start && v.requiredBy >= start) {
      errors.requiredBy =
        v.eventDatePrecision === EVENT_DATE_PRECISION.MONTH
          ? 'The proposal deadline must be before the first day of the event month.'
          : 'The proposal deadline must be before the event date.'
    }
  }

  if (v.eventName && v.eventName.length > EVENT_NAME_MAX) errors.eventName = `Use at most ${EVENT_NAME_MAX} characters.`
  if (v.briefTags.length || !Array.isArray(v.briefTags)) {
    const problem = checkCodes(lists, 'briefTags', v.briefTags, { multi: true })
    if (problem) errors.briefTags = problem
  }

  if (v.participants !== null && (!Number.isInteger(v.participants) || v.participants <= 0)) {
    errors.participants = 'Enter a whole number of participants greater than 0.'
  }

  return { errors, values: v }
}

/** Fields of an existing request in the shape validateRequestFields expects. */
export function requestFields(request) {
  return {
    clientId: request.clientId,
    brand: request.brand,
    service: request.service,
    opportunityId: request.opportunityId,
    eventName: request.eventName ?? null,
    eventDatePrecision: request.eventDatePrecision,
    eventDate: request.eventDate,
    eventEndDate: request.eventEndDate ?? null,
    requiredBy: request.requiredBy,
    participants: request.participants,
    requirementsSummary: request.requirementsSummary,
    specificRequirements: request.specificRequirements,
    briefTags: request.briefTags ?? [],
  }
}

/** Open requests that look like the same request (client, brand, service, event date). Warn, don't block. */
export function findPossibleDuplicates(input, allRequests, excludeId = null) {
  const v = normalizeRequestFields(input)
  if (!v.clientId || !v.brand || !v.service || !v.eventDate) return []
  return allRequests.filter(
    (r) =>
      r.id !== excludeId && isOpenRequest(r) && r.clientId === v.clientId && r.brand === v.brand &&
      r.service === v.service && r.eventDate === v.eventDate,
  )
}

/** Next "PR-YYYY-NNNN" id for the year of `now`. */
export function nextRequestId(existing, now = new Date()) {
  const year = now.getFullYear()
  const prefix = `PR-${year}-`
  const max = existing
    .filter((r) => r.id.startsWith(prefix))
    .reduce((m, r) => Math.max(m, Number(r.id.slice(prefix.length)) || 0), 0)
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

/** Shared checks for create and edit: may this viewer create requests, and for this client? */
function checkCreator(values, ctx) {
  const { viewer, clients = [], usersById = {} } = ctx
  const access = canOpenRequestForm(viewer, usersById)
  if (!access.allowed) return { error: access.reason }
  const client = clients.find((c) => c.id === values.clientId)
  if (client && !clientsForCreator(viewer, clients, usersById).some((c) => c.id === client.id)) {
    return { error: 'You can only create requests for clients you own.', errors: { clientId: 'Not one of your clients.' } }
  }
  return { client }
}

/**
 * Creates a Draft (private to its creator). bdOwner is ALWAYS the client's relationship
 * owner; assignedAM always comes from brand routing.
 * ctx = { viewer, clients, opportunities, allRequests, usersById, routing, now } (routing: brand -> AM; today's default when absent)
 */
export function createDraft(input, ctx) {
  const { viewer, clients = [], opportunities = [], allRequests = [], now = new Date() } = ctx
  const { errors, values } = validateRequestFields(input, { mode: 'draft', today: todayISO(now), clients, opportunities })
  const who = checkCreator(values, ctx)
  if (who.error) return { ok: false, error: who.error, errors: { ...errors, ...who.errors } }
  if (Object.keys(errors).length) return { ok: false, error: 'Please fix the highlighted fields.', errors }

  const changedAt = now.toISOString()
  const entry = { status: PS.DRAFT, changedBy: viewer.userId, role: viewer.activeRole, changedAt, note: null, version: 1 }
  if (viewer.userId !== who.client.owner) entry.onBehalfOf = who.client.owner

  const request = {
    id: nextRequestId(allRequests, now),
    ...values,
    bdOwner: who.client.owner,
    createdBy: viewer.userId,
    assignedAM: resolveAssignedAM(values.brand, ctx.routing),
    status: PS.DRAFT,
    submittedAt: null,
    submittedBy: null,
    lastUpdated: changedAt,
    amPrice: null,
    version: 1,
    priceChange: null,
    statusHistory: [entry],
  }
  return { ok: true, request, message: `${request.id} saved as a draft. Only you can see it until it is submitted.` }
}

/**
 * Edits a Draft in place (same id; never creates a new record). Only its creator, acting
 * in a role allowed to create it. Status and history are unchanged; lastUpdated moves.
 */
export function updateDraft(request, input, ctx) {
  const { viewer, clients = [], opportunities = [], usersById = {}, now = new Date() } = ctx
  if (request.status !== PS.DRAFT) return { ok: false, error: 'Only drafts can be edited.', errors: {} }
  const permission = checkActors([ACTOR.CREATOR], request, viewer, usersById)
  if (!permission.allowed) return { ok: false, error: permission.reason, errors: {} }

  const { errors, values } = validateRequestFields(input, { mode: 'draft', today: todayISO(now), clients, opportunities })
  const who = checkCreator(values, ctx)
  if (who.error) return { ok: false, error: who.error, errors: { ...errors, ...who.errors } }
  if (Object.keys(errors).length) return { ok: false, error: 'Please fix the highlighted fields.', errors }

  const next = {
    ...request,
    ...values,
    bdOwner: who.client.owner,
    assignedAM: resolveAssignedAM(values.brand, ctx.routing),
    lastUpdated: now.toISOString(),
  }
  return { ok: true, request: next, message: `${request.id} draft saved. Only you can see it until it is submitted.` }
}

/** May this viewer edit this draft? (Only drafts, only their creator in a creating role.) */
export function canEditDraft(request, viewer, usersById = {}) {
  return request.status === PS.DRAFT && checkActors([ACTOR.CREATOR], request, viewer, usersById).allowed
}

/**
 * Save a draft (create, or edit draftId) and optionally submit it, as ONE operation.
 * Pure: takes the current collections, returns the new ones. Nothing is returned to save
 * unless every step passes, so a failed submit never leaves a half-made record.
 *
 * state = { proposalRequests, opportunities, clients, users }
 * -> { ok: true, request, message, proposalRequests, opportunities } | { ok: false, error, errors }
 */
export function saveRequest(state, input, { draftId = null, submit = false } = {}, { viewer, now = new Date() }) {
  const ctx = {
    viewer,
    usersById: Object.fromEntries(state.users.map((u) => [u.id, u])),
    clients: state.clients,
    opportunities: state.opportunities,
    allRequests: state.proposalRequests,
    now,
  }

  let saved
  if (draftId) {
    const existing = state.proposalRequests.find((r) => r.id === draftId)
    if (!existing) return { ok: false, error: `Draft ${draftId} not found.`, errors: {} }
    saved = updateDraft(existing, input, ctx)
  } else {
    saved = createDraft(input, ctx)
  }

  // When submitting, report every missing/invalid field at once (not just the draft minimum).
  if (submit) {
    const full = validateRequestFields(input, {
      mode: 'submit', today: todayISO(now), clients: state.clients, opportunities: state.opportunities,
    })
    const fieldErrors = { ...full.errors, ...(saved.ok ? {} : saved.errors) }
    if (Object.keys(fieldErrors).length) {
      return { ok: false, error: saved.ok ? 'Please fix the highlighted fields.' : saved.error, errors: fieldErrors }
    }
  }
  if (!saved.ok) return saved

  let request = saved.request
  let opportunity = null
  let message = saved.message
  const withDraft = draftId
    ? state.proposalRequests.map((r) => (r.id === draftId ? request : r))
    : [...state.proposalRequests, request]

  if (submit) {
    const submitted = applyAction(request, ACTION.SUBMIT, {}, { ...ctx, allRequests: withDraft })
    if (!submitted.ok) return submitted
    request = submitted.request
    opportunity = submitted.opportunity
    message = submitted.message
  }

  return {
    ok: true,
    request,
    message,
    proposalRequests: withDraft.map((r) => (r.id === request.id ? request : r)),
    opportunities: opportunity
      ? state.opportunities.map((o) => (o.id === opportunity.id ? opportunity : o))
      : state.opportunities,
  }
}
