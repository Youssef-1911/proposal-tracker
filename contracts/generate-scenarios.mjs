// Generates contracts/proposal-scenarios.json from the FRONTEND rules (the behavioural reference).
//
//   node contracts/generate-scenarios.mjs           recompute expectations on the EXISTING frozen world
//   node contracts/generate-scenarios.mjs --fresh   rebuild the world from today's demo seed (all dates move)
//
// By default the frozen world and "now" are reused, so a regeneration only changes what
// the rules changed (making the diff reviewable).
//
// Regenerate ONLY when a business rule intentionally changes. The JSON is then checked by:
//   - frontend/tests/contracts.test.mjs  (the JavaScript rules still produce these answers)
//   - backend/tests/test_contracts.py    (the Python rules and the API produce the same answers)
// so the two implementations cannot drift apart silently.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createDemoData, demoProposalFiles } from '../frontend/src/demo/seed.js'
import {
  COMMENT_MAX_LENGTH, PROPOSAL_FILE_MAX_BYTES, PROPOSAL_FILE_TYPES, UPLOAD_STATUSES, canSeeReplacedFiles, uploadTarget,
  validateComment,
} from '../frontend/src/domain/proposalFiles.js'
import { TRANSITIONS, applyAction, getActions, canEditDraft, validateRequestFields } from '../frontend/src/domain/workflow.js'
import {
  pricePerParticipant, proposalVersions, responsibleFor, stageTiming,
} from '../frontend/src/domain/proposals.js'
import { isOpenRequest, isRequestOverdue, isDeadlinePending, waitingOn, todayISO } from '../frontend/src/domain/metrics.js'
import { LOST_REASONS, SHARE_CHANNELS, STATUS_CONFIG, stageList, stageOf, subLabelFor } from '../frontend/src/domain/status.js'
import { BRAND_AM_ROUTING } from '../frontend/src/domain/routing.js'
import { checkActors } from '../frontend/src/domain/permissions.js'
import {
  canCreateClient, canEditOpportunity, clientPermissions, findPossibleDuplicateClients, manualStageTargets, newClientOwner,
  normalizePhone, transferPlan, validateClientFields, validateContactFields, validateOpportunityFields, validateStageMove,
  validateTransfer, searchClients, didYouMean,
} from '../frontend/src/domain/crm.js'
import {
  canManageEvent, canSeeEvent, canSeeEventPrice, canSeePipelineItem, eventActions, eventStatusOf, eventTiming, pipelineItem,
  validateEventCancel, validateEventDateChange, validateEventPostpone,
} from '../frontend/src/domain/events.js'
import { canRemind, remindTarget } from '../frontend/src/domain/reminders.js'
import { radarItems } from '../frontend/src/domain/radar.js'
import { myWorkSection, stuckDays } from '../frontend/src/domain/myWork.js'
import { validateTodo } from '../frontend/src/domain/todos.js'
import {
  canRate, canSeeRatings, canSetFacilitatorsNeeded, clashes, facilitatorRecord, possibleDuplicates, staffingTotals, suggestedNeeded,
  validateRating,
} from '../frontend/src/domain/staffing.js'
import {
  CORRECTION_TARGET_IDS, PAST_OUTCOMES, canAddPastRecord, canCorrectStatus, correctionNote, pastHistory, plainStatus, stageForStatus,
  validateCorrection, validatePastRecord,
} from '../frontend/src/domain/corrections.js'
import { activityItems, findMentions, messageRecipients, newForYou, newRecipients } from '../frontend/src/domain/activity.js'
import { openChangeIds } from '../frontend/src/domain/conversation.js'
import { DEFAULT_LISTS, LIST_DEFS, effectiveLists, validateListChange } from '../frontend/src/domain/lists.js'
import { canClearWaitingOn, canSetWaitingOn, effectiveWaiting, validateWaitingOn } from '../frontend/src/domain/waiting.js'
import {
  canAskQuestion, canPostMessage, canUpdateDetails, changeKind, openQuestionIds, validateDetailsUpdate, validateMessage,
} from '../frontend/src/domain/conversation.js'
import {
  EMPTY_FILTERS, SORT, TAB, TABS, deadlineState, followUpDue, needsMyAction, queryTracker, scopesFor,
} from '../frontend/src/domain/tracker.js'
import {
  actsAsBusinessDevelopment, canOwnClients, analyticsBrands, canCommentOnRequest, canSeeAnalytics, canSeeClient, canSeeOpportunity, canSeeRequest, defaultPrivileges,
  pageAccess, privilegesOf, seesProposalData, visibleBrands,
} from '../frontend/src/domain/access.js'
import {
  accountChanges, canDeactivate, canManageAccounts, canReactivate, checkAccountUpdate, deactivationWarnings, initialsFor,
  newAccountId, routingChoices, validateAccountFields, validateRouting, deactivationMove, validateDeactivationMove,
  assignedAmChangeNote,
} from '../frontend/src/domain/accounts.js'

const FILE = new URL('./proposal-scenarios.json', import.meta.url)
const previous = !process.argv.includes('--fresh') && existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null
const NOW = previous ? new Date(previous.now) : new Date()
const TODAY = previous ? previous.today : todayISO(NOW)
const data = previous
  ? { users: previous.world.users, clients: previous.world.clients, opportunities: previous.world.opportunities, proposalRequests: [] }
  : createDemoData()
const year = TODAY.slice(0, 4)
const iso = (daysAgo, hour = 10) => { const d = new Date(NOW); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return d.toISOString() }
const dateIn = (days) => { const d = new Date(NOW); d.setDate(d.getDate() + days); return todayISO(d) }

