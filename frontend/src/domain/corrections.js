/**
 * Data fixes, outside the normal step-by-step workflow (which stays the way to move new work forward):
 *
 *   "Correct status (data fix)": jump straight to the right status. Noha always; the BD owner (acting as
 *   BD) and the assigned AM (acting as AM) on their own requests. Recorded as "Status corrected from X to
 *   Y" (by that person), never notifies anyone, and voids the outcome it replaces in the numbers.
 *
 *   "Add past proposal or event": a record from before IEE, its history built from the dates entered,
 *   marked "Added manually — before IEE". No notifications; counted in all numbers like any other record.
 *
 * Pure rules; the backend (app/domain/corrections.py) gives the same answers (contract: correctionCases).
 */

import { actsAsBusinessDevelopment } from './access.js'
import { getBrand } from './brands.js'
import { ROLE } from './roles.js'
import { LOST_REASONS, PROPOSAL_STATUS as PS } from './status.js'
import { confirmEventErrors } from './workflow.js'

export const CORRECTED_NOTE = 'Status corrected'
export const PAST_NOTE = 'Added manually — before IEE'
const NOTE_MAX = 300

/** The plain-word statuses a correction can jump to. */
export const CORRECTION_TARGETS = [
  { id: 'with_am', label: 'With AM', status: PS.IN_PROGRESS },
  { id: 'waiting_bd', label: 'Waiting for BD', status: PS.AWAITING_BD_INFO },
  { id: 'ready', label: 'Ready for BD', status: PS.READY_FOR_BD },
  { id: 'with_client', label: 'With client', status: PS.SHARED_WITH_CLIENT },
  { id: 'postponed', label: 'Postponed', status: PS.POSTPONED },
  { id: 'initial', label: 'Initially confirmed', status: PS.ACCEPTED, eventStatus: 'initial' },
  { id: 'confirmed', label: 'Confirmed', status: PS.ACCEPTED, eventStatus: 'confirmed' },
  { id: 'lost', label: 'Lost', status: PS.REJECTED },
  { id: 'cancelled', label: 'Cancelled', status: PS.CANCELLED },
]
export const CORRECTION_TARGET_IDS = CORRECTION_TARGETS.map((t) => t.id)

/** The request's status in the same plain words ("With client", "Initially confirmed", …). */
export function plainStatus(r) {
  if ([PS.SUBMITTED, PS.IN_PROGRESS, PS.REVISION_REQUESTED].includes(r.status)) return 'With AM'
  if (r.status === PS.ACCEPTED) return r.eventStatus === 'initial' ? 'Initially confirmed' : 'Confirmed'
  if (r.status === PS.CLOSED_UNRECORDED) return 'Closed · not recorded'
  if (r.status === PS.CLOSED_POSTPONED) return 'Closed · postponed'
  return CORRECTION_TARGETS.find((t) => t.status === r.status)?.label ?? r.status
}

/** The opportunity stage that matches a status (corrections and past records keep the two in step). */
export function stageForStatus(status) {
  if (status === PS.ACCEPTED) return 'won'
  if (status === PS.REJECTED) return 'lost'
  if (status === PS.CANCELLED) return 'closed_no_result'
  if ([PS.SHARED_WITH_CLIENT, PS.POSTPONED].includes(status)) return 'negotiation'
  return 'proposal_requested'
}

const ok = { allowed: true, reason: null }
const deny = (reason) => ({ allowed: false, reason })

/** "Correct status (data fix)": Noha always; the BD owner and the assigned AM on their own requests. Never a draft. */
export function canCorrectStatus(r, viewer, usersById = {}) {
  if (r.status === PS.DRAFT) return deny('A draft has no status to correct yet.')
  if (viewer.activeRole === ROLE.COMMERCIAL_HEAD) return ok
  if (viewer.userId === r.bdOwner && actsAsBusinessDevelopment(viewer, usersById[viewer.userId])) return ok
  if (viewer.userId === r.assignedAM && viewer.activeRole === ROLE.ACCOUNT_MANAGER) return ok
  return deny('Only the Commercial Head, the BD owner or the assigned Account Manager can correct the status.')
}

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
function isRealDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}
const LOST_IDS = LOST_REASONS.filter((x) => !x.importOnly).map((x) => x.id)

/**
 * input = { target, followUpOn, eventDate, eventEndDate, finalPrice, finalParticipants, lostReason, note }
 * -> { errors, values: { target, status, eventStatus, followUpOn, eventDate, eventEndDate, finalPrice,
 *      finalParticipants, lostReason, note, from, to } }
 */
