// Workflow rules for proposal requests. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDemoData } from '../src/demo/seed.js'
import { ACTION, TRANSITIONS, applyAction, createDraft, getActions, nextRequestId } from '../src/domain/workflow.js'
import { BRAND_AM_ROUTING } from '../src/domain/routing.js'
import { ROLE } from '../src/domain/roles.js'
import { OPPORTUNITY_STAGE as OS, PROPOSAL_STATUS as PS, STATUS_CONFIG } from '../src/domain/status.js'
import { canViewRequest, proposalVersions } from '../src/domain/proposals.js'
import { amTurnaroundDays, isOpenRequest, openStatusIds, requestsForHead, todayISO } from '../src/domain/metrics.js'

// ---------- helpers ----------

const CONFIRM = { eventDate: '2030-01-15' } // "Mark confirmed" needs the event date

const BD = ROLE.BUSINESS_DEVELOPMENT
const AM = ROLE.ACCOUNT_MANAGER
const CH = ROLE.COMMERCIAL_HEAD
const as = (userId, activeRole) => ({ userId, activeRole })
const NOHA = as('u-noha', CH)
const AHMED = as('u-ahmed', BD)
const SHERINE = as('u-sherine', BD)
const ABDELRAHMAN = as('u-abdelrahman', BD)
const MK_BD = as('u-mariam-elkhayat', BD)
const MK_AM = as('u-mariam-elkhayat', AM)
const MD_AM = as('u-mariam-dimitri', AM)

function future(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return todayISO(d)
}

/** Fresh copy of the demo data plus helpers that apply actions like the store does. */
function world() {
  const d = createDemoData()
  const usersById = Object.fromEntries(d.users.map((u) => [u.id, u]))
  const get = (id) => d.proposalRequests.find((r) => r.id === id)
  const opp = (id) => d.opportunities.find((o) => o.id === id)
  const ctx = (viewer) => ({ viewer, usersById, opportunities: d.opportunities, allRequests: d.proposalRequests, now: new Date() })
  const act = (id, action, viewer, input = {}) => {
    const res = applyAction(get(id), action, input, ctx(viewer))
    if (res.ok) {
      d.proposalRequests = d.proposalRequests.map((r) => (r.id === id ? res.request : r))
      if (res.opportunity) d.opportunities = d.opportunities.map((o) => (o.id === res.opportunity.id ? res.opportunity : o))
    }
    return res
  }
  const add = (request) => { d.proposalRequests = [...d.proposalRequests, request] }
  // Simulates the AM uploading the proposal file for the version being prepared (backend-only in Phase 3B).
  const upload = (id) => {
    const r = get(id)
    const version = r.status === PS.REVISION_REQUESTED ? r.version + 1 : r.version
    d.proposalRequests = d.proposalRequests.map((x) => (x.id === id
      ? { ...x, files: [...(x.files ?? []), { version, fileType: 'pdf', originalName: `v${version}.pdf`, uploadedBy: x.assignedAM }] }
      : x))
  }
  const draftCtx = (viewer) => ({ viewer, usersById, clients: d.clients, opportunities: d.opportunities, allRequests: d.proposalRequests })
  const allowed = (id, viewer) => getActions(get(id), viewer, usersById).filter((a) => a.allowed).map((a) => a.action)
  return { d, usersById, get, opp, ctx, act, add, upload, allowed, draftCtx }
}

function assertOk(res) {
  assert.equal(res.ok, true, res.error + ' ' + JSON.stringify(res.errors))
  return res
}

// ---------- table ----------

test('transition table only uses statuses from STATUS_CONFIG; cancel starts only from open statuses', () => {
  for (const t of TRANSITIONS) {
    assert.ok(STATUS_CONFIG.proposal[t.to], t.action)
    for (const f of t.from) assert.ok(STATUS_CONFIG.proposal[f], `${t.action} from ${f}`)
  }
  const cancel = TRANSITIONS.find((t) => t.action === ACTION.CANCEL)
  assert.deepEqual([...cancel.from].sort(), [...openStatusIds()].sort())
  assert.equal(cancel.from.includes(PS.DRAFT), false, 'drafts cannot be cancelled in this checkpoint')
})