// ---------- edge cases added to the demo world ----------
const extra = [
  { // Noha's private draft on behalf of Ahmed (only Noha may see or act on it)
    id: `PR-${year}-0090`, opportunityId: 'OPP-0002', clientId: 'c-05', brand: 'grasshoppers', service: 'school_trip',
    bdOwner: 'u-ahmed', createdBy: 'u-noha', assignedAM: BRAND_AM_ROUTING.grasshoppers, status: 'draft',
    submittedAt: null, submittedBy: null, lastUpdated: iso(1), requiredBy: dateIn(8), eventDate: dateIn(40),
    eventDatePrecision: 'day', participants: 80, requirementsSummary: 'Grade 4 trip', specificRequirements: null,
    amPrice: null, version: 1, priceChange: null,
    statusHistory: [{ status: 'draft', changedBy: 'u-noha', role: 'commercial_head', changedAt: iso(1), note: null, version: 1, onBehalfOf: 'u-ahmed' }],
  },
  { // Ahmed's undated draft (drafts may lack a deadline; never invented)
    id: `PR-${year}-0091`, opportunityId: null, clientId: 'c-08', brand: 'teamup', service: 'team_building',
    bdOwner: 'u-ahmed', createdBy: 'u-ahmed', assignedAM: BRAND_AM_ROUTING.teamup, status: 'draft',
    submittedAt: null, submittedBy: null, lastUpdated: iso(0, 8), requiredBy: null, eventDate: null,
    eventDatePrecision: 'day', participants: null, requirementsSummary: null, specificRequirements: null,
    amPrice: null, version: 1, priceChange: null,
    statusHistory: [{ status: 'draft', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(0, 8), note: null, version: 1 }],
  },
  { // Mariam El Khayat's own Grasshoppers request, version 2 in preparation (v1 price kept)
    id: `PR-${year}-0092`, opportunityId: 'OPP-0011', clientId: 'c-01', brand: 'grasshoppers', service: 'school_trip',
    bdOwner: 'u-mariam-elkhayat', createdBy: 'u-mariam-elkhayat', assignedAM: 'u-mariam-elkhayat', status: 'in_progress',
    submittedAt: iso(9), submittedBy: 'u-mariam-elkhayat', lastUpdated: iso(4), requiredBy: dateIn(3), eventDate: dateIn(30),
    eventDatePrecision: 'day', participants: 120, requirementsSummary: 'Revised trip', specificRequirements: null,
    amPrice: null, version: 2, priceChange: null,
    statusHistory: [
      { status: 'draft', changedBy: 'u-mariam-elkhayat', role: 'business_development', changedAt: iso(10), note: null, version: 1 },
      { status: 'submitted', changedBy: 'u-mariam-elkhayat', role: 'business_development', changedAt: iso(9), note: null, version: 1 },
      { status: 'in_progress', changedBy: 'u-mariam-elkhayat', role: 'account_manager', changedAt: iso(8), note: null, version: 1 },
      { status: 'ready_for_bd', changedBy: 'u-mariam-elkhayat', role: 'account_manager', changedAt: iso(7), note: null, version: 1, amPrice: 130000 },
      { status: 'shared_with_client', changedBy: 'u-mariam-elkhayat', role: 'business_development', changedAt: iso(6), note: null, version: 1 },
      { status: 'revision_requested', changedBy: 'u-mariam-elkhayat', role: 'business_development', changedAt: iso(5), note: 'Fewer buses', version: 1, previousRequiredBy: dateIn(-2), requiredBy: dateIn(3) },
      { status: 'in_progress', changedBy: 'u-mariam-elkhayat', role: 'account_manager', changedAt: iso(4), note: null, version: 2 },
    ],
  },
  { // Submitted without a linked opportunity, month-only event date
    id: `PR-${year}-0093`, opportunityId: null, clientId: 'c-12', brand: 'teamup', service: 'family_day',
    bdOwner: 'u-mariam-elkhayat', createdBy: 'u-mariam-elkhayat', assignedAM: BRAND_AM_ROUTING.teamup, status: 'submitted',
    submittedAt: iso(2), submittedBy: 'u-mariam-elkhayat', lastUpdated: iso(2), requiredBy: dateIn(12), eventDate: dateIn(120).slice(0, 7),
    eventDatePrecision: 'month', participants: 200, requirementsSummary: 'Autumn family day', specificRequirements: null,
    amPrice: null, version: 1, priceChange: null,
    statusHistory: [
      { status: 'draft', changedBy: 'u-mariam-elkhayat', role: 'business_development', changedAt: iso(3), note: null, version: 1 },
      { status: 'submitted', changedBy: 'u-mariam-elkhayat', role: 'business_development', changedAt: iso(2), note: null, version: 1 },
    ],
  },
]
// Proposal files (Phase 3B): worlds frozen before files existed get them by the demo seed's rule
// (one per version that reached Ready for BD; PR-…-0015's current file already uploaded).
const FILE_UPLOADED = new Set([`PR-${year}-0015`])
const withFiles = (r) => (r.files ? r : {
  ...r, files: demoProposalFiles(r.statusHistory, { assignedAM: r.assignedAM, fileUploaded: FILE_UPLOADED.has(r.id) }),
})
// ---------- real-data phase: Doaa's own client and request, Postponed, imported, event date ranges ----------
// Added to the frozen world once (kept on later regenerations).
const PHASE_CLIENT = {
  id: 'c-20', name: 'Delta Ventures', type: 'corporate', brands: ['teamup'], city: 'Cairo', owner: 'u-doaa',
  contact: { name: 'Hossam Adel', title: 'HR Director', phone: '+20 100 555 0120', email: 'h.adel@deltaventures.example' },
}
if (!data.clients.some((c) => c.id === PHASE_CLIENT.id)) data.clients.push(PHASE_CLIENT)
const sharedHistory = (by, bd, am) => [
  { status: 'draft', changedBy: by, role: 'business_development', changedAt: iso(12), note: null, version: 1 },
  { status: 'submitted', changedBy: by, role: 'business_development', changedAt: iso(11), note: null, version: 1 },
  { status: 'in_progress', changedBy: am, role: 'account_manager', changedAt: iso(10), note: null, version: 1 },
  { status: 'ready_for_bd', changedBy: am, role: 'account_manager', changedAt: iso(8), note: null, version: 1, amPrice: 90000 },
  { status: 'shared_with_client', changedBy: bd, role: 'business_development', changedAt: iso(6), note: null, version: 1, channel: 'email' },
]
const phaseRequest = (n, over) => ({
  id: `PR-${year}-${n}`, opportunityId: null, clientId: 'c-08', brand: 'teamup', service: 'team_building',
  bdOwner: 'u-ahmed', createdBy: 'u-ahmed', assignedAM: BRAND_AM_ROUTING.teamup, status: 'submitted',
  submittedAt: iso(11), submittedBy: 'u-ahmed', lastUpdated: iso(6), requiredBy: dateIn(5), eventDate: dateIn(40),
  eventDatePrecision: 'day', eventEndDate: null, participants: 60, requirementsSummary: 'Contract case', specificRequirements: null,
  amPrice: null, version: 1, priceChange: null, followUpOn: null, imported: false,
  statusHistory: [
    { status: 'draft', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(12), note: null, version: 1 },
    { status: 'submitted', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(11), note: null, version: 1 },
  ],
  ...over,
})
const PHASE_REQUESTS = [
  // Doaa (Executive with "Brings in clients") owns this one: she does its BD steps, nothing else.
  phaseRequest('0094', { clientId: 'c-20', bdOwner: 'u-doaa', createdBy: 'u-doaa', submittedBy: 'u-doaa', status: 'shared_with_client',
    amPrice: 90000, statusHistory: sharedHistory('u-doaa', 'u-doaa', BRAND_AM_ROUTING.teamup).map((e) => (e.role === 'business_development' ? { ...e, role: 'executive' } : e)) }),
  // Postponed, follow-up due (needs BD again) and not yet due (waiting on purpose).
  phaseRequest('0095', { status: 'postponed', followUpOn: dateIn(-1), statusHistory: [...sharedHistory('u-ahmed', 'u-ahmed', BRAND_AM_ROUTING.teamup),
    { status: 'postponed', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(5), note: 'Budget review', version: 1, followUpOn: dateIn(-1) }], amPrice: 90000 }),
  phaseRequest('0096', { status: 'postponed', followUpOn: dateIn(10), statusHistory: [...sharedHistory('u-ahmed', 'u-ahmed', BRAND_AM_ROUTING.teamup),
    { status: 'postponed', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(5), note: null, version: 1, followUpOn: dateIn(10) }], amPrice: 90000 }),
  // Imported from the 2026 tracker: In Progress, no file and no price (exempt from both).
  phaseRequest('0097', { status: 'in_progress', imported: true, requiredBy: null, participants: null, lastUpdated: iso(20),
    statusHistory: [{ status: 'in_progress', changedBy: 'u-noha', role: 'commercial_head', changedAt: iso(20), note: 'Imported from Proposal Tracker 2026 (row #7)', version: 1, imported: true }] }),
  // Imported "Pending" without a proposal date: In Progress + "Needs review" — no deadline counts, never in queues.
  phaseRequest('0100', { status: 'in_progress', imported: true, needsReview: true, requiredBy: dateIn(-5), lastUpdated: iso(30),
    statusHistory: [{ status: 'in_progress', changedBy: 'u-noha', role: 'commercial_head', changedAt: iso(30), note: 'Imported from Proposal Tracker 2026 (row #8)', version: 1, imported: true }] }),
  // Events (Won requests): imported "Event Completed" without a date (Done), imported "Approved" without a
  // date (Date not set), and a Won month-only event (by month).
  phaseRequest('0101', { status: 'accepted', imported: true, originalStatus: 'Event Completed', eventDatePrecision: 'unset',
    eventDate: null, eventName: 'Ramadan Iftar Riders – Alex', requiredBy: null, lastUpdated: iso(40),
    statusHistory: [{ status: 'accepted', changedBy: 'u-noha', role: 'commercial_head', changedAt: iso(40), note: 'Imported from Proposal Tracker 2026 (row #13)', version: 1, imported: true }] }),
  phaseRequest('0102', { status: 'accepted', imported: true, originalStatus: 'Approved', eventDatePrecision: 'unset',
    eventDate: null, eventName: 'Giveaways', requiredBy: null, lastUpdated: iso(20),
    statusHistory: [{ status: 'accepted', changedBy: 'u-noha', role: 'commercial_head', changedAt: iso(20), note: 'Imported from Proposal Tracker 2026 (row #9)', version: 1, imported: true }] }),
  phaseRequest('0103', { status: 'accepted', eventDatePrecision: 'month', eventDate: dateIn(-45).slice(0, 7), eventName: 'Summer team day',
    statusHistory: [...sharedHistory('u-ahmed', 'u-ahmed', BRAND_AM_ROUTING.teamup),
      { status: 'accepted', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(3), note: null, version: 1 }], amPrice: 90000 }),
  // Event date range, and "Date not set yet".
  phaseRequest('0098', { eventEndDate: dateIn(42) }),
  phaseRequest('0099', { eventDatePrecision: 'unset', eventDate: null }),
  // "Set waiting on" by hand: Operations (anyone in the team), supplier prices, expected in 3 days.
  phaseRequest('0104', { status: 'in_progress', briefTags: ['transport', 'outdoor'],
    waiting: { team: 'operations', userId: null, reason: 'supplier_prices', expectedBy: dateIn(3), note: null, setAt: iso(2), setBy: BRAND_AM_ROUTING.teamup },
    statusHistory: [
      { status: 'draft', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(12), note: null, version: 1 },
      { status: 'submitted', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(11), note: null, version: 1 },
      { status: 'in_progress', changedBy: BRAND_AM_ROUTING.teamup, role: 'account_manager', changedAt: iso(10), note: null, version: 1 },
    ] }),
  // An internal change: BD asked for changes before sharing, the AM is on version 2.
  phaseRequest('0106', { status: 'in_progress', version: 2, amPrice: null, statusHistory: [
    { status: 'draft', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(12), note: null, version: 1 },
    { status: 'submitted', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(11), note: null, version: 1 },
    { status: 'in_progress', changedBy: BRAND_AM_ROUTING.teamup, role: 'account_manager', changedAt: iso(10), note: null, version: 1 },
    { status: 'ready_for_bd', changedBy: BRAND_AM_ROUTING.teamup, role: 'account_manager', changedAt: iso(8), note: null, version: 1, amPrice: 90000 },
    { status: 'revision_requested', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(7), note: 'Contract: cheaper buses', version: 1, reasons: ['price'] },
    { status: 'in_progress', changedBy: BRAND_AM_ROUTING.teamup, role: 'account_manager', changedAt: iso(6), note: null, version: 2 },
  ] }),
  // History from the 2026 tracker closed without a result, and closed while postponed.
  phaseRequest('0108', { status: 'closed_unrecorded', imported: true, originalStatus: 'Pending', requiredBy: null, lastUpdated: iso(25),
    statusHistory: [
      { status: 'shared_with_client', changedBy: 'u-noha', role: 'commercial_head', changedAt: iso(30), note: 'Imported from Proposal Tracker 2026 (row #20)', version: 1, imported: true },
      { status: 'closed_unrecorded', changedBy: 'u-noha', role: 'commercial_head', changedAt: iso(25), note: 'Closed — historical data from the 2026 tracker', version: 1, imported: true },
    ] }),
  phaseRequest('0109', { status: 'closed_postponed', imported: true, originalStatus: 'Postponed', requiredBy: null, lastUpdated: iso(25),
    statusHistory: [
      { status: 'closed_postponed', changedBy: 'u-noha', role: 'commercial_head', changedAt: iso(25), note: 'Imported from Proposal Tracker 2026 (row #21)', version: 1, imported: true },
    ] }),
  // A conversation: the AM asks, BD answers, BD asks for a change (picked up), a message mentioning Noha.
  phaseRequest('0110', { status: 'in_progress', statusHistory: [
      { status: 'draft', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(12), note: null, version: 1 },
      { status: 'submitted', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(11), note: null, version: 1 },
      { status: 'in_progress', changedBy: BRAND_AM_ROUTING.teamup, role: 'account_manager', changedAt: iso(10), note: null, version: 1 },
    ],
    comments: [
      { id: 1, kind: 'question', body: 'Is the 150 participants final?', about: 'participants', parentId: null, reasons: [], author: BRAND_AM_ROUTING.teamup, role: 'account_manager', createdAt: iso(9) },
      { id: 2, kind: 'answer', body: 'Yes, final.', about: null, parentId: 1, reasons: [], author: 'u-ahmed', role: 'business_development', createdAt: iso(8) },
      { id: 3, kind: 'change', body: 'Cheaper buses please', about: 'client', parentId: null, reasons: ['price', 'transport'], author: 'u-ahmed', role: 'business_development', createdAt: iso(7) },
      { id: 4, kind: 'picked_up', body: 'Picked up', about: null, parentId: 3, reasons: [], author: BRAND_AM_ROUTING.teamup, role: 'account_manager', createdAt: iso(6) },
      { id: 5, kind: 'comment', body: 'Draft attached — @Noha El Kenawy please check', about: null, parentId: null, reasons: [], author: BRAND_AM_ROUTING.teamup, role: 'account_manager', createdAt: iso(5) },
      { id: 6, kind: 'change', body: '', about: 'internal', parentId: null, reasons: ['design'], author: 'u-noha', role: 'commercial_head', createdAt: iso(4) },
    ] }),
  // A confirmed event that was then cancelled ("Cancelled after confirmation", never Done).
  phaseRequest('0107', { status: 'accepted', eventDate: dateIn(20), eventCancelledAt: iso(1), eventCancelReason: 'budget',
    statusHistory: [...sharedHistory('u-ahmed', 'u-ahmed', BRAND_AM_ROUTING.teamup),
      { status: 'accepted', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(3), note: null, version: 1 }], amPrice: 90000 }),
  // Event statuses: Initially confirmed (planning only, in 3 days) and Postponed (on hold).
  phaseRequest('0111', { status: 'accepted', eventStatus: 'initial', eventDate: dateIn(3), eventName: 'Preliminary offsite',
    statusHistory: [...sharedHistory('u-ahmed', 'u-ahmed', BRAND_AM_ROUTING.teamup),
      { status: 'accepted', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(2), note: null, version: 1 }], amPrice: 70000 }),
  phaseRequest('0112', { status: 'accepted', eventStatus: 'postponed', eventDate: dateIn(30), eventPostponeReason: 'other',
    eventPostponeNote: 'Client moved the budget', statusHistory: [...sharedHistory('u-ahmed', 'u-ahmed', BRAND_AM_ROUTING.teamup),
      { status: 'accepted', changedBy: 'u-ahmed', role: 'business_development', changedAt: iso(4), note: null, version: 1 }], amPrice: 70000 }),
  // Two roles: Mariam El Khayat submitted as BD; it routes to her as the Grasshoppers AM (New for her there only).
  phaseRequest('0113', { brand: 'grasshoppers', service: 'school_trip', clientId: 'c-01', bdOwner: 'u-mariam-elkhayat', createdBy: 'u-mariam-elkhayat',
    submittedBy: 'u-mariam-elkhayat', assignedAM: 'u-mariam-elkhayat', status: 'submitted',
    statusHistory: [
      { status: 'draft', changedBy: 'u-mariam-elkhayat', role: 'business_development', changedAt: iso(3), note: null, version: 1 },
      { status: 'submitted', changedBy: 'u-mariam-elkhayat', role: 'business_development', changedAt: iso(2), note: null, version: 1 },
    ],
    events: [{ id: 1, event: 'details_updated', changedBy: 'u-mariam-elkhayat', role: 'business_development', changedAt: iso(1),
      toUser: null, details: { changes: [] } }] }),
  // Waiting on the client by hand (a shared proposal): budget approval.
  phaseRequest('0105', { status: 'shared_with_client', amPrice: 90000, statusHistory: sharedHistory('u-ahmed', 'u-ahmed', BRAND_AM_ROUTING.teamup),
    waiting: { team: 'client', userId: null, reason: 'budget_approval', expectedBy: null, note: null, setAt: iso(4), setBy: 'u-ahmed' } }),
]
const baseRequests = previous ? previous.world.requests : [...data.proposalRequests, ...extra]
const requests = [...baseRequests, ...PHASE_REQUESTS.filter((p) => !baseRequests.some((r) => r.id === p.id))].map(withFiles)

