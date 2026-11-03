// New Proposal Request form rules (create, edit, submit). Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDemoData } from '../src/demo/seed.js'
import {
  ACTION, applyAction, canEditDraft, createDraft, findPossibleDuplicates, saveRequest, updateDraft,
  validateRequestFields,
} from '../src/domain/workflow.js'
import { canOpenRequestForm, clientsForCreator } from '../src/domain/permissions.js'
import { canViewRequest } from '../src/domain/proposals.js'
import { BRAND_AM_ROUTING } from '../src/domain/routing.js'
import { ROLE } from '../src/domain/roles.js'
import { OPPORTUNITY_STAGE as OS, PROPOSAL_STATUS as PS } from '../src/domain/status.js'
import { isOpenRequest, requestsForAM, requestsForBD, requestsForHead, todayISO } from '../src/domain/metrics.js'
import { formatEventDate } from '../src/lib/format.js'

// ---------- helpers ----------

const BD = ROLE.BUSINESS_DEVELOPMENT
const as = (userId, activeRole) => ({ userId, activeRole })
const NOHA = as('u-noha', ROLE.COMMERCIAL_HEAD)
const AHMED = as('u-ahmed', BD)
const SHERINE = as('u-sherine', BD)
const MK_BD = as('u-mariam-elkhayat', BD)
const MK_AM = as('u-mariam-elkhayat', ROLE.ACCOUNT_MANAGER)
const MD_AM = as('u-mariam-dimitri', ROLE.ACCOUNT_MANAGER)

function future(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return todayISO(d)
}
function futureMonth(monthsAhead) {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() + monthsAhead)
  return todayISO(d).slice(0, 7)
}

/** A fresh demo world; save() behaves exactly like the store (state replaced only on ok). */
function world() {
  let state = createDemoData()
  const usersById = Object.fromEntries(state.users.map((u) => [u.id, u]))
  const save = (viewer, input, options = {}) => {
    const res = saveRequest(state, input, options, { viewer })
    if (res.ok) state = { ...state, proposalRequests: res.proposalRequests, opportunities: res.opportunities }
    return res
  }
  return {
    get state() { return state },
    usersById,
    save,
    get: (id) => state.proposalRequests.find((r) => r.id === id),
    opp: (id) => state.opportunities.find((o) => o.id === id),
    count: () => state.proposalRequests.length,
    ctx: (viewer) => ({ viewer, usersById, clients: state.clients, opportunities: state.opportunities, allRequests: state.proposalRequests }),
  }
}

/** A complete, valid Team Up request for Ahmed's client Harbor Line Logistics (c-08). */
const ahmedTeamUp = (over = {}) => ({
  clientId: 'c-08', brand: 'teamup', service: 'team_building', opportunityId: '',
  eventDatePrecision: 'day', eventDate: future(40), requiredBy: future(10), participants: '120',
  requirementsSummary: 'Half-day team building', specificRequirements: '', ...over,
})

function ok(res) {
  assert.equal(res.ok, true, `${res.error} ${JSON.stringify(res.errors)}`)
  return res
}

// 1. Required fields --------------------------------------------------------

test('1. a draft needs client, brand and service; a submission needs every request field', () => {
  const w = world()
  const before = w.count()
  const draft = w.save(AHMED, {})
  assert.equal(draft.ok, false)
  assert.deepEqual(Object.keys(draft.errors).sort(), ['brand', 'clientId', 'service'])

  const minimal = { clientId: 'c-08', brand: 'teamup', service: 'team_building' }
  const submit = w.save(AHMED, minimal, { submit: true })
  assert.equal(submit.ok, false)
  assert.deepEqual(Object.keys(submit.errors).sort(), ['eventDate', 'participants', 'requiredBy', 'requirementsSummary'])
  assert.equal(w.count(), before, 'nothing saved after validation errors')
})

// 2. Invalid dates and counts ------------------------------------------------