// ---------- full lifecycle ----------

test('end to end: create -> submit -> info loop -> ready -> share -> revision v2 -> ready -> share -> accepted', () => {
  const w = world()
  // Harbor Line Logistics (owner Ahmed), Team Up, linked to OPP-0004 (Requirements Gathered)
  const created = assertOk(createDraft(
    { clientId: 'c-08', brand: 'teamup', service: 'family_day', opportunityId: 'OPP-0004',
      eventDate: w.opp('OPP-0004').eventDate, eventDatePrecision: 'day', participants: 300,
      requiredBy: future(5), requirementsSummary: 'Family day for 300 people' },
    w.draftCtx(AHMED),
  ))
  const id = created.request.id
  assert.equal(id, nextRequestId(w.d.proposalRequests))
  assert.equal(created.request.assignedAM, BRAND_AM_ROUTING.teamup)
  w.add(created.request)

  assertOk(w.act(id, ACTION.SUBMIT, AHMED))
  assert.equal(w.opp('OPP-0004').stage, OS.PROPOSAL_REQUESTED, 'submit advances the opportunity')
  assertOk(w.act(id, ACTION.START_WORK, MD_AM))
  assertOk(w.act(id, ACTION.REQUEST_BD_INFO, MD_AM, { note: 'Need venue capacity' }))
  assert.equal(w.get(id).status, PS.AWAITING_BD_INFO)
  assertOk(w.act(id, ACTION.PROVIDE_BD_INFO, AHMED, { note: '350 seated' }))
  assert.equal(w.get(id).status, PS.SUBMITTED, 'the answer hands the request back to the AM')
  assertOk(w.act(id, ACTION.START_WORK, MD_AM))
  w.upload(id)
  assertOk(w.act(id, ACTION.MARK_READY, MD_AM, { amPrice: 250000 }))
  assertOk(w.act(id, ACTION.SHARE_WITH_CLIENT, AHMED, { confirmShared: true, channel: 'whatsapp' }))
  assert.equal(w.opp('OPP-0004').stage, OS.NEGOTIATION, 'sharing advances the opportunity')
  const newDeadline = future(4)
  assertOk(w.act(id, ACTION.REQUEST_REVISION, AHMED, { note: 'Half-day option', newRequiredBy: newDeadline }))
  assert.equal(w.get(id).requiredBy, newDeadline)
  assertOk(w.act(id, ACTION.START_REVISION, MD_AM))
  assert.equal(w.get(id).version, 2)
  assert.equal(w.get(id).amPrice, null, 'new version has no price until it is ready')
  w.upload(id)
  assertOk(w.act(id, ACTION.MARK_READY, MD_AM, { amPrice: 210000, note: 'Half day, price down EGP 40,000' }))
  assertOk(w.act(id, ACTION.SHARE_WITH_CLIENT, AHMED, { confirmShared: true, channel: 'whatsapp' }))
  const done = assertOk(w.act(id, ACTION.RECORD_ACCEPTED, AHMED, CONFIRM))
  assert.match(done.message, /OPP-0004 marked Confirmed/)

  const r = w.get(id)
  assert.equal(r.status, PS.ACCEPTED)
  assert.equal(w.opp('OPP-0004').stage, OS.WON)
  assert.equal(r.statusHistory.length, 13) // draft + 12 actions
  assert.deepEqual(proposalVersions(r).map((v) => [v.version, v.amPrice]), [[2, 210000], [1, 250000]], 'v1 price preserved')
  assert.equal(r.lastUpdated, r.statusHistory.at(-1).changedAt)
  // Every entry records the acting role, and AM steps were done as AM.
  for (const e of r.statusHistory) {
    const amStep = [PS.IN_PROGRESS, PS.AWAITING_BD_INFO, PS.READY_FOR_BD].includes(e.status)
    assert.equal(e.role, amStep ? AM : BD, e.status)
    assert.equal(e.changedBy, amStep ? 'u-mariam-dimitri' : 'u-ahmed', e.status)
  }
  const revision = r.statusHistory.find((e) => e.status === PS.REVISION_REQUESTED)
  assert.equal(revision.requiredBy, newDeadline)
  assert.ok(revision.previousRequiredBy)
})

