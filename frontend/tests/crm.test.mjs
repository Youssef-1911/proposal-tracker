// Clients, contacts and opportunities rules (CRM 1). Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDemoData } from '../src/demo/seed.js'
import {
  canCreateClient, canEditOpportunity, clientPermissions, findPossibleDuplicateClients, manualStageTargets, newClientOwner,
  normalizePhone, transferPlan, validateClientFields, validateContactFields, validateOpportunityFields, validateStageMove,
  validateTransfer,
} from '../src/domain/crm.js'
import { OPPORTUNITY_STAGE as OS } from '../src/domain/status.js'

const as = (userId, activeRole) => ({ userId, activeRole })
const NOHA = as('u-noha', 'commercial_head')
const AHMED = as('u-ahmed', 'business_development')
const SHERINE = as('u-sherine', 'business_development')
const MK_AM = as('u-mariam-elkhayat', 'account_manager')
const MD_AM = as('u-mariam-dimitri', 'account_manager')
const data = createDemoData()
const usersById = Object.fromEntries(data.users.map((u) => [u.id, u]))
const client = (id) => data.clients.find((c) => c.id === id)
const opp = (id) => data.opportunities.find((o) => o.id === id)

test('creating clients: any BD (as BD) or the Commercial Head; an AM cannot', () => {
  assert.equal(canCreateClient(AHMED, usersById).allowed, true)
  assert.equal(canCreateClient(NOHA, usersById).allowed, true)
  assert.match(canCreateClient(MK_AM, usersById).reason, /Switch your active role to Business Development/)
  assert.equal(canCreateClient(MD_AM, usersById).reason, 'Only Business Development or the Commercial Head can create clients.')
  assert.deepEqual(newClientOwner(AHMED, 'u-sherine', usersById), { owner: 'u-ahmed' }, 'a BD always becomes the owner')
  assert.deepEqual(newClientOwner(NOHA, 'u-sherine', usersById), { owner: 'u-sherine' })
  assert.ok(newClientOwner(NOHA, 'u-mariam-dimitri', usersById).errors.owner, 'the owner must be BD')
})

test('editing a client: its owner (as BD) or the Head; others get the owner named; transfer is Head only', () => {
  const c = client('c-08') // owner Ahmed
  assert.equal(clientPermissions(c, AHMED, usersById).edit.allowed, true)
  assert.equal(clientPermissions(c, NOHA, usersById).edit.allowed, true)
  assert.equal(clientPermissions(c, SHERINE, usersById).edit.reason,
    'Only the relationship owner, Ahmed Seif, or the Commercial Head can do this.')
  assert.equal(clientPermissions(c, AHMED, usersById).transfer.reason, 'Only the Commercial Head can transfer a client to another owner.')
  assert.equal(clientPermissions(c, NOHA, usersById).transfer.allowed, true)
  const own = client('c-01') // owner Mariam El Khayat
  assert.match(clientPermissions(own, MK_AM, usersById).edit.reason, /Switch your active role to Business Development/)
  assert.equal(clientPermissions({ ...c, archivedAt: '2026-10-01T00:00:00Z' }, NOHA, usersById).edit.reason, 'This client is archived.')
})

test('opportunities: owner or Head edit; Won is never a manual target and Won is final', () => {
  assert.equal(canEditOpportunity(opp('OPP-0004'), AHMED, usersById).allowed, true)
  assert.match(canEditOpportunity(opp('OPP-0004'), SHERINE, usersById).reason, /Only the opportunity owner, Ahmed Seif/)
  assert.ok(!manualStageTargets(opp('OPP-0004')).includes(OS.WON))
  assert.deepEqual(manualStageTargets(opp('OPP-0016')), [], 'Won is final')
  const won = validateStageMove(opp('OPP-0004'), { stage: OS.WON })
  assert.equal(won.code, 'invalid_transition')
})

test('manual Lost needs a listed reason; reopening a Lost opportunity needs a note', () => {
  const o = opp('OPP-0004')
  assert.ok(validateStageMove(o, { stage: OS.LOST }).errors.lostReason)
  assert.ok(validateStageMove(o, { stage: OS.LOST, lostReason: 'other' }).errors.note)
  const lost = validateStageMove(o, { stage: OS.LOST, lostReason: 'budget_cancelled' })
  assert.deepEqual([lost.ok, lost.lostReason, lost.reasonCode], [true, 'budget_cancelled', 'manual_change'])
  const reopen = opp('OPP-0018') // Lost
  assert.ok(validateStageMove(reopen, { stage: OS.NEGOTIATION }).errors.note)
  assert.equal(validateStageMove(reopen, { stage: OS.NEGOTIATION, note: 'Client called back' }).ok, true)
})

