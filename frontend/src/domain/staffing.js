/**
 * HR staffing: facilitators for confirmed events. The backend (app/domain/staffing.py) gives the same
 * answers (contract: staffingCases).
 */

import { ROLE } from './roles.js'

export const RATING_EDIT_DAYS = 7
export const MIN_RATINGS_FOR_TOP = 3
const DAY = 86400000

/** "Facilitators needed": Operations, the assigned AM (acting as AM) or the Commercial Head. */
export function canSetFacilitatorsNeeded(r, viewer) {
  if ([ROLE.OPERATIONS, ROLE.COMMERCIAL_HEAD].includes(viewer.activeRole)) return true
  return viewer.activeRole === ROLE.ACCOUNT_MANAGER && viewer.userId === r.assignedAM
}

/** The list, assignments, staffing and ratios: HR and Operations only. */
export const canManageFacilitators = (viewer) => [ROLE.HR, ROLE.OPERATIONS].includes(viewer.activeRole)

/** Ratings are seen by HR and Operations only. */
export const canSeeRatings = (viewer) => [ROLE.HR, ROLE.OPERATIONS].includes(viewer.activeRole)

/** Who rates facilitators after a done event: HR and Operations. */
export const canRate = (viewer) => [ROLE.HR, ROLE.OPERATIONS].includes(viewer.activeRole)

/** A suggestion from the ratio (one facilitator per N participants), never saved by itself. */
export function suggestedNeeded(participants, perFacilitator) {
  if (!participants || !perFacilitator || participants <= 0 || perFacilitator <= 0) return null
  return Math.ceil(participants / perFacilitator)
}

/** "N needed · M assigned · K missing" for an event. */
export function staffingOf(needed, assigned) {
  const n = needed ?? 0
  return { needed: needed ?? null, assigned, missing: Math.max(0, n - assigned) }
}

/** Totals for a list of events: { events, needed, assigned, missing }. */
export function staffingTotals(events) {
  return events.reduce((t, e) => {
    const s = staffingOf(e.facilitatorsNeeded, e.assignedCount ?? 0)
    return { events: t.events + 1, needed: t.needed + (s.needed ?? 0), assigned: t.assigned + s.assigned, missing: t.missing + s.missing }
  }, { events: 0, needed: 0, assigned: 0, missing: 0 })
}

/** The days an event covers ([start, end]); a month-only or missing date covers nothing. */
function span(e) {
  if (!e.eventDate || e.eventDatePrecision === 'month') return null
  return [e.eventDate, e.eventEndDate && e.eventEndDate > e.eventDate ? e.eventEndDate : e.eventDate]
}

/** Same-day clash: the other events (of this facilitator's assignments) that share a day with this one. */
export function clashes(event, otherEvents) {
  const a = span(event)
  if (!a) return []
  return otherEvents.filter((o) => {
    const b = span(o)
    return o.id !== event.id && b && b[0] <= a[1] && a[0] <= b[1]
  }).map((o) => o.id).sort()
}

/** A rating can be changed for 7 days after it was first given, then it is locked. */
export function ratingEditable(rating, now = new Date()) {
  return !rating || now.getTime() - new Date(rating.createdAt).getTime() <= RATING_EDIT_DAYS * DAY
}

/** input = { stars, attended, feedback } -> { errors, values }. Stars 1-5 when they attended; none otherwise. */
export function validateRating(input = {}) {
  const errors = {}
  const attended = input.attended === true || input.attended === 'yes'
  if (input.attended === undefined || input.attended === null || input.attended === '') errors.attended = 'Did they attend?'
  const stars = input.stars === '' || input.stars === null || input.stars === undefined ? null : Number(input.stars)
  if (attended && (stars === null || !Number.isInteger(stars) || stars < 1 || stars > 5)) errors.stars = 'Give 1 to 5 stars.'
  const feedback = typeof input.feedback === 'string' && input.feedback.trim() ? input.feedback.trim() : null
  if (feedback && feedback.length > 1000) errors.feedback = 'Use at most 1000 characters.'
  return { errors, values: { attended, stars: attended ? stars : null, feedback } }
}

/**
 * A facilitator's record from their ratings ([{ requestId, raterId, stars, attended, updatedAt }]) and
 * assignments on done events ([requestId]).
 * -> { average (one decimal, or null), ratings (with stars), attended (events), assignedDone, }
 * An event counts as attended when the latest rating of it says so.
 */
export function facilitatorRecord(ratings, doneAssignments) {
  const starred = ratings.filter((r) => r.attended && r.stars)
  const average = starred.length ? Math.round((starred.reduce((s, r) => s + r.stars, 0) / starred.length) * 10) / 10 : null
  const latest = new Map()
  for (const r of [...ratings].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))) latest.set(r.requestId, r)
  const attended = [...latest.values()].filter((r) => r.attended).length
  return { average, ratings: starred.length, attended, assignedDone: new Set(doneAssignments).size }
}

/** Duplicate check while adding: the same phone, or a name that matches ignoring case and spaces. */
export function possibleDuplicates(input, facilitators) {
  const phone = String(input.phone ?? '').replace(/\D/g, '')
  const name = String(input.name ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  return facilitators.filter((f) => (phone && String(f.phone ?? '').replace(/\D/g, '') === phone)
    || (name && f.name.toLowerCase().replace(/\s+/g, ' ').trim() === name)).map((f) => f.id)
}