// ---------- who may act ----------

test('AM steps: only the assigned AM, acting as AM', () => {
  const w = world()
  const id = 'PR-2026-0017' // Team Up, submitted
  assert.deepEqual(w.allowed(id, MD_AM), [ACTION.START_WORK], 'the AM may start work but not cancel')
  for (const viewer of [NOHA, ABDELRAHMAN]) {
    const res = w.act(id, ACTION.START_WORK, viewer)
    assert.equal(res.ok, false)
    assert.match(res.error, /Only the assigned Account Manager, Mariam Dimitri/)
  }
  // The Grasshoppers AM does not see Team Up requests (no "See all brands"): reported as not found.
  assert.equal(w.act(id, ACTION.START_WORK, MK_AM).error, `Request ${id} not found.`)
  assert.equal(w.get(id).status, PS.SUBMITTED, 'rejected attempts change nothing')
})

test('BD steps: only the BD owner, acting as BD (not other BDs, not the Head, not the AM)', () => {
  const w = world()
  const id = 'PR-2026-0010' // Ready for BD, owner Abdelrahman, AM Mariam Dimitri
  for (const viewer of [AHMED, SHERINE, NOHA, MD_AM]) {
    const res = w.act(id, ACTION.SHARE_WITH_CLIENT, viewer, { confirmShared: true, channel: 'whatsapp' })
    assert.equal(res.ok, false, viewer.userId)
    assert.equal(res.error, 'Only the BD owner, Abdelrahman Shams, can do this.')
  }
  assertOk(w.act(id, ACTION.SHARE_WITH_CLIENT, ABDELRAHMAN, { confirmShared: true, channel: 'whatsapp' }))
})

test("Mariam El Khayat's actions follow her active role on her self-assigned requests", () => {
  const w = world()
  const submitted = 'PR-2026-0016' // her BD request, routed to her as Grasshoppers AM
  assert.equal(w.get(submitted).bdOwner, w.get(submitted).assignedAM)
  const asBD = w.act(submitted, ACTION.START_WORK, MK_BD)
  assert.equal(asBD.ok, false)
  assert.match(asBD.error, /Switch your active role to Account Manager — Grasshoppers/)
  assertOk(w.act(submitted, ACTION.START_WORK, MK_AM))
  assert.equal(w.get(submitted).statusHistory.at(-1).role, AM)

  const ready = 'PR-2026-0011'
  const asAM = w.act(ready, ACTION.SHARE_WITH_CLIENT, MK_AM, { confirmShared: true, channel: 'whatsapp' })
  assert.equal(asAM.ok, false)
  assert.match(asAM.error, /Switch your active role to Business Development/)
  assertOk(w.act(ready, ACTION.SHARE_WITH_CLIENT, MK_BD, { confirmShared: true, channel: 'whatsapp' }))
  assert.equal(w.get(ready).statusHistory.at(-1).role, BD)
})

test('getActions lists only actions for the current status, each with allowed/reason', () => {
  const w = world()
  const actions = getActions(w.get('PR-2026-0007'), SHERINE, w.usersById) // shared with client
  assert.deepEqual(actions.map((a) => a.action).sort(), [
    ACTION.CANCEL, ACTION.RECORD_ACCEPTED, ACTION.RECORD_REJECTED, ACTION.REQUEST_REVISION, ACTION.POSTPONE,
  ].sort())
  assert.ok(actions.every((a) => a.allowed))
  const forAhmed = getActions(w.get('PR-2026-0007'), AHMED, w.usersById)
  assert.ok(forAhmed.every((a) => !a.allowed && a.reason))
  assert.deepEqual(getActions(w.get('PR-2026-0007'), NOHA, w.usersById).filter((a) => a.allowed).map((a) => a.action), [ACTION.CANCEL])
})

// ---------- invalid transitions & validation ----------

