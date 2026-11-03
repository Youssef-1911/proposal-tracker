// Analytics metrics (Commercial Head). Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDemoData } from '../src/demo/seed.js'
import { BRANDS } from '../src/domain/brands.js'
import { LOST_REASONS, PROPOSAL_STATUS as PS } from '../src/domain/status.js'
import {
  bdRequestActivity, lostReasonBreakdown, requestWinRate, requestsByBrandService, requestsForHead,
} from '../src/domain/metrics.js'

const data = createDemoData()
const visible = requestsForHead(data.proposalRequests) // what the Head sees: no drafts

test('win rate = won / (won + lost); cancelled requests are not an outcome', () => {
  const r = requestWinRate(visible)
  const count = (s) => visible.filter((x) => x.status === s).length
  assert.deepEqual([r.won, r.lost], [count(PS.ACCEPTED), count(PS.REJECTED)])
  assert.equal(r.decided, r.won + r.lost)
  assert.equal(r.winRate, r.won / (r.won + r.lost))
  assert.equal(requestWinRate([]).winRate, null)
})

test('lost reasons come from the rejected history entry, in the fixed list order', () => {
  const b = lostReasonBreakdown(visible, LOST_REASONS)
  assert.deepEqual(b.rows.map((x) => x.id), LOST_REASONS.map((x) => x.id))
  assert.equal(b.rows.find((x) => x.id === 'price').count, 1, 'demo PR-0001')
  assert.equal(b.rows.find((x) => x.id === 'competitor').count, 1, 'demo PR-0003')
  assert.equal(b.total, b.rows.reduce((n, x) => n + x.count, 0) + b.notRecorded)
})

test('BD activity: one row per BD, counts from their own requests and opportunities', () => {
  const rows = bdRequestActivity(data.users, { opportunities: data.opportunities, requests: visible })
  assert.deepEqual(rows.map((r) => r.user.id).sort(), data.users.filter((u) => u.roles.includes('business_development')).map((u) => u.id).sort())
  for (const row of rows) {
    const mine = visible.filter((r) => r.bdOwner === row.user.id)
    assert.ok(row.submitted <= mine.length && row.shared <= row.submitted && row.won <= row.shared, row.user.id)
  }
})

test('requests by brand and service count submitted requests only', () => {
  const rows = requestsByBrandService(data.proposalRequests, BRANDS)
  assert.equal(rows.reduce((n, r) => n + r.count, 0), data.proposalRequests.filter((r) => r.status !== PS.DRAFT).length)
  assert.ok(rows.every((r) => r.count > 0))
})
