// Run with: npm test   (Node's built-in test runner; no extra dependencies)
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDemoData } from '../src/demo/seed.js'
import { BRAND_AM_ROUTING } from '../src/domain/routing.js'
import { ROLE } from '../src/domain/roles.js'
import { PROPOSAL_STATUS as PS, STATUS_CONFIG } from '../src/domain/status.js'
import { canViewRequest, nextActionFor, proposalVersions, responsibleFor, timeline } from '../src/domain/proposals.js'
import { isOpenRequest, pipelineValue, requestsForAM, requestsForBD, requestsForHead } from '../src/domain/metrics.js'
import { formatDate, formatEventDate } from '../src/lib/format.js'

const data = createDemoData()
const byId = (id) => data.proposalRequests.find((r) => r.id === id)
const NOHA = 'u-noha'
const MK = 'u-mariam-elkhayat'
const AHMED = 'u-ahmed'
const ROLES = new Set(Object.values(ROLE))

// ---------- Data-field corrections ----------

test('requestedBy is gone; bdOwner is the client relationship owner', () => {
  for (const r of data.proposalRequests) {
    assert.equal('requestedBy' in r, false, r.id)
    const client = data.clients.find((c) => c.id === r.clientId)
    assert.equal(r.bdOwner, client.owner, r.id)
  }
})

test('assignedAM always follows the brand routing rule', () => {
  for (const r of data.proposalRequests) assert.equal(r.assignedAM, BRAND_AM_ROUTING[r.brand], r.id)
})

test('every request has createdBy and lastUpdated = latest history timestamp', () => {
  for (const r of data.proposalRequests) {
    assert.ok(r.createdBy, r.id)
    assert.equal(r.lastUpdated, r.statusHistory.at(-1).changedAt, r.id)
  }
})

test('history entries carry a valid role and version; current version matches history', () => {
  for (const r of data.proposalRequests) {
    for (const e of r.statusHistory) {
      assert.ok(ROLES.has(e.role), `${r.id} ${e.status} role ${e.role}`)
      assert.ok(Number.isInteger(e.version) && e.version >= 1, r.id)
    }
    assert.equal(r.version, r.statusHistory.at(-1).version, r.id)
  }
})

test('a request created by the Commercial Head on behalf of a BD keeps both people', () => {
  const r = data.proposalRequests.find((x) => x.createdBy === NOHA)
  assert.ok(r, 'expected one request created by Noha')
  assert.notEqual(r.bdOwner, NOHA)
  assert.equal(r.statusHistory[0].changedBy, NOHA)
  assert.equal(r.statusHistory[0].role, ROLE.COMMERCIAL_HEAD)
})

test("Mariam El Khayat's self-assigned requests record AM and BD steps in separate roles", () => {
  const self = data.proposalRequests.filter((r) => r.bdOwner === MK && r.assignedAM === MK && r.statusHistory.length > 2)
  assert.ok(self.length >= 1)
  for (const r of self) {
    for (const e of r.statusHistory) {
      const amStep = [PS.IN_PROGRESS, PS.AWAITING_BD_INFO, PS.READY_FOR_BD].includes(e.status)
      assert.equal(e.role, amStep ? ROLE.ACCOUNT_MANAGER : ROLE.BUSINESS_DEVELOPMENT, `${r.id} ${e.status}`)
    }
  }
})

// ---------- Versions & prices ----------

test('revised request keeps both versions; the unrecorded v1 price stays null (not invented)', () => {
  const r = data.proposalRequests.find((x) => x.version === 2)
  assert.ok(r, 'expected a version-2 request')
  const versions = proposalVersions(r)
  assert.deepEqual(versions.map((v) => v.version), [2, 1])
  assert.equal(versions[0].amPrice, r.amPrice)
  assert.equal(versions[0].isCurrent, true)
  assert.equal(versions[1].amPrice, null)
})

test('no versions before the AM has started; a started version shows as pending without a price', () => {
  const submitted = data.proposalRequests.find((r) => r.status === PS.SUBMITTED)
  assert.deepEqual(proposalVersions(submitted), [])
  const inProgress = data.proposalRequests.find((r) => r.status === PS.IN_PROGRESS)
  const [v] = proposalVersions(inProgress)
  assert.equal(v.isPending, true)
  assert.equal(v.amPrice, null)
})