test('actions not valid for the current status are rejected', () => {
  const w = world()
  const res = w.act('PR-2026-0017', ACTION.SHARE_WITH_CLIENT, ABDELRAHMAN, { confirmShared: true, channel: 'whatsapp' }) // still Submitted
  assert.equal(res.ok, false)
  assert.match(res.error, /not possible while the request is Submitted/)
  assert.equal(w.act('PR-2026-0017', 'teleport', NOHA).ok, false)
  for (const id of ['PR-2026-0002', 'PR-2026-0001', 'PR-2026-0004']) { // accepted, rejected, cancelled
    assert.deepEqual(getActions(w.get(id), NOHA, w.usersById), [], `${id} is closed`)
  }
})

test('required inputs are validated and failures leave the record untouched', () => {
  const w = world()
  w.upload('PR-2026-0014') // the file is there, so the inputs themselves are checked
  const before = structuredClone(w.get('PR-2026-0014')) // In Progress, Grasshoppers
  for (const amPrice of ['', null, 'abc', 0, -5, 12.5]) {
    const res = w.act('PR-2026-0014', ACTION.MARK_READY, MK_AM, { amPrice })
    assert.equal(res.ok, false, `price ${amPrice}`)
    assert.ok(res.errors.amPrice)
  }
  const blank = w.act('PR-2026-0014', ACTION.REQUEST_BD_INFO, MK_AM, { note: '   ' })
  assert.ok(blank.errors.note)
  assert.deepEqual(w.get('PR-2026-0014'), before)

  const shared = 'PR-2026-0007'
  assert.ok(w.act(shared, ACTION.REQUEST_REVISION, SHERINE, { note: 'x' }).errors.newRequiredBy)
  assert.ok(w.act(shared, ACTION.REQUEST_REVISION, SHERINE, { note: 'x', newRequiredBy: future(-1) }).errors.newRequiredBy)
  assert.ok(w.act(shared, ACTION.RECORD_REJECTED, SHERINE, {}).errors.lostReason, 'a lost reason must be chosen')
  assert.ok(w.act('PR-2026-0011', ACTION.SHARE_WITH_CLIENT, MK_BD, {}).errors.confirmShared)
})

test('applyAction is pure: it never mutates the request it receives', () => {
  const w = world()
  const original = w.get('PR-2026-0017')
  const snapshot = structuredClone(original)
  applyAction(original, ACTION.START_WORK, {}, w.ctx(MD_AM))
  assert.deepEqual(original, snapshot)
})

// ---------- drafts, creation, on-behalf ----------

test('Commercial Head creates and submits on behalf of the BD owner; draft private until submitted', () => {
  const w = world()
  // Delta Lighthouse School (owner Ahmed), Grasshoppers, linked to OPP-0002
  const created = assertOk(createDraft(
    { clientId: 'c-05', brand: 'grasshoppers', service: 'school_trip', opportunityId: 'OPP-0002',
      eventDate: w.opp('OPP-0002').eventDate, participants: 80, requiredBy: future(6), requirementsSummary: 'Grade 4 trip' },
    w.draftCtx(NOHA),
  ))
  const r = created.request
  assert.equal(r.createdBy, 'u-noha')
  assert.equal(r.bdOwner, 'u-ahmed')
  assert.equal(r.assignedAM, BRAND_AM_ROUTING.grasshoppers)
  assert.equal(r.statusHistory[0].onBehalfOf, 'u-ahmed')
  w.add(r)

  assert.equal(canViewRequest(w.get(r.id), 'u-ahmed'), false, 'BD owner cannot see the Head\'s draft')
  assert.deepEqual(getActions(w.get(r.id), AHMED, w.usersById), [])
  assert.equal(w.act(r.id, ACTION.SUBMIT, AHMED).ok, false)

  assertOk(w.act(r.id, ACTION.SUBMIT, NOHA))
  const after = w.get(r.id)
  assert.equal(after.submittedBy, 'u-noha')
  assert.equal(after.statusHistory.at(-1).onBehalfOf, 'u-ahmed')
  assert.equal(after.statusHistory.at(-1).role, CH)
  assert.equal(canViewRequest(after, 'u-ahmed'), true, 'visible to everyone once submitted')
  assert.deepEqual(w.allowed(r.id, AHMED), [ACTION.CANCEL], 'BD owner can now act on BD steps (cancel)')
})

