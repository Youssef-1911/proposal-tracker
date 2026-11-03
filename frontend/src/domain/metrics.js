/**
 * THE single place for metric definitions. Every dashboard uses these functions,
 * so "open", "overdue", "pipeline" etc. mean the same thing everywhere.
 *
 * All functions are pure: they take data arrays (from the store hooks) plus
 * `today` (local calendar date "YYYY-MM-DD") or `now` (Date) and return values.
 * Nothing here contains demo numbers.
 */

import { PROPOSAL_STATUS, getStatus, stageList, statusList } from './status.js'
import { ROLE } from './roles.js'
import { toISODate } from '../lib/format.js'

const DAY_MS = 86400000
export const STALE_AFTER_DAYS = 3
export const UPCOMING_WINDOW_DAYS = 7

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Today's LOCAL calendar date as "YYYY-MM-DD". */
export function todayISO(now = new Date()) {
  return toISODate(now)
}

function addDaysISO(today, days) {
  const [y, m, d] = today.split('-').map(Number)
  return toISODate(new Date(y, m - 1, d + days))
}

/** A date strictly before today's local date. ISO dates compare correctly as strings. */
export function isBeforeToday(dateISO, today) {
  return Boolean(dateISO) && dateISO < today
}

export function isWithinNextDays(dateISO, today, days = UPCOMING_WINDOW_DAYS) {
  return Boolean(dateISO) && dateISO >= today && dateISO <= addDaysISO(today, days)
}

// ---------------------------------------------------------------------------
// Proposal requests: status rules
// ---------------------------------------------------------------------------

const proposalCfg = (r) => getStatus('proposal', r.status)

export function isDraft(r) {
  return r.status === PROPOSAL_STATUS.DRAFT
}

/** THE definition of an open request: anything except Draft, Accepted, Rejected, Cancelled. */
export function isOpenRequest(r) {
  return !isDraft(r) && !proposalCfg(r).closed
}

export function waitingOn(r) {
  return proposalCfg(r).waitingOn
}

/** An imported request flagged "Needs review" has no deadline that counts until someone acts on it. */
export function isDeadlinePending(r) {
  return proposalCfg(r).deadlinePending === true && !r.needsReview
}

/** Open, AM still owes the proposal, and requiredBy is before today. */
export function isRequestOverdue(r, today) {
  return isOpenRequest(r) && isDeadlinePending(r) && isBeforeToday(r.requiredBy, today)
}

export function isDeadlineUpcoming(r, today, days = UPCOMING_WINDOW_DAYS) {
  return isOpenRequest(r) && isDeadlinePending(r) && isWithinNextDays(r.requiredBy, today, days)
}

export function lastStatusChangeAt(r) {
  return r.statusHistory.at(-1)?.changedAt ?? null
}

export function daysSinceLastChange(r, now = new Date()) {
  const last = lastStatusChangeAt(r)
  return last ? (now - new Date(last)) / DAY_MS : null
}

/** Open and no status change for more than STALE_AFTER_DAYS days. */
export function isStale(r, now = new Date()) {
  if (r.needsReview) return false // imported, to be checked: not "stuck"
  // A postponed proposal is waiting on purpose until its follow-up date.
  if (r.status === PROPOSAL_STATUS.POSTPONED && r.followUpOn && r.followUpOn > todayISO(now)) return false
  return isOpenRequest(r) && daysSinceLastChange(r, now) > STALE_AFTER_DAYS
}

// ---------------------------------------------------------------------------
// Proposal requests: who may see what
// ---------------------------------------------------------------------------

/** A draft is visible only to the person who created it (even the Commercial Head can't see others'). */
export function isVisibleDraftFor(r, userId) {
  return isDraft(r) && r.createdBy === userId
}

/** BD view: requests they own, plus drafts only if they created them. */
export function requestsForBD(requests, userId) {
  return requests.filter((r) => r.bdOwner === userId && (!isDraft(r) || isVisibleDraftFor(r, userId)))
}

/** AM view: their brand only, never drafts. */
export function requestsForAM(requests, brandId) {
  return requests.filter((r) => r.brand === brandId && !isDraft(r))
}

/** Commercial Head view: never drafts; optional brand filter ('all' or a brand id). */
export function requestsForHead(requests, brandFilter = 'all') {
  return requests.filter((r) => !isDraft(r) && (brandFilter === 'all' || r.brand === brandFilter))
}

export function sortByRequiredBy(requests) {
  return [...requests].sort((a, b) => (a.requiredBy ?? '').localeCompare(b.requiredBy ?? ''))
}

/** Per-status counts in STATUS_CONFIG order. byBrand: optional list of brand ids to split by. */
export function countByStatus(requests, { statuses, brands = [] } = {}) {
  const list = statusList('proposal').filter((s) => !statuses || statuses.includes(s.id))
  return list.map((s) => {
    const matching = requests.filter((r) => r.status === s.id)
    return {
      ...s,
      total: matching.length,
      byBrand: Object.fromEntries(brands.map((b) => [b, matching.filter((r) => r.brand === b).length])),
    }
  })
}