test('only Ready for BD history entries carry a price', () => {
  for (const r of data.proposalRequests) {
    for (const e of r.statusHistory) {
      assert.equal('amPrice' in e, e.status === PS.READY_FOR_BD, `${r.id} ${e.status}`)
    }
  }
})

// ---------- Next action ----------

test('every open/draft status has a nextStep; closed statuses have none', () => {
  for (const [id, cfg] of Object.entries(STATUS_CONFIG.proposal)) {
    if (cfg.closed) assert.equal(cfg.nextStep, null, id)
    else assert.ok(cfg.nextStep, id)
  }
})

test('responsible person follows waitingOn: AM steps -> assigned AM, BD steps -> BD owner, draft -> creator', () => {
  for (const r of data.proposalRequests) {
    const who = STATUS_CONFIG.proposal[r.status].waitingOn
    const resp = responsibleFor(r)
    if (who === 'am') assert.deepEqual(resp, { userId: r.assignedAM, role: ROLE.ACCOUNT_MANAGER }, r.id)
    else if (who === 'bd' && r.status === PS.DRAFT) assert.equal(resp.userId, r.createdBy, r.id)
    else if (who === 'bd') assert.deepEqual(resp, { userId: r.bdOwner, role: ROLE.BUSINESS_DEVELOPMENT }, r.id)
    else assert.equal(resp, null, r.id)
    assert.equal(nextActionFor(r) === null, STATUS_CONFIG.proposal[r.status].closed, r.id)
  }
})

// ---------- Visibility ----------

test('drafts are visible only to their creator (not even the Commercial Head); others are visible to all', () => {
  for (const r of data.proposalRequests) {
    for (const u of data.users) {
      const expected = r.status !== PS.DRAFT || r.createdBy === u.id
      assert.equal(canViewRequest(r, u.id), expected, `${r.id} as ${u.id}`)
    }
  }
  const draft = data.proposalRequests.find((r) => r.status === PS.DRAFT)
  assert.equal(canViewRequest(draft, NOHA), false)
})

test("a draft someone else created for a BD is not on that BD's dashboard", () => {
  const draftByNoha = { ...byId('PR-2026-0019'), id: 'PR-TEST', createdBy: NOHA, bdOwner: AHMED }
  const list = requestsForBD([...data.proposalRequests, draftByNoha], AHMED)
  assert.equal(list.some((r) => r.id === 'PR-TEST'), false)
  assert.equal(list.some((r) => r.id === 'PR-2026-0019'), true) // Ahmed's own draft
})

test('dashboard totals still reconcile after the field rename', () => {
  const open = (list) => list.filter(isOpenRequest).length
  assert.equal(
    open(requestsForHead(data.proposalRequests)),
    open(requestsForAM(data.proposalRequests, 'grasshoppers')) + open(requestsForAM(data.proposalRequests, 'teamup')),
  )
  const bds = data.users.filter((u) => u.roles.includes(ROLE.BUSINESS_DEVELOPMENT))
  const sum = bds.reduce((s, u) => s + pipelineValue(data.opportunities.filter((o) => o.owner === u.id)), 0)
  assert.equal(pipelineValue(data.opportunities), sum)
})

// ---------- Timeline & formatting ----------

test('timeline is newest first and marks exactly one origin entry (the oldest)', () => {
  for (const r of data.proposalRequests) {
    const t = timeline(r)
    assert.equal(t.filter((e) => e.isOrigin).length, 1, r.id)
    assert.equal(t.at(-1).isOrigin, true, r.id)
    for (let i = 1; i < t.length; i++) assert.ok(t[i - 1].changedAt >= t[i].changedAt, r.id)
  }
})

test('event dates: month-only shows "Mar 2027", full dates show "14 Mar 2027"', () => {
  assert.equal(formatEventDate('2027-03'), 'Mar 2027')
  assert.equal(formatEventDate('2027-03-14'), '14 Mar 2027')
  assert.equal(formatEventDate(null), '—')
  assert.equal(formatDate('2026-09-13'), '13 Sep 2026') // never "Sept"
  assert.ok(data.proposalRequests.some((r) => /^\d{4}-\d{2}$/.test(r.eventDate)), 'seed has a month-only event date')
})
