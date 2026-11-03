/**
 * Proposal Tracker: scopes, tabs, search, filters, sorting and URL state.
 * Pure functions built on the existing rules; nothing here defines a status,
 * routing or permission rule of its own.
 *
 * Visibility is applied FIRST (requestsInScope), so search, filters, tab counts
 * and empty states can only ever see requests this viewer may view.
 */

import { WAITING_CHIP_IDS, effectiveWaiting, matchesWaitingChip } from './waiting.js'
import { BRANDS, getBrand, serviceLabel } from './brands.js'
import { ROLE } from './roles.js'
import { PROPOSAL_STATUS, getStage, getStatus, stageList, stageOf, statusList, subLabelFor } from './status.js'
import { ACTOR, holdsResponsibility } from './permissions.js'
import { canViewRequest, responsibleFor } from './proposals.js'
import { PRIVILEGE, canSeeBrand, hasPrivilege } from './access.js'
import { canEditDraft, eventStartDate } from './workflow.js'
import {
  UPCOMING_WINDOW_DAYS, isDeadlinePending, isDeadlineUpcoming, isDraft, isOpenRequest, isRequestOverdue, isStale,
  isVisibleDraftFor, todayISO,
} from './metrics.js'
import { formatEventDate } from '../lib/format.js'
import { editDraftLink, proposalLink } from '../lib/links.js'

// ---------------------------------------------------------------------------
// Scopes (follow the ACTIVE role)
// ---------------------------------------------------------------------------

export const SCOPE = { MINE: 'mine', MY_BRAND: 'my_brand', COMPANY: 'company' }

const SCOPES_BY_ROLE = {
  [ROLE.BUSINESS_DEVELOPMENT]: [
    { id: SCOPE.MINE, label: 'Mine', kind: 'personal' },
    { id: SCOPE.COMPANY, label: 'Company', kind: 'company', readOnly: true },
  ],
  [ROLE.ACCOUNT_MANAGER]: [
    { id: SCOPE.MY_BRAND, label: 'My brand', kind: 'personal' },
    { id: SCOPE.COMPANY, label: 'Company', kind: 'company', readOnly: true },
  ],
  [ROLE.COMMERCIAL_HEAD]: [{ id: SCOPE.COMPANY, label: 'Company', kind: 'company' }],
  [ROLE.EXECUTIVE]: [{ id: SCOPE.COMPANY, label: 'Company', kind: 'company', readOnly: true }],
}

/**
 * The viewer's scopes. An Account Manager gets the other brand (Company) only with "See all
 * brands"; Marketing and Operations have none. user = the viewer's user record.
 */
export function scopesFor(activeRole, user = null) {
  const scopes = SCOPES_BY_ROLE[activeRole] ?? []
  if (activeRole === ROLE.ACCOUNT_MANAGER && !hasPrivilege(user, PRIVILEGE.SEE_ALL_BRANDS)) {
    return scopes.filter((s) => s.id !== SCOPE.COMPANY)
  }
  return scopes
}

export function defaultScope(activeRole, user = null) {
  return scopesFor(activeRole, user)[0]?.id ?? null
}

/**
 * The requests in a scope. Always a subset of what the viewer may view.
 *   BD   Mine     = requests I own (bdOwner) + my own drafts
 *        Company  = other BD owners' non-draft requests (view-only)
 *   AM   My brand = my brand's non-draft requests
 *        Company  = the other brand's non-draft requests (view-only)
 *        Company  = the other brand's non-draft requests (view-only; only with "See all brands")
 *   Head Company  = every non-draft request + my own drafts
 *   Executive Company = every non-draft request (view-only)
 * user = the viewer's user record (for the AM's brand and privileges).
 */
export function requestsInScope(requests, viewer, user, scope) {
  if (!scopesFor(viewer.activeRole, user).some((s) => s.id === scope)) return []
  const visible = requests.filter((r) => canViewRequest(r, viewer.userId) && canSeeBrand(viewer, user, r.brand))
  const role = viewer.activeRole
  if (role === ROLE.BUSINESS_DEVELOPMENT) {
    if (scope === SCOPE.MINE) return visible.filter((r) => (isDraft(r) ? isVisibleDraftFor(r, viewer.userId) : r.bdOwner === viewer.userId))
    if (scope === SCOPE.COMPANY) return visible.filter((r) => !isDraft(r) && r.bdOwner !== viewer.userId)
  }
  if (role === ROLE.ACCOUNT_MANAGER) {
    if (scope === SCOPE.MY_BRAND) return visible.filter((r) => !isDraft(r) && r.brand === user?.brand)
    if (scope === SCOPE.COMPANY) return visible.filter((r) => !isDraft(r) && r.brand !== user?.brand)
  }
  if ((role === ROLE.COMMERCIAL_HEAD || role === ROLE.EXECUTIVE) && scope === SCOPE.COMPANY) {
    return visible.filter((r) => !isDraft(r) || isVisibleDraftFor(r, viewer.userId))
  }
  return []
}