export function validateCorrection(input = {}, r) {
  const errors = {}
  const t = CORRECTION_TARGETS.find((x) => x.id === input.target)
  const values = {
    target: t?.id ?? null, status: t?.status ?? null, eventStatus: t?.eventStatus ?? null,
    followUpOn: null, eventDate: null, eventEndDate: null, finalPrice: null, finalParticipants: null, lostReason: null,
    note: text(input.note), from: plainStatus(r), to: t?.label ?? null,
  }
  if (!t) {
    errors.target = 'Choose the right status.'
    return { errors, values }
  }
  if (t.label === values.from) errors.target = `It is already ${t.label}.`
  if (t.id === 'postponed') {
    if (!isRealDay(input.followUpOn)) errors.followUpOn = 'Enter the follow-up date.'
    else values.followUpOn = input.followUpOn
  }
  if (t.status === PS.ACCEPTED) {
    const event = { eventDate: input.eventDate, eventEndDate: input.eventEndDate, finalPrice: input.finalPrice,
      finalParticipants: input.finalParticipants }
    Object.assign(errors, confirmEventErrors(event))
    const blank = (v) => v === null || v === undefined || v === ''
    values.eventDate = input.eventDate ?? null
    values.eventEndDate = blank(input.eventEndDate) ? null : input.eventEndDate
    values.finalPrice = blank(input.finalPrice) ? null : Number(input.finalPrice)
    values.finalParticipants = blank(input.finalParticipants) ? null : Number(input.finalParticipants)
  }
  if (t.id === 'lost') {
    if (!input.lostReason) errors.lostReason = 'Choose why it was lost.'
    else if (!LOST_IDS.includes(input.lostReason)) errors.lostReason = 'Choose a reason from the list.'
    else values.lostReason = input.lostReason
  }
  if (values.note && values.note.length > NOTE_MAX) errors.note = `Use at most ${NOTE_MAX} characters.`
  return { errors, values }
}

/** The history line: "Status corrected from With client to Lost — the note". */
export function correctionNote(values) {
  return `${CORRECTED_NOTE} from ${values.from} to ${values.to}${values.note ? ` — ${values.note}` : ''}`
}

// ---------------------------------------------------------------------------
// "Add past proposal or event"
// ---------------------------------------------------------------------------

export const PAST_OUTCOMES = [
  { id: 'with_client', label: 'With client', status: PS.SHARED_WITH_CLIENT },
  { id: 'postponed', label: 'Postponed', status: PS.POSTPONED },
  { id: 'confirmed', label: 'Confirmed (event to come)', status: PS.ACCEPTED },
  { id: 'done', label: 'Done (event took place)', status: PS.ACCEPTED },
  { id: 'lost', label: 'Lost', status: PS.REJECTED },
  { id: 'cancelled', label: 'Cancelled', status: PS.CANCELLED },
]

/** Who may add a past record: Noha; BD (for their own clients); Account Managers (for their brand). */
export function canAddPastRecord(viewer, { client = null, brand = null } = {}, usersById = {}) {
  const me = usersById[viewer.userId]
  if (viewer.activeRole === ROLE.COMMERCIAL_HEAD) return ok
  if (actsAsBusinessDevelopment(viewer, me)) {
    return !client || client.owner === viewer.userId ? ok : deny('You can add past records for your own clients only.')
  }
  if (viewer.activeRole === ROLE.ACCOUNT_MANAGER) {
    return !brand || !me?.brand || me.brand === brand ? ok : deny('You can add past records for your brand only.')
  }
  return deny('Only the Commercial Head, Business Development or Account Managers can add past records.')
}

/**
 * input = { brand, service, bdOwner, assignedAM, eventName, briefDate, sentDate, eventDate, eventEndDate,
 *   participants, outcome, amPrice, finalPrice, lostReason, followUpOn, notes }; ctx = { today }
 * -> { errors, values }
 */