// ---------- people (accounts phase: job titles, emails, privileges, new roles) ----------
// The demo seed's people (Doaa and Tony included), plus test-only people the contract needs:
// a Marketing and an Operations person, a Team Up AM with "See all brands", a deactivated AM.
const seedUsers = Object.fromEntries(createDemoData().users.map((u) => [u.id, u]))
const TEST_USERS = [
  { id: 'u-mona', name: 'Mona Fathy', roles: ['marketing'], brand: null, jobTitle: 'Marketing Specialist', email: 'mona@eventflow.example' },
  { id: 'u-karim', name: 'Karim Adel', roles: ['operations'], brand: null, jobTitle: 'Operations Coordinator', email: 'karim@eventflow.example' },
  { id: 'u-clara', name: 'Clara Eshak', roles: ['hr'], brand: null, jobTitle: 'HR', email: 'clara@eventflow.example' },
  { id: 'u-hana', name: 'Hana Wahba', roles: ['account_manager'], brand: 'teamup', jobTitle: 'Account Manager', email: 'hana@eventflow.example',
    privileges: { ...defaultPrivileges(['account_manager']), seeAllBrands: true } },
  { id: 'u-nour', name: 'Nour Hamdy', roles: ['account_manager'], brand: 'grasshoppers', jobTitle: 'Account Manager', email: 'nour@eventflow.example', active: false },
].map((u, i) => ({ initials: initialsFor(u.name), avatarTone: (i % 6) + 1, active: true, privileges: defaultPrivileges(u.roles), ...u }))
const testById = Object.fromEntries(TEST_USERS.map((u) => [u.id, u]))
const userIds = [...new Set([...data.users.map((u) => u.id), ...Object.keys(seedUsers), ...TEST_USERS.map((u) => u.id)])]
const USER_KEYS = ['id', 'name', 'roles', 'brand', 'initials', 'avatarTone', 'jobTitle', 'email', 'active', 'privileges']
const only = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))
const users = userIds.map((id) => only(seedUsers[id] ?? testById[id] ?? data.users.find((u) => u.id === id), USER_KEYS))
const usersById = Object.fromEntries(users.map((u) => [u.id, u]))
const clientsById = Object.fromEntries(data.clients.map((c) => [c.id, c]))
const VIEWERS = [
  { userId: 'u-noha', activeRole: 'commercial_head' },
  { userId: 'u-mariam-elkhayat', activeRole: 'business_development' },
  { userId: 'u-mariam-elkhayat', activeRole: 'account_manager' },
  { userId: 'u-mariam-dimitri', activeRole: 'account_manager' },
  { userId: 'u-abdelrahman', activeRole: 'business_development' },
  { userId: 'u-sherine', activeRole: 'business_development' },
  { userId: 'u-ahmed', activeRole: 'business_development' },
  // Accounts phase: read-only, no proposal data, and an AM with "See all brands".
  { userId: 'u-doaa', activeRole: 'executive' },
  { userId: 'u-mona', activeRole: 'marketing' },
  { userId: 'u-karim', activeRole: 'operations' },
  { userId: 'u-hana', activeRole: 'account_manager' },
]
const ACTION_KEYS = ['action', 'label', 'to', 'requires', 'notePrompt', 'confirm', 'tone', 'allowed', 'reason']
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))

// ---------- per request ----------
const requestCases = requests.map((r) => ({
  id: r.id,
  isOpen: isOpenRequest(r),
  isClosed: STATUS_CONFIG.proposal[r.status].closed,
  waitingOn: waitingOn(r),
  deadlinePending: isDeadlinePending(r),
  isOverdue: isRequestOverdue(r, TODAY),
  deadlineState: deadlineState(r, TODAY),
  responsible: responsibleFor(r),
  stage: stageOf(r.status),
  subLabel: subLabelFor(r.status, r.version),
  versions: proposalVersions(r),
  amPricePerParticipant: pricePerParticipant(r.amPrice, r.participants),
  timing: stageTiming(r, NOW),
  perViewer: VIEWERS.map((viewer) => ({
    viewer,
    canView: canSeeRequest(r, viewer, usersById),
    canComment: canCommentOnRequest(r, viewer, usersById),
    canEditDraft: canEditDraft(r, viewer, usersById),
    needsMyAction: needsMyAction(r, viewer, usersById, NOW),
    actions: getActions(r, viewer, usersById).map((a) => pick(a, ACTION_KEYS)),
    upload: uploadTarget(r, viewer, usersById),
    seesReplacedFiles: canSeeReplacedFiles(r, viewer),
  })),
}))

// ---------- tracker queries ----------
const ctxFor = (viewer) => ({ viewer, user: usersById[viewer.userId], usersById, clientsById, today: TODAY, now: NOW })
const runQuery = (viewer, state) => {
  const out = queryTracker(requests, { ...state, filters: { ...EMPTY_FILTERS, ...(state.filters ?? {}) } }, ctxFor(viewer))
  return { ids: out.rows.map((r) => r.id), counts: out.counts, bucketCounts: out.bucketCounts, scopeSize: out.scoped.length }
}
const trackerCases = []
for (const viewer of VIEWERS) {
  for (const scope of scopesFor(viewer.activeRole, usersById[viewer.userId]).map((s) => s.id)) {
    for (const tab of TABS.map((t) => t.id)) {
      for (const sort of Object.values(SORT)) {
        const state = { scope, tab, sort, filters: {} }
        trackerCases.push({ viewer, state, expect: runQuery(viewer, state) })
      }
    }
  }
}
const H = VIEWERS[0], MK_BD = VIEWERS[1], MK_AM = VIEWERS[2], MD = VIEWERS[3], AH = VIEWERS[6]
const filterCases = [
  [H, 'company', { q: `pr-${year}-0007` }], [H, 'company', { q: '0007' }], [H, 'company', { q: 'harbor line' }],
  [H, 'company', { q: `PR-${year}-0018` }], [H, 'company', { q: 'Crescent Valley' }], [H, 'company', { q: 'zzz-no-such' }],
  [H, 'company', { brand: 'grasshoppers' }], [H, 'company', { status: ['submitted'] }],
  [H, 'company', { status: ['submitted', 'in_progress'] }], [H, 'company', { status: ['draft'] }],
  [H, 'company', { assignedAM: 'u-mariam-dimitri' }], [H, 'company', { bdOwner: 'u-sherine' }],
  [H, 'company', { waitingOn: 'am' }], [H, 'company', { waitingOn: 'bd' }], [H, 'company', { open: true }],
  [H, 'company', { deadline: 'overdue' }], [H, 'company', { deadline: 'upcoming' }], [H, 'company', { deadline: 'later' }],
  [H, 'company', { deadline: 'none' }], [H, 'company', { status: ['ready_for_bd'] }], [H, 'company', { status: ['shared_with_client'] }],
  [H, 'company', { brand: 'teamup', waitingOn: 'am', bdOwner: 'u-abdelrahman' }],
  [AH, 'mine', { brand: 'grasshoppers', status: ['revision_requested'] }], [AH, 'company', { q: '0018' }],
  [AH, 'mine', { bdOwner: 'u-ahmed', waitingOn: 'am' }], [MK_BD, 'mine', { q: 'crescent' }],
  [MK_AM, 'my_brand', { status: ['submitted', 'in_progress', 'awaiting_bd_info', 'ready_for_bd', 'shared_with_client', 'revision_requested'] }],
  [MD, 'company', { status: ['in_progress'] }], [MD, 'my_brand', { deadline: 'overdue' }],
  // display stages
  [H, 'company', { stage: ['with_am'] }], [H, 'company', { stage: ['ready_to_send', 'with_client'] }],
  [H, 'company', { stage: ['closed'], brand: 'teamup' }], [H, 'company', { stage: ['draft'] }],
  [H, 'company', { stage: ['with_am'], status: ['submitted'] }], [MK_AM, 'my_brand', { stage: ['with_am'] }],
  [AH, 'mine', { stage: ['draft'] }], [MK_BD, 'mine', { stage: ['ready_to_send'] }],
  [H, 'company', { needsReview: true }], [MD, 'my_brand', { needsReview: true }], [H, 'company', { deadline: 'overdue', brand: 'teamup' }],
  // "Waiting on" chips
  [H, 'company', { waiting: 'client' }], [H, 'company', { waiting: 'operations' }], [H, 'company', { waiting: 'bd' }],
  [H, 'company', { waiting: 'am' }], [H, 'company', { waiting: 'marketing' }], [H, 'company', { waiting: 'me' }],
  [AH, 'mine', { waiting: 'me' }], [MD, 'my_brand', { waiting: 'me' }], [MK_AM, 'my_brand', { waiting: 'am', brand: 'grasshoppers' }],
  // The Proposals page: confirmed proposals are Events and are not listed (also not counted in the tabs)
  [H, 'company', { hideEvents: true }], [AH, 'mine', { hideEvents: true }], [H, 'company', { hideEvents: true, stage: ['closed'] }],
  // The Proposals tabs (one home for every proposal): each tab, with the others' counts.
  ...['open', 'with_am', 'waiting', 'ready', 'with_client', 'postponed', 'closed'].map((bucket) => [H, 'company', { hideEvents: true, bucket }]),
  [MD, 'my_brand', { hideEvents: true, bucket: 'with_am' }], [AH, 'mine', { hideEvents: true, bucket: 'open', brand: 'teamup' }],
]
for (const [viewer, scope, filters] of filterCases) {
  // A scope the viewer does not have (e.g. an AM without "See all brands"): the API answers 422, tested there.
  if (!scopesFor(viewer.activeRole, usersById[viewer.userId]).some((sc) => sc.id === scope)) continue
  for (const tab of [TAB.ALL, TAB.ACTION]) {
    const state = { scope, tab, sort: SORT.DEADLINE, filters }
    trackerCases.push({ viewer, state, expect: runQuery(viewer, state) })
  }
}

