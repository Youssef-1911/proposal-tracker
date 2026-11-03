// Polish: relative times, the previous-period change, Ctrl+K matching, peek links, the event sheet. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatWhen, formatWhenFull } from '../src/lib/format.js'
import { funnelChange, previousToday } from '../src/domain/scorecard.js'
import { commandMatches } from '../src/domain/command.js'
import { parsePeek, peekToken } from '../src/lib/peek.js'
import { eventSheetHtml } from '../src/lib/eventSheet.js'

test('7: times read relatively; the full Cairo date and time is kept for hover and tap', () => {
  const now = new Date('2026-10-28T10:00:00Z') // Wednesday, 13:00 in Cairo
  assert.equal(formatWhen('2026-10-28T09:59:40Z', now), 'Just now')
  assert.equal(formatWhen('2026-10-28T09:55:00Z', now), '5 min ago')
  assert.equal(formatWhen('2026-10-28T07:00:00Z', now), '3 h ago')
  assert.equal(formatWhen('2026-10-27T10:00:00Z', now), 'Yesterday')
  assert.equal(formatWhen('2026-10-26T10:00:00Z', now), 'Mon')
  assert.equal(formatWhen('2026-10-01T10:00:00Z', now), '1 Oct')
  assert.equal(formatWhen('2025-12-01T10:00:00Z', now), '1 Dec 2025')
  assert.equal(formatWhen(null, now), '—')
  assert.match(formatWhenFull('2026-10-28T07:00:00Z'), /^Wednesday, 28 Oct 2026, \d\d:00 \(Cairo\)$/)
})

test('5: the change compares the same days of the previous period, and hides without previous data', () => {
  assert.equal(previousToday('month', '2026-10-27'), '2026-09-27')
  assert.equal(previousToday('month', '2026-03-31'), '2026-02-28')
  assert.equal(previousToday('month', '2026-01-15'), '2025-12-15')
  assert.equal(previousToday('quarter', '2026-05-31'), '2026-02-28')
  assert.equal(previousToday('year', '2028-02-29'), '2027-02-28')
  assert.equal(previousToday('all', '2026-10-27'), null)

  const received = (id, at) => ({ id, status: 'submitted', brand: 'teamup', statusHistory: [{ status: 'submitted', changedAt: at }] })
  assert.equal(funnelChange([received('a', '2026-10-05T09:00:00Z')], 'month', '2026-10-27'), null, 'nothing last month')
  assert.equal(funnelChange([received('a', '2026-10-05T09:00:00Z')], 'all', '2026-10-27'), null, 'All time has no previous period')
  const change = funnelChange([received('a', '2026-10-05T09:00:00Z'), received('b', '2026-10-06T09:00:00Z'),
    received('c', '2026-09-10T09:00:00Z'), received('d', '2026-09-29T09:00:00Z')], 'month', '2026-10-27')
  assert.equal(change.label, 'vs last month')
  assert.equal(change.received, 1, '2 this month vs 1 by 27 Sep (29 Sep is after the same day)')
})

test('2: Ctrl+K matches every word, ignoring case and accents; labels starting with the text come first', () => {
  const items = [
    { id: 1, label: 'Proposals', hint: 'Page' },
    { id: 2, label: 'New request', hint: 'Action' },
    { id: 3, label: 'Café Riche · Summer day', hint: 'PR-2026-0007' },
    { id: 4, label: 'Add past record', hint: 'Action', keywords: 'old proposal' },
  ]
  assert.deepEqual(commandMatches(items, '').map((i) => i.id), [1, 2, 3, 4])
  assert.deepEqual(commandMatches(items, 'cafe summer').map((i) => i.id), [3])
  assert.deepEqual(commandMatches(items, '0007').map((i) => i.id), [3])
  assert.deepEqual(commandMatches(items, 'pro').map((i) => i.id), [1, 4])
  assert.deepEqual(commandMatches(items, 'zzz'), [])
})

test('1: a peek lives in the URL: a proposal by its ID, an event as event:<ID>', () => {
  assert.equal(peekToken('proposal', 'PR-2026-0007'), 'PR-2026-0007')
  assert.equal(peekToken('event', 'PR-2026-0007'), 'event:PR-2026-0007')
  assert.deepEqual(parsePeek('event:PR-2026-0007'), { kind: 'event', id: 'PR-2026-0007' })
  assert.deepEqual(parsePeek('PR-2026-0007'), { kind: 'proposal', id: 'PR-2026-0007' })
  assert.equal(parsePeek(null), null)
})

test('8: the event sheet never carries a price; facilitators only for HR / Operations; text is escaped', () => {
  const ev = {
    id: 'PR-2026-0007', clientName: 'Sodic <School>', eventName: 'Family day', brand: 'grasshoppers', service: 'family_day',
    eventDate: '2026-11-12', eventDatePrecision: 'day', venue: 'Zayed park', participants: 120, finalPrice: 98765, amPrice: 87654,
    brief: 'Games & lunch', briefTags: [], specificRequirements: null, teamNotes: 'Gate 3',
    contact: { name: 'Mona', phone: '0100', email: null },
    staffing: { facilitators: [{ id: 1, name: 'Karim', phone: '0111' }] },
  }
  const ops = eventSheetHtml(ev, { lists: null, showFacilitators: true })
  assert.ok(!/98765|98,765|87654|87,654|EGP|price/i.test(ops), 'no price at all')
  assert.ok(ops.includes('Sodic &lt;School&gt;') && ops.includes('Games &amp; lunch'))
  assert.ok(ops.includes('Facilitators assigned') && ops.includes('Karim · 0111'))
  assert.ok(ops.includes('Mona · 0100') && ops.includes('Zayed park') && ops.includes('12 Nov 2026'))
  assert.ok(ops.includes('<strong>IEE</strong>') && ops.includes('Grasshoppers'))

  const bd = eventSheetHtml(ev, { lists: null, showFacilitators: false })
  assert.ok(!bd.includes('Facilitators assigned'))
  const hr = eventSheetHtml({ ...ev, contact: null }, { lists: null, showFacilitators: true })
  assert.ok(!hr.includes('Client contact'), 'no contact when the viewer may not see it')
})
