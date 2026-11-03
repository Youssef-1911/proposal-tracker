// Display stage layer and lost reasons. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDemoData } from '../src/demo/seed.js'
import {
  LOST_REASONS, LOST_REASONS_FOR_FORMS, PROPOSAL_STATUS as PS, STATUS_CONFIG, stageList, stageOf, statusesInStage, statusList, subLabelFor,
} from '../src/domain/status.js'
import { countByStage, countByStatus, todayISO } from '../src/domain/metrics.js'
import {
  EMPTY_FILTERS, GROUP, SCOPE, SORT, TAB, groupByStage, parseTrackerParams, queryTracker, trackerParams, trackerRow,
} from '../src/domain/tracker.js'

const NOHA = { userId: 'u-noha', activeRole: 'commercial_head' }

function setup(viewer = NOHA) {
  const data = createDemoData()
  const usersById = Object.fromEntries(data.users.map((u) => [u.id, u]))
  const clientsById = Object.fromEntries(data.clients.map((c) => [c.id, c]))
  const ctx = { viewer, user: usersById[viewer.userId], usersById, clientsById, today: todayISO(), now: new Date() }
  const run = (over = {}) => queryTracker(data.proposalRequests, {
    scope: SCOPE.COMPANY, tab: TAB.ALL, sort: SORT.DEADLINE, ...over, filters: { ...EMPTY_FILTERS, ...(over.filters ?? {}) },
  }, ctx)
  return { data, ctx, run }
}

test('the 13 statuses map to exactly the 5 approved stages (Postponed is With client)', () => {
  assert.deepEqual(stageList().map((s) => [s.id, s.label]), [
    ['draft', 'Draft'], ['with_am', 'With AM'], ['ready_to_send', 'Ready to send'], ['with_client', 'With client'], ['closed', 'Closed'],
  ])
  assert.deepEqual(statusesInStage('draft'), [PS.DRAFT])
  assert.deepEqual(statusesInStage('with_am'), [PS.SUBMITTED, PS.IN_PROGRESS, PS.AWAITING_BD_INFO, PS.REVISION_REQUESTED])
  assert.deepEqual(statusesInStage('ready_to_send'), [PS.READY_FOR_BD])
  assert.deepEqual(statusesInStage('with_client'), [PS.SHARED_WITH_CLIENT, PS.POSTPONED])
  assert.deepEqual(statusesInStage('closed'), [PS.ACCEPTED, PS.REJECTED, PS.CANCELLED, PS.CLOSED_UNRECORDED, PS.CLOSED_POSTPONED])
  assert.equal(statusList('proposal').length, 13, 'the ten statuses, Postponed, and the two closed history outcomes')
  assert.ok(statusList('proposal').every((s) => STATUS_CONFIG.stage[s.stage]), 'every status has a stage')
})

test('sub-labels are exactly as specified; Revision names the version being prepared', () => {
  const sub = (s, v) => subLabelFor(s, v)
  assert.deepEqual(
    [PS.DRAFT, PS.SUBMITTED, PS.IN_PROGRESS, PS.AWAITING_BD_INFO, PS.READY_FOR_BD, PS.SHARED_WITH_CLIENT, PS.ACCEPTED, PS.REJECTED, PS.CANCELLED].map((s) => sub(s, 1)),
    [null, 'New', 'Preparing', 'Needs BD info', 'Proposal ready', 'Awaiting reply', 'Confirmed', 'Lost', 'Cancelled'],
  )
  assert.equal(sub(PS.REVISION_REQUESTED, 1), 'Revision (v2)')
  assert.equal(sub(PS.REVISION_REQUESTED, 2), 'Revision (v3)')
  assert.equal(STATUS_CONFIG.proposal[PS.AWAITING_BD_INFO].waitingOn, 'bd', '"Needs BD info" keeps its Waiting on BD badge')
})

test('Ready for BD and Shared with Client stay in different stages', () => {
  assert.notEqual(stageOf(PS.READY_FOR_BD), stageOf(PS.SHARED_WITH_CLIENT))
})