export function validatePastRecord(input = {}, { today } = {}) {
  const errors = {}
  const v = {
    brand: text(input.brand), service: text(input.service), bdOwner: text(input.bdOwner), assignedAM: text(input.assignedAM),
    eventName: text(input.eventName), briefDate: text(input.briefDate), sentDate: text(input.sentDate),
    eventDate: text(input.eventDate), eventEndDate: text(input.eventEndDate), outcome: text(input.outcome),
    participants: null, amPrice: null, finalPrice: null, lostReason: null, followUpOn: text(input.followUpOn), notes: text(input.notes),
  }
  const brand = getBrand(v.brand)
  if (!brand) errors.brand = 'Choose the brand.'
  else if (!brand.services.some((s) => s.id === v.service)) errors.service = 'Choose a service of this brand.'
  if (!v.bdOwner) errors.bdOwner = 'Choose the BD owner.'
  if (!v.assignedAM) errors.assignedAM = 'Choose the Account Manager.'
  if (v.eventName && v.eventName.length > 120) errors.eventName = 'Use at most 120 characters.'
  const day = (key, label) => {
    if (v[key] && !isRealDay(v[key])) errors[key] = `Enter a valid ${label}.`
  }
  if (!v.briefDate) errors.briefDate = 'Enter the brief date.'
  else day('briefDate', 'brief date')
  day('sentDate', 'date')
  day('eventDate', 'event date')
  day('eventEndDate', 'end date')
  day('followUpOn', 'follow-up date')
  if (!errors.briefDate && today && v.briefDate > today) errors.briefDate = 'A past record cannot start in the future.'
  if (v.sentDate && !errors.sentDate && !errors.briefDate) {
    if (v.sentDate < v.briefDate) errors.sentDate = 'The proposal cannot be sent before the brief.'
    else if (today && v.sentDate > today) errors.sentDate = 'The sent date cannot be in the future.'
  }
  if (v.eventEndDate && v.eventDate && !errors.eventDate && !errors.eventEndDate && v.eventEndDate < v.eventDate) {
    errors.eventEndDate = 'The end date cannot be before the start date.'
  }
  const outcome = PAST_OUTCOMES.find((o) => o.id === v.outcome)
  if (!outcome) errors.outcome = 'Choose what happened.'
  if (['confirmed', 'done'].includes(v.outcome) && !v.eventDate) errors.eventDate = 'Enter the event date.'
  if (v.outcome === 'done' && v.eventDate && !errors.eventDate && today && (v.eventEndDate || v.eventDate) > today) {
    errors.eventDate = 'A done event has a date in the past (choose "Confirmed" for one still to come).'
  }
  if (v.outcome === 'lost') {
    if (!input.lostReason) errors.lostReason = 'Choose why it was lost.'
    else if (!LOST_IDS.includes(input.lostReason)) errors.lostReason = 'Choose a reason from the list.'
    else v.lostReason = input.lostReason
  }
  const whole = (key, min, message) => {
    const raw = input[key]
    if (raw === null || raw === undefined || raw === '') return
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min) errors[key] = message
    else v[key] = n
  }
  whole('participants', 1, 'Enter a whole number of participants greater than 0.')
  whole('amPrice', 1, 'Enter the proposal price as a whole number of EGP.')
  whole('finalPrice', 0, 'Enter the final price as a whole number of EGP.')
  if (v.notes && v.notes.length > 1000) errors.notes = 'Use at most 1000 characters.'
  return { errors, values: v }
}

/**
 * The history a past record gets, from the dates entered (all marked "Added manually — before IEE"):
 * Submitted on the brief date; Ready for BD and Shared on the sent date (when there is one); then the
 * outcome on the sent date (else the brief date). -> [{ status, day, followUpOn?, lostReason?, amPrice? }]
 */
export function pastHistory(v, today) {
  const outcome = PAST_OUTCOMES.find((o) => o.id === v.outcome)
  const at = v.sentDate ?? v.briefDate
  const steps = [{ status: PS.SUBMITTED, day: v.briefDate }]
  if (v.sentDate) {
    steps.push({ status: PS.READY_FOR_BD, day: v.sentDate, amPrice: v.amPrice ?? null })
    steps.push({ status: PS.SHARED_WITH_CLIENT, day: v.sentDate })
  } else if (outcome.status !== PS.CANCELLED && outcome.status !== PS.REJECTED) {
    steps.push({ status: PS.SHARED_WITH_CLIENT, day: v.briefDate })
  }
  if (outcome.status === PS.POSTPONED) steps.push({ status: PS.POSTPONED, day: at, followUpOn: v.followUpOn ?? plusDays(today, 7) })
  if (outcome.status === PS.ACCEPTED) steps.push({ status: PS.ACCEPTED, day: at })
  if (outcome.status === PS.REJECTED) steps.push({ status: PS.REJECTED, day: at, lostReason: v.lostReason })
  if (outcome.status === PS.CANCELLED) steps.push({ status: PS.CANCELLED, day: at })
  return steps
}

function plusDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