test('a BD can create only for clients they own; an AM cannot create', () => {
  const w = world()
  const input = { clientId: 'c-08', brand: 'teamup', service: 'family_day', requiredBy: future(5), requirementsSummary: 'x' } // owner Ahmed
  assert.equal(createDraft(input, w.draftCtx(SHERINE)).ok, false)
  assert.equal(createDraft(input, w.draftCtx(MD_AM)).ok, false)
  const bad = createDraft({ ...input, requirementsSummary: ' ', requiredBy: future(-2) }, w.draftCtx(AHMED))
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.requiredBy, 'past deadline rejected even in a draft')
  assert.equal(bad.errors.requirementsSummary, undefined, 'brief is optional for a draft (required on submit)')
})

test('a BD submits their own draft; Mariam El Khayat must be in BD mode to submit hers', () => {
  const w = world()
  assert.equal(w.act('PR-2026-0018', ACTION.SUBMIT, MK_AM).ok, false)
  assertOk(w.act('PR-2026-0018', ACTION.SUBMIT, MK_BD))
  const r = w.get('PR-2026-0018')
  assert.equal(r.submittedBy, 'u-mariam-elkhayat')
  assert.equal('onBehalfOf' in r.statusHistory.at(-1), false)
  assert.equal(r.assignedAM, 'u-mariam-elkhayat', 'routes to herself as Grasshoppers AM')
})

// ---------- cancel ----------

test('cancel: BD owner or Commercial Head with a reason; never the AM; never drafts or closed requests', () => {
  const w = world()
  assert.equal(w.act('PR-2026-0013', ACTION.CANCEL, MD_AM, { note: 'x' }).ok, false)
  assert.ok(w.act('PR-2026-0013', ACTION.CANCEL, AHMED, {}).errors.note)
  assertOk(w.act('PR-2026-0013', ACTION.CANCEL, AHMED, { note: 'Client postponed' }))
  assertOk(w.act('PR-2026-0015', ACTION.CANCEL, NOHA, { note: 'Duplicate' }))
  assert.equal(w.act('PR-2026-0019', ACTION.CANCEL, AHMED, { note: 'x' }).ok, false, 'draft')
  assert.equal(w.act('PR-2026-0002', ACTION.CANCEL, NOHA, { note: 'x' }).ok, false, 'already accepted')
})

// ---------- opportunity effects ----------

test('rejected sets the opportunity Lost only when no other request for it is open', () => {
  const w = world()
  const id = 'PR-2026-0007' // OPP-0013, shared, only request on it
  const res = assertOk(w.act(id, ACTION.RECORD_REJECTED, SHERINE, { lostReason: 'budget_cancelled' }))
  assert.equal(w.opp('OPP-0013').stage, OS.LOST)
  assert.match(res.message, /marked Lost/)

  const w2 = world()
  // Another open request on the same opportunity keeps it alive.
  w2.add({ ...w2.get('PR-2026-0009'), id: 'PR-2026-9001', status: PS.IN_PROGRESS })
  const res2 = assertOk(w2.act('PR-2026-0009', ACTION.RECORD_REJECTED, MK_BD, { lostReason: 'price', note: 'Too expensive' }))
  assert.equal(w2.opp('OPP-0014').stage, OS.NEGOTIATION, 'unchanged')
  assert.match(res2.message, /stays Negotiation: PR-2026-9001 is still open/)
})