test('lost reasons are the fixed list with the approved labels', () => {
  assert.deepEqual(LOST_REASONS.map((r) => [r.id, r.label]), [
    ['price', 'Price'], ['timing', 'Timing'], ['competitor', 'Chose a competitor'],
    ['no_response', 'No response'], ['budget_cancelled', 'Budget cancelled'], ['other', 'Other'],
    ['not_recorded', 'Not recorded'],
  ])
  assert.deepEqual(LOST_REASONS_FOR_FORMS.map((r) => r.id), ['price', 'timing', 'competitor', 'no_response', 'budget_cancelled', 'other'],
    '"Not recorded" is for imported data only, never offered in a form')
})

test('stage filter narrows to the statuses of that stage and combines with others', () => {
  const { run } = setup()
  const withAm = run({ filters: { stage: ['with_am'] } }).rows
  assert.ok(withAm.length > 0 && withAm.every((r) => statusesInStage('with_am').includes(r.status)))
  const two = run({ filters: { stage: ['ready_to_send', 'with_client'] } }).rows
  assert.ok(two.every((r) => [PS.READY_FOR_BD, PS.SHARED_WITH_CLIENT].includes(r.status)))
  const combo = run({ filters: { stage: ['with_am'], status: [PS.SUBMITTED] } }).rows
  assert.ok(combo.every((r) => r.status === PS.SUBMITTED))
  assert.deepEqual(run({ filters: { stage: ['draft'] } }).rows.map((r) => r.id), [], 'other people\'s drafts never appear')
})

test('group by stage keeps stage order and the sort order inside each group', () => {
  const { run, ctx } = setup()
  const rows = run().rows.map((r) => trackerRow(r, ctx))
  const groups = groupByStage(rows)
  assert.deepEqual(groups.map((g) => g.stage), ['with_am', 'ready_to_send', 'with_client', 'closed'].filter((s) => groups.some((g) => g.stage === s)))
  assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), rows.length)
  for (const g of groups) {
    const order = rows.filter((r) => r.stage === g.stage).map((r) => r.id)
    assert.deepEqual(g.rows.map((r) => r.id), order)
  }
})

test('rows carry stage, stage label and sub-label', () => {
  const { data, ctx } = setup()
  const awaiting = trackerRow(data.proposalRequests.find((r) => r.status === PS.AWAITING_BD_INFO), ctx)
  assert.deepEqual([awaiting.stage, awaiting.stageLabel, awaiting.subLabel], ['with_am', 'With AM', 'Needs BD info'])
  const revision = trackerRow(data.proposalRequests.find((r) => r.status === PS.REVISION_REQUESTED), ctx)
  assert.equal(revision.subLabel, `Revision (v${revision.request.version + 1})`)
})

test('stage filter and grouping round-trip through the URL', () => {
  const { data } = setup()
  const parse = (qs) => parseTrackerParams(new URLSearchParams(qs), NOHA, data.users)
  const state = parse('stage=with_am,closed,bogus&status=submitted&group=stage')
  assert.deepEqual(state.filters.stage, ['with_am', 'closed'])
  assert.equal(state.group, GROUP.STAGE)
  assert.deepEqual(parse(new URLSearchParams(trackerParams(state, NOHA)).toString()), state)
  assert.equal(parse('group=status').group, GROUP.NONE)
})

test('dashboard breakdowns group by stage with the detailed statuses nested', () => {
  const { data } = setup()
  const requests = data.proposalRequests.filter((r) => r.status !== PS.DRAFT)
  const stages = countByStage(requests, { brands: ['grasshoppers', 'teamup'] })
  const detailed = countByStatus(requests, { brands: ['grasshoppers', 'teamup'] })
  assert.equal(stages.reduce((n, s) => n + s.total, 0), detailed.reduce((n, s) => n + s.total, 0))
  for (const st of stages) {
    assert.equal(st.total, st.statuses.reduce((n, s) => n + s.total, 0), st.id)
    assert.equal(st.byBrand.grasshoppers + st.byBrand.teamup, st.total, st.id)
  }
  const openOnly = countByStage(requests, { statuses: [PS.SUBMITTED, PS.READY_FOR_BD] })
  assert.deepEqual(openOnly.map((s) => s.id), ['with_am', 'ready_to_send'], 'stages without included statuses are left out')
})