// ---------- action outcomes ----------
// Each case applies ONE action to the frozen world (cases are independent). extraRequests are
// added to the world for that case only. expect = actionOutcome(applyAction(...)).
const byId = Object.fromEntries(requests.map((r) => [r.id, r]))
const SAMPLE_INPUTS = { // first = valid; the rest are invalid or alternative inputs
  submit: [{}],
  start_work: [{}],
  request_bd_info: [{ note: 'Contract: confirm headcount per grade' }, { note: '  ' }, { reasons: ['budget', 'venue'] },
    { reasons: ['other'] }, { reasons: ['other'], note: 'Contract: the dress code' }, { reasons: ['nope'] }, { reasons: 'budget' }],
  provide_bd_info: [{ note: 'Contract: 60 students' }, {}],
  mark_ready: [{ amPrice: 123000, note: 'Contract: fewer buses, price down EGP 7,000' }, { amPrice: 0 }, { amPrice: 12.5 }, { amPrice: 'abc' }, { amPrice: 123000 }],
  share_with_client: [{ confirmShared: true, channel: 'whatsapp' }, { confirmShared: true }, { channel: 'email' }],
  request_revision: [{ note: 'Contract: half-day option', newRequiredBy: dateIn(3) }, { note: 'x', newRequiredBy: dateIn(-1) }, { note: 'x' },
    { reasons: ['price', 'design'], newRequiredBy: dateIn(3) }, { newRequiredBy: dateIn(3) }],
  start_revision: [{}],
  record_accepted: [{ eventDate: dateIn(30), finalPrice: 95000, finalParticipants: 80, venue: 'Contract: the garden' }, {},
    { eventDate: dateIn(30), eventEndDate: dateIn(29) }, { eventDate: dateIn(30), finalPrice: -1, finalParticipants: 2.5 },
    { eventDate: '2026-02-30' }, { eventDate: dateIn(-3), eventEndDate: dateIn(-2), teamNotes: 'x'.repeat(1001) },
    { eventDate: dateIn(20), eventStatus: 'initial' }, { eventDate: dateIn(20), eventStatus: 'maybe' }],
  record_rejected: [{ lostReason: 'price' }, { lostReason: 'other', note: 'Contract: school changed principal' }, { lostReason: 'other' }, { lostReason: 'cheaper' }],
  cancel: [{ note: 'Contract: client postponed' }, {}],
  request_changes: [{ reasons: ['price', 'design'] }, {}, { reasons: ['other'] }, { reasons: ['other'], note: 'Contract: the venue' }],
  take_back: [{}, { note: 'Contract: fix the transport' }],
  set_outcome_confirmed: [{ eventDate: dateIn(-60), finalPrice: 80000 }, {}],
  set_outcome_lost: [{ lostReason: 'price' }, { lostReason: 'not_recorded' }, {}],
  postpone: [{ followUpOn: dateIn(7), note: 'Contract: decision after the budget review' }, { followUpOn: dateIn(-1) }, {},
    { followUpOn: dateIn(7), reasons: ['seasonal'] }, { followUpOn: dateIn(7), reasons: ['seasonal', 'other'] }],
  resume: [{}],
}

/** The part of applyAction's result both implementations must reproduce exactly (same in contracts.test.mjs). */
function actionOutcome(res) {
  if (!res.ok) return { ok: false, code: res.code, error: res.error, errors: res.errors }
  const r = res.request
  return {
    ok: true, status: r.status, stage: stageOf(r.status), subLabel: subLabelFor(r.status, r.version), version: r.version,
    amPrice: r.amPrice, requiredBy: r.requiredBy, submittedBy: r.submittedBy, submittedAt: r.submittedAt,
    lastUpdated: r.lastUpdated, historyLength: r.statusHistory.length, entry: r.statusHistory.at(-1),
    opportunityChange: res.opportunityChange, warnings: res.warnings, message: res.message,
  }
}

/** A copy of an existing request cut back to its first `keep` history entries (for extra scenarios). */
function variant(baseId, id, keep, over = {}) {
  const base = byId[baseId]
  const statusHistory = base.statusHistory.slice(0, keep)
  const last = statusHistory.at(-1)
  const ready = statusHistory.filter((e) => e.status === 'ready_for_bd' && e.version === last.version).at(-1)
  return {
    ...base, id, status: last.status, version: last.version, amPrice: ready?.amPrice ?? null,
    lastUpdated: last.changedAt, statusHistory,
    files: demoProposalFiles(statusHistory, { assignedAM: base.assignedAM, fileUploaded: over.fileUploaded }),
    ...over,
  }
}

const actionCases = []
const runAction = (name, requestId, action, viewer, input, extraRequests = []) => {
  const all = [...requests, ...extraRequests]
  const request = all.find((r) => r.id === requestId)
  const res = applyAction(request, action, input, {
    viewer, usersById, opportunities: data.opportunities, allRequests: all, clients: data.clients, now: NOW,
  })
  actionCases.push({ name, requestId, action, viewer, input, ...(extraRequests.length ? { extraRequests } : {}), expect: actionOutcome(res) })
}
const vName = (v) => `${v.userId}/${v.activeRole}`
for (const r of requests) {
  for (const t of TRANSITIONS.filter((x) => x.from.includes(r.status))) {
    const [valid, ...others] = SAMPLE_INPUTS[t.action]
    // Viewers holding the responsibility (a precondition such as "no file yet" is then part of the outcome).
    const allowed = VIEWERS.filter((v) => checkActors(t.actors, r, v, usersById).allowed)
    for (const v of allowed) runAction(`${r.id} ${t.action} by ${vName(v)}`, r.id, t.action, v, valid)
    for (const [i, input] of others.entries()) runAction(`${r.id} ${t.action} invalid #${i + 1}`, r.id, t.action, allowed[0], input)
    const denied = VIEWERS.find((v) => canSeeRequest(r, v, usersById) && !allowed.includes(v))
    if (denied) runAction(`${r.id} ${t.action} denied ${vName(denied)}`, r.id, t.action, denied, valid)
    const hidden = VIEWERS.find((v) => !canSeeRequest(r, v, usersById))
    if (hidden) runAction(`${r.id} ${t.action} hidden from ${vName(hidden)}`, r.id, t.action, hidden, valid)
  }
}
runAction('unknown action', `PR-${year}-0017`, 'teleport', H, {})
runAction('action not valid at the current status', `PR-${year}-0017`, 'share_with_client', VIEWERS[4], SAMPLE_INPUTS.share_with_client[0])
// Mark won while another request on the opportunity is open: Won, the other untouched, a warning.
const openSibling = variant(`PR-${year}-0009`, `PR-${year}-9101`, 3)
runAction('Mark won with another open request', `PR-${year}-0009`, 'record_accepted', MK_BD, {}, [openSibling])
runAction('Mark lost with another open request', `PR-${year}-0009`, 'record_rejected', MK_BD, { lostReason: 'competitor' }, [openSibling])
// Mark won on a Lost opportunity reopens it (reopened_after_acceptance).
const onLost = variant(`PR-${year}-0003`, `PR-${year}-9102`, 5)
runAction('Mark won reopens a Lost opportunity', onLost.id, 'record_accepted', VIEWERS[4], {}, [onLost])
// Sharing never moves a Won opportunity backwards.
const onWon = variant(`PR-${year}-0002`, `PR-${year}-9103`, 4)
runAction('Share on a Won opportunity', onWon.id, 'share_with_client', AH, { confirmShared: true, channel: 'email' }, [onWon])
// Mark lost on a Won opportunity: it stays Won; the reason stays on the request's history.
const lostOnWon = variant(`PR-${year}-0002`, `PR-${year}-9104`, 5)
runAction('Mark lost on a Won opportunity', lostOnWon.id, 'record_rejected', AH, { lostReason: 'timing' }, [lostOnWon])
// Version 2 with its file uploaded: Mark ready needs the "what changed" note.
const v2Ready = variant(`PR-${year}-0092`, `PR-${year}-9106`, 7, { fileUploaded: true })
runAction('Mark ready v2 without a change note', v2Ready.id, 'mark_ready', MK_AM, { amPrice: 118000 }, [v2Ready])
runAction('Mark ready v2 with a change note', v2Ready.id, 'mark_ready', MK_AM,
  { amPrice: 118000, note: 'Two buses instead of three, price down EGP 12,000' }, [v2Ready])

// ---------- comment validation ----------
const commentCases = [
  'Please confirm the bus count.', '  trimmed  ', '', '   ', null, 42, '<script>alert(1)</script> & <b>bold</b>',
  'x'.repeat(2000), 'x'.repeat(2001), 'é'.repeat(2000), '😀'.repeat(2000), '😀'.repeat(2001),
].map((body) => ({ body, expect: validateComment(body) }))

