// The Events page and the client page's Events tab. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cairoTodayISO, clientEvents, eventTiming, eventsPage } from '../src/domain/events.js'

const TODAY = '2026-10-22'
const won = (id, over = {}) => ({ id, status: 'accepted', brand: 'teamup', bdOwner: 'u-ahmed', submittedAt: '2026-01-05T09:00:00Z', ...over })
const REQUESTS = [
  won('A', { eventDate: '2026-11-05' }), // upcoming
  won('B', { eventDate: '2026-10-30', brand: 'grasshoppers' }), // upcoming, sooner
  won('C', { eventDatePrecision: 'unset' }), // date not set
  won('D', { eventDate: '2026-03-01', eventEndDate: '2026-03-03' }), // done
  won('E', { imported: true, originalStatus: 'Event Completed' }), // done (filed under its submission)
  won('F', { eventDate: '2025-12-10', bdOwner: 'u-sherine' }), // done last year
  won('G', { eventDate: '2026-10-21' }), // done yesterday
  { id: 'H', status: 'rejected', brand: 'teamup', bdOwner: 'u-ahmed', eventDate: '2026-11-01' },
  { id: 'I', status: 'draft', brand: 'teamup', bdOwner: 'u-ahmed' },
]
const ids = (page) => page.rows.map((e) => e.request.id)

test('event timing: done, upcoming, date not set; only Won requests', () => {
  assert.deepEqual(REQUESTS.map((r) => eventTiming(r, TODAY)),
    ['upcoming', 'upcoming', 'undated', 'done', 'done', 'done', 'done', null, null])
  assert.equal(eventTiming(won('J', { eventDate: '2026-10-22' }), TODAY), 'upcoming', 'today is still upcoming')
  assert.equal(eventTiming(won('K', { eventDate: '2026-10', eventDatePrecision: 'month' }), TODAY), 'upcoming', 'this month')
})

test('tabs, sorting and counts', () => {
  const up = eventsPage(REQUESTS, { tab: 'upcoming' }, TODAY)
  assert.deepEqual(ids(up), ['B', 'A', 'C'], 'soonest first; "Date not set" last')
  assert.deepEqual(ids(eventsPage(REQUESTS, { tab: 'done' }, TODAY)), ['G', 'D', 'E', 'F'], 'newest first')
  assert.deepEqual(ids(eventsPage(REQUESTS, { tab: 'all' }, TODAY)), ['A', 'B', 'G', 'D', 'E', 'F', 'C'])
  assert.deepEqual(up.counts, { upcoming: 3, done: 4, cancelled: 0, all: 7 })
  assert.equal(up.doneThisYear, 3, 'the top line: done this year')
  assert.equal(up.upcoming, 3)
})

test('filters: brand, mine, period (undated events stay listed)', () => {
  assert.deepEqual(ids(eventsPage(REQUESTS, { tab: 'all', brand: 'grasshoppers' }, TODAY)), ['B'])
  assert.deepEqual(ids(eventsPage(REQUESTS, { tab: 'all', ownerId: 'u-sherine' }, TODAY)), ['F'])
  const month = eventsPage(REQUESTS, { tab: 'all', period: 'month' }, TODAY)
  assert.deepEqual(ids(month), ['B', 'G', 'C'])
  assert.equal(month.upcoming, 3, 'the top line ignores the period')
  assert.deepEqual(ids(eventsPage(REQUESTS, { tab: 'done', period: 'year' }, TODAY)), ['G', 'D', 'E'])
})

test('client Events tab: one row per submitted request, newest first, Won / Lost / Open', () => {
  const tab = clientEvents([...REQUESTS, { id: 'L', status: 'in_progress', eventDate: '2027-01-10' }], TODAY)
  assert.deepEqual(tab.rows.map((e) => e.request.id), ['L', 'A', 'H', 'B', 'G', 'D', 'E', 'C', 'F'], 'undated rows filed under their submission')
  assert.deepEqual(tab.counts, { won: 7, lost: 1, open: 1 })
  assert.equal(tab.rows.find((e) => e.request.id === 'H').timing, null, 'only Won rows get Done / Upcoming')
})

test("Cairo's date, not the computer's", () => {
  assert.equal(cairoTodayISO(new Date('2026-10-21T22:30:00Z')), '2026-10-22', 'after midnight in Cairo')
  assert.equal(cairoTodayISO(new Date('2026-10-22T20:00:00Z')), '2026-10-22')
})

test('Operations page: this week, confirmed, initially confirmed, pipeline, done (last 20), postponed / cancelled', async () => {
  const { operationsSections } = await import('../src/domain/events.js')
  const today = '2026-10-23'
  const ev = (id, over) => ({ id, status: 'accepted', brand: 'teamup', eventDatePrecision: 'day', ...over })
  const events = [
    ev('a', { eventDate: '2026-10-25', eventStatus: 'confirmed' }),
    ev('b', { eventDate: '2026-10-24', eventStatus: 'initial' }),
    ev('c', { eventDate: '2026-11-30', eventStatus: 'confirmed', brand: 'grasshoppers' }),
    ev('d', { eventDate: '2026-11-02', eventStatus: 'postponed' }),
    ev('e', { eventDate: '2026-11-03', eventCancelledAt: '2026-10-01T00:00:00Z' }),
    ...Array.from({ length: 22 }, (_, i) => ev(`old${i}`, { eventDate: `2026-09-${String(i + 1).padStart(2, '0')}` })),
  ]
  const pipeline = [{ id: 'p', status: 'shared_with_client', brand: 'teamup', eventDate: '2026-12-01', eventDatePrecision: 'day' }]
  const s = operationsSections(events, pipeline, {}, today)
  const ids = (rows) => rows.map((e) => e.request.id)
  assert.deepEqual(ids(s.week), ['b', 'a'])
  assert.deepEqual(ids(s.confirmed), ['a', 'c'])
  assert.deepEqual(ids(s.initial), ['b'])
  assert.deepEqual(ids(s.pipeline), ['p'])
  assert.deepEqual(ids(s.off), ['d', 'e'])
  assert.equal(s.done.length, 20)
  assert.equal(s.doneTotal, 22)
  assert.equal(s.done[0].request.id, 'old21', 'newest first')
  assert.deepEqual(ids(operationsSections(events, pipeline, { brand: 'grasshoppers' }, today).confirmed), ['c'])
})