test('2. invalid event dates, proposal deadlines and participant counts are rejected', () => {
  const today = todayISO()
  const check = (over) => validateRequestFields(ahmedTeamUp(over), { mode: 'submit', today }).errors

  assert.ok(check({ eventDate: future(-1) }).eventDate, 'past event date')
  assert.ok(check({ eventDate: '2027-02-30' }).eventDate, 'impossible date')
  assert.ok(check({ eventDatePrecision: 'month', eventDate: '2027-13' }).eventDate, 'impossible month')
  assert.ok(check({ eventDatePrecision: 'month', eventDate: futureMonth(-1) }).eventDate, 'past month')

  assert.ok(check({ requiredBy: future(-1) }).requiredBy, 'past deadline')
  assert.ok(check({ requiredBy: 'tomorrow' }).requiredBy, 'not a date')
  assert.match(check({ eventDate: future(10), requiredBy: future(10) }).requiredBy, /before the event date/)
  assert.match(check({ eventDate: future(10), requiredBy: future(12) }).requiredBy, /before the event date/)
  const month = futureMonth(2)
  assert.match(
    check({ eventDatePrecision: 'month', eventDate: month, requiredBy: `${month}-01` }).requiredBy,
    /before the first day of the event month/,
  )
  assert.deepEqual(check({ eventDatePrecision: 'month', eventDate: month, requiredBy: future(5) }), {}, 'valid month-only request')

  for (const participants of ['0', '-3', '2.5', 'abc']) {
    assert.ok(check({ participants }).participants, `participants ${participants}`)
  }
  assert.deepEqual(check({}), {}, 'the baseline input is valid')
})

// 3. Draft creation ------------------------------------------------------------

test('3. saving a draft creates a private Draft that is not in any AM queue', () => {
  const w = world()
  const res = ok(w.save(AHMED, { clientId: 'c-08', brand: 'teamup', service: 'team_building' }))
  const r = w.get(res.request.id)
  assert.equal(r.status, PS.DRAFT)
  assert.equal(r.submittedAt, null)
  assert.equal(r.submittedBy, null)
  assert.equal(r.statusHistory.length, 1)
  assert.equal(requestsForAM(w.state.proposalRequests, 'teamup').some((x) => x.id === r.id), false)
  assert.equal(requestsForHead(w.state.proposalRequests).some((x) => x.id === r.id), false)
  assert.equal(requestsForBD(w.state.proposalRequests, 'u-ahmed').some((x) => x.id === r.id), true)
})

// 4. Submission -----------------------------------------------------------------

test('4. submitting creates the request and moves it to Submitted through the workflow', () => {
  const w = world()
  const res = ok(w.save(AHMED, ahmedTeamUp({ opportunityId: 'OPP-0004' }), { submit: true }))
  const r = w.get(res.request.id)
  assert.equal(r.status, PS.SUBMITTED)
  assert.equal(r.submittedBy, 'u-ahmed')
  assert.ok(r.submittedAt)
  assert.equal(r.participants, 120, 'participants stored as a number')
  assert.equal(isOpenRequest(r), true)
  assert.equal(requestsForAM(w.state.proposalRequests, 'teamup').some((x) => x.id === r.id), true, 'now in the AM queue')
  assert.equal(w.opp('OPP-0004').stage, OS.PROPOSAL_REQUESTED, 'linked opportunity synced by the workflow')
})

// 5 & 6. Routing ----------------------------------------------------------------

test('5. Grasshoppers requests route to Mariam El Khayat', () => {
  const w = world()
  const res = ok(w.save(MK_BD, {
    clientId: 'c-04', brand: 'grasshoppers', service: 'sleepover', eventDate: future(50), requiredBy: future(9),
    participants: 40, requirementsSummary: 'Year 2 sleepover',
  }, { submit: true }))
  assert.equal(res.request.assignedAM, 'u-mariam-elkhayat')
  assert.equal(res.request.assignedAM, BRAND_AM_ROUTING.grasshoppers)
})

