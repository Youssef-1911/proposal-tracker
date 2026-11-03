// The shared numbers of Home and Analytics (domain/scorecard.js). Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  amScorecard, bdScorecard, bdTable, chartMonths, funnel, inPeriod, monthly, onTimeRate, rate, results, scorecardCsv,
} from '../src/domain/scorecard.js'
import { groupByWaiting, matchesWaitingChip } from '../src/domain/waiting.js'

const TODAY = '2026-10-22'
const h = (status, at, extra = {}) => ({ status, changedAt: `${at}T08:00:00Z`, changedBy: 'u-x', role: 'account_manager', version: 1, ...extra })
const req = (id, status, history, extra = {}) => ({
  id, status, brand: 'teamup', bdOwner: 'u-ahmed', assignedAM: 'u-md', createdBy: 'u-ahmed', version: 1,
  submittedAt: history.find((e) => e.status === 'submitted')?.changedAt ?? null, statusHistory: history, ...extra,
})

const WON = req('W', 'accepted', [h('draft', '2026-10-01'), h('submitted', '2026-10-01'), h('in_progress', '2026-10-02'),
  h('ready_for_bd', '2026-10-04'), h('shared_with_client', '2026-10-06'), h('accepted', '2026-10-10')], { amPrice: 90000, requiredBy: '2026-10-05' })
const LOST = req('L', 'rejected', [h('submitted', '2026-09-01'), h('ready_for_bd', '2026-09-03'), h('shared_with_client', '2026-09-04'),
  h('rejected', '2026-10-12', { lostReason: 'price' })], { requiredBy: '2026-09-02' })
const READY = req('R', 'ready_for_bd', [h('submitted', '2026-10-15'), h('ready_for_bd', '2026-10-18')])
// Revised twice: Ready for BD three times, shared twice — counted once each.
const REVISED = req('V', 'shared_with_client', [h('submitted', '2026-10-01'), h('ready_for_bd', '2026-10-03'),
  h('shared_with_client', '2026-10-04'), h('revision_requested', '2026-10-05'), h('in_progress', '2026-10-06'),
  h('ready_for_bd', '2026-10-07'), h('shared_with_client', '2026-10-08')], { version: 2 })
const IMPORTED = req('I', 'accepted', [h('accepted', '2026-03-01', { imported: true })], { imported: true, submittedAt: '2026-02-20T09:00:00Z' })
const DRAFT = req('D', 'draft', [h('draft', '2026-10-20')], { submittedAt: null })
const ALL = [WON, LOST, READY, REVISED, IMPORTED, DRAFT]

test('periods are Cairo calendar days up to today', () => {
  assert.equal(inPeriod('2026-10-01', 'month', TODAY), true)
  assert.equal(inPeriod('2026-09-30', 'month', TODAY), false)
  assert.equal(inPeriod('2026-07-01', 'quarter', TODAY), false)
  assert.equal(inPeriod('2026-10-10', 'quarter', TODAY), true)
  assert.equal(inPeriod('2026-01-02', 'year', TODAY), true)
  assert.equal(inPeriod('2025-12-31', 'all', TODAY), true)
  assert.equal(inPeriod('2026-10-23', 'all', TODAY), false, 'never the future')
})

test('funnel: each request counts once per measure; Ready for BD is never "sent"', () => {
  assert.deepEqual(funnel(ALL, 'month', TODAY), { received: 3, prepared: 3, sent: 2, won: 1, lost: 1, postponed: 0, inProgress: 2 })
  assert.deepEqual(funnel(ALL, 'all', TODAY), { received: 5, prepared: 4, sent: 3, won: 2, lost: 1, postponed: 0, inProgress: 2 })
})

test('rates say "X of Y", and "—" under 5 closed', () => {
  assert.equal(rate(1, 2).text, '— · 1 of 2')
  assert.equal(rate(36, 83).text, '43% · 36 of 83')
  assert.equal(rate(0, 0).text, '— · 0 of 0')
})

test('BD and AM scorecards', () => {
  const bd = bdScorecard(ALL, 'month', TODAY)
  assert.deepEqual(bd.headline.map((x) => x.value), [3, 1, '— · 1 of 2', 90000])
  assert.equal(bd.breakdowns[1].rows[0].label, 'Price')
  const am = amScorecard(ALL, 'month', TODAY)
  assert.deepEqual(am.headline.map((x) => x.id), ['received', 'prepared', 'turnaround', 'onTime'])
  assert.equal(am.breakdowns[0].title, 'Outcome of your proposals')
  assert.equal(onTimeRate([WON, LOST]).text, '— · 1 of 2', 'W ready on 4 Oct for 5 Oct; L ready after its deadline')
})

test('monthly chart, results list and tables', () => {
  assert.deepEqual(chartMonths('quarter', TODAY), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
  const oct = monthly(ALL, 'year', TODAY).find((m) => m.month === '2026-10')
  assert.deepEqual(oct, { month: '2026-10', received: 3, won: 1, lost: 1 })
  const r = results(ALL, 'all', TODAY)
  assert.deepEqual(r.won.map((x) => x.request.id), ['W', 'I'])
  assert.deepEqual(r.counts, { won: 2, lost: 1, postponed: 0 })
  const rows = bdTable(ALL, [{ id: 'u-ahmed', name: 'Ahmed Seif', as: 'bd', active: true }, { id: 'u-nour', name: 'Nour', as: 'bd', active: false }], 'all', TODAY)
  assert.deepEqual(rows.map((x) => [x.name, x.requests, x.won]), [['Ahmed Seif', 5, 2], ['Nour', 0, 0]])
  assert.match(scorecardCsv(rows, [], 'All time'), /"Nour","Former team member"/)
})

test('waiting on: chips and "group by who it is waiting on"', () => {
  const manual = { ...READY, id: 'M', status: 'in_progress', waiting: { team: 'marketing', userId: null, reason: 'design', setAt: '2026-10-19T08:00:00Z' } }
  assert.equal(matchesWaitingChip(READY, 'bd', 'u-ahmed'), true)
  assert.equal(matchesWaitingChip(READY, 'me', 'u-ahmed'), true)
  assert.equal(matchesWaitingChip(manual, 'marketing', 'u-ahmed'), true)
  assert.equal(matchesWaitingChip(REVISED, 'client', 'u-ahmed'), true)
  assert.equal(matchesWaitingChip(WON, 'client', 'u-ahmed'), false, 'closed: nobody')
  const groups = groupByWaiting([READY, REVISED, manual, WON], { 'u-ahmed': { name: 'Ahmed Seif' } }, new Date('2026-10-22T10:00:00Z'))
  assert.deepEqual(groups.map((g) => [g.label, g.count]), [['Client', 1], ['Ahmed Seif', 1], ['Marketing', 1]])
})
