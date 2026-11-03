/**
 * "Due by date": open requests grouped by their proposal deadline, overdue first.
 *   Overdue · Today · Tomorrow · each later day this week ("Thu 29 Oct") · Next week · Later · No deadline
 * Imported rows flagged "Needs review" have no deadline that counts, so they are left out.
 */

import { getStatus, PROPOSAL_STATUS as PS } from './status.js'

const DAY = 86400000
const utc = (iso) => new Date(`${iso}T00:00:00Z`)
const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / DAY)
const dayLabel = (iso) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  .format(utc(iso)).replace(',', '')

/** Open = submitted and not closed (drafts and closed requests have no deadline to meet). */
export const isOpenWithDeadline = (r) => r.status !== PS.DRAFT && !getStatus('proposal', r.status).closed && !r.needsReview

/**
 * requests -> [{ key, label, overdue, count, requests }], in order. A week ends on Saturday
 * (the next Sunday starts "Next week"). Within a group: earliest deadline first, then newest activity.
 */
export function dueGroups(requests, today) {
  const toSaturday = 6 - utc(today).getUTCDay()
  const groups = new Map()
  const add = (key, label, order, r, overdue = false) => {
    const g = groups.get(key) ?? { key, label, order, overdue, requests: [] }
    g.requests.push(r)
    groups.set(key, g)
  }
  for (const r of requests.filter(isOpenWithDeadline)) {
    if (!r.requiredBy) { add('none', 'No deadline', 9999, r); continue }
    const d = daysBetween(today, r.requiredBy)
    if (d < 0) add('overdue', 'Overdue', -1, r, true)
    else if (d === 0) add('today', 'Today', 0, r)
    else if (d === 1) add('tomorrow', 'Tomorrow', 1, r)
    else if (d <= toSaturday) add(r.requiredBy, dayLabel(r.requiredBy), d, r)
    else if (d <= toSaturday + 7) add('next-week', 'Next week', 100, r)
    else add('later', 'Later', 200, r)
  }
  const activity = (r) => String(r.lastUpdated ?? '')
  return [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ order, ...g }) => ({
      ...g,
      count: g.requests.length,
      requests: g.requests.sort((a, b) => String(a.requiredBy ?? '').localeCompare(String(b.requiredBy ?? ''))
        || activity(b).localeCompare(activity(a))),
    }))
}

/** "12 proposals · 2 overdue · 4 due this week" (this week: today to Saturday). */
export function deadlineSummary(requests, today) {
  const open = requests.filter(isOpenWithDeadline)
  const toSaturday = 6 - utc(today).getUTCDay()
  const days = (r) => (r.requiredBy ? daysBetween(today, r.requiredBy) : null)
  return {
    total: open.length,
    overdue: open.filter((r) => days(r) !== null && days(r) < 0).length,
    dueThisWeek: open.filter((r) => days(r) !== null && days(r) >= 0 && days(r) <= toSaturday).length,
  }
}

/** Deadline tone for a card: 'overdue' (red), 'soon' (within 3 days, amber), or null. */
export function deadlineTone(r, today) {
  if (!r.requiredBy || !isOpenWithDeadline(r)) return null
  const d = daysBetween(today, r.requiredBy)
  return d < 0 ? 'overdue' : d <= 3 ? 'soon' : null
}