test('6. Team Up requests route to Mariam Dimitri', () => {
  const w = world()
  const res = ok(w.save(AHMED, ahmedTeamUp(), { submit: true }))
  assert.equal(res.request.assignedAM, 'u-mariam-dimitri')
  assert.equal(res.request.assignedAM, BRAND_AM_ROUTING.teamup)
})

// 7 & 8. On behalf + separation -------------------------------------------------

test('7/8. Noha submits on behalf of the client owner; createdBy, bdOwner, assignedAM, submittedBy stay separate', () => {
  const w = world()
  // Papyrus Fintech (c-07) is owned by Abdelrahman. A bdOwner in the input is ignored.
  const res = ok(w.save(NOHA, {
    clientId: 'c-07', brand: 'teamup', service: 'corporate_event', eventDate: future(60), requiredBy: future(12),
    participants: 250, requirementsSummary: 'Annual dinner', bdOwner: 'u-sherine',
  }, { submit: true }))
  const r = w.get(res.request.id)
  assert.equal(r.createdBy, 'u-noha')
  assert.equal(r.bdOwner, 'u-abdelrahman', 'always the client relationship owner')
  assert.equal(r.assignedAM, 'u-mariam-dimitri')
  assert.equal(r.submittedBy, 'u-noha', 'Noha submitted it, not the BD owner')
  const [created, submitted] = r.statusHistory
  assert.deepEqual([created.changedBy, created.role, created.onBehalfOf], ['u-noha', ROLE.COMMERCIAL_HEAD, 'u-abdelrahman'])
  assert.deepEqual([submitted.changedBy, submitted.role, submitted.onBehalfOf], ['u-noha', ROLE.COMMERCIAL_HEAD, 'u-abdelrahman'])
})

test("8. Mariam El Khayat's own Grasshoppers request: one person, BD role recorded, routed to her as AM", () => {
  const w = world()
  const r = ok(w.save(MK_BD, {
    clientId: 'c-01', brand: 'grasshoppers', service: 'explorers_league', eventDate: future(30), requiredBy: future(7),
    participants: 60, requirementsSummary: 'Explorers League term',
  }, { submit: true })).request
  assert.deepEqual([r.createdBy, r.bdOwner, r.submittedBy, r.assignedAM], Array(4).fill('u-mariam-elkhayat'))
  assert.ok(r.statusHistory.every((e) => e.role === BD))
  assert.equal('onBehalfOf' in r.statusHistory[1], false)
})

// 9. Draft privacy ------------------------------------------------------------------

test("9. drafts are private to their creator; Noha's draft for Abdelrahman is hidden from him until submitted", () => {
  const w = world()
  const r = ok(w.save(NOHA, { clientId: 'c-07', brand: 'teamup', service: 'family_day' })).request
  for (const u of ['u-abdelrahman', 'u-ahmed', 'u-mariam-dimitri', 'u-mariam-elkhayat']) {
    assert.equal(canViewRequest(r, u), false, u)
  }
  assert.equal(canViewRequest(r, 'u-noha'), true)
  assert.equal(requestsForBD(w.state.proposalRequests, 'u-abdelrahman').some((x) => x.id === r.id), false)
  assert.equal(canEditDraft(r, as('u-abdelrahman', BD), w.usersById), false)
  assert.equal(updateDraft(r, { clientId: 'c-07', brand: 'teamup', service: 'family_day' }, w.ctx(as('u-abdelrahman', BD))).ok, false)
})

// 10. History and transitions ----------------------------------------------------------

test('10. history: Draft then Submitted; editing a draft adds no history; a submitted request cannot be resubmitted', () => {
  const w = world()
  const draft = ok(w.save(AHMED, { clientId: 'c-08', brand: 'teamup', service: 'team_building' })).request
  ok(w.save(AHMED, ahmedTeamUp({ requirementsSummary: 'Edited brief' }), { draftId: draft.id }))
  assert.equal(w.get(draft.id).statusHistory.length, 1, 'edit does not add a status change')
  assert.equal(w.get(draft.id).requirementsSummary, 'Edited brief')

  ok(w.save(AHMED, ahmedTeamUp(), { draftId: draft.id, submit: true }))
  assert.deepEqual(w.get(draft.id).statusHistory.map((e) => e.status), [PS.DRAFT, PS.SUBMITTED])

  const again = applyAction(w.get(draft.id), ACTION.SUBMIT, {}, w.ctx(AHMED))
  assert.equal(again.ok, false)
  assert.match(again.error, /not possible while the request is Submitted/)
  assert.equal(w.save(AHMED, ahmedTeamUp(), { draftId: draft.id }).ok, false, 'cannot edit after submission')
})

