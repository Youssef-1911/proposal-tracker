// Shared contract scenarios (../../contracts/proposal-scenarios.json).
// The SAME file is checked by the backend (backend/tests/test_contracts.py), so the
// JavaScript and Python rules cannot drift apart. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { applyAction, getActions, canEditDraft, validateRequestFields } from '../src/domain/workflow.js'
import * as CRM from '../src/domain/crm.js'
import { eventTiming } from '../src/domain/events.js'
import * as ACCESS from '../src/domain/access.js'
import * as ACCOUNTS from '../src/domain/accounts.js'
import { pricePerParticipant, proposalVersions, responsibleFor, stageTiming } from '../src/domain/proposals.js'
import {
  COMMENT_MAX_LENGTH, PROPOSAL_FILE_MAX_BYTES, PROPOSAL_FILE_TYPES, UPLOAD_STATUSES, canSeeReplacedFiles, uploadTarget,
  validateComment,
} from '../src/domain/proposalFiles.js'
import { isOpenRequest, isRequestOverdue, isDeadlinePending, waitingOn } from '../src/domain/metrics.js'
import { LOST_REASONS, SHARE_CHANNELS, STATUS_CONFIG, stageList, stageOf, subLabelFor } from '../src/domain/status.js'
import { EMPTY_FILTERS, deadlineState, followUpDue, needsMyAction, queryTracker, scopesFor } from '../src/domain/tracker.js'

const scenarios = JSON.parse(readFileSync(new URL('../../contracts/proposal-scenarios.json', import.meta.url), 'utf8'))
const { world, today } = scenarios
const now = new Date(scenarios.now)
const usersById = Object.fromEntries(world.users.map((u) => [u.id, u]))
const clientsById = Object.fromEntries(world.clients.map((c) => [c.id, c]))
const requestsById = Object.fromEntries(world.requests.map((r) => [r.id, r]))
const ACTION_KEYS = ['action', 'label', 'to', 'requires', 'notePrompt', 'confirm', 'tone', 'allowed', 'reason']
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))

test('contract file is well-formed and covers every viewer, scope and tab', () => {
  assert.ok(scenarios.requestCases.length >= 20)
  assert.ok(scenarios.trackerCases.length >= 100)
  assert.ok(scenarios.trackerCases.some((c) => c.state.filters?.stage), 'stage filter cases present')
  assert.equal(scenarios.viewers.length, 11)
  for (const role of ['executive', 'marketing', 'operations']) assert.ok(scenarios.viewers.some((v) => v.activeRole === role), role)
})

test('per-request rules match the contract (status, deadlines, responsibility, versions)', () => {
  for (const c of scenarios.requestCases) {
    const r = requestsById[c.id]
    assert.equal(isOpenRequest(r), c.isOpen, c.id)
    assert.equal(STATUS_CONFIG.proposal[r.status].closed, c.isClosed, c.id)
    assert.equal(waitingOn(r), c.waitingOn, c.id)
    assert.equal(isDeadlinePending(r), c.deadlinePending, c.id)
    assert.equal(isRequestOverdue(r, today), c.isOverdue, c.id)
    assert.equal(deadlineState(r, today), c.deadlineState, c.id)
    assert.deepEqual(responsibleFor(r), c.responsible, c.id)
    assert.deepEqual(proposalVersions(r), c.versions, c.id)
    assert.equal(stageOf(r.status), c.stage, c.id)
    assert.equal(subLabelFor(r.status, r.version), c.subLabel, c.id)
    assert.equal(pricePerParticipant(r.amPrice, r.participants), c.amPricePerParticipant, c.id)
    assert.deepEqual(stageTiming(r, now), c.timing, c.id)
    for (const p of c.perViewer) {
      assert.deepEqual(uploadTarget(r, p.viewer, usersById), p.upload, `${c.id} upload as ${p.viewer.userId}/${p.viewer.activeRole}`)
      assert.equal(canSeeReplacedFiles(r, p.viewer), p.seesReplacedFiles, c.id)
    }
  }
})

