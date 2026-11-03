/**
 * "My queue — board" (Account Managers): every open proposal assigned to me, by where it is in
 * production. Confirmed, lost and closed proposals are not on the board; stages change only through
 * actions (no drag and drop).
 *   New · Preparing · Waiting (on BD, Marketing, Operations, Management) · Ready for BD · With client
 */

import { isOpenWithDeadline } from './deadlines.js'
import { PROPOSAL_STATUS as PS } from './status.js'
import { effectiveWaiting, statusSince } from './waiting.js'

export const QUEUE_COLUMNS = [
  { id: 'new', label: 'New' },
  { id: 'preparing', label: 'Preparing' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'ready', label: 'Ready for BD' },
  { id: 'client', label: 'With client' },
]

/** The column a request sits in, for its assigned AM. */
export function queueColumn(r, userId) {
  const w = effectiveWaiting(r)
  // Waiting by hand on someone else (BD, Marketing, Operations, Management), or on BD for missing information.
  if (r.status === PS.AWAITING_BD_INFO || (w?.kind === 'manual' && w.team !== 'client' && w.userId !== userId)) return 'waiting'
  if (r.status === PS.SUBMITTED) return 'new'
  if ([PS.IN_PROGRESS, PS.REVISION_REQUESTED].includes(r.status)) return 'preparing'
  if (r.status === PS.READY_FOR_BD) return 'ready'
  return 'client' // shared with the client, postponed
}

const DAY = 86400000

/** Whole days it has been in its column (since its status, or since it started waiting by hand). */
export function daysInColumn(r, column, now = new Date()) {
  const since = column === 'waiting' && r.waiting?.setAt ? r.waiting.setAt : statusSince(r)
  return since ? Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / DAY)) : null
}

/**
 * -> [{ id, label, count, cards: [{ request, days, waiting }] }]; each column newest activity first.
 */
export function queueBoard(requests, userId, now = new Date()) {
  const mine = requests.filter((r) => r.assignedAM === userId && isOpenWithDeadline(r))
  const activity = (r) => String(r.lastUpdated ?? statusSince(r) ?? '')
  return QUEUE_COLUMNS.map((c) => {
    const cards = mine.filter((r) => queueColumn(r, userId) === c.id)
      .sort((a, b) => activity(b).localeCompare(activity(a)))
      .map((request) => ({ request, days: daysInColumn(request, c.id, now), waiting: c.id === 'waiting' ? effectiveWaiting(request) : null }))
    return { ...c, count: cards.length, cards }
  })
}