/** Every status except Draft (drafts are private to their BD, so shared views never list them). */
export function sharedStatusIds() {
  return statusList('proposal').filter((s) => s.id !== PROPOSAL_STATUS.DRAFT).map((s) => s.id)
}

/**
 * Per display-stage counts (stage order), each with its detailed statuses nested.
 * Same options as countByStatus; stages whose statuses are all excluded are left out.
 */
export function countByStage(requests, { statuses, brands = [] } = {}) {
  const detailed = countByStatus(requests, { statuses, brands })
  return stageList()
    .map((st) => {
      const children = detailed.filter((s) => s.stage === st.id)
      return {
        ...st,
        total: children.reduce((sum, c) => sum + c.total, 0),
        byBrand: Object.fromEntries(brands.map((b) => [b, children.reduce((sum, c) => sum + c.byBrand[b], 0)])),
        statuses: children,
      }
    })
    .filter((st) => st.statuses.length)
}

/** Status ids that count as open (for filters and breakdowns). */
export function openStatusIds() {
  return statusList('proposal')
    .filter((s) => s.id !== PROPOSAL_STATUS.DRAFT && !s.closed)
    .map((s) => s.id)
}

// ---------------------------------------------------------------------------
// AM turnaround: Submitted -> first Ready for BD, minus time in Awaiting BD Information
// ---------------------------------------------------------------------------

/** Days, or null when the history lacks a Submitted -> Ready for BD span. */
export function amTurnaroundDays(r) {
  const h = r.statusHistory
  const start = h.findIndex((e) => e.status === PROPOSAL_STATUS.SUBMITTED)
  if (start === -1) return null
  const end = h.findIndex((e, i) => i > start && e.status === PROPOSAL_STATUS.READY_FOR_BD)
  if (end === -1) return null

  const t = (i) => new Date(h[i].changedAt).getTime()
  let ms = t(end) - t(start)
  for (let i = start; i < end; i++) {
    if (h[i].status === PROPOSAL_STATUS.AWAITING_BD_INFO) ms -= t(i + 1) - t(i)
  }
  return ms >= 0 ? ms / DAY_MS : null
}

