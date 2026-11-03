// Radar prefill, the morning summary, and staffing rules. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { prefillFrom } from '../src/domain/radar.js'
import { factsSentence, greeting, morningFacts } from '../src/domain/morning.js'
import { clashes, ratingEditable, suggestedNeeded } from '../src/domain/staffing.js'

test('"Create request from previous" copies the request, never its dates', () => {
  const r = { clientId: 'c1', brand: 'teamup', service: 'team_building', eventName: 'Ramadan Iftar', requirementsSummary: 'Iftar for 300',
    briefTags: ['food'], specificRequirements: 'Halal', participants: 250, confirmedParticipants: 300, occasionId: 1,
    eventDate: '2025-03-10', eventEndDate: '2025-03-11', requiredBy: '2025-02-20' }
  const f = prefillFrom(r)
  assert.deepEqual([f.brand, f.service, f.eventName, f.participants, f.occasionId, f.briefTags], ['teamup', 'team_building', 'Ramadan Iftar', 300, 1, ['food']])
  assert.deepEqual([f.eventDate, f.eventEndDate, f.requiredBy], [null, null, null])
})

test('morning summary: at most 3 facts, in priority order, per role', () => {
  const counts = { newItems: 3, overdue: 0, dueToday: 2, longestWait: { name: 'Sodic', days: 90, to: '/p' }, questions: 1,
    eventsThisWeek: 4, radar: 2, stuck: 5 }
  assert.equal(factsSentence(morningFacts(counts, 'business_development')), '3 new items, 2 due today, and Sodic has been waiting 90 days.')
  assert.deepEqual(morningFacts({ eventsThisWeek: 4 }, 'operations').map((f) => f.key), ['events'])
  assert.deepEqual(morningFacts({ eventsThisWeek: 4, radar: 2, stuck: 5 }, 'business_development'), [], 'no radar fact: it lives on Clients')
  assert.deepEqual(morningFacts({ dueToday: 1, todosDueToday: 2 }, 'account_manager').map((f) => f.text), ['1 due today', '2 to-dos due today'])
  assert.equal(morningFacts({ todosDueToday: 1 }, 'operations')[0].to, '/#todos')
  assert.deepEqual(morningFacts({ radar: 2, stuck: 5 }, 'executive').map((f) => f.key), ['stuck'])
  assert.equal(factsSentence(morningFacts({}, 'commercial_head')), "You're all caught up.")
  assert.equal(greeting('Ahmed', 9), 'Good morning Ahmed')
  assert.equal(greeting('Ahmed', 14), 'Good afternoon Ahmed')
})

test('staffing: suggestion, same-day clash, rating lock after 7 days', () => {
  assert.equal(suggestedNeeded(100, 15), 7)
  assert.deepEqual(clashes({ id: 'A', eventDate: '2026-11-05', eventDatePrecision: 'day' },
    [{ id: 'B', eventDate: '2026-11-04', eventEndDate: '2026-11-05', eventDatePrecision: 'day' }, { id: 'C', eventDate: '2026-11-06', eventDatePrecision: 'day' }]), ['B'])
  const now = new Date('2026-11-20T10:00:00Z')
  assert.equal(ratingEditable({ createdAt: '2026-11-14T10:00:00Z' }, now), true)
  assert.equal(ratingEditable({ createdAt: '2026-11-12T10:00:00Z' }, now), false)
})