// ---------- CRM 1: clients, contacts, opportunities ----------
const crmClients = data.clients.map((c) => ({ ...c, contacts: c.contacts ?? [c.contact] }))
const archivedClient = { ...crmClients.find((c) => c.id === 'c-08'), id: 'c-99', name: 'Archived Test Client', archivedAt: NOW.toISOString() }
const stageMoveInputs = [
  { stage: 'won' }, { stage: 'lost' }, { stage: 'lost', lostReason: 'cheaper' }, { stage: 'lost', lostReason: 'other' },
  { stage: 'lost', lostReason: 'other', note: 'Contract: school changed principal' }, { stage: 'lost', lostReason: 'timing' },
  { stage: 'negotiation' }, { stage: 'negotiation', note: 'Contract: client called back' }, { stage: 'contacted' }, {},
]
const crmCases = {
  clientPermissions: [...crmClients, archivedClient].flatMap((c) => VIEWERS.map((viewer) => ({
    clientId: c.id, archived: Boolean(c.archivedAt), owner: c.owner, viewer, expect: clientPermissions(c, viewer, usersById),
  }))),
  createClient: VIEWERS.map((viewer) => ({ viewer, expect: canCreateClient(viewer, usersById) })),
  newClientOwner: VIEWERS.flatMap((viewer) => ['u-sherine', 'u-mariam-dimitri', 'u-noha', 'u-doaa', 'u-tony', null].map((requested) => ({
    viewer, requested, expect: newClientOwner(viewer, requested, usersById),
  }))),
  opportunityPermissions: data.opportunities.flatMap((o) => VIEWERS.map((viewer) => ({
    opportunityId: o.id, viewer, expect: { edit: canEditOpportunity(o, viewer, usersById), targets: manualStageTargets(o) },
  }))),
  stageMoves: ['OPP-0004', 'OPP-0013', 'OPP-0016', 'OPP-0018'].flatMap((id) => stageMoveInputs.map((input) => ({
    opportunityId: id, input, expect: validateStageMove(data.opportunities.find((o) => o.id === id), input),
  }))),
  clientFields: [
    {}, { name: ' Nile School ', type: 'school', brands: ['grasshoppers'] }, { name: 'x'.repeat(201), type: 'bank', brands: ['other'] },
    { name: 'A', type: 'corporate', brands: ['teamup', 'teamup'], city: ' Cairo ', notes: ' n ' },
  ].map((input) => ({ input, expect: validateClientFields(input) })),
  contactFields: [
    {}, { name: 'Sara', phone: '+20 100 555-0106', email: 'Sara@Example.com', isPrimary: true },
    { name: 'Sara', phone: 'call me', email: 'not-an-email' }, { name: '  ', notes: 'x'.repeat(1001) },
  ].map((input) => ({ input, expect: validateContactFields(input) })),
  opportunityFields: [
    [{}, null], [{ brand: 'teamup', service: 'family_day' }, null],
    [{ brand: 'teamup', service: 'summer_camp', estimatedValue: '12.5', participants: '0' }, null],
    [{ brand: 'grasshoppers', service: 'school_trip', estimatedValue: 150000, participants: '80', eventDate: dateIn(30), nextAction: 'Call', nextActionDate: dateIn(2) }, null],
    [{ brand: 'grasshoppers', service: 'school_trip', eventDatePrecision: 'month', eventDate: dateIn(-40).slice(0, 7) }, null],
    [{ brand: 'teamup', service: 'family_day', eventDate: dateIn(-3), nextActionDate: dateIn(-1) }, null],
    [{ brand: 'teamup', service: 'family_day', eventDate: dateIn(-3), nextActionDate: dateIn(-1) }, { eventDate: dateIn(-3), nextActionDate: dateIn(-1) }],
    [{ brand: 'teamup', service: 'family_day', eventDate: '2027-02-30' }, null],
  ].map(([input, current]) => ({ input, current, expect: validateOpportunityFields(input, { today: TODAY, current }) })),
  phones: ['+20 100 555 0106', '00201005550106', '01005550106', '0100-555-0106', '(02) 2735 1234', '+20 2 2735 1234', '', 'abc']
    .map((phone) => ({ phone, expect: normalizePhone(phone) })),
  duplicates: [
    { name: 'oakpalm american school ', contacts: [] }, { name: 'Oakpalm', contacts: [] }, { name: 'Oak', contacts: [] },
    { name: 'Totally New Client', contacts: [{ phone: crmClients[0].contact.phone.replace('+20 ', '0').replace(/ /g, '-'), email: '' }] },
    { name: 'Another New Client', contacts: [{ phone: '', email: crmClients[1].contact.email.toUpperCase() }] },
    { name: 'Nobody Similar', contacts: [{ phone: '0100 000 0000', email: 'x@y.z' }] },
  ].map((candidate) => ({ candidate, expect: findPossibleDuplicateClients(candidate, crmClients) })),
  transfers: crmClients.flatMap((c) => [true, false].map((moveRequests) => ({
    clientId: c.id, moveRequests, expect: transferPlan(c, { opportunities: data.opportunities, requests }, { moveRequests }),
  }))),
  transferInputs: [
    [{ toOwner: 'u-abdelrahman' }, 'c-07'], [{ toOwner: 'u-mariam-dimitri', reason: 'x' }, 'c-07'],
    [{ toOwner: 'u-sherine', reason: '  Account review  ' }, 'c-07'], [{ toOwner: 'u-sherine', reason: 'x'.repeat(501) }, 'c-07'],
    [{ toOwner: 'u-doaa', reason: 'Doaa brings in clients' }, 'c-07'], [{ toOwner: 'u-tony', reason: 'No' }, 'c-07'],
    [{ toOwner: 'u-noha', reason: 'Noha takes it' }, 'c-07'], [{ toOwner: 'u-nour', reason: 'Inactive' }, 'c-07'],
  ].map(([input, clientId]) => ({ clientId, input, expect: validateTransfer(crmClients.find((c) => c.id === clientId), input, usersById) })),
}

// ---------- Accounts, roles and privileges ----------
const ROUTING = { ...BRAND_AM_ROUTING }
const ROLE_SETS = [
  ['commercial_head'], ['executive'], ['business_development'], ['account_manager'], ['marketing'], ['operations'],
  ['business_development', 'account_manager'], ['executive', 'account_manager'], [],
]
const NOHA = usersById['u-noha']
const accountInputs = [
  {},
  { name: '  Salma Nabil ', email: ' Salma.Nabil@EventFlow.example ', jobTitle: ' Marketing Lead ', roles: ['marketing'] },
  { name: 'Hossam Ali', email: 'NOHA@eventflow.example', roles: ['account_manager'] },
  { name: 'Hossam Ali', email: 'nour@eventflow.example', roles: ['account_manager'], brand: 'teamup' },
  { name: 'Hossam Ali', email: 'hossam@eventflow.example', roles: ['account_manager'], brand: 'other' },
  { name: 'Hossam Ali', email: 'hossam@eventflow', roles: ['ceo'] },
  { name: 'x'.repeat(201), email: 'a@b.co', jobTitle: 'y'.repeat(201), roles: ['executive', 'executive'], brand: 'teamup' },
  { name: 'Rana', email: 'rana@eventflow.example', roles: ['commercial_head'], privileges: { manageAccounts: false, seeAnalytics: 'yes' } },
]
const routedTo = ROUTING.teamup
const accountCases = {
  routing: ROUTING,
  defaults: ROLE_SETS.map((roles) => ({ roles, expect: defaultPrivileges(roles) })),
  privileges: users.map((u) => ({ userId: u.id, expect: privilegesOf(u) })),
  perViewer: VIEWERS.map((viewer) => ({
    viewer,
    expect: {
      seesProposalData: seesProposalData(viewer.activeRole),
      visibleBrands: visibleBrands(viewer, usersById[viewer.userId]),
      scopes: scopesFor(viewer.activeRole, usersById[viewer.userId]).map((s) => s.id),
      pages: pageAccess(viewer, usersById[viewer.userId]),
      analytics: canSeeAnalytics(usersById[viewer.userId], viewer),
      analyticsBrands: analyticsBrands(viewer, usersById[viewer.userId]),
      manageAccounts: canManageAccounts(viewer, usersById),
    },
  })),
  clientVisibility: data.clients.flatMap((c) => VIEWERS.map((viewer) => ({
    clientId: c.id, viewer, expect: canSeeClient(c, viewer, usersById),
  }))),
  opportunityVisibility: data.opportunities.flatMap((o) => VIEWERS.map((viewer) => ({
    opportunityId: o.id, viewer, expect: canSeeOpportunity(o, viewer, usersById),
  }))),
  fields: [
    ...accountInputs.map((input) => ({ input, id: null })),
    { input: { name: 'Noha El Kenawy', email: 'noha@eventflow.example', roles: ['commercial_head'] }, id: 'u-noha' },
  ].map(({ input, id }) => ({ input, id, expect: validateAccountFields(input, { users, id }) })),
  ids: [
    ['Doaa', ['u-noha']], ['Doaa', ['u-doaa']], ['Doaa', ['u-doaa', 'u-doaa-2']], ['  Sara  Mostafa ', []],
    ['Zoë Ångström', []], ['نهى', []], ['', []], ["O'Brien-Smith Jr.", []],
  ].map(([name, existing]) => ({ name, existing, expect: newAccountId(name, existing) })),
  initials: ['Noha El Kenawy', 'Doaa', 'Tony', '  sara  mostafa ', '', 'A'].map((name) => ({ name, expect: initialsFor(name) })),
  updates: [
    ['u-noha', 'u-noha', { ...NOHA, privileges: { ...privilegesOf(NOHA), manageAccounts: false } }],
    ['u-noha', 'u-doaa', { ...usersById['u-doaa'], privileges: { ...privilegesOf(usersById['u-doaa']), manageAccounts: true } }],
    ['u-doaa', 'u-noha', { ...NOHA, privileges: { ...privilegesOf(NOHA), manageAccounts: false } }],
    ['u-noha', routedTo, { ...usersById[routedTo], roles: ['business_development'] }],
    ['u-noha', routedTo, { ...usersById[routedTo], brand: 'grasshoppers' }],
    ['u-noha', 'u-hana', { ...usersById['u-hana'], brand: 'grasshoppers' }],
    ['u-noha', 'u-mariam-elkhayat', { ...usersById['u-mariam-elkhayat'], roles: ['business_development'] }],
  ].map(([actorId, targetId, input]) => {
    const { values } = validateAccountFields(input, { users, id: targetId })
    return { actorId, targetId, input, expect: checkAccountUpdate(usersById[targetId], values, { actorId, users, routing: ROUTING }) }
  }),
  // With an extra manager (Doaa given "Manage accounts"), Noha's own switch can be turned off by Doaa.
  updatesWithTwoManagers: (() => {
    const two = users.map((u) => (u.id === 'u-doaa' ? { ...u, privileges: { ...u.privileges, manageAccounts: true } } : u))
    const { values } = validateAccountFields({ ...NOHA, privileges: { ...privilegesOf(NOHA), manageAccounts: false } }, { users: two, id: 'u-noha' })
    return [{ actorId: 'u-doaa', targetId: 'u-noha', expect: checkAccountUpdate(NOHA, values, { actorId: 'u-doaa', users: two, routing: ROUTING }) }]
  })(),
  deactivate: users.flatMap((target) => ['u-noha', 'u-doaa'].map((actorId) => ({
    actorId, targetId: target.id, expect: canDeactivate(target, { actorId, users, routing: ROUTING }),
  }))),
  reactivate: users.map((u) => ({ userId: u.id, expect: canReactivate(u) })),
  warnings: users.map((u) => ({ userId: u.id, expect: deactivationWarnings(u, { clients: data.clients, requests }) })),
  changes: [
    ['u-ahmed', { name: 'Ahmed Seif', email: 'ahmed.seif@eventflow.example', jobTitle: 'Senior BD', roles: ['business_development'] }],
    ['u-doaa', { ...usersById['u-doaa'], privileges: { ...privilegesOf(usersById['u-doaa']), seeAnalytics: false, manageAccounts: true } }],
    ['u-mariam-dimitri', { ...usersById['u-mariam-dimitri'] }],
    ['u-mona', { ...usersById['u-mona'], roles: ['marketing', 'operations'] }],
  ].map(([id, input]) => {
    const { values } = validateAccountFields(input, { users, id })
    return { userId: id, input, expect: accountChanges(usersById[id], values) }
  }),
  routingChoices: ['grasshoppers', 'teamup'].map((brand) => ({ brand, expect: routingChoices(brand, users).map((u) => u.id) })),
  routingInputs: [
    ['teamup', 'u-hana'], ['teamup', 'u-mariam-dimitri'], ['teamup', 'u-mariam-elkhayat'], ['grasshoppers', 'u-nour'],
    ['grasshoppers', 'u-ahmed'], ['other', 'u-hana'], ['teamup', null],
  ].map(([brand, amId]) => ({ brand, amId, expect: validateRouting(brand, amId, { users, routing: ROUTING }) })),
  // "Brings in clients": who does BD steps without switching role, and who may own clients.
  actsAsBD: VIEWERS.map((viewer) => ({ viewer, expect: actsAsBusinessDevelopment(viewer, usersById[viewer.userId]) })),
  canOwnClients: users.map((u) => ({ userId: u.id, expect: canOwnClients(u) })),
  // Deactivating an Account Manager who still has requests: they move to another AM of the brand.
  deactivationMoves: ['u-mariam-dimitri', 'u-mariam-elkhayat', 'u-hana', 'u-nour', 'u-ahmed'].map((id) => ({
    userId: id, expect: deactivationMove(usersById[id], { users, requests }),
  })),
  deactivationMoveInputs: [
    ['u-mariam-dimitri', { moveTo: 'u-hana' }], ['u-mariam-dimitri', {}], ['u-mariam-dimitri', { moveTo: 'u-mariam-elkhayat' }],
    ['u-mariam-dimitri', { moveTo: 'u-mariam-dimitri' }], ['u-mariam-elkhayat', { moveTo: 'u-hana' }], ['u-ahmed', {}],
  ].map(([id, input]) => ({ userId: id, input, expect: validateDeactivationMove(usersById[id], input, { users, requests }) })),
  amChangeNote: assignedAmChangeNote('Mariam Dimitri', 'Hana Wahba', 'Noha El Kenawy'),
}