/** { averageDays, included, considered }. Requests without the needed timestamps are excluded. */
export function averageTurnaround(requests) {
  // Imported requests whose sheet row lacked the dates are left out entirely (not counted as considered).
  const considered = requests.filter((r) => !isDraft(r) && !(r.imported && amTurnaroundDays(r) === null))
  const values = considered.map(amTurnaroundDays).filter((v) => v !== null)
  return {
    averageDays: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    included: values.length,
    considered: considered.length,
  }
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

const stageCfg = (o) => getStatus('opportunity', o.stage)

export function isActiveOpportunity(o) {
  return !stageCfg(o).closed
}

/** Estimated value of ACTIVE opportunities only. This is pipeline, never revenue. */
export function pipelineValue(opportunities) {
  return opportunities.filter(isActiveOpportunity).reduce((sum, o) => sum + (o.estimatedValue ?? 0), 0)
}

export function opportunitiesByStage(opportunities) {
  return statusList('opportunity').map((s) => {
    const matching = opportunities.filter((o) => o.stage === s.id)
    return {
      ...s,
      key: s.id,
      group: s.closed ? 'closed' : 'open',
      count: matching.length,
      value: matching.reduce((sum, o) => sum + (o.estimatedValue ?? 0), 0),
    }
  })
}

export function filterByBrand(items, brandFilter = 'all') {
  return brandFilter === 'all' ? items : items.filter((i) => i.brand === brandFilter)
}

/**
 * Won/lost outcomes. Win rate is null without closed deals.
 * acceptedProposalValue = AM price on Accepted requests. Not invoiced/confirmed revenue.
 */
export function outcomes(opportunities, requests) {
  const won = opportunities.filter((o) => stageCfg(o).outcome === 'won')
  const lost = opportunities.filter((o) => stageCfg(o).outcome === 'lost')
  const accepted = requests.filter((r) => r.status === PROPOSAL_STATUS.ACCEPTED && r.amPrice !== null)
  return {
    won: won.length,
    lost: lost.length,
    winRate: won.length + lost.length ? won.length / (won.length + lost.length) : null,
    acceptedProposalCount: accepted.length,
    acceptedProposalValue: accepted.reduce((sum, r) => sum + r.amPrice, 0),
  }
}

/**
 * Proposals marked won (Accepted) and lost (Rejected) in this calendar month, by the date of
 * that status change. wonValue = AM price on the won ones (not confirmed revenue).
 */
export function decidedThisMonth(requests, now = new Date()) {
  const month = todayISO(now).slice(0, 7)
  const decidedIn = (r, status) => r.status === status
    && r.statusHistory.some((e) => e.status === status && todayISO(new Date(e.changedAt)).slice(0, 7) === month)
  const won = requests.filter((r) => decidedIn(r, PROPOSAL_STATUS.ACCEPTED))
  const lost = requests.filter((r) => decidedIn(r, PROPOSAL_STATUS.REJECTED))
  return { won, lost, wonValue: won.reduce((sum, r) => sum + (r.amPrice ?? 0), 0) }
}

/** Open requests by how long they have waited in their current stage, longest first. */
export function waitingLongest(requests, now = new Date(), limit = 8) {
  const DAY = 86400000
  const since = (r) => {
    const h = r.statusHistory
    let i = h.length - 1
    while (i > 0 && getStatus('proposal', h[i - 1].status).stage === getStatus('proposal', r.status).stage) i -= 1
    return h[i]?.changedAt ?? null
  }
  return requests.filter(isOpenRequest)
    .map((r) => ({ request: r, days: since(r) ? Math.max(0, Math.floor((now - new Date(since(r))) / DAY)) : 0 }))
    .sort((a, b) => b.days - a.days || a.request.id.localeCompare(b.request.id))
    .slice(0, limit)
}

export function priceChangeExceptions(requests) {
  return requests.filter((r) => r.priceChange !== null && r.priceChange !== undefined)
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function tasksForUser(tasks, userId) {
  return tasks.filter((t) => t.owner === userId)
}

export function isTaskOverdue(t, today) {
  return !t.done && isBeforeToday(t.dueDate, today)
}

export function isTaskDueToday(t, today) {
  return !t.done && t.dueDate === today
}

// ---------------------------------------------------------------------------
// Follow-ups & next actions (BD)
// ---------------------------------------------------------------------------

/** Open tasks + next actions on active opportunities, merged and sorted by date (no date last). */
export function upcomingActions(tasks, opportunities, today) {
  const fromTasks = tasks.filter((t) => !t.done).map((t) => ({
    id: t.id, kind: 'task', taskType: t.type, title: t.title, date: t.dueDate,
    clientId: t.related.clientId, opportunityId: t.related.opportunityId,
  }))
  // A next action is already tracked when an open task exists for the same opportunity on the same date.
  const covered = new Set(fromTasks.map((t) => `${t.opportunityId}|${t.date}`))
  const fromOpps = opportunities
    .filter((o) => isActiveOpportunity(o) && o.nextAction && !covered.has(`${o.id}|${o.nextActionDate}`))
    .map((o) => ({
    id: `next-${o.id}`, kind: 'next_action', title: o.nextAction, date: o.nextActionDate,
    clientId: o.clientId, opportunityId: o.id,
  }))
  return [...fromTasks, ...fromOpps]
    .map((a) => ({ ...a, overdue: isBeforeToday(a.date, today), dueToday: a.date === today }))
    .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))
}

// ---------------------------------------------------------------------------
// Activity (from status history)
// ---------------------------------------------------------------------------

/** Flattened status-history events for the given requests, newest first. */
export function requestActivity(requests, limit = 8) {
  return requests
    .flatMap((r) => r.statusHistory.map((entry, i) => ({ request: r, entry, index: i, isFirst: i === 0 })))
    .sort((a, b) => b.entry.changedAt.localeCompare(a.entry.changedAt))
    .slice(0, limit)
}

// ---------------------------------------------------------------------------
// Workload (Commercial Head) — AMs and BDs are measured separately, never ranked together
// ---------------------------------------------------------------------------

export function usersWithRole(users, role) {
  return users.filter((u) => u.roles.includes(role))
}

/** One row per Account Manager, from Head-visible (non-draft) requests. */
export function amWorkload(users, requests, today) {
  return usersWithRole(users, ROLE.ACCOUNT_MANAGER).map((am) => {
    const mine = requests.filter((r) => r.assignedAM === am.id)
    const open = mine.filter(isOpenRequest)
    return {
      user: am,
      brand: am.brand,
      open: open.length,
      waitingOnAM: open.filter((r) => waitingOn(r) === 'am').length,
      awaitingBDInfo: open.filter((r) => r.status === PROPOSAL_STATUS.AWAITING_BD_INFO).length,
      overdue: open.filter((r) => isRequestOverdue(r, today)).length,
      turnaround: averageTurnaround(mine),
    }
  })
}