test('forward-only stage sync never moves an opportunity backward or reopens it', () => {
  const w = world()
  // OPP-0010 is already Proposal Requested; the BD answer returns the request to Submitted.
  assertOk(w.act('PR-2026-0013', ACTION.PROVIDE_BD_INFO, AHMED, { note: 'Guidelines attached' }))
  assert.equal(w.opp('OPP-0010').stage, OS.PROPOSAL_REQUESTED)
  // A won opportunity is not reopened by sharing another proposal for it.
  w.add({ ...w.get('PR-2026-0011'), id: 'PR-2026-9002', opportunityId: 'OPP-0016', status: PS.READY_FOR_BD })
  assertOk(w.act('PR-2026-9002', ACTION.SHARE_WITH_CLIENT, MK_BD, { confirmShared: true, channel: 'whatsapp' }))
  assert.equal(w.opp('OPP-0016').stage, OS.WON)
})

// ---------- metrics stay consistent ----------

test('dashboard metrics follow the shared record: submitting a draft adds one open request', () => {
  const w = world()
  const open = () => requestsForHead(w.d.proposalRequests).filter(isOpenRequest).length
  const before = open()
  assertOk(w.act('PR-2026-0019', ACTION.SUBMIT, AHMED))
  assert.equal(open(), before + 1)
})

test('turnaround still excludes time awaiting BD information after a live info loop', () => {
  const w = world()
  const id = 'PR-2026-0016' // Submitted, Grasshoppers
  const t0 = new Date('2030-01-01T09:00:00Z')
  const at = (h) => new Date(t0.getTime() + h * 3600000)
  const run = (action, viewer, input, h) => {
    const res = applyAction(w.get(id), action, input, { ...w.ctx(viewer), now: at(h) })
    assertOk(res)
    w.d.proposalRequests = w.d.proposalRequests.map((r) => (r.id === id ? res.request : r))
  }
  // Rewrite the existing submit time to t0 so the arithmetic is exact.
  const r = w.get(id)
  r.statusHistory = r.statusHistory.map((e) => (e.status === PS.SUBMITTED ? { ...e, changedAt: t0.toISOString() } : e))
  run(ACTION.START_WORK, MK_AM, {}, 24) // +1 day
  run(ACTION.REQUEST_BD_INFO, MK_AM, { note: 'Headcount?' }, 48) // +2 days
  run(ACTION.PROVIDE_BD_INFO, MK_BD, { note: '60' }, 96) // waited 2 days on BD
  run(ACTION.START_WORK, MK_AM, {}, 120)
  w.upload(id)
  run(ACTION.MARK_READY, MK_AM, { amPrice: 90000 }, 144) // +6 days gross
  assert.equal(amTurnaroundDays(w.get(id)), 4, '6 days gross minus 2 days awaiting BD')
})

test('denial reasons name who can act, e.g. BD owner or Commercial Head for cancel', () => {
  const w = world()
  const res = w.act('PR-2026-0007', ACTION.CANCEL, ABDELRAHMAN, { note: 'x' })
  assert.equal(res.error, 'Only the BD owner, Sherine El Tabakh, or the Commercial Head can do this.')
})

// ---------- lost reasons ----------

test('Mark lost needs a reason from the fixed list; a note is required only for "Other"', () => {
  const w = world()
  const id = 'PR-2026-0007' // shared with client, owner Sherine, OPP-0013
  const t = TRANSITIONS.find((x) => x.action === ACTION.RECORD_REJECTED)
  assert.equal(t.label, 'Mark lost')
  assert.equal(TRANSITIONS.find((x) => x.action === ACTION.RECORD_ACCEPTED).label, 'Mark confirmed')

  assert.ok(w.act(id, ACTION.RECORD_REJECTED, SHERINE, { lostReason: 'cheaper' }).errors.lostReason, 'unknown reason')
  const other = w.act(id, ACTION.RECORD_REJECTED, SHERINE, { lostReason: 'other', note: '  ' })
  assert.ok(other.errors.note, '"Other" needs a description')
  assert.equal(w.get(id).status, PS.SHARED_WITH_CLIENT, 'failed attempts change nothing')

  assertOk(w.act(id, ACTION.RECORD_REJECTED, SHERINE, { lostReason: 'competitor' }))
  const entry = w.get(id).statusHistory.at(-1)
  assert.equal(entry.status, PS.REJECTED)
  assert.equal(entry.lostReason, 'competitor')
  assert.equal(entry.note, null, 'note is optional for a listed reason')
  assert.equal(w.opp('OPP-0013').stage, OS.LOST)
  assert.equal(w.opp('OPP-0013').lostReason, 'competitor', "stored as the opportunity's lost reason")
})