test('field validation for clients, contacts and opportunities (no past dates on new or changed dates)', () => {
  assert.deepEqual(Object.keys(validateClientFields({}).errors).sort(), ['brands', 'name', 'type'])
  assert.deepEqual(validateClientFields({ name: ' Nile School ', type: 'school', brands: ['grasshoppers'] }).errors, {})
  assert.ok(validateContactFields({ name: 'A', email: 'not-an-email' }).errors.email)
  assert.deepEqual(validateContactFields({ name: 'A', phone: '+20 100 555-0106', email: 'a@b.co' }).errors, {})
  const today = '2026-10-21'
  const base = { brand: 'teamup', service: 'family_day' }
  assert.ok(validateOpportunityFields({ ...base, service: 'summer_camp' }, { today }).errors.service)
  assert.ok(validateOpportunityFields({ ...base, eventDate: '2026-10-20' }, { today }).errors.eventDate)
  assert.ok(validateOpportunityFields({ ...base, nextActionDate: '2026-10-01' }, { today }).errors.nextActionDate)
  assert.ok(validateOpportunityFields({ ...base, estimatedValue: '12.5' }, { today }).errors.estimatedValue)
  const current = { eventDate: '2026-10-01', nextActionDate: '2026-10-02' }
  assert.deepEqual(validateOpportunityFields({ ...base, eventDate: '2026-10-01', nextActionDate: '2026-10-02' }, { today, current }).errors, {},
    'an unchanged past date may stay')
})

test('Egyptian phone formats and emails are compared normalised; similar names match', () => {
  for (const p of ['+20 100 555 0106', '00201005550106', '01005550106', '0100-555-0106']) {
    assert.equal(normalizePhone(p), '1005550106', p)
  }
  const existing = data.clients.map((c) => ({ ...c, contacts: [c.contact] }))
  const oakpalm = existing.find((c) => c.name === 'Oakpalm American School')
  const byName = findPossibleDuplicateClients({ name: 'oakpalm american school ', contacts: [] }, existing)
  assert.deepEqual(byName.map((d) => [d.id, d.matches]), [[oakpalm.id, ['name']]])
  const byPhone = findPossibleDuplicateClients({ name: 'Different', contacts: [{ phone: oakpalm.contact.phone.replace('+20 ', '0') }] }, existing)
  assert.deepEqual(byPhone.map((d) => d.matches), [['phone']])
  const byEmail = findPossibleDuplicateClients({ name: 'Different', contacts: [{ email: oakpalm.contact.email.toUpperCase() }] }, existing)
  assert.deepEqual(byEmail.map((d) => d.matches), [['email']])
  assert.deepEqual(findPossibleDuplicateClients({ name: 'Oakpalm', contacts: [] }, existing, oakpalm.id), [], 'excludes itself')
})

test('transfer: reason required; open opportunities move; open requests move only when ticked', () => {
  const c = client('c-07') // Abdelrahman: one submitted, one cancelled, one rejected request
  assert.deepEqual(Object.keys(validateTransfer(c, { toOwner: 'u-abdelrahman' }, usersById).errors).sort(), ['reason', 'toOwner'])
  assert.deepEqual(validateTransfer(c, { toOwner: 'u-sherine', reason: 'Account review' }, usersById).errors, {})
  const all = transferPlan(c, { opportunities: data.opportunities, requests: data.proposalRequests }, { moveRequests: true })
  const none = transferPlan(c, { opportunities: data.opportunities, requests: data.proposalRequests }, { moveRequests: false })
  assert.ok(all.opportunityIds.length > 0 && !all.opportunityIds.includes('OPP-0018'), 'Lost OPP-0018 keeps its owner')
  assert.equal(all.requestIds.length, all.openRequestCount)
  assert.ok(all.requestIds.every((id) => ['submitted', 'in_progress', 'awaiting_bd_info', 'ready_for_bd', 'shared_with_client',
    'revision_requested'].includes(data.proposalRequests.find((r) => r.id === id).status)), 'open requests only')
  assert.deepEqual([none.requestIds, none.opportunityIds], [[], all.opportunityIds])
})