test('proposal file settings and comment validation match the contract', () => {
  assert.deepEqual(scenarios.proposalFiles,
    { types: PROPOSAL_FILE_TYPES, maxBytes: PROPOSAL_FILE_MAX_BYTES, uploadStatuses: UPLOAD_STATUSES })
  assert.equal(scenarios.commentMaxLength, COMMENT_MAX_LENGTH)
  for (const c of scenarios.commentCases) assert.deepEqual(validateComment(c.body), c.expect, String(c.body).slice(0, 40))
})

test('display stages, status-to-stage map and lost reasons match the contract', () => {
  assert.deepEqual(stageList().map(({ id, label, order }) => ({ id, label, order })), scenarios.stages)
  for (const [id, s] of Object.entries(scenarios.statusStages)) {
    assert.deepEqual({ stage: STATUS_CONFIG.proposal[id].stage, subLabel: STATUS_CONFIG.proposal[id].subLabel }, s, id)
  }
  assert.deepEqual(LOST_REASONS, scenarios.lostReasons)
})

test('per-viewer visibility, editability, needs-my-action and allowed actions match the contract', () => {
  for (const c of scenarios.requestCases) {
    const r = requestsById[c.id]
    for (const p of c.perViewer) {
      const label = `${c.id} as ${p.viewer.userId}/${p.viewer.activeRole}`
      assert.equal(ACCESS.canSeeRequest(r, p.viewer, usersById), p.canView, label)
      assert.equal(ACCESS.canCommentOnRequest(r, p.viewer, usersById), p.canComment, label)
      assert.equal(canEditDraft(r, p.viewer, usersById), p.canEditDraft, label)
      assert.equal(needsMyAction(r, p.viewer, usersById, now), p.needsMyAction, label)
      assert.deepEqual(getActions(r, p.viewer, usersById).map((a) => pick(a, ACTION_KEYS)), p.actions, label)
    }
  }
})

test('tracker results (ids in order, tab counts, scope size) match the contract', () => {
  for (const c of scenarios.trackerCases) {
    const ctx = { viewer: c.viewer, user: usersById[c.viewer.userId], usersById, clientsById, today, now }
    const out = queryTracker(world.requests, { ...c.state, filters: { ...EMPTY_FILTERS, ...c.state.filters } }, ctx)
    const label = `${c.viewer.userId}/${c.viewer.activeRole} ${JSON.stringify(c.state)}`
    assert.deepEqual(out.rows.map((r) => r.id), c.expect.ids, label)
    assert.deepEqual(out.counts, c.expect.counts, label)
    assert.equal(out.scoped.length, c.expect.scopeSize, label)
  }
})

// Same extraction as contracts/generate-scenarios.mjs actionOutcome().
function actionOutcome(res) {
  if (!res.ok) return { ok: false, code: res.code, error: res.error, errors: res.errors }
  const r = res.request
  return {
    ok: true, status: r.status, stage: stageOf(r.status), subLabel: subLabelFor(r.status, r.version), version: r.version,
    amPrice: r.amPrice, requiredBy: r.requiredBy, submittedBy: r.submittedBy, submittedAt: r.submittedAt,
    lastUpdated: r.lastUpdated, historyLength: r.statusHistory.length, entry: r.statusHistory.at(-1),
    opportunityChange: res.opportunityChange, warnings: res.warnings, message: res.message,
  }
}

test('action outcomes (status, history entry, opportunity effect, warnings, failures) match the contract', () => {
  assert.ok(scenarios.actionCases.length >= 100)
  assert.deepEqual(SHARE_CHANNELS, scenarios.shareChannels)
  for (const c of scenarios.actionCases) {
    const all = [...world.requests, ...(c.extraRequests ?? [])]
    const request = all.find((r) => r.id === c.requestId)
    const res = applyAction(request, c.action, c.input, {
      viewer: c.viewer, usersById, opportunities: world.opportunities, allRequests: all, clients: world.clients, now,
    })
    assert.deepEqual(actionOutcome(res), c.expect, c.name)
  }
})

