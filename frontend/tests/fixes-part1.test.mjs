// Fixes from the test run (part 1): one test per bug or rule so it cannot come back. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deadlineSummary, deadlineTone, dueGroups } from '../src/domain/deadlines.js'
import { queueBoard, queueColumn } from '../src/domain/queue.js'
import { calendarEvents, calendarMonth } from '../src/domain/events.js'
import { matchesWaitingChip } from '../src/domain/waiting.js'
import { SORT, SORT_OPTIONS, parseTrackerParams } from '../src/domain/tracker.js'

const TODAY = '2026-10-27' // a Tuesday
const req = (id, over = {}) => ({ id, status: 'in_progress', brand: 'teamup', assignedAM: 'am', bdOwner: 'bd', version: 1,
  statusHistory: [], lastUpdated: '2026-10-20T10:00:00Z', ...over })

test('7: Due by date groups open requests by deadline, overdue first', () => {
  const rows = [
    req('a', { requiredBy: '2026-10-25' }), req('b', { requiredBy: TODAY }), req('c', { requiredBy: '2026-10-29' }),
    req('d', { requiredBy: '2026-11-02' }), req('e', { requiredBy: '2026-12-20' }), req('f', { requiredBy: null }),
    req('closed', { status: 'accepted', requiredBy: TODAY }), req('waiting', { requiredBy: TODAY, waiting: { team: 'marketing' } }),
  ]
  const g = dueGroups(rows, TODAY)
  assert.deepEqual(g.map((x) => `${x.label} · ${x.count}`), ['Overdue · 1', 'Today · 2', 'Thu 29 Oct · 1', 'Next week · 1', 'Later · 1', 'No deadline · 1'])
  assert.equal(g[0].overdue, true)
  assert.ok(g[1].requests.some((r) => r.id === 'waiting'), 'requests waiting on others are included')
  assert.deepEqual(deadlineSummary(rows, TODAY), { total: 7, overdue: 1, dueThisWeek: 3 })
  assert.equal(deadlineTone(rows[0], TODAY), 'overdue')
  assert.equal(deadlineTone(rows[2], TODAY), 'soon')
})

test('8: the queue board puts each of my open proposals in one column; closed ones are not on it', () => {
  const rows = [
    req('new', { status: 'submitted' }), req('prep'), req('rev', { status: 'revision_requested' }),
    req('info', { status: 'awaiting_bd_info' }), req('mkt', { waiting: { team: 'marketing', userId: null, setAt: '2026-10-24T09:00:00Z' } }),
    req('ready', { status: 'ready_for_bd' }), req('client', { status: 'shared_with_client' }), req('post', { status: 'postponed' }),
    req('won', { status: 'accepted' }), req('other', { assignedAM: 'someone-else' }),
  ]
  const board = queueBoard(rows, 'am', new Date('2026-10-27T10:00:00Z'))
  const ids = Object.fromEntries(board.map((c) => [c.id, c.cards.map((x) => x.request.id).sort()]))
  assert.deepEqual(ids, { new: ['new'], preparing: ['prep', 'rev'], waiting: ['info', 'mkt'], ready: ['ready'], client: ['client', 'post'] })
  const mkt = board.find((c) => c.id === 'waiting').cards.find((x) => x.request.id === 'mkt')
  assert.equal(mkt.days, 3)
  assert.equal(mkt.waiting.team, 'marketing')
  assert.equal(queueColumn(req('x', { waiting: { team: 'am', userId: 'am' } }), 'am'), 'preparing', 'waiting on me is not "Waiting"')
})

test('1f: the calendar shows every confirmed and initially confirmed event with a date; month-only ones in a strip', () => {
  const ev = (id, over) => ({ id, status: 'accepted', brand: 'teamup', eventDatePrecision: 'day', ...over })
  const events = [
    ev('done', { eventDate: '2026-03-04', eventStatus: 'confirmed' }), // long done: still on the calendar
    ev('initial', { eventDate: '2026-11-03', eventStatus: 'initial' }),
    ev('month', { eventDate: '2026-11', eventDatePrecision: 'month', eventStatus: 'confirmed' }),
    ev('two-days', { eventDate: '2026-11-10', eventEndDate: '2026-11-11', eventStatus: 'confirmed' }),
    ev('postponed', { eventDate: '2026-11-05', eventStatus: 'postponed' }),
    ev('cancelled', { eventDate: '2026-11-06', eventCancelledAt: '2026-10-01T00:00:00Z' }),
    ev('gh', { eventDate: '2026-11-12', eventStatus: 'confirmed', brand: 'grasshoppers' }),
  ]
  const rows = calendarEvents(events, {}, TODAY)
  assert.deepEqual(rows.map((e) => e.request.id).sort(), ['done', 'gh', 'initial', 'month', 'two-days'])
  const nov = calendarMonth(rows, '2026-11')
  assert.deepEqual(nov.monthOnly.map((e) => e.request.id), ['month'])
  assert.deepEqual(Object.keys(nov.byDay).filter((d) => d.startsWith('2026-11')).sort(), ['2026-11-03', '2026-11-10', '2026-11-11', '2026-11-12'])
  assert.ok(calendarMonth(rows, '2026-03').byDay['2026-03-04'])
  assert.deepEqual(calendarEvents(events, { brand: 'grasshoppers' }, TODAY).map((e) => e.request.id), ['gh'])
})

test('1e: a manual waiting-on is the one truth for every filter', () => {
  const r = req('m', { status: 'in_progress', waiting: { team: 'marketing', userId: 'u-nada' } })
  assert.equal(matchesWaitingChip(r, 'marketing', 'am'), true)
  assert.equal(matchesWaitingChip(r, 'am', 'am'), false, 'not waiting on the AM while it waits on Marketing')
  assert.equal(matchesWaitingChip(r, 'me', 'u-nada'), true)
})

test('2: Proposals default to the most recent activity first', () => {
  assert.equal(SORT_OPTIONS[0].id, SORT.UPDATED)
  const state = parseTrackerParams(new URLSearchParams(''), { userId: 'u-ahmed', activeRole: 'business_development' },
    [{ id: 'u-ahmed', roles: ['business_development'], brand: null }])
  assert.equal(state.sort, SORT.UPDATED)
})