// ---------------------------------------------------------------------------
// Needs my action, deadline state
// ---------------------------------------------------------------------------

/**
 * BD/AM: the request waits on a step I hold (STATUS_CONFIG.waitingOn + permissions),
 *        or it is my draft to complete and submit.
 * Head:  my drafts, and open requests with no status change for more than 3 days.
 */
export function needsMyAction(request, viewer, usersById = {}, now = new Date()) {
  if (isDraft(request)) return canEditDraft(request, viewer, usersById)
  if (!isOpenRequest(request)) return false
  if (request.needsReview) return false // shown as "Review N imported requests" instead, never in queues
  const who = getStatus('proposal', request.status).waitingOn
  // Waiting on someone set by hand: that is the one source of truth (e.g. Marketing — Nada, not the AM).
  const manual = request.waiting?.team ? effectiveWaiting(request) : null
  // A postponed proposal needs BD again only once its follow-up date has come.
  const mine = manual ? manual.userId === viewer.userId : who === 'bd'
    ? holdsResponsibility(ACTOR.BD_OWNER, request, viewer, usersById) && (!isPostponed(request) || followUpDue(request, now))
    : who === 'am' && holdsResponsibility(ACTOR.ASSIGNED_AM, request, viewer, usersById)
  // The Commercial Head watches stuck requests, plus the BD steps on requests she owns herself.
  if (viewer.activeRole === ROLE.COMMERCIAL_HEAD) return isStale(request, now) || mine
  return mine
}

const isPostponed = (r) => r.status === PROPOSAL_STATUS.POSTPONED

/** A postponed proposal whose follow-up date is today or past. */
export function followUpDue(request, now = new Date()) {
  return isPostponed(request) && Boolean(request.followUpOn) && request.followUpOn <= todayISO(now)
}

export const DEADLINE_STATE = {
  OVERDUE: 'overdue',
  UPCOMING: 'upcoming',
  LATER: 'later',
  NONE: 'none',
}

export const DEADLINE_STATE_LABELS = {
  [DEADLINE_STATE.OVERDUE]: 'Overdue',
  [DEADLINE_STATE.UPCOMING]: `Due within ${UPCOMING_WINDOW_DAYS} days`,
  [DEADLINE_STATE.LATER]: 'Due later',
  [DEADLINE_STATE.NONE]: 'No active deadline',
}

