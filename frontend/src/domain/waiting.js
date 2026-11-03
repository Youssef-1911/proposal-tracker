/**
 * "Where is it / Waiting on": who a request is waiting on right now.
 *
 * Automatic (from the status) unless someone set it by hand:
 *   draft                         -> its creator (Business Development)
 *   shared with client, postponed -> the client
 *   other open statuses           -> the assigned AM or the BD owner (STATUS_CONFIG.waitingOn)
 *   closed                        -> nobody
 * Set by hand ("Set waiting on": the BD owner, the assigned AM or the Commercial Head):
 *   request.waiting = { team, userId, reason, expectedBy, note, setAt, setBy }. Any status change
 *   clears it; so does "Clear" (and "Done" by the person or team it waits on).
 * The stage itself never changes here. The backend (app/domain/waiting.py) gives the same answers.
 */

import { actsAsBusinessDevelopment } from './access.js'
import { checkCodes, OTHER, visibleOptions } from './lists.js'
import { ROLE } from './roles.js'
import { PROPOSAL_STATUS as PS, getStatus } from './status.js'
import { isRequestOverdue } from './metrics.js'

export const WAITING_TEAMS = [
  { id: 'bd', label: 'Business Development', reasons: 'waitingInternal', roles: [ROLE.BUSINESS_DEVELOPMENT] },
  { id: 'am', label: 'Account Manager', reasons: 'waitingInternal', roles: [ROLE.ACCOUNT_MANAGER] },
  { id: 'marketing', label: 'Marketing', reasons: 'waitingMarketing', roles: [ROLE.MARKETING] },
  { id: 'operations', label: 'Operations', reasons: 'waitingOperations', roles: [ROLE.OPERATIONS] },
  { id: 'client', label: 'Client', reasons: 'waitingClient', roles: [] },
  { id: 'management', label: 'Management', reasons: 'waitingInternal', roles: [ROLE.COMMERCIAL_HEAD, ROLE.EXECUTIVE] },
]
export const WAITING_TEAM_IDS = WAITING_TEAMS.map((t) => t.id)
export const getTeam = (id) => WAITING_TEAMS.find((t) => t.id === id) ?? null

/** Filter chips on Proposals: "me" plus one per team (management has no chip). */
export const WAITING_CHIPS = [
  { id: 'me', label: 'Waiting on me' },
  { id: 'bd', label: 'BD' },
  { id: 'am', label: 'AM' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'operations', label: 'Operations' },
  { id: 'client', label: 'Client' },
]
export const WAITING_CHIP_IDS = WAITING_CHIPS.map((c) => c.id)
export const WAITING_NOTE_MAX = 300

const CLIENT_STATUSES = [PS.SHARED_WITH_CLIENT, PS.POSTPONED]

function isRealDay(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}
const isClosed = (r) => getStatus('proposal', r.status).closed

/** When the request reached its current status (the last history entry), else its last update. */
export function statusSince(r) {
  const h = r.statusHistory ?? []
  return r.statusSince ?? (h.length ? h[h.length - 1].changedAt : null) ?? r.lastUpdated ?? null
}

/** -> null (closed) | { kind: 'auto' | 'manual', team, userId, reason, expectedBy, note, since } */
export function effectiveWaiting(r) {
  if (isClosed(r)) return null
  if (r.waiting?.team && r.status !== PS.DRAFT) {
    const w = r.waiting
    return { kind: 'manual', team: w.team, userId: w.userId ?? null, reason: w.reason ?? null,
      expectedBy: w.expectedBy ?? null, note: w.note ?? null, since: w.setAt ?? statusSince(r) }
  }
  const base = { kind: 'auto', reason: null, expectedBy: null, note: null, since: statusSince(r) }
  if (r.status === PS.DRAFT) return { ...base, team: 'bd', userId: r.createdBy }
  if (CLIENT_STATUSES.includes(r.status)) return { ...base, team: 'client', userId: null }
  const who = getStatus('proposal', r.status).waitingOn
  return who === 'am' ? { ...base, team: 'am', userId: r.assignedAM } : { ...base, team: 'bd', userId: r.bdOwner }
}

/** Does this open request match a "Waiting on" chip? (me = it waits on this person by name). */
export function matchesWaitingChip(r, chip, userId) {
  if (!chip) return true
  const w = effectiveWaiting(r)
  if (!w) return false
  return chip === 'me' ? w.userId === userId : w.team === chip
}

/** Whole days since it started waiting (0 = today). */
export function waitingDays(w, now = new Date()) {
  if (!w?.since) return null
  return Math.max(0, Math.floor((now.getTime() - new Date(w.since).getTime()) / 86400000))
}

/** "Mariam Dimitri" · "Client" · "Marketing — Nada" · "Marketing". */
export function waitingLabel(w, usersById = {}) {
  if (!w) return '—'
  if (w.team === 'client') return 'Client'
  const person = w.userId ? usersById[w.userId]?.name ?? w.userId : null
  if (w.team === 'bd' || w.team === 'am') return person ?? getTeam(w.team).label
  return person ? `${getTeam(w.team).label} — ${person}` : getTeam(w.team).label
}

/** People who can be chosen for a team (active, holding one of the team's roles). */
export function teamPeople(teamId, users = []) {
  const team = getTeam(teamId)
  if (!team) return []
  return users.filter((u) => u.active !== false && u.roles.some((r) => team.roles.includes(r)))
    .sort((a, b) => a.name.localeCompare(b.name))
}

const ok = { allowed: true, reason: null }
const deny = (reason) => ({ allowed: false, reason })