test('CRM rules (permissions, stage moves, fields, duplicates, transfers) match the contract', () => {
  const crm = scenarios.crmCases
  const clients = world.clients.map((c) => ({ ...c, contacts: c.contacts ?? [c.contact] }))
  const archived = { ...clients.find((c) => c.id === 'c-08'), id: 'c-99', archivedAt: scenarios.now }
  const clientById = Object.fromEntries([...clients, archived].map((c) => [c.id, c]))
  const oppById = Object.fromEntries(world.opportunities.map((o) => [o.id, o]))
  for (const c of crm.clientPermissions) assert.deepEqual(CRM.clientPermissions(clientById[c.clientId], c.viewer, usersById), c.expect, c.clientId)
  for (const c of crm.createClient) assert.deepEqual(CRM.canCreateClient(c.viewer, usersById), c.expect)
  for (const c of crm.newClientOwner) assert.deepEqual(CRM.newClientOwner(c.viewer, c.requested, usersById), c.expect)
  for (const c of crm.opportunityPermissions) {
    const o = oppById[c.opportunityId]
    assert.deepEqual({ edit: CRM.canEditOpportunity(o, c.viewer, usersById), targets: CRM.manualStageTargets(o) }, c.expect)
  }
  for (const c of crm.stageMoves) assert.deepEqual(CRM.validateStageMove(oppById[c.opportunityId], c.input), c.expect)
  for (const c of crm.clientFields) assert.deepEqual(CRM.validateClientFields(c.input), c.expect)
  for (const c of crm.contactFields) assert.deepEqual(CRM.validateContactFields(c.input), c.expect)
  for (const c of crm.opportunityFields) assert.deepEqual(CRM.validateOpportunityFields(c.input, { today, current: c.current }), c.expect)
  for (const c of crm.phones) assert.equal(CRM.normalizePhone(c.phone), c.expect, c.phone)
  for (const c of crm.duplicates) assert.deepEqual(CRM.findPossibleDuplicateClients(c.candidate, clients), c.expect)
  for (const c of crm.transfers) {
    assert.deepEqual(CRM.transferPlan(clientById[c.clientId], { opportunities: world.opportunities, requests: world.requests },
      { moveRequests: c.moveRequests }), c.expect)
  }
  for (const c of crm.transferInputs) assert.deepEqual(CRM.validateTransfer(clientById[c.clientId], c.input, usersById), c.expect)
})

