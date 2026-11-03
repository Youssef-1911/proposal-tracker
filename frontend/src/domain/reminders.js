/**
 * "Remind": one in-app notification to the person a request waits on, listing EVERYTHING waiting on
 * them ("3 requests are waiting on you"), at most once per recipient every 24 hours. Pure rules; the
 * backend (app/domain/reminders.py) gives the same answers, checked by the contract file.
 */

import { actsAsBusinessDevelopment } from './access.js'
import { ROLE } from './roles.js'
import { PROPOSAL_STATUS as PS, getStatus } from './status.js'
import { effectiveWaiting } from './waiting.js'

export const REMIND_EVERY_HOURS = 24
const ok = { allowed: true, reason: null }
const deny = (reason) => ({ allowed: false, reason })

/** Open, submitted, not an untouched imported row ("Needs review"): only those can be reminded about. */
export const remindable = (r) => r.status !== PS.DRAFT && !getStatus('proposal', r.status).closed && !r.needsReview

/** Who it waits on by name, if anyone: the person a reminder goes to. */
export function remindTarget(r) {
  const w = remindable(r) ? effectiveWaiting(r) : null
  return w?.userId ?? null
}

/** The BD owner, the assigned AM, the Commercial Head or an Executive, about someone else. */
export function canRemind(r, viewer, usersById = {}) {
  if (!remindable(r)) return deny('Nothing to remind about on this request.')
  const target = remindTarget(r)
  if (!target) return deny('It is not waiting on a person.')
  if (target === viewer.userId) return deny('It is waiting on you.')
  if (usersById[target]?.active === false) return deny('That person is no longer active.')
  const holds = [ROLE.COMMERCIAL_HEAD, ROLE.EXECUTIVE].includes(viewer.activeRole)
    || (viewer.userId === r.bdOwner && actsAsBusinessDevelopment(viewer, usersById[viewer.userId]))
    || (viewer.userId === r.assignedAM && viewer.activeRole === ROLE.ACCOUNT_MANAGER)
  return holds ? ok : deny('Only the BD owner, the assigned Account Manager, the Commercial Head or an Executive can send a reminder.')
}

/** Everything waiting on this person by name (what one reminder lists). */
export const waitingOnPerson = (requests, userId) => requests.filter((r) => remindTarget(r) === userId)

/** When the next reminder to this person is possible (ISO), or null when it is possible now. */
export function nextReminderAt(lastSentAt, now = new Date()) {
  if (!lastSentAt) return null
  const next = new Date(new Date(lastSentAt).getTime() + REMIND_EVERY_HOURS * 3600000)
  return next > now ? next.toISOString() : null
}
