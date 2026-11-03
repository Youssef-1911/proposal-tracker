// Follow-up run: "Your turn" wording, days with me, and never "EGP 0". Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { daysWithMe, neededAction } from '../src/domain/myWork.js'
import { NO_PRICES, formatTotal } from '../src/lib/format.js'
import { isNewFor } from '../src/domain/activity.js'

const users = { 'u-ahmed': { id: 'u-ahmed', name: 'Ahmed Seif', roles: ['business_development'] },
  'u-md': { id: 'u-md', name: 'Mariam Dimitri', roles: ['account_manager'] },
  'u-mk': { id: 'u-mk', name: 'Mariam El Khayat', roles: ['business_development', 'account_manager'] } }
const r = (over) => ({ id: 'x', bdOwner: 'u-ahmed', assignedAM: 'u-md', status: 'in_progress', statusHistory: [], ...over })

test('"What\'s needed" states the action', () => {
  const am = { userId: 'u-md', activeRole: 'account_manager' }
  const bd = { userId: 'u-ahmed', activeRole: 'business_development' }
  assert.equal(neededAction(r({}), am, users), 'Prepare the proposal')
  assert.equal(neededAction(r({ openQuestions: 1 }), am, users), "Answer Ahmed's question")
  assert.equal(neededAction(r({ status: 'ready_for_bd' }), bd, users), 'Share with client')
  assert.equal(neededAction(r({ status: 'postponed' }), bd, users), 'Follow up (postponed)')
})

test('days with me: red after the deadline, or after 14 days without one', () => {
  const since = (d) => [{ status: 'in_progress', changedAt: d }]
  const now = new Date('2026-10-27T10:00:00Z')
  assert.deepEqual(daysWithMe(r({ statusHistory: since('2026-10-07T10:00:00Z') }), '2026-10-27', now), { days: 20, late: true })
  assert.deepEqual(daysWithMe(r({ statusHistory: since('2026-10-20T10:00:00Z') }), '2026-10-27', now), { days: 7, late: false })
  assert.equal(daysWithMe(r({ requiredBy: '2026-10-26', statusHistory: since('2026-10-25T10:00:00Z') }), '2026-10-27', now).late, true)
})

test('a money total with no prices behind it is never "EGP 0"', () => {
  assert.equal(formatTotal(0, 0), NO_PRICES)
  assert.match(formatTotal(1500, 2), /1,500/)
})

test('"New": your own action is never new for you, in either role', () => {
  const item = { by: 'u-mk', byRole: 'business_development', to: ['u-mk'], slots: { 'u-mk': 'am' } }
  assert.equal(isNewFor(item, { userId: 'u-mk', activeRole: 'account_manager' }, users), false)
  assert.equal(isNewFor({ ...item, by: 'u-ahmed' }, { userId: 'u-mk', activeRole: 'account_manager' }, users), true)
  assert.equal(isNewFor({ ...item, by: 'u-ahmed' }, { userId: 'u-mk', activeRole: 'business_development' }, users), false,
    'something addressed to her as AM shows only while working as AM')
})
