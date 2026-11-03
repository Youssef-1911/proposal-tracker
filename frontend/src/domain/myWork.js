/**
 * My Work's "Your turn" table: what to do, in plain words, and how long it has been with me.
 */

import { getTeam, effectiveWaiting, groupByWaiting, waitingDays } from './waiting.js'
import { optionLabel } from './lists.js'
import { PROPOSAL_STATUS as PS, getStatus } from './status.js'
import { ROLE } from './roles.js'
import { followUpDue } from './tracker.js'

export const LONG_WITH_ME_DAYS = 14

const firstName = (usersById, id) => usersById[id]?.name?.split(' ')[0] ?? null

/**
 * "Prepare the proposal" · "Answer Ahmed's question" · "Share with client" · "Follow up (postponed)" …
 * The action the viewer has to take now (an open question to them comes first).
 */
export function neededAction(r, viewer, usersById = {}, lists) {
  const other = viewer.userId === r.assignedAM ? r.bdOwner : r.assignedAM
  if ((r.openQuestions ?? 0) > 0 && other && other !== viewer.userId) {
    const who = firstName(usersById, other)
    return who ? `Answer ${who}'s question` : 'Answer the open question'
  }
  const w = effectiveWaiting(r)
  if (w?.kind === 'manual' && w.userId === viewer.userId) {
    const reason = optionLabel(lists, getTeam(w.team)?.reasons, w.reason)
    return reason ? `Your part: ${reason}` : 'Your part (set by hand)'
  }
  switch (r.status) {
    case PS.DRAFT: return 'Finish and submit the draft'
    case PS.SUBMITTED:
    case PS.IN_PROGRESS: return 'Prepare the proposal'
    case PS.REVISION_REQUESTED: return 'Prepare the revised proposal'
    case PS.AWAITING_BD_INFO: {
      const who = firstName(usersById, r.assignedAM)
      return who ? `Send ${who} the missing information` : 'Send the missing information'
    }
    case PS.READY_FOR_BD: return 'Share with client'
    case PS.POSTPONED: return 'Follow up (postponed)'
    case PS.SHARED_WITH_CLIENT: return "Record the client's answer"
    default: return 'Take the next step'
  }
}

/** Days it has been with me, and whether that is too long (after the deadline, or 14+ days without one). */
export function daysWithMe(r, today, now = new Date()) {
  let days = waitingDays(effectiveWaiting(r), now)
  if (r.status === PS.POSTPONED && r.followUpOn) {
    days = Math.max(0, Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${r.followUpOn}T00:00:00Z`)) / 86400000))
  }
  const late = r.requiredBy ? r.requiredBy < today : (days ?? 0) > LONG_WITH_ME_DAYS
  return { days, late }
}

// ---------------------------------------------------------------------------
// The sections (one rule for the page, the morning summary and check_users)
// ---------------------------------------------------------------------------

export const STUCK_DAYS = 3
const MANAGEMENT = [ROLE.COMMERCIAL_HEAD, ROLE.EXECUTIVE]
const isOpen = (r) => r.status !== PS.DRAFT && !getStatus('proposal', r.status).closed && !r.needsReview

/** Noha and the Executives: open requests with no change for 3+ days are "Stuck · N days". -> days | null */
export function stuckDays(r, viewer, now = new Date()) {
  if (!MANAGEMENT.includes(viewer.activeRole) || !isOpen(r)) return null
  const days = waitingDays(effectiveWaiting(r), now) ?? 0
  return days >= STUCK_DAYS ? days : null
}

/**
 * Where an open request sits in this person's My Work: 'turn' (it waits on me, or my postponed
 * proposal's follow-up date came) · 'team' / 'client' (Waiting on others: what I sent or own; Noha and
 * the Executives: every open request in the company, from the moment it waits on someone) · null (not in
 * My Work). One section at most.
 */
export function myWorkSection(r, viewer, now = new Date()) {
  if (!isOpen(r)) return null
  const me = viewer.userId
  const w = effectiveWaiting(r)
  const followUp = r.status === PS.POSTPONED && r.bdOwner === me && viewer.activeRole !== ROLE.ACCOUNT_MANAGER && followUpDue(r, now)
  if (w?.userId === me || followUp) return 'turn'
  const involved = r.bdOwner === me || r.assignedAM === me || r.createdBy === me
  if (!involved && !MANAGEMENT.includes(viewer.activeRole)) return null
  return w?.team === 'client' ? 'client' : 'team'
}

/** Noha and the Executives see everyone's requests here: the ones they sent themselves are marked "Sent by you". */
export const sentBy = (r, viewer) => MANAGEMENT.includes(viewer.activeRole) && (r.createdBy === viewer.userId || r.submittedBy === viewer.userId)

/** Noha and the Executives get the groups folded to one line each (name · count · longest wait · newest). */
export const foldsGroups = (viewer) => MANAGEMENT.includes(viewer.activeRole)

/**
 * "Waiting on others": the team, grouped by person / team with a count, longest wait first; and the
 * client (shared or postponed). Stuck ones (Noha, Executives) first in their group, then newest activity.
 * Each team group also names its newest request (the one that most recently started waiting there).
 */
export function waitingOnOthers(requests, viewer, usersById = {}, now = new Date(), newestFirst = () => 0) {
  const stuck = (r) => stuckDays(r, viewer, now) ?? -1
  const order = (a, b) => stuck(b) - stuck(a) || newestFirst(a, b)
  const team = groupByWaiting(requests.filter((r) => myWorkSection(r, viewer, now) === 'team'), usersById, now)
    .map((g) => ({
      ...g,
      requests: [...g.requests].sort(order),
      newest: g.requests.reduce((a, b) => (String(effectiveWaiting(b)?.since ?? '') > String(effectiveWaiting(a)?.since ?? '') ? b : a)),
    }))
  const client = requests.filter((r) => myWorkSection(r, viewer, now) === 'client').sort(order)
  return { team, client, total: team.reduce((n, g) => n + g.count, 0) + client.length }
}