// ---------- real-data phase: event dates on requests ----------
const realDataCases = {
  requestFields: [
    [{ clientId: 'c-08', brand: 'teamup', service: 'team_building', eventDatePrecision: 'unset', eventDate: dateIn(30) }, 'submit'],
    [{ clientId: 'c-08', brand: 'teamup', service: 'team_building', eventDate: dateIn(30), eventEndDate: dateIn(32),
      requiredBy: dateIn(5), participants: 40, requirementsSummary: 'Two-day offsite' }, 'submit'],
    [{ clientId: 'c-08', brand: 'teamup', service: 'team_building', eventDate: dateIn(30), eventEndDate: dateIn(29) }, 'draft'],
    [{ clientId: 'c-08', brand: 'teamup', service: 'team_building', eventEndDate: dateIn(29) }, 'draft'],
    [{ clientId: 'c-08', brand: 'teamup', service: 'team_building', eventDatePrecision: 'month', eventDate: dateIn(60).slice(0, 7), eventEndDate: dateIn(70) }, 'draft'],
    [{ clientId: 'c-08', brand: 'teamup', service: 'team_building', requiredBy: dateIn(5), participants: 40, requirementsSummary: 'x' }, 'submit'],
    [{ clientId: 'c-01', brand: 'grasshoppers', service: 'activation' }, 'draft'],
    [{ clientId: 'c-01', brand: 'grasshoppers', service: 'family_day' }, 'draft'],
  ].map(([input, mode]) => ({ input, mode, expect: validateRequestFields(input, { mode, today: TODAY, clients: data.clients, opportunities: data.opportunities }) })),
  opportunityFields: [
    { brand: 'teamup', service: 'family_day', eventDate: dateIn(20), eventEndDate: dateIn(21) },
    { brand: 'teamup', service: 'family_day', eventDate: dateIn(20), eventEndDate: dateIn(19) },
    { brand: 'grasshoppers', service: 'activation', eventDatePrecision: 'month', eventDate: dateIn(60).slice(0, 7), eventEndDate: dateIn(61) },
  ].map((input) => ({ input, expect: validateOpportunityFields(input, { today: TODAY, current: null }) })),
  followUpDue: requests.filter((r) => r.status === 'postponed').map((r) => ({ id: r.id, expect: followUpDue(r, NOW) })),
  eventNameFields: [
    [{ clientId: 'c-08', brand: 'teamup', service: 'team_building', eventName: '  Summer team day ' }, 'draft'],
    [{ clientId: 'c-08', brand: 'teamup', service: 'team_building', eventName: 'x'.repeat(81) }, 'draft'],
  ].map(([input, mode]) => ({ input, mode, expect: validateRequestFields(input, { mode, today: TODAY, clients: data.clients, opportunities: data.opportunities }) })),
  opportunityEventNames: [{ brand: 'teamup', service: 'family_day', eventName: 'Staff day' }, { brand: 'teamup', service: 'family_day', eventName: 'y'.repeat(81) }]
    .map((input) => ({ input, expect: validateOpportunityFields(input, { today: TODAY, current: null }) })),
  // Client field: type to search (and "Did you mean …?" before adding a new one).
  clientSearch: ['harbor', 'SCHOOL', 'oak', 'crescent valley', 'zzz', '', '  ', 'ad'].map((query) => ({ query, expect: searchClients(query, data.clients) })),
  didYouMean: ['Oakpalm American', 'harbor line logistics', 'Nothing Like It', 'Delta', ''].map((name) => ({ name, expect: didYouMean(name, data.clients) })),
  // Events (Won requests): Done / Upcoming / Date not set.
  eventTiming: requests.map((r) => ({ id: r.id, expect: eventTiming(r, TODAY) })),
}

// ---------- waiting on, dropdown lists, brief tags ----------
const DEFAULTS = effectiveLists()
const WAIT_IDS = [`PR-${year}-0002`, `PR-${year}-0005`, `PR-${year}-0007`, `PR-${year}-0017`, `PR-${year}-0094`, `PR-${year}-0096`,
  `PR-${year}-0104`, `PR-${year}-0105`].filter((id) => byId[id])
const pickWaiting = (w) => (w ? { kind: w.kind, team: w.team, userId: w.userId, reason: w.reason, expectedBy: w.expectedBy } : null)
const waitingCases = {
  lists: { definitions: LIST_DEFS, defaults: DEFAULT_LISTS },
  effective: requests.map((r) => ({ id: r.id, expect: pickWaiting(effectiveWaiting(r)) })),
  canSet: WAIT_IDS.flatMap((id) => VIEWERS.map((viewer) => ({ id, viewer, expect: canSetWaitingOn(byId[id], viewer, usersById) }))),
  canClear: WAIT_IDS.flatMap((id) => VIEWERS.map((viewer) => ({ id, viewer, expect: canClearWaitingOn(byId[id], viewer, usersById) }))),
  validate: [
    { team: 'operations', reason: 'supplier_prices', expectedBy: dateIn(3) },
    { team: 'client', userId: 'u-ahmed', reason: 'budget_approval' },
    { team: 'am', reason: 'information_missing' },
    { team: 'am', userId: 'u-mariam-dimitri', reason: 'approval_needed', note: '  ' },
    { team: 'bd', userId: 'u-mariam-dimitri', reason: 'information_missing' },
    { team: 'marketing', reason: 'other' },
    { team: 'marketing', reason: 'other', note: 'Contract: new logo' },
    { team: 'marketing', reason: 'supplier_prices' },
    { team: 'nobody', reason: 'x' },
    { team: 'client', reason: 'awaiting_reply', expectedBy: dateIn(-1) },
    { team: 'client', reason: 'awaiting_reply', expectedBy: '2026-02-30' },
    { team: 'management', userId: 'u-noha', reason: 'approval_needed', note: 'x'.repeat(301) },
  ].map((input) => ({ input, expect: validateWaitingOn(input, { lists: DEFAULTS, usersById, today: TODAY }) })),
  listChanges: [
    ['whatsMissing', { action: 'add', label: 'Dress code' }], ['whatsMissing', { action: 'add', label: 'budget' }],
    ['whatsMissing', { action: 'add', label: '   ' }], ['whatsMissing', { action: 'add', label: '***' }],
    ['briefTags', { action: 'rename', code: 'venue', label: 'Venue needed' }], ['briefTags', { action: 'rename', code: 'venue', label: 'Outdoor' }],
    ['briefTags', { action: 'rename', code: 'nope', label: 'X' }], ['postponeWhy', { action: 'hide', code: 'seasonal' }],
    ['postponeWhy', { action: 'hide', code: 'other' }], ['postponeWhy', { action: 'show', code: 'seasonal' }],
    ['nope', { action: 'add', label: 'X' }], ['cities', { action: 'delete', code: 'cairo' }],
    ['cities', { action: 'add', label: 'Luxor' }], ['cities', { action: 'add', label: 'Aswan' }], ['cities', { action: 'add', label: 'Port Said' }],
  ].map(([listId, input]) => ({ listId, input, expect: validateListChange(DEFAULTS, listId, input) })),
  overrides: { rows: [{ listId: 'cities', code: 'luxor', label: 'Luxor', hidden: false, position: 10 },
    { listId: 'cities', code: 'cairo', label: 'Greater Cairo', hidden: false, position: 0 },
    { listId: 'postponeWhy', code: 'seasonal', label: 'Seasonal / Ramadan', hidden: true, position: 3 }] },
  briefTagFields: [
    [{ clientId: 'c-08', brand: 'teamup', service: 'team_building', briefTags: ['transport', 'outdoor'] }, 'draft'],
    [{ clientId: 'c-08', brand: 'teamup', service: 'team_building', briefTags: ['spaceship'] }, 'draft'],
    [{ clientId: 'c-08', brand: 'teamup', service: 'team_building', briefTags: 'transport' }, 'draft'],
    [{ clientId: 'c-08', brand: 'teamup', service: 'team_building', briefTags: ['venue', 'venue'] }, 'draft'],
  ].map(([input, mode]) => ({ input, mode, expect: validateRequestFields(input, { mode, today: TODAY, clients: data.clients, opportunities: data.opportunities }) })),
}
waitingCases.overrides.expect = effectiveLists(waitingCases.overrides.rows)