// 11. Duplicate prevention ---------------------------------------------------------------

test('11. saving and submitting the same draft never creates a second record', () => {
  const w = world()
  const before = w.count()
  const first = ok(w.save(AHMED, { clientId: 'c-08', brand: 'teamup', service: 'team_building' }))
  ok(w.save(AHMED, { clientId: 'c-08', brand: 'teamup', service: 'team_building' }, { draftId: first.request.id }))
  ok(w.save(AHMED, ahmedTeamUp(), { draftId: first.request.id, submit: true }))
  assert.equal(w.count(), before + 1)
  assert.equal(w.get(first.request.id).status, PS.SUBMITTED)
})

test('11b. a failed submit saves nothing, and an existing draft keeps its last saved values', () => {
  const w = world()
  const before = w.count()
  assert.equal(w.save(AHMED, ahmedTeamUp({ participants: '0' }), { submit: true }).ok, false)
  assert.equal(w.count(), before, 'no half-created draft')

  const draft = ok(w.save(AHMED, ahmedTeamUp({ requirementsSummary: 'Saved brief' }))).request
  const failed = w.save(AHMED, ahmedTeamUp({ requirementsSummary: 'Unsaved edit', requiredBy: future(-3) }), { draftId: draft.id, submit: true })
  assert.equal(failed.ok, false)
  assert.equal(w.get(draft.id).requirementsSummary, 'Saved brief')
  assert.equal(w.get(draft.id).status, PS.DRAFT)
})

test('11c. possible duplicates (same client, brand, service and event date) are found among open requests only', () => {
  const w = world()
  const existing = ok(w.save(AHMED, ahmedTeamUp(), { submit: true })).request
  const dupes = findPossibleDuplicates(ahmedTeamUp(), w.state.proposalRequests)
  assert.deepEqual(dupes.map((r) => r.id), [existing.id])
  assert.deepEqual(findPossibleDuplicates(ahmedTeamUp({ eventDate: future(41) }), w.state.proposalRequests), [])
  assert.deepEqual(findPossibleDuplicates(ahmedTeamUp(), w.state.proposalRequests, existing.id), [], 'excludes itself')
  // A warning only: a second request with the same details is still allowed.
  ok(w.save(AHMED, ahmedTeamUp(), { submit: true }))
})

// Access, client list, services, opportunities --------------------------------------------

test('only BD (in BD role) and the Commercial Head can open the form; Mariam in AM mode is told to switch', () => {
  assert.equal(canOpenRequestForm(AHMED).allowed, true)
  assert.equal(canOpenRequestForm(NOHA).allowed, true)
  const usersById = Object.fromEntries(createDemoData().users.map((u) => [u.id, u]))
  const mk = canOpenRequestForm(MK_AM, usersById)
  assert.equal(mk.allowed, false)
  assert.match(mk.reason, /Switch your active role to Business Development/)
  assert.equal(canOpenRequestForm(MD_AM, usersById).allowed, false)
  const w = world()
  assert.equal(w.save(MD_AM, ahmedTeamUp()).ok, false)
})

test('a BD sees and may use only their own clients; Noha sees all', () => {
  const { clients } = createDemoData()
  assert.ok(clientsForCreator(SHERINE, clients).every((c) => c.owner === 'u-sherine'))
  assert.equal(clientsForCreator(NOHA, clients).length, clients.length)
  assert.deepEqual(clientsForCreator(MD_AM, clients), [])
  const w = world()
  const res = w.save(SHERINE, ahmedTeamUp()) // Ahmed's client
  assert.equal(res.ok, false)
  assert.ok(res.errors.clientId)
})