test('"Other" with a description is stored with its note', () => {
  const w = world()
  assertOk(w.act('PR-2026-0007', ACTION.RECORD_REJECTED, SHERINE, { lostReason: 'other', note: 'School changed principal' }))
  const entry = w.get('PR-2026-0007').statusHistory.at(-1)
  assert.deepEqual([entry.lostReason, entry.note], ['other', 'School changed principal'])
})

// ---------- Phase 3A: share channel, Mark won warnings, reason codes, failure codes ----------

test('sharing records the channel from the fixed list (WhatsApp, Email, In person, Other)', () => {
  const w = world()
  const id = 'PR-2026-0010' // Ready for BD, owner Abdelrahman, OPP-0012
  const missing = w.act(id, ACTION.SHARE_WITH_CLIENT, ABDELRAHMAN, { confirmShared: true })
  assert.equal(missing.code, 'validation')
  assert.ok(missing.errors.channel)
  assert.ok(w.act(id, ACTION.SHARE_WITH_CLIENT, ABDELRAHMAN, { confirmShared: true, channel: 'fax' }).errors.channel)
  const res = assertOk(w.act(id, ACTION.SHARE_WITH_CLIENT, ABDELRAHMAN, { confirmShared: true, channel: 'email' }))
  assert.equal(w.get(id).statusHistory.at(-1).channel, 'email')
  assert.deepEqual(res.opportunityChange,
    { id: 'OPP-0012', from: OS.PROPOSAL_REQUESTED, to: OS.NEGOTIATION, reasonCode: 'proposal_shared', lostReason: null })
})

test('Mark won with other open requests: opportunity Won, the others untouched, and a warning lists them', () => {
  const w = world()
  w.add({ ...w.get('PR-2026-0009'), id: 'PR-2026-9003', status: PS.IN_PROGRESS, bdOwner: 'u-mariam-elkhayat' })
  const res = assertOk(w.act('PR-2026-0009', ACTION.RECORD_ACCEPTED, MK_BD, CONFIRM))
  assert.equal(w.opp('OPP-0014').stage, OS.WON)
  assert.equal(w.get('PR-2026-9003').status, PS.IN_PROGRESS, 'nothing is cancelled automatically')
  assert.equal(res.warnings.length, 1)
  assert.equal(res.warnings[0].code, 'other_open_requests')
  assert.deepEqual(res.warnings[0].requests, [{ id: 'PR-2026-9003', status: PS.IN_PROGRESS, bdOwner: 'u-mariam-elkhayat' }])
  assert.match(res.warnings[0].message, /PR-2026-9003 is still open/)

  const alone = world()
  assert.deepEqual(assertOk(alone.act('PR-2026-0007', ACTION.RECORD_ACCEPTED, SHERINE, CONFIRM)).warnings, [], 'no warning when nothing else is open')
})

test('opportunity reason codes: a Lost opportunity reopened by Mark won is recorded as reopened_after_acceptance', () => {
  const w = world()
  // OPP-0018 is Lost; a further proposal for it is accepted.
  w.add({ ...w.get('PR-2026-0007'), id: 'PR-2026-9004', opportunityId: 'OPP-0018', bdOwner: 'u-sherine' })
  const res = assertOk(w.act('PR-2026-9004', ACTION.RECORD_ACCEPTED, SHERINE, CONFIRM))
  assert.deepEqual(res.opportunityChange,
    { id: 'OPP-0018', from: OS.LOST, to: OS.WON, reasonCode: 'reopened_after_acceptance', lostReason: null })
  const lost = assertOk(world().act('PR-2026-0007', ACTION.RECORD_REJECTED, SHERINE, { lostReason: 'timing' }))
  assert.deepEqual(lost.opportunityChange,
    { id: 'OPP-0013', from: OS.NEGOTIATION, to: OS.LOST, reasonCode: 'proposal_rejected', lostReason: 'timing' })
})

