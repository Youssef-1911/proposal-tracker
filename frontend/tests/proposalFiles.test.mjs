// Proposal files (upload eligibility, download names), comments, counters. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDemoData } from '../src/demo/seed.js'
import {
  COMMENT_MAX_LENGTH, PROPOSAL_FILE_MAX_BYTES, UPLOAD_STATUSES, canSeeReplacedFiles, downloadFileName, uploadTarget,
  validateComment,
} from '../src/domain/proposalFiles.js'
import { pricePerParticipant, proposalVersions, stageTiming } from '../src/domain/proposals.js'
import { PROPOSAL_STATUS as PS } from '../src/domain/status.js'

const as = (userId, activeRole) => ({ userId, activeRole })
const NOHA = as('u-noha', 'commercial_head')
const MK_AM = as('u-mariam-elkhayat', 'account_manager')
const MK_BD = as('u-mariam-elkhayat', 'business_development')
const MD_AM = as('u-mariam-dimitri', 'account_manager')
const AHMED = as('u-ahmed', 'business_development')

function world() {
  const d = createDemoData()
  const usersById = Object.fromEntries(d.users.map((u) => [u.id, u]))
  const get = (id) => d.proposalRequests.find((r) => r.id === id)
  return { d, usersById, get }
}

test('only the assigned AM uploads, only while the request is with the AM; reasons name who can', () => {
  const w = world()
  assert.deepEqual(UPLOAD_STATUSES, [PS.SUBMITTED, PS.IN_PROGRESS, PS.AWAITING_BD_INFO, PS.REVISION_REQUESTED])
  assert.equal(PROPOSAL_FILE_MAX_BYTES, 25 * 1024 * 1024)
  const ok = uploadTarget(w.get('PR-2026-0014'), MK_AM, w.usersById) // In Progress, Grasshoppers
  assert.deepEqual(ok, { allowed: true, code: null, reason: null, version: 1, replaces: false, startsWork: false })
  for (const viewer of [NOHA, AHMED]) {
    const res = uploadTarget(w.get('PR-2026-0014'), viewer, w.usersById)
    assert.deepEqual([res.allowed, res.code], [false, 'forbidden'], viewer.userId)
    assert.match(res.reason, /Only the assigned Account Manager, Mariam El Khayat/)
  }
  // The other brand's AM does not see the request at all, unless given "See all brands".
  assert.equal(uploadTarget(w.get('PR-2026-0014'), MD_AM, w.usersById).code, 'not_found')
  w.usersById[MD_AM.userId] = { ...w.usersById[MD_AM.userId], privileges: { ...w.usersById[MD_AM.userId].privileges, seeAllBrands: true } }
  const seen = uploadTarget(w.get('PR-2026-0014'), MD_AM, w.usersById)
  assert.deepEqual([seen.allowed, seen.code], [false, 'forbidden'])
  assert.match(seen.reason, /Only the assigned Account Manager, Mariam El Khayat/)
  assert.match(uploadTarget(w.get('PR-2026-0014'), MK_BD, w.usersById).reason,
    /Switch your active role to Account Manager — Grasshoppers/)
  const ready = uploadTarget(w.get('PR-2026-0010'), MD_AM, w.usersById) // Ready for BD
  assert.deepEqual([ready.allowed, ready.code], [false, 'invalid_transition'])
  assert.equal(uploadTarget(w.get('PR-2026-0019'), MD_AM, w.usersById).code, 'not_found', "someone else's draft")
})

test('uploading again replaces the version being prepared; a revision prepares the next version', () => {
  const w = world()
  assert.equal(uploadTarget(w.get('PR-2026-0015'), MD_AM, w.usersById).replaces, true, 'demo file already uploaded')
  const revision = uploadTarget(w.get('PR-2026-0006'), MD_AM, w.usersById) // Revision Requested, v1 locked
  assert.deepEqual([revision.allowed, revision.version, revision.replaces], [true, 2, false])
})

test('download names: request id, client name in safe characters, version', () => {
  assert.equal(downloadFileName('PR-2026-0042', 'Papyrus Fintech', 2, 'pdf'), 'PR-2026-0042_Papyrus_Fintech_v2.pdf')
  assert.equal(downloadFileName('PR-2026-0042', '../../etc/passwd & <b>', 1, 'pptx'), 'PR-2026-0042_etc_passwd_b_v1.pptx')
  assert.equal(downloadFileName('PR-2026-0042', 'مدرسة النيل', 1, 'pdf'), 'PR-2026-0042_Client_v1.pdf')
})

test('comments: plain text, trimmed, 1 to 2,000 characters', () => {
  assert.equal(COMMENT_MAX_LENGTH, 2000)
  assert.deepEqual(validateComment('  <b>Hi</b> & thanks  '), { errors: {}, body: '<b>Hi</b> & thanks' })
  assert.ok(validateComment('   ').errors.body)
  assert.ok(validateComment(null).errors.body)
  assert.deepEqual(validateComment('x'.repeat(2000)).errors, {})
  assert.match(validateComment('x'.repeat(2001)).errors.body, /up to 2,000 characters \(this one has 2001\)/)
})

test('price per participant is rounded to whole EGP and shown per version', () => {
  assert.equal(pricePerParticipant(250000, 300), 833)
  assert.equal(pricePerParticipant(100, 8), 13, '12.5 rounds up')
  assert.equal(pricePerParticipant(null, 300), null)
  assert.equal(pricePerParticipant(1000, null), null)
  const w = world()
  const [current] = proposalVersions(w.get('PR-2026-0010')) // 285,000 for 350 people
  assert.deepEqual([current.pricePerParticipant, current.hasFile], [814, true])
})

test('stage timing: time in the current stage and since shared with the client', () => {
  const w = world()
  const now = new Date()
  const shared = stageTiming(w.get('PR-2026-0007'), now) // Shared with Client
  assert.equal(shared.stageSince, shared.sharedAt)
  assert.ok(shared.daysSinceShared >= 0 && shared.daysInStage === shared.daysSinceShared)
  // With AM since the revision was requested, across the following In Progress.
  const r = w.get('PR-2026-0006')
  const t = stageTiming(r, now)
  assert.equal(t.stageSince, r.statusHistory.find((e) => e.status === PS.REVISION_REQUESTED).changedAt)
  assert.equal(t.daysSinceShared, null, 'only counted while the request is with the client')
  assert.ok(t.sharedAt)
})

test('uploading while Submitted also starts work; allowed while Awaiting BD Information', () => {
  const w = world()
  const submitted = uploadTarget(w.get('PR-2026-0016'), MK_AM, w.usersById) // Submitted, Grasshoppers
  assert.deepEqual([submitted.allowed, submitted.startsWork, submitted.version], [true, true, 1])
  const awaiting = uploadTarget(w.get('PR-2026-0012'), MK_AM, w.usersById) // Awaiting BD Information
  assert.deepEqual([awaiting.allowed, awaiting.startsWork], [true, false])
})

test('replaced files: only the assigned AM (as AM) and the Commercial Head see them', () => {
  const w = world()
  const r = w.get('PR-2026-0014') // AM Mariam El Khayat
  assert.equal(canSeeReplacedFiles(r, MK_AM), true)
  assert.equal(canSeeReplacedFiles(r, NOHA), true)
  for (const v of [MK_BD, MD_AM, AHMED]) assert.equal(canSeeReplacedFiles(r, v), false, v.userId)
})