test('services must belong to the brand; a linked opportunity must be open and match client and brand', () => {
  const w = world()
  assert.ok(w.save(AHMED, ahmedTeamUp({ service: 'summer_camp' })).errors.service, 'Grasshoppers service on Team Up')
  assert.ok(w.save(AHMED, ahmedTeamUp({ opportunityId: 'OPP-0002' })).errors.opportunityId, "Grasshoppers opp / other brand")
  assert.ok(w.save(AHMED, ahmedTeamUp({ opportunityId: 'OPP-0006' })).errors.opportunityId, "another client's opportunity")
  const wonOpp = w.save(AHMED, { clientId: 'c-05', brand: 'grasshoppers', service: 'summer_camp', opportunityId: 'OPP-0016' })
  assert.ok(wonOpp.errors.opportunityId, 'closed (Won) opportunity')
  ok(w.save(AHMED, ahmedTeamUp({ opportunityId: 'OPP-0015' })))
})

test('drafts are edited in place only by their creator in a creating role', () => {
  const w = world()
  const mine = ok(w.save(MK_BD, { clientId: 'c-01', brand: 'grasshoppers', service: 'school_trip' })).request
  assert.equal(canEditDraft(mine, MK_BD, w.usersById), true)
  assert.equal(canEditDraft(mine, MK_AM, w.usersById), false, 'not while acting as AM')
  assert.equal(canEditDraft(mine, NOHA, w.usersById), false, 'not even the Commercial Head')
  const edited = ok(w.save(MK_BD, { clientId: 'c-04', brand: 'grasshoppers', service: 'sleepover' }, { draftId: mine.id }))
  assert.equal(edited.request.id, mine.id)
  assert.equal(edited.request.clientId, 'c-04')
})

test('month-only event dates are kept as month + year and never turned into an exact day', () => {
  const w = world()
  const month = futureMonth(3)
  const r = ok(w.save(AHMED, ahmedTeamUp({ eventDatePrecision: 'month', eventDate: month }), { submit: true })).request
  assert.equal(r.eventDate, month)
  assert.equal(r.eventDatePrecision, 'month')
  assert.match(formatEventDate(r.eventDate), /^[A-Z][a-z]{2} \d{4}$/)
})

// 12. Existing behaviour ----------------------------------------------------------------------

test('12. seeded drafts still submit from the detail page and dashboards still reconcile', () => {
  const w = world()
  const res = applyAction(w.get('PR-2026-0019'), ACTION.SUBMIT, {}, w.ctx(AHMED))
  ok(res)
  const open = (list) => list.filter(isOpenRequest).length
  const s = w.state
  assert.equal(open(requestsForHead(s.proposalRequests)),
    open(requestsForAM(s.proposalRequests, 'grasshoppers')) + open(requestsForAM(s.proposalRequests, 'teamup')))
  assert.ok(s.proposalRequests.every((r) => ['day', 'month'].includes(r.eventDatePrecision)))
  // createDraft used directly (no store) still enforces routing.
  const direct = createDraft({ clientId: 'c-12', brand: 'teamup', service: 'family_day' }, w.ctx(MK_BD))
  assert.equal(direct.request.assignedAM, 'u-mariam-dimitri')
})

test('submitting an empty form reports every required field at once', () => {
  const w = world()
  const res = w.save(AHMED, {}, { submit: true })
  assert.equal(res.ok, false)
  assert.deepEqual(Object.keys(res.errors).sort(),
    ['brand', 'clientId', 'eventDate', 'participants', 'requiredBy', 'requirementsSummary', 'service'])
})

test('permission errors are not hidden by field errors when submitting', () => {
  const w = world()
  const res = w.save(MD_AM, {}, { submit: true })
  assert.equal(res.ok, false)
  assert.match(res.error, /Only Business Development or the Commercial Head/)
})