test('failures carry a code the API maps to an HTTP status', () => {
  const w = world()
  assert.equal(w.act('PR-2026-0019', ACTION.SUBMIT, NOHA).code, 'not_found', "someone else's draft")
  assert.equal(w.act('PR-2026-0017', 'teleport', NOHA).code, 'unknown_action')
  assert.equal(w.act('PR-2026-0017', ACTION.SHARE_WITH_CLIENT, ABDELRAHMAN, {}).code, 'invalid_transition')
  assert.equal(w.act('PR-2026-0017', ACTION.START_WORK, NOHA).code, 'forbidden')
  assert.equal(w.act('PR-2026-0014', ACTION.MARK_READY, MK_AM, {}).code, 'precondition', 'no proposal file yet')
  assert.equal(w.act('PR-2026-0015', ACTION.MARK_READY, MD_AM, {}).code, 'validation', 'file uploaded, price missing')
})

// ---------- Phase 3B: proposal file, "what changed" note, Won stays Won ----------

test('Mark ready needs the current version\'s file; the reason shows in getActions', () => {
  const w = world()
  const id = 'PR-2026-0014' // In Progress, no file yet
  const ready = getActions(w.get(id), MK_AM, w.usersById).find((a) => a.action === ACTION.MARK_READY)
  assert.deepEqual([ready.allowed, ready.reason], [false, 'Upload the proposal file before marking it ready.'])
  const res = w.act(id, ACTION.MARK_READY, MK_AM, { amPrice: 90000 })
  assert.deepEqual([res.ok, res.code, res.error], [false, 'precondition', 'Upload the proposal file before marking it ready.'])
  w.upload(id)
  assert.equal(getActions(w.get(id), MK_AM, w.usersById).find((a) => a.action === ACTION.MARK_READY).allowed, true)
  assertOk(w.act(id, ACTION.MARK_READY, MK_AM, { amPrice: 90000 }))
  // Another viewer still sees who may act, not the file reason.
  assert.match(getActions(w.get('PR-2026-0015'), NOHA, w.usersById).find((a) => a.action === ACTION.MARK_READY).reason,
    /Only the assigned Account Manager/)
})

test('from version 2, Mark ready also needs a "what changed" note', () => {
  const w = world()
  const id = 'PR-2026-0006' // Revision Requested, Team Up, v1 ready
  w.upload(id) // prepares version 2 while the revision is requested
  assertOk(w.act(id, ACTION.START_REVISION, MD_AM))
  const ready = getActions(w.get(id), MD_AM, w.usersById).find((a) => a.action === ACTION.MARK_READY)
  assert.deepEqual([ready.requires.note, ready.notePrompt], [true, 'What changed in this version?'])
  const missing = w.act(id, ACTION.MARK_READY, MD_AM, { amPrice: 196000 })
  assert.match(missing.errors.note, /Describe what changed in this version/)
  assertOk(w.act(id, ACTION.MARK_READY, MD_AM, { amPrice: 196000, note: 'Half day, price down EGP 40,000' }))
  const v2 = proposalVersions(w.get(id)).find((v) => v.version === 2)
  assert.deepEqual([v2.changeNote, v2.hasFile, v2.pricePerParticipant], ['Half day, price down EGP 40,000', true, 1960])
})

test('Mark lost when the opportunity is already Won: it stays Won, the reason stays on the request', () => {
  const w = world()
  // A further proposal for the Won OPP-0016, shared with the client.
  w.add({ ...w.get('PR-2026-0007'), id: 'PR-2026-9005', opportunityId: 'OPP-0016', bdOwner: 'u-sherine' })
  const res = assertOk(w.act('PR-2026-9005', ACTION.RECORD_REJECTED, SHERINE, { lostReason: 'timing' }))
  assert.equal(w.opp('OPP-0016').stage, OS.WON)
  assert.equal(res.opportunityChange, null)
  assert.match(res.message, /Opportunity OPP-0016 stays Won\./)
  assert.equal(w.get('PR-2026-9005').statusHistory.at(-1).lostReason, 'timing')
})