/** "Set waiting on" (and Clear): the BD owner, the assigned AM or the Commercial Head, on an open, submitted request. */
export function canSetWaitingOn(r, viewer, usersById = {}) {
  if (r.status === PS.DRAFT) return deny('A draft is not waiting on anyone yet.')
  if (isClosed(r)) return deny('This request is closed.')
  if (viewer.activeRole === ROLE.COMMERCIAL_HEAD) return ok
  if (viewer.userId === r.bdOwner && actsAsBusinessDevelopment(viewer, usersById[viewer.userId])) return ok
  if (viewer.userId === r.assignedAM && viewer.activeRole === ROLE.ACCOUNT_MANAGER) return ok
  return deny('Only the BD owner, the assigned Account Manager or the Commercial Head can change who it is waiting on.')
}

/** "Done — back to …": also the person (or, when no one is named, anyone in the team) it waits on. */
export function canClearWaitingOn(r, viewer, usersById = {}) {
  if (!r.waiting?.team) return deny('It already follows the status.')
  const set = canSetWaitingOn(r, viewer, usersById)
  if (set.allowed || isClosed(r) || r.status === PS.DRAFT) return set
  const w = r.waiting
  if (w.userId === viewer.userId) return ok
  const team = getTeam(w.team)
  if (!w.userId && team?.roles.includes(viewer.activeRole)) return ok
  return set
}

/** Who it goes back to when cleared (the automatic value): "BD" or "AM" or "the client". */
export function backTo(r) {
  const auto = effectiveWaiting({ ...r, waiting: null })
  if (!auto) return null
  return auto.team === 'client' ? 'the client' : auto.team === 'am' ? 'AM' : 'BD'
}

/**
 * input = { team, userId, reason, expectedBy, note } -> { errors, values }.
 * ctx = { lists, usersById, today }
 */
export function validateWaitingOn(input = {}, { lists, usersById = {}, today } = {}) {
  const errors = {}
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const values = {
    team: text(input.team), userId: text(input.userId), reason: text(input.reason),
    expectedBy: text(input.expectedBy), note: text(input.note),
  }
  const team = getTeam(values.team)
  if (!team) {
    errors.team = 'Choose who it is waiting on.'
    return { errors, values }
  }
  if (team.id === 'client') values.userId = null
  else if (values.userId) {
    const u = usersById[values.userId]
    if (!u || u.active === false || !u.roles.some((r) => team.roles.includes(r))) errors.userId = `Choose someone from ${team.label}.`
  } else if (team.id === 'bd' || team.id === 'am') errors.userId = 'Choose the person.'
  if (!values.reason) errors.reason = 'Choose the reason.'
  else if (checkCodes(lists, team.reasons, [values.reason], { multi: false })) errors.reason = 'Choose a reason from the list.'
  if (values.expectedBy) {
    if (!isRealDay(values.expectedBy)) {
      errors.expectedBy = 'Enter a valid date.'
    } else if (today && values.expectedBy < today) errors.expectedBy = 'The expected date cannot be in the past.'
  }
  if (values.reason === OTHER && !values.note) errors.note = 'Add a note when choosing "Other".'
  if (values.note && values.note.length > WAITING_NOTE_MAX) errors.note = `Use at most ${WAITING_NOTE_MAX} characters.`
  return { errors, values }
}

/** The reasons offered for a team (visible options of its list). */
export const teamReasons = (lists, teamId) => (getTeam(teamId) ? visibleOptions(lists, getTeam(teamId).reasons) : [])

/**
 * "Group by who it's waiting on": one section per person (or team / Client), longest wait first.
 * -> [{ key, label, count, longestDays, requests }]
 */
export function groupByWaiting(requests, usersById = {}, now = new Date()) {
  const groups = new Map()
  for (const r of requests) {
    const w = effectiveWaiting(r)
    if (!w) continue
    const key = w.team === 'client' ? 'client' : `${w.team}:${w.userId ?? ''}`
    const g = groups.get(key) ?? { key, label: waitingLabel(w, usersById), requests: [], longestDays: 0 }
    g.requests.push(r)
    g.longestDays = Math.max(g.longestDays, waitingDays(w, now) ?? 0)
    groups.set(key, g)
  }
  return [...groups.values()]
    .map((g) => ({ ...g, count: g.requests.length,
      requests: g.requests.sort((a, b) => (waitingDays(effectiveWaiting(b), now) ?? 0) - (waitingDays(effectiveWaiting(a), now) ?? 0)) }))
    .sort((a, b) => b.longestDays - a.longestDays || b.count - a.count || a.label.localeCompare(b.label))
}

/**
 * One status pill per row, written for the viewer: "Your turn" · "Waiting on <name>" · "Overdue" ·
 * "Won" · "Lost" (or "Cancelled"). kind: turn · waiting · overdue · won · lost (one colour each).
 */
export function viewerPill(r, viewer, usersById = {}, today) {
  if (r.status === PS.ACCEPTED) return { kind: 'won', label: 'Confirmed' }
  if (r.status === PS.REJECTED) return { kind: 'lost', label: 'Lost' }
  if (r.status === PS.CANCELLED) return { kind: 'lost', label: 'Cancelled' }
  if (r.status === PS.CLOSED_UNRECORDED) return { kind: 'closed', label: 'Closed · not recorded' }
  if (r.status === PS.CLOSED_POSTPONED) return { kind: 'closed', label: 'Closed · postponed' }
  if (today && isRequestOverdue(r, today)) return { kind: 'overdue', label: 'Overdue' }
  const w = effectiveWaiting(r)
  if (w?.userId && w.userId === viewer.userId) return { kind: 'turn', label: 'Your turn' }
  return { kind: 'waiting', label: `Waiting on ${waitingLabel(w, usersById)}` }
}