// ---------- questions & changes ----------
const MESSAGES = [
  { id: 1, kind: 'comment', parentId: null }, { id: 2, kind: 'question', parentId: null },
  { id: 3, kind: 'question', parentId: null }, { id: 4, kind: 'answer', parentId: 2 },
  { id: 5, kind: 'question', parentId: null }, { id: 6, kind: 'answered', parentId: 5 },
]
const ASK_IDS = [`PR-${year}-0001`, `PR-${year}-0005`, `PR-${year}-0007`, `PR-${year}-0017`, `PR-${year}-0094`, `PR-${year}-0106`]
  .filter((id) => byId[id])
const EVENT_VIEWERS = [...VIEWERS, { userId: 'u-clara', activeRole: 'hr' }]
const eventCases = {
  canSee: requests.flatMap((r) => EVENT_VIEWERS.map((viewer) => ({ id: r.id, viewer, expect: canSeeEvent(r, viewer, usersById) }))),
  seePrice: EVENT_VIEWERS.map((viewer) => ({ viewer, expect: canSeeEventPrice(viewer) })),
  canManage: requests.filter((r) => r.status === 'accepted').flatMap((r) => EVENT_VIEWERS.map((viewer) => ({
    id: r.id, viewer, expect: canManageEvent(r, viewer, usersById) }))),
  dateChanges: [[{ eventDate: dateIn(45) }], [{ eventDate: dateIn(45), eventEndDate: dateIn(44) }], [{}],
    [{ eventDate: '2026-13-01' }], [{ eventDate: dateIn(45), eventEndDate: dateIn(46), note: ' Venue moved ' }]]
    .map(([input]) => ({ id: `PR-${year}-0103`, input, expect: validateEventDateChange(byId[`PR-${year}-0103`], input) })),
  cancels: [{ reason: 'budget' }, { reason: 'other' }, { reason: 'other', note: 'Contract: CEO changed' }, {}, { reason: 'weather' }]
    .map((input) => ({ input, expect: validateEventCancel(input, DEFAULTS) })),
  // Event status (Initially confirmed · Confirmed · Postponed · Cancelled) and what each person may change.
  status: requests.map((r) => ({ id: r.id, expect: eventStatusOf(r) })),
  actions: requests.filter((r) => r.status === 'accepted').flatMap((r) => EVENT_VIEWERS.map((viewer) => ({
    id: r.id, viewer, expect: eventActions(r, viewer, usersById) }))),
  postpones: [{ reason: 'budget_not_approved' }, { reason: 'other' }, { reason: 'other', note: ' Client moved it ' }, {}, { reason: 'warp' },
    { reason: 'other', note: 'x'.repeat(301) }].map((input) => ({ input, expect: validateEventPostpone(input, DEFAULTS) })),
  // The Operations page's pipeline: awareness only (never drafts; exactly these fields).
  pipeline: requests.flatMap((r) => EVENT_VIEWERS.map((viewer) => ({ id: r.id, viewer, expect: canSeePipelineItem(r, viewer, usersById) }))),
  pipelineFields: requests.filter((r) => r.status === 'shared_with_client').slice(0, 3).map((r) => ({ id: r.id, expect: pipelineItem(r) })),
}
const reminderCases = {
  target: requests.map((r) => ({ id: r.id, expect: remindTarget(r) })),
  canRemind: requests.slice(0, 40).flatMap((r) => VIEWERS.map((viewer) => ({ id: r.id, viewer, expect: canRemind(r, viewer, usersById) }))),
}

const CONVO = byId[`PR-${year}-0110`]
const activityCases = {
  mentions: ['@Noha El Kenawy can you check', 'thanks @sherine!', '@mariam please', 'email me@example.com', '@Ahmed Seif and @Doaa',
    'no mention', '@NOHA EL KENAWY'].map((body) => ({ body, expect: findMentions(body, users) })),
  recipients: CONVO.comments.map((m) => ({ id: CONVO.id, messageId: m.id,
    expect: messageRecipients(m, CONVO, usersById, CONVO.comments) })),
  extraRecipients: [
    { kind: 'question', author: 'u-noha', body: 'Who owns this?' },
    { kind: 'comment', author: 'u-doaa', body: 'Looks good @Sherine El Tabakh' },
    { kind: 'change', author: 'u-ahmed', body: 'x', about: 'client', reasons: ['price'] },
    { kind: 'comment', author: 'u-ahmed', body: '@Mona please' },
  ].map((m) => ({ id: CONVO.id, message: m, expect: messageRecipients(m, CONVO, usersById, CONVO.comments) })),
  openChanges: { id: CONVO.id, expect: openChangeIds(CONVO.comments) },
  // New for a person IN A ROLE (Mariam El Khayat has two); her own BD step is new for her as AM.
  newForYou: [...new Set([...requests.filter((r) => r.status !== 'draft').slice(-12), byId[`PR-${year}-0113`]])].flatMap((r) => VIEWERS.flatMap((viewer) => [null, iso(7)].map((lastReadAt) => {
    const got = newForYou(r, viewer, lastReadAt, usersById)
    return { id: r.id, viewer, lastReadAt, expect: got && { line: got.line, count: got.count } }
  }))),
  // The one shared rule: everyone an item is New for also gets a bell notification (with the role it is for).
  newRecipients: [...new Set([byId[`PR-${year}-0113`], CONVO, ...requests.filter((r) => r.status !== 'draft').slice(-6)])]
    .flatMap((r) => activityItems(r, usersById).map((item, i) => ({ id: r.id, index: i, line: item.line, expect: newRecipients(item, usersById) }))),
}

const conversationCases = {
  canAsk: ASK_IDS.flatMap((id) => VIEWERS.map((viewer) => ({ id, viewer, expect: canAskQuestion(byId[id], viewer, usersById) }))),
  canPost: ['comment', 'question', 'answer'].flatMap((kind) => VIEWERS.map((viewer) => ({
    kind, id: `PR-${year}-0005`, viewer, expect: canPostMessage(kind, byId[`PR-${year}-0005`], viewer, usersById) }))),
  canUpdateDetails: ASK_IDS.flatMap((id) => VIEWERS.map((viewer) => ({ id, viewer, expect: canUpdateDetails(byId[id], viewer, usersById) }))),
  openQuestions: { messages: MESSAGES, expect: openQuestionIds(MESSAGES) },
  messages: [
    { kind: 'comment', body: ' Looks good ' }, { kind: 'comment', body: '   ' }, { body: 'No kind given' },
    { kind: 'question', body: 'Which venue?', about: 'venue' }, { kind: 'question', body: 'x', about: 'spaceship' },
    { kind: 'question', body: '' }, { kind: 'answer', body: 'The garden', parentId: 3 }, { kind: 'answer', body: 'Again', parentId: 2 },
    { kind: 'answer', body: 'x', parentId: 1 }, { kind: 'answered', parentId: 3 }, { kind: 'answered', parentId: 5 },
    { kind: 'shout', body: 'x' }, { kind: 'comment', body: 'y'.repeat(2001) },
    { kind: 'change', reasons: ['price'], about: 'client' }, { kind: 'change', reasons: [], about: 'client' },
    { kind: 'change', reasons: ['other'], about: 'internal' }, { kind: 'change', reasons: ['price'], about: 'nobody' },
    { kind: 'change', reasons: ['price', 'warp'], about: 'internal', body: 'x' },
    { kind: 'picked_up', parentId: 2 }, { kind: 'picked_up', parentId: 99 },
  ].map((input) => ({ input, expect: validateMessage(input, { lists: DEFAULTS, messages: MESSAGES }) })),
  details: [
    [`PR-${year}-0005`, { participants: 150 }], [`PR-${year}-0005`, { participants: '0' }], [`PR-${year}-0005`, {}],
    [`PR-${year}-0005`, { eventName: 'Summer day', requirementsSummary: '  New brief  ' }],
    [`PR-${year}-0005`, { requiredBy: dateIn(-2) }], [`PR-${year}-0097`, { participants: 80 }],
    [`PR-${year}-0005`, { eventDatePrecision: 'unset', eventDate: null }],
  ].map(([id, input]) => ({ id, input, expect: validateDetailsUpdate(byId[id], input, { today: TODAY, lists: DEFAULTS }) })),
  changeKind: requests.flatMap((r) => Array.from({ length: r.version }, (_, i) => ({ id: r.id, version: i + 1, expect: changeKind(r, i + 1) }))),
}

// ---------- data fixes: "Correct status" and "Add past proposal or event" ----------
const SHARED = requests.find((r) => r.status === 'shared_with_client')
const correctionInputs = [
  {}, { target: 'nope' }, { target: 'with_am' }, { target: 'with_client' }, { target: 'postponed' },
  { target: 'postponed', followUpOn: dateIn(10) }, { target: 'confirmed' }, { target: 'confirmed', eventDate: dateIn(20), finalPrice: '95000' },
  { target: 'initial', eventDate: dateIn(20), eventEndDate: dateIn(19) }, { target: 'confirmed', eventDate: '2026-02-30', finalPrice: -1 },
  { target: 'lost' }, { target: 'lost', lostReason: 'price', note: '  Went with a cheaper offer ' }, { target: 'lost', lostReason: 'not_recorded' },
  { target: 'cancelled', note: 'x'.repeat(301) }, { target: 'ready', note: 'Typo in the import' },
]
const pastInputs = [
  {}, { brand: 'teamup', service: 'kids_activity' },
  { brand: 'teamup', service: 'team_building', bdOwner: 'u-ahmed', assignedAM: 'u-mariam-dimitri', briefDate: dateIn(-60), outcome: 'with_client' },
  { brand: 'teamup', service: 'team_building', bdOwner: 'u-ahmed', assignedAM: 'u-mariam-dimitri', briefDate: dateIn(-60),
    sentDate: dateIn(-50), outcome: 'done', eventDate: dateIn(-20), amPrice: '90000', finalPrice: '85000', participants: '120' },
  { brand: 'teamup', service: 'team_building', bdOwner: 'u-ahmed', assignedAM: 'u-mariam-dimitri', briefDate: dateIn(-60),
    sentDate: dateIn(-50), outcome: 'done', eventDate: dateIn(20) },
  { brand: 'grasshoppers', service: 'school_trip', bdOwner: 'u-mariam-elkhayat', assignedAM: 'u-mariam-elkhayat', briefDate: dateIn(-30),
    sentDate: dateIn(-40), outcome: 'lost' },
  { brand: 'grasshoppers', service: 'school_trip', bdOwner: 'u-mariam-elkhayat', assignedAM: 'u-mariam-elkhayat', briefDate: dateIn(-30),
    outcome: 'lost', lostReason: 'timing', amPrice: '0', participants: '2.5' },
  { brand: 'teamup', service: 'team_building', bdOwner: 'u-ahmed', assignedAM: 'u-mariam-dimitri', briefDate: dateIn(5), outcome: 'cancelled' },
  { brand: 'teamup', service: 'team_building', bdOwner: 'u-ahmed', assignedAM: 'u-mariam-dimitri', briefDate: dateIn(-10), outcome: 'postponed',
    eventDate: dateIn(30), eventEndDate: dateIn(29) },
  { brand: 'teamup', service: 'team_building', bdOwner: 'u-ahmed', assignedAM: 'u-mariam-dimitri', briefDate: dateIn(-10), outcome: 'confirmed',
    eventDate: dateIn(30), followUpOn: dateIn(3) },
]
const correctionCases = {
  targets: CORRECTION_TARGET_IDS,
  plain: requests.map((r) => ({ id: r.id, expect: plainStatus(r) })),
  stages: [...new Set(requests.map((r) => r.status))].map((status) => ({ status, expect: stageForStatus(status) })),
  canCorrect: requests.slice(-20).flatMap((r) => VIEWERS.map((viewer) => ({ id: r.id, viewer, expect: canCorrectStatus(r, viewer, usersById) }))),
  validate: correctionInputs.map((input) => {
    const got = validateCorrection(input, SHARED)
    return { id: SHARED.id, input, expect: got, note: Object.keys(got.errors).length ? null : correctionNote(got.values) }
  }),
  canAddPast: VIEWERS.flatMap((viewer) => [{}, { clientOwner: 'u-ahmed', brand: 'teamup' }, { clientOwner: 'u-sherine', brand: 'grasshoppers' }]
    .map((ctx) => ({ viewer, ctx, expect: canAddPastRecord(viewer, { client: ctx.clientOwner ? { owner: ctx.clientOwner } : null, brand: ctx.brand }, usersById) }))),
  past: pastInputs.map((input) => {
    const got = validatePastRecord(input, { today: TODAY })
    return { input, expect: got, history: Object.keys(got.errors).length ? null : pastHistory(got.values, TODAY) }
  }),
  pastOutcomes: PAST_OUTCOMES.map((o) => o.id),
}