test('accounts, roles and privileges (visibility, pages, account checks, safeguards, routing) match the contract', () => {
  const a = scenarios.accountCases
  const users = world.users
  const routing = a.routing
  for (const c of a.defaults) assert.deepEqual(ACCESS.defaultPrivileges(c.roles), c.expect, c.roles.join('+'))
  for (const c of a.privileges) assert.deepEqual(ACCESS.privilegesOf(usersById[c.userId]), c.expect, c.userId)
  for (const c of a.perViewer) {
    const user = usersById[c.viewer.userId]
    const label = `${c.viewer.userId}/${c.viewer.activeRole}`
    assert.deepEqual({
      seesProposalData: ACCESS.seesProposalData(c.viewer.activeRole),
      visibleBrands: ACCESS.visibleBrands(c.viewer, user),
      scopes: scopesFor(c.viewer.activeRole, user).map((s) => s.id),
      pages: ACCESS.pageAccess(c.viewer, user),
      analytics: ACCESS.canSeeAnalytics(user, c.viewer),
      analyticsBrands: ACCESS.analyticsBrands(c.viewer, user),
      manageAccounts: ACCOUNTS.canManageAccounts(c.viewer, usersById),
    }, c.expect, label)
  }
  for (const c of a.clientVisibility) assert.equal(ACCESS.canSeeClient(clientsById[c.clientId], c.viewer, usersById), c.expect, c.clientId)
  const oppsById = Object.fromEntries(world.opportunities.map((o) => [o.id, o]))
  for (const c of a.opportunityVisibility) assert.equal(ACCESS.canSeeOpportunity(oppsById[c.opportunityId], c.viewer, usersById), c.expect, c.opportunityId)
  for (const c of a.fields) assert.deepEqual(ACCOUNTS.validateAccountFields(c.input, { users, id: c.id }), c.expect, JSON.stringify(c.input))
  for (const c of a.ids) assert.equal(ACCOUNTS.newAccountId(c.name, c.existing), c.expect, c.name)
  for (const c of a.initials) assert.equal(ACCOUNTS.initialsFor(c.name), c.expect, c.name)
  for (const c of a.updates) {
    const { values } = ACCOUNTS.validateAccountFields(c.input, { users, id: c.targetId })
    assert.deepEqual(ACCOUNTS.checkAccountUpdate(usersById[c.targetId], values, { actorId: c.actorId, users, routing }), c.expect, `${c.actorId} edits ${c.targetId}`)
  }
  const two = users.map((u) => (u.id === 'u-doaa' ? { ...u, privileges: { ...u.privileges, manageAccounts: true } } : u))
  for (const c of a.updatesWithTwoManagers) {
    const noha = usersById[c.targetId]
    const { values } = ACCOUNTS.validateAccountFields({ ...noha, privileges: { ...ACCESS.privilegesOf(noha), manageAccounts: false } }, { users: two, id: c.targetId })
    assert.deepEqual(ACCOUNTS.checkAccountUpdate(noha, values, { actorId: c.actorId, users: two, routing }), c.expect)
  }
  for (const c of a.deactivate) {
    assert.deepEqual(ACCOUNTS.canDeactivate(usersById[c.targetId], { actorId: c.actorId, users, routing }), c.expect, `${c.actorId} -> ${c.targetId}`)
  }
  for (const c of a.reactivate) assert.deepEqual(ACCOUNTS.canReactivate(usersById[c.userId]), c.expect, c.userId)
  for (const c of a.warnings) {
    assert.deepEqual(ACCOUNTS.deactivationWarnings(usersById[c.userId], { clients: world.clients, requests: world.requests }), c.expect, c.userId)
  }
  for (const c of a.changes) {
    const { values } = ACCOUNTS.validateAccountFields(c.input, { users, id: c.userId })
    assert.deepEqual(ACCOUNTS.accountChanges(usersById[c.userId], values), c.expect, c.userId)
  }
  for (const c of a.routingChoices) assert.deepEqual(ACCOUNTS.routingChoices(c.brand, users).map((u) => u.id), c.expect, c.brand)
  for (const c of a.routingInputs) assert.deepEqual(ACCOUNTS.validateRouting(c.brand, c.amId, { users, routing }), c.expect, `${c.brand} ${c.amId}`)
  for (const c of a.actsAsBD) assert.equal(ACCESS.actsAsBusinessDevelopment(c.viewer, usersById[c.viewer.userId]), c.expect, c.viewer.userId)
  for (const c of a.canOwnClients) assert.equal(ACCESS.canOwnClients(usersById[c.userId]), c.expect, c.userId)
  for (const c of a.deactivationMoves) {
    assert.deepEqual(ACCOUNTS.deactivationMove(usersById[c.userId], { users, requests: world.requests }), c.expect, c.userId)
  }
  for (const c of a.deactivationMoveInputs) {
    assert.deepEqual(ACCOUNTS.validateDeactivationMove(usersById[c.userId], c.input, { users, requests: world.requests }), c.expect, c.userId)
  }
  assert.equal(ACCOUNTS.assignedAmChangeNote('Mariam Dimitri', 'Hana Wahba', 'Noha El Kenawy'), a.amChangeNote)
})

test('real-data phase: event date ranges and "Not set yet", new services, follow-up dates match the contract', () => {
  const r = scenarios.realDataCases
  for (const c of r.requestFields) {
    assert.deepEqual(validateRequestFields(c.input, { mode: c.mode, today, clients: world.clients, opportunities: world.opportunities }),
      c.expect, JSON.stringify(c.input))
  }
  for (const c of r.opportunityFields) {
    assert.deepEqual(CRM.validateOpportunityFields(c.input, { today, current: null }), c.expect, JSON.stringify(c.input))
  }
  for (const c of r.followUpDue) assert.equal(followUpDue(requestsById[c.id], now), c.expect, c.id)
  for (const c of r.eventNameFields) {
    assert.deepEqual(validateRequestFields(c.input, { mode: c.mode, today, clients: world.clients, opportunities: world.opportunities }),
      c.expect, JSON.stringify(c.input).slice(0, 80))
  }
  for (const c of r.opportunityEventNames) assert.deepEqual(CRM.validateOpportunityFields(c.input, { today, current: null }), c.expect)
  for (const c of r.clientSearch) assert.deepEqual(CRM.searchClients(c.query, world.clients), c.expect, c.query)
  for (const c of r.didYouMean) assert.equal(CRM.didYouMean(c.name, world.clients), c.expect, c.name)
  for (const c of r.eventTiming) assert.equal(eventTiming(requestsById[c.id], today), c.expect, c.id)
})
