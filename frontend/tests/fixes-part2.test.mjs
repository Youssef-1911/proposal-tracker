// Fixes from the test run (part 2: pages). Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REDIRECTS, firstPageFor, visibleSections } from '../src/navigation.js'
import { eventSectionCounts } from '../src/domain/events.js'
import { executiveOverview, valueOf } from '../src/domain/scorecard.js'

const ALL_PAGES = { home: true, queue: true, proposals: true, events: true, clients: true, dashboard: true, analytics: true,
  team: true, staffing: true, facilitators: true, screen: true }
const menu = (role) => visibleSections(ALL_PAGES, role).flatMap((s) => s.items).map((i) => i.label)

test('Flat menu per role: main pages only, no sub-items; tabs live inside pages', () => {
  assert.deepEqual(menu('business_development'), ['My Work', 'Proposals', 'Events', 'Clients', 'Dashboard'])
  assert.deepEqual(menu('account_manager'), ['My Work', 'My queue', 'Proposals', 'Events', 'Dashboard'])
  assert.deepEqual(menu('executive').slice(0, 5), ['Dashboard', 'Analytics', 'Proposals', 'Events', 'Clients'])
  assert.deepEqual(menu('operations'), ['My Work', 'Events', 'Staffing', 'Facilitators'])
  assert.deepEqual(menu('hr'), ['My Work', 'Staffing', 'Facilitators', 'Events'])
  assert.deepEqual(menu('marketing'), ['My Work', 'Events'])
  assert.ok(visibleSections(ALL_PAGES, 'commercial_head')[0].items.every((i) => !i.children))
})

test('Old addresses lead to the tab inside the page; Executives land on Dashboard', () => {
  assert.equal(REDIRECTS['/events/week'], '/events?tab=week')
  assert.equal(REDIRECTS['/dashboard/funnel'], '/analytics?tab=proposals')
  assert.equal(firstPageFor('executive'), '/dashboard')
  assert.equal(firstPageFor('operations'), '/')
})

test('2: menu counts per Events page', () => {
  const ev = (id, over) => ({ id, status: 'accepted', brand: 'teamup', eventDatePrecision: 'day', ...over })
  const items = [ev('a', { eventDate: '2026-10-29', eventStatus: 'confirmed' }), ev('b', { eventDate: '2026-12-01', eventStatus: 'initial' }),
    ev('c', { eventDate: '2026-01-10', eventStatus: 'confirmed' }), ev('d', { eventDate: '2026-11-20', eventStatus: 'postponed' })]
  const counts = eventSectionCounts({ items, pipeline: [{ id: 'p', status: 'in_progress', brand: 'teamup' }] }, '2026-10-27')
  assert.deepEqual(counts, { week: 1, confirmed: 1, initial: 1, pipeline: 1, done: 1, off: 1 })
})

test('4: Executive Overview — confirmed value (vs last year), pipeline, rate by brand, top clients, lost reasons', () => {
  const TODAY = '2026-10-27'
  const h = (status, at, extra = {}) => ({ status, changedAt: at, ...extra })
  const won = (id, at, price, over = {}) => ({ id, status: 'accepted', brand: 'teamup', clientId: 'c1', amPrice: 1000, finalPrice: price,
    statusHistory: [h('submitted', at), h('accepted', at)], ...over })
  const lost = (id, at, reason) => ({ id, status: 'rejected', brand: 'teamup', clientId: 'c2', statusHistory: [h('submitted', at), h('rejected', at, { lostReason: reason })] })
  const requests = [
    won('a', '2026-10-05T10:00:00Z', 50000), won('b', '2026-03-01T10:00:00Z', null, { clientId: 'c3' }),
    won('old', '2025-10-03T10:00:00Z', 20000), lost('l1', '2026-04-01T10:00:00Z', 'price'), lost('l2', '2026-05-01T10:00:00Z', 'price'),
    lost('l3', '2026-06-01T10:00:00Z', 'timing'),
    { id: 's', status: 'shared_with_client', brand: 'grasshoppers', clientId: 'c4', amPrice: 7000, statusHistory: [] },
    { id: 'p', status: 'postponed', brand: 'grasshoppers', clientId: 'c4', amPrice: 3000, statusHistory: [] },
  ]
  const o = executiveOverview(requests, TODAY)
  assert.equal(valueOf(requests[1]), 1000, 'no final price: the AM price')
  assert.equal(o.month.value, 50000)
  assert.equal(o.month.lastYear.value, 20000, 'the same month to date last year')
  assert.equal(o.year.value, 51000)
  assert.deepEqual(o.pipeline, { value: 10000, count: 2, priced: 2 })
  assert.deepEqual(o.byBrand.find((b) => b.brand === 'teamup').rate.text, '40% · 2 of 5')
  assert.deepEqual(o.topClients.map((c) => [c.clientId, c.value]), [['c1', 50000], ['c3', 1000]])
  assert.deepEqual(o.lostReasons.map((r) => [r.key, r.count]), [['price', 2], ['timing', 1]])
  assert.equal(executiveOverview(requests.filter((r) => r.id !== 'old'), TODAY).month.lastYear, null, 'no data last year')
})