// ---------- the repeat-client radar ----------
const RT = TODAY
const rq = (id, clientId, over) => ({ id, clientId, status: 'accepted', occasionId: null, submittedAt: null, eventDate: null,
  eventEndDate: null, eventName: null, statusHistory: [], ...over })
const RADAR_CLIENTS = { 'c-a': { name: 'Talabat', owner: 'u-ahmed' }, 'c-b': { name: 'Sodic', owner: 'u-sherine' },
  'c-c': { name: 'Azha', owner: 'u-ahmed' }, 'c-d': { name: 'Fade', owner: 'u-noha' }, 'c-e': { name: 'Nile School', owner: 'u-ahmed' } }
const RADAR_REQUESTS = [
  // a) Ramadan last year, Ramadan starts in 6 weeks: on the radar (Talabat); Sodic already asked for it (covered).
  rq('R1', 'c-a', { occasionId: 1, eventName: 'Ramadan Iftar Riders', eventDate: dateIn(-320), submittedAt: `${dateIn(-360)}T09:00:00Z` }),
  rq('R2', 'c-b', { occasionId: 1, eventDate: dateIn(-320), submittedAt: `${dateIn(-360)}T09:00:00Z` }),
  rq('R3', 'c-b', { occasionId: 1, status: 'in_progress', submittedAt: `${dateIn(-5)}T09:00:00Z` }),
  // Easter: starts in 12 weeks (outside the 8-week window).
  rq('R4', 'c-c', { occasionId: 2, status: 'rejected', submittedAt: `${dateIn(-300)}T09:00:00Z` }),
  // b) Rhythm: three events about 90 days apart, the last 120 days ago, nothing since (Fade, due); Azha: one event 200 days ago.
  rq('R5', 'c-d', { eventDate: dateIn(-300), eventName: 'Fade Easter' }), rq('R6', 'c-d', { eventDate: dateIn(-210) }),
  rq('R7', 'c-d', { eventDate: dateIn(-120), eventName: 'Fade Summer' }),
  rq('R8', 'c-c', { eventDate: dateIn(-200), eventName: 'TEB' }),
  // One event 100 days ago (not due yet) and one with a newer request (not on the radar).
  rq('R9', 'c-e', { eventDate: dateIn(-100) }),
  rq('R10', 'c-a', { eventDate: dateIn(-250) }), rq('R11', 'c-a', { status: 'shared_with_client', submittedAt: `${dateIn(-10)}T09:00:00Z` }),
]
const RADAR_PERIODS = [
  { occasionId: 1, name: 'Ramadan', startsOn: dateIn(-345), endsOn: dateIn(-316) },
  { occasionId: 1, name: 'Ramadan', startsOn: dateIn(42), endsOn: dateIn(71) },
  { occasionId: 2, name: 'Easter', startsOn: dateIn(84), endsOn: dateIn(85) },
]
const radarCases = {
  today: RT, clients: RADAR_CLIENTS, requests: RADAR_REQUESTS, periods: RADAR_PERIODS,
  runs: [[], [{ clientId: 'c-a', signal: 'occasion:1', until: dateIn(71) }], [{ clientId: 'c-d', signal: 'rhythm', until: dateIn(-1) }]]
    .map((dismissals) => ({ dismissals, expect: radarItems(RADAR_REQUESTS, RADAR_PERIODS, dismissals, RADAR_CLIENTS, RT) })),
}

// ---------- HR staffing ----------
const ev = (id, eventDate, eventEndDate = null, eventDatePrecision = 'day') => ({ id, eventDate, eventEndDate, eventDatePrecision })
const staffingCases = {
  suggested: [[120, 15], [15, 15], [16, 15], [0, 15], [100, null], [null, 10], [7, 0]].map(([p, n]) => ({ participants: p, per: n, expect: suggestedNeeded(p, n) })),
  totals: { events: [{ facilitatorsNeeded: 8, assignedCount: 5 }, { facilitatorsNeeded: null, assignedCount: 2 }, { facilitatorsNeeded: 3, assignedCount: 4 }],
    expect: staffingTotals([{ facilitatorsNeeded: 8, assignedCount: 5 }, { facilitatorsNeeded: null, assignedCount: 2 }, { facilitatorsNeeded: 3, assignedCount: 4 }]) },
  clashes: [
    [ev('E1', dateIn(5)), [ev('E2', dateIn(5)), ev('E3', dateIn(6)), ev('E4', dateIn(4), dateIn(5))]],
    [ev('E1', dateIn(5), dateIn(7)), [ev('E2', dateIn(7)), ev('E3', dateIn(8))]],
    [ev('E1', dateIn(5).slice(0, 7), null, 'month'), [ev('E2', dateIn(5))]],
  ].map(([event, others]) => ({ event, others, expect: clashes(event, others) })),
  ratings: [{}, { attended: true }, { attended: true, stars: 4 }, { attended: 'yes', stars: '5', feedback: ' Great with kids ' },
    { attended: false, stars: 3 }, { attended: true, stars: 6 }, { attended: true, stars: 2.5 }, { attended: true, stars: 3, feedback: 'x'.repeat(1001) }]
    .map((input) => ({ input, expect: validateRating(input) })),
  records: [
    [[{ requestId: 'A', raterId: 'u1', stars: 5, attended: true, updatedAt: '2026-01-01T10:00:00Z' },
      { requestId: 'A', raterId: 'u2', stars: 4, attended: true, updatedAt: '2026-01-02T10:00:00Z' },
      { requestId: 'B', raterId: 'u1', stars: null, attended: false, updatedAt: '2026-02-01T10:00:00Z' },
      { requestId: 'C', raterId: 'u1', stars: 3, attended: true, updatedAt: '2026-03-01T10:00:00Z' }], ['A', 'B', 'C', 'C']],
    [[], ['A']],
  ].map(([ratings, done]) => ({ ratings, done, expect: facilitatorRecord(ratings, done) })),
  duplicates: [{ name: 'Ahmed Samir', phone: '0100 123 4567' }, { name: '  ahmed   samir ' }, { name: 'Someone', phone: '01001234567' }, { name: 'New Person', phone: '0111' }]
    .map((input) => ({ input, expect: possibleDuplicates(input, [{ id: 1, name: 'Ahmed Samir', phone: '+20 100 123 4567' }, { id: 2, name: 'Mona', phone: '0100-123-4567' }]) })),
  permissions: [...EVENT_VIEWERS, { userId: 'u-doaa', activeRole: 'executive' }].map((viewer) => ({
    viewer, needed: canSetFacilitatorsNeeded({ assignedAM: BRAND_AM_ROUTING.teamup }, viewer), seeRatings: canSeeRatings(viewer), rate: canRate(viewer) })),
}

// ---------- My Work sections and personal to-dos ----------
// For every viewer: the section of each request in their My Work (turn · team · client) and, for Noha and
// the Executives, the days it has been stuck (3+). Only requests that are in My Work are listed.
const myWorkCases = VIEWERS.map((viewer) => ({
  viewer,
  sections: Object.fromEntries(requests.map((r) => [r.id, myWorkSection(r, viewer, NOW)]).filter(([, v]) => v)),
  stuck: Object.fromEntries(requests.map((r) => [r.id, stuckDays(r, viewer, NOW)]).filter(([, v]) => v !== null)),
}))
const todoCases = [{}, { text: '  Call Sodic  ' }, { text: 'x'.repeat(301) }, { text: 'Visit', dueOn: '2026-02-30' },
  { text: 'Visit', dueOn: '2026-11-02', linkKind: 'client', linkId: 'CL-0008' }, { text: 'Send', linkKind: 'request' },
  { text: 'Send', linkKind: 'opportunity', linkId: 'OPP-0001' }, { text: 'Brief', dueOn: '', linkKind: '', linkId: '' }]
  .map((input) => ({ input, expect: validateTodo(input) }))

const out = {
  description: 'Shared proposal-request rule scenarios generated from the frontend rules. Do not edit by hand.',
  generatedAt: previous ? previous.generatedAt : NOW.toISOString(),
  now: NOW.toISOString(),
  today: TODAY,
  world: { users, clients: data.clients, opportunities: data.opportunities, requests },
  stages: stageList().map(({ id, label, order }) => ({ id, label, order })),
  statusStages: Object.fromEntries(Object.entries(STATUS_CONFIG.proposal).map(([id, c]) => [id, { stage: c.stage, subLabel: c.subLabel }])),
  lostReasons: LOST_REASONS,
  shareChannels: SHARE_CHANNELS,
  proposalFiles: { types: PROPOSAL_FILE_TYPES, maxBytes: PROPOSAL_FILE_MAX_BYTES, uploadStatuses: UPLOAD_STATUSES },
  commentMaxLength: COMMENT_MAX_LENGTH,
  viewers: VIEWERS,
  requestCases,
  trackerCases,
  actionCases,
  commentCases,
  crmCases,
  accountCases,
  realDataCases,
  waitingCases,
  conversationCases,
  eventCases,
  reminderCases,
  activityCases,
  correctionCases,
  radarCases,
  staffingCases,
  myWorkCases,
  todoCases,
}
writeFileSync(FILE, JSON.stringify(out, null, 1) + '\n')
console.log(`requests: ${requests.length} · request×viewer cases: ${requestCases.length * VIEWERS.length} · tracker cases: ${trackerCases.length} · action cases: ${actionCases.length}`)