/** Uses the existing deadline rules. 'none' = deadline not pending at this status, or no date at all. */
export function deadlineState(request, today) {
  if (isRequestOverdue(request, today)) return DEADLINE_STATE.OVERDUE
  if (isDeadlineUpcoming(request, today)) return DEADLINE_STATE.UPCOMING
  if (isOpenRequest(request) && isDeadlinePending(request) && request.requiredBy) {
    return DEADLINE_STATE.LATER
  }
  return DEADLINE_STATE.NONE
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export const TAB = { ALL: 'all', ACTION: 'action', OVERDUE: 'overdue', CLOSED: 'closed' }
export const TABS = [
  { id: TAB.ALL, label: 'All' },
  { id: TAB.ACTION, label: 'Needs my action' },
  { id: TAB.OVERDUE, label: 'Overdue' },
  { id: TAB.CLOSED, label: 'Closed' },
]

function inTab(tab, r, ctx) {
  if (tab === TAB.ACTION) return needsMyAction(r, ctx.viewer, ctx.usersById, ctx.now)
  if (tab === TAB.OVERDUE) return isRequestOverdue(r, ctx.today)
  if (tab === TAB.CLOSED) return getStatus('proposal', r.status).closed
  return true
}

// ---------------------------------------------------------------------------
// Search & filters
// ---------------------------------------------------------------------------

export const SORT = { DEADLINE: 'deadline', UPDATED: 'updated', EVENT: 'event' }
// Default: most recent activity first (newest on top).
export const SORT_OPTIONS = [
  { id: SORT.UPDATED, label: 'Most recent activity' },
  { id: SORT.DEADLINE, label: 'Proposal deadline' },
  { id: SORT.EVENT, label: 'Event date' },
]

export const EMPTY_FILTERS = {
  q: '', brand: '', stage: [], status: [], assignedAM: '', bdOwner: '', deadline: '', waitingOn: '', open: false,
  needsReview: false,
  hideEvents: false, // the Proposals page: a confirmed proposal is an Event and is listed under Events instead
  bucket: '', // the Proposals page's tab: open · with_am · waiting · ready · with_client · postponed · closed
  waiting: '', // "Waiting on" chip: me · bd · am · marketing · operations · client (domain/waiting.js)
}

/** Optional presentation grouping of the result rows. */
export const GROUP = { NONE: '', STAGE: 'stage' }

/** Search by request ID or client name (case-insensitive). */
function matchesSearch(r, q, clientsById) {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return r.id.toLowerCase().includes(needle) || (clientsById[r.clientId]?.name ?? '').toLowerCase().includes(needle)
}

function matchesFilters(r, f, ctx) {
  if (!matchesSearch(r, f.q, ctx.clientsById)) return false
  if (f.brand && r.brand !== f.brand) return false
  if (f.stage?.length && !f.stage.includes(stageOf(r.status))) return false
  if (f.status.length && !f.status.includes(r.status)) return false
  if (f.assignedAM && r.assignedAM !== f.assignedAM) return false
  if (f.bdOwner && r.bdOwner !== f.bdOwner) return false
  if (f.deadline && deadlineState(r, ctx.today) !== f.deadline) return false
  // "Waiting on AM / BD" follows who it is really waiting on now (a manual waiting-on wins), like the chips.
  if (f.waitingOn && !matchesWaitingChip(r, f.waitingOn, ctx.viewer?.userId)) return false
  if (f.open && !isOpenRequest(r)) return false
  if (f.waiting && !matchesWaitingChip(r, f.waiting, ctx.viewer?.userId)) return false
  if (f.needsReview && !r.needsReview) return false
  if (f.hideEvents && r.status === PROPOSAL_STATUS.ACCEPTED) return false
  if (f.bucket && !inBucket(r, f.bucket)) return false
  return true
}

export function activeFilterCount(filters) {
  return Object.entries(filters).filter(([, v]) => (Array.isArray(v) ? v.length : Boolean(v))).length
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

const closed = (r) => getStatus('proposal', r.status).closed
const byText = (a, b) => (a ?? '').localeCompare(b ?? '')

/**
 * Default (deadline), in three groups:
 *   1. open requests whose proposal deadline still applies (STATUS_CONFIG.deadlinePending),
 *      soonest first, so overdue and upcoming work is at the top;
 *   2. other open requests and drafts (e.g. Ready for BD / Shared with Client, whose deadline
 *      no longer applies), by their recorded deadline;
 *   3. closed requests, most recently updated first.
 * Missing dates are never invented; they sort after dated items in their group.
 */
const sortGroup = (r) => (closed(r) ? 2 : isOpenRequest(r) && isDeadlinePending(r) ? 0 : 1)

export function sortRequests(rows, sort = SORT.DEADLINE) {
  const withDate = (field) => (a, b) => {
    if (!a[field] && !b[field]) return 0
    if (!a[field]) return 1
    if (!b[field]) return -1
    return byText(a[field], b[field])
  }
  const updatedDesc = (a, b) => byText(b.lastUpdated, a.lastUpdated)
  const eventStart = (r) => eventStartDate(r.eventDate, r.eventDatePrecision)

  return [...rows].sort((a, b) => {
    if (sort === SORT.UPDATED) return updatedDesc(a, b) || byText(a.id, b.id)
    if (closed(a) !== closed(b)) return closed(a) ? 1 : -1 // closed last
    if (closed(a)) return updatedDesc(a, b) || byText(a.id, b.id)
    if (sort === SORT.EVENT) {
      return withDate('_event')({ _event: eventStart(a) }, { _event: eventStart(b) }) || byText(a.id, b.id)
    }
    return sortGroup(a) - sortGroup(b) || withDate('requiredBy')(a, b) || byText(a.id, b.id)
  })
}

// ---------------------------------------------------------------------------
// Whole query
// ---------------------------------------------------------------------------

/**
 * scope -> filters -> tab counts -> tab -> sort.
 * ctx = { viewer, user, usersById, clientsById, today, now }
 * -> { scoped, rows, counts: { all, action, overdue, closed } }
 */
export function queryTracker(requests, state, ctx) {
  const scoped = requestsInScope(requests, ctx.viewer, ctx.user, state.scope)
  const filtered = scoped.filter((r) => matchesFilters(r, state.filters, ctx))
  const counts = Object.fromEntries(TABS.map((t) => [t.id, filtered.filter((r) => inTab(t.id, r, ctx)).length]))
  const rows = sortRequests(filtered.filter((r) => inTab(state.tab, r, ctx)), state.sort)
  // The Proposals tabs' counts: every other filter applied, not the tab itself.
  const unbucketed = state.filters.bucket ? scoped.filter((r) => matchesFilters(r, { ...state.filters, bucket: '' }, ctx)) : filtered
  const bucketCounts = Object.fromEntries(PROPOSAL_TABS.map((t) => [t.id, unbucketed.filter((r) => inBucket(r, t.id)).length]))
  return { scoped, rows, counts, bucketCounts }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** Everything a row/card shows, derived from the shared record. */
export function trackerRow(r, ctx) {
  const responsible = responsibleFor(r)
  const editable = isDraft(r) && canEditDraft(r, ctx.viewer, ctx.usersById)
  return {
    request: r,
    id: r.id,
    href: editable ? editDraftLink(r.id) : proposalLink(r.id),
    opensEditor: editable,
    clientName: ctx.clientsById[r.clientId]?.name ?? '—',
    brandName: getBrand(r.brand)?.name ?? r.brand,
    serviceName: r.service ? serviceLabel(r.brand, r.service) : '—',
    eventDateLabel: formatEventDate(r.eventDate, r.eventEndDate),
    deadlineState: deadlineState(r, ctx.today),
    deadlineActive: isOpenRequest(r) && isDeadlinePending(r),
    statusLabel: getStatus('proposal', r.status).label,
    stage: stageOf(r.status),
    stageLabel: getStage(stageOf(r.status)).label,
    subLabel: subLabelFor(r.status, r.version),
    // Keep "Ready for BD" (internal) visibly distinct from "Shared with Client".
    statusHint: r.status === PROPOSAL_STATUS.READY_FOR_BD ? 'Not yet shared with the client' : null,
    waitingOn: responsible ? { userId: responsible.userId, role: responsible.role } : null,
    needsMyAction: needsMyAction(r, ctx.viewer, ctx.usersById, ctx.now),
  }
}

/** Rows grouped by display stage (stage order), keeping each group's sort order. Empty groups are left out. */
export function groupByStage(rows) {
  return stageList()
    .map((st) => ({ stage: st.id, label: st.label, rows: rows.filter((r) => stageOf((r.request ?? r).status) === st.id) }))
    .filter((g) => g.rows.length)
}

// ---------------------------------------------------------------------------
// URL state (also reads the existing dashboard links)
// ---------------------------------------------------------------------------

const STATUS_IDS = statusList('proposal').map((s) => s.id)
const BRAND_IDS = BRANDS.map((b) => b.id)
const STAGE_IDS = stageList().map((s) => s.id)

/**
 * URL -> tracker state. Unknown or not-allowed values are ignored (fall back to defaults).
 * Reads: scope, tab, q, brand, stage (comma list), status (comma list), assignedAM, bdOwner,
 *        deadline, waitingOn, open=true, sort, group=stage.
 */
export function parseTrackerParams(params, viewer, users) {
  const get = (k) => params.get(k) ?? ''
  const me = users.find((u) => u.id === viewer.userId) ?? null
  const scopes = scopesFor(viewer.activeRole, me).map((s) => s.id)
  const userIds = new Set(users.map((u) => u.id))
  const amIds = new Set(users.filter((u) => u.roles.includes(ROLE.ACCOUNT_MANAGER)).map((u) => u.id))
  const bdIds = new Set(users.filter((u) => u.roles.includes(ROLE.BUSINESS_DEVELOPMENT)).map((u) => u.id))
  return {
    scope: scopes.includes(get('scope')) ? get('scope') : defaultScope(viewer.activeRole, me),
    tab: TABS.some((t) => t.id === get('tab')) ? get('tab') : TAB.ALL,
    sort: SORT_OPTIONS.some((s) => s.id === get('sort')) ? get('sort') : SORT.UPDATED,
    group: get('group') === GROUP.STAGE ? GROUP.STAGE : GROUP.NONE,
    filters: {
      q: get('q'),
      brand: BRAND_IDS.includes(get('brand')) ? get('brand') : '',
      stage: get('stage').split(',').filter((s) => STAGE_IDS.includes(s)),
      status: get('status').split(',').filter((s) => STATUS_IDS.includes(s)),
      assignedAM: amIds.has(get('assignedAM')) && userIds.has(get('assignedAM')) ? get('assignedAM') : '',
      bdOwner: bdIds.has(get('bdOwner')) ? get('bdOwner') : '',
      deadline: Object.values(DEADLINE_STATE).includes(get('deadline')) ? get('deadline') : '',
      waitingOn: ['am', 'bd'].includes(get('waitingOn')) ? get('waitingOn') : '',
      open: get('open') === 'true',
      needsReview: get('needsReview') === 'true',
      waiting: WAITING_CHIP_IDS.includes(get('waiting')) ? get('waiting') : '',
    },
  }
}

/** Tracker state -> URL params (defaults omitted so links stay short and shareable). */
export function trackerParams(state, viewer) {
  const out = {}
  if (state.scope && state.scope !== defaultScope(viewer.activeRole)) out.scope = state.scope
  if (state.tab !== TAB.ALL) out.tab = state.tab
  if (state.sort !== SORT.UPDATED) out.sort = state.sort
  if (state.group) out.group = state.group
  const f = state.filters
  if (f.q.trim()) out.q = f.q.trim()
  for (const k of ['brand', 'assignedAM', 'bdOwner', 'deadline', 'waitingOn']) if (f[k]) out[k] = f[k]
  if (f.stage?.length) out.stage = f.stage.join(',')
  if (f.status.length) out.status = f.status.join(',')
  if (f.open) out.open = 'true'
  if (f.needsReview) out.needsReview = 'true'
  if (f.waiting) out.waiting = f.waiting
  return out
}

// ---------------------------------------------------------------------------
// The Proposals page's tabs: one home for every proposal (an Event is never a proposal)
// ---------------------------------------------------------------------------

export const PROPOSAL_TABS = [
  { id: 'open', label: 'All open' },
  { id: 'with_am', label: 'With AM' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'ready', label: 'Ready for BD' },
  { id: 'with_client', label: 'With client' },
  { id: 'postponed', label: 'Postponed' },
  { id: 'closed', label: 'Closed' },
]
export const PROPOSAL_TAB_IDS = PROPOSAL_TABS.map((t) => t.id)
const WAITING_TEAMS = ['bd', 'marketing', 'operations', 'management']

/**
 * Where a proposal lives: with_am · waiting (on BD, Marketing, Operations or management) · ready ·
 * with_client · postponed · closed (lost, cancelled before confirmation) · draft. An Event (accepted) -> null.
 */
export function proposalBucket(r) {
  const s = r.status
  if (s === PROPOSAL_STATUS.ACCEPTED) return null
  if (s === PROPOSAL_STATUS.DRAFT) return 'draft'
  if ([PROPOSAL_STATUS.REJECTED, PROPOSAL_STATUS.CANCELLED, PROPOSAL_STATUS.CLOSED_UNRECORDED, PROPOSAL_STATUS.CLOSED_POSTPONED].includes(s)) return 'closed'
  if (s === PROPOSAL_STATUS.POSTPONED) return 'postponed'
  if (s === PROPOSAL_STATUS.SHARED_WITH_CLIENT) return 'with_client'
  if (s === PROPOSAL_STATUS.READY_FOR_BD) return 'ready'
  if (s === PROPOSAL_STATUS.AWAITING_BD_INFO) return 'waiting'
  const w = r.waiting?.team ? effectiveWaiting(r) : null
  if (w && WAITING_TEAMS.includes(w.team)) return 'waiting'
  return 'with_am'
}

/** Is it in this Proposals tab? ("open" = every proposal not closed, drafts included). */
export function inBucket(r, tab) {
  const b = proposalBucket(r)
  if (b === null) return false
  return tab === 'open' ? b !== 'closed' : b === tab
}