/** One row per BD. Opportunities/requests/tasks should already be brand-filtered by the caller. */
export function bdActivity(users, { opportunities, requests, tasks }, today) {
  return usersWithRole(users, ROLE.BUSINESS_DEVELOPMENT).map((bd) => {
    const opps = opportunities.filter((o) => o.owner === bd.id)
    const reqs = requests.filter((r) => r.bdOwner === bd.id && isOpenRequest(r))
    return {
      user: bd,
      activeOpportunities: opps.filter(isActiveOpportunity).length,
      pipelineValue: pipelineValue(opps),
      openRequests: reqs.length,
      waitingOnBD: reqs.filter((r) => waitingOn(r) === 'bd').length,
      overdueTasks: tasks.filter((t) => t.owner === bd.id && isTaskOverdue(t, today)).length,
      won: opps.filter((o) => stageCfg(o).outcome === 'won').length,
      lost: opps.filter((o) => stageCfg(o).outcome === 'lost').length,
    }
  })
}

/** Tasks linked to an opportunity of the given brand ('all' keeps everything). */
export function tasksForBrand(tasks, opportunities, brandFilter = 'all') {
  if (brandFilter === 'all') return tasks
  const brandOf = Object.fromEntries(opportunities.map((o) => [o.id, o.brand]))
  return tasks.filter((t) => brandOf[t.related.opportunityId] === brandFilter)
}

// ---------------------------------------------------------------------------
// Bottlenecks (Commercial Head)
// ---------------------------------------------------------------------------

/** Open requests grouped by who they wait on, with the longest-waiting item and stale list. */
export function bottlenecks(requests, now = new Date()) {
  const open = requests.filter(isOpenRequest)
  const oldestOf = (list) =>
    [...list].sort((a, b) => lastStatusChangeAt(a).localeCompare(lastStatusChangeAt(b)))[0] ?? null
  const group = (who) => {
    const list = open.filter((r) => waitingOn(r) === who)
    return { count: list.length, oldest: oldestOf(list) }
  }
  return {
    am: group('am'),
    bd: group('bd'),
    stale: open
      .filter((r) => isStale(r, now))
      .sort((a, b) => lastStatusChangeAt(a).localeCompare(lastStatusChangeAt(b))),
  }
}

// ---------------------------------------------------------------------------
// Analytics (Commercial Head)
// ---------------------------------------------------------------------------

const hasEntry = (r, status) => r.statusHistory.some((e) => e.status === status)

/**
 * Proposal outcomes from requests: won = Accepted, lost = Rejected. Cancelled requests are
 * not a sales outcome and are left out. winRate = won / (won + lost), null when nothing is decided.
 */
export function requestWinRate(requests) {
  const won = requests.filter((r) => r.status === PROPOSAL_STATUS.ACCEPTED).length
  const lost = requests.filter((r) => r.status === PROPOSAL_STATUS.REJECTED).length
  return { won, lost, decided: won + lost, winRate: won + lost ? won / (won + lost) : null }
}

/**
 * Why proposals were lost: the reason recorded on each Rejected request's "lost" history entry.
 * -> [{ id, label, count }] in LOST_REASONS order (zeros included), plus notRecorded (older data).
 */
export function lostReasonBreakdown(requests, reasons) {
  const lost = requests.filter((r) => r.status === PROPOSAL_STATUS.REJECTED)
  const reasonOf = (r) => [...r.statusHistory].reverse().find((e) => e.status === PROPOSAL_STATUS.REJECTED)?.lostReason ?? null
  const counts = lost.map(reasonOf)
  return {
    total: lost.length,
    rows: reasons.map((reason) => ({ ...reason, count: counts.filter((c) => c === reason.id).length })),
    notRecorded: counts.filter((c) => !c).length,
  }
}

/**
 * One row per Business Development person (never ranked against each other or against AMs):
 * opportunities owned, and how many of their requests were submitted, shared with the client, won.
 * Requests should already exclude other people's drafts (they never count as submitted anyway).
 */
export function bdRequestActivity(users, { opportunities, requests }) {
  return usersWithRole(users, ROLE.BUSINESS_DEVELOPMENT).map((bd) => {
    const mine = requests.filter((r) => r.bdOwner === bd.id)
    return {
      user: bd,
      opportunities: opportunities.filter((o) => o.owner === bd.id).length,
      submitted: mine.filter((r) => hasEntry(r, PROPOSAL_STATUS.SUBMITTED)).length,
      shared: mine.filter((r) => hasEntry(r, PROPOSAL_STATUS.SHARED_WITH_CLIENT)).length,
      won: mine.filter((r) => r.status === PROPOSAL_STATUS.ACCEPTED).length,
    }
  })
}

/** Submitted (non-draft) requests counted per brand and service. -> [{ brand, service, count }] (count > 0). */
export function requestsByBrandService(requests, brands) {
  const submitted = requests.filter((r) => !isDraft(r))
  return brands.flatMap((b) => b.services.map((s) => ({
    brand: b.id, service: s.id,
    count: submitted.filter((r) => r.brand === b.id && r.service === s.id).length,
  }))).filter((row) => row.count > 0)
}
