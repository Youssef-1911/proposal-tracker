// Real starting data and data fixes: what the numbers count. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { countedHistory, funnel, valueCards } from '../src/domain/scorecard.js'
import { pastHistory, validatePastRecord } from '../src/domain/corrections.js'

const TODAY = '2026-10-27'
const h = (status, at, extra = {}) => ({ status, changedAt: at, ...extra })

test('a corrected outcome replaces the wrong one in the numbers', () => {
  const r = { id: 'a', status: 'rejected', brand: 'teamup', amPrice: 1000,
    statusHistory: [h('submitted', '2026-10-01T09:00:00Z'), h('shared_with_client', '2026-10-02T09:00:00Z'),
      h('accepted', '2026-10-03T09:00:00Z'), h('rejected', '2026-10-05T09:00:00Z', { corrected: true, lostReason: 'price' })] }
  assert.deepEqual(countedHistory(r).map((e) => e.status), ['submitted', 'shared_with_client', 'rejected'])
  const f = funnel([r], 'year', TODAY)
  assert.deepEqual([f.won, f.lost, f.sent], [0, 1, 1])
})

test('values: final price for confirmed, proposal price for sent and lost, each "based on N with a price"', () => {
  const won = { id: 'w', status: 'accepted', amPrice: 1000, finalPrice: 900,
    statusHistory: [h('shared_with_client', '2026-10-02T09:00:00Z'), h('accepted', '2026-10-03T09:00:00Z')] }
  const unpriced = { id: 'u', status: 'accepted', statusHistory: [h('accepted', '2026-10-04T09:00:00Z')] }
  const lost = { id: 'l', status: 'rejected', amPrice: 500, statusHistory: [h('shared_with_client', '2026-10-02T09:00:00Z'), h('rejected', '2026-10-06T09:00:00Z')] }
  const cards = Object.fromEntries(valueCards([won, unpriced, lost], 'year', TODAY).map((c) => [c.id, c]))
  assert.deepEqual([cards.confirmedValue.value, cards.confirmedValue.priced, cards.confirmedValue.count], [900, 1, 2])
  assert.deepEqual([cards.sentValue.value, cards.sentValue.priced], [1500, 2])
  assert.deepEqual([cards.lostValue.value, cards.lostValue.count], [500, 1])
})

test('a past record counts like any other: its history steps come from the dates entered', () => {
  const { errors, values } = validatePastRecord({ brand: 'teamup', service: 'team_building', bdOwner: 'u-ahmed', assignedAM: 'u-md',
    briefDate: '2026-03-01', sentDate: '2026-03-10', eventDate: '2026-04-15', outcome: 'done', amPrice: '70000' }, { today: TODAY })
  assert.deepEqual(errors, {})
  const steps = pastHistory(values, TODAY)
  assert.deepEqual(steps.map((s) => `${s.status}@${s.day}`), ['submitted@2026-03-01', 'ready_for_bd@2026-03-10',
    'shared_with_client@2026-03-10', 'accepted@2026-03-10'])
  assert.equal(steps[1].amPrice, 70000)
})
