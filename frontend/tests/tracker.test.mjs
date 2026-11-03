// Proposal Tracker rules. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDemoData } from '../src/demo/seed.js'
import {
  DEADLINE_STATE, EMPTY_FILTERS, SCOPE, SORT, TAB, activeFilterCount, deadlineState, needsMyAction,
  parseTrackerParams, queryTracker, requestsInScope, scopesFor, sortRequests, trackerParams, trackerRow,
} from '../src/domain/tracker.js'
import { saveRequest } from '../src/domain/workflow.js'
import { canViewRequest } from '../src/domain/proposals.js'
import { ROLE } from '../src/domain/roles.js'
import { PROPOSAL_STATUS as PS, STATUS_CONFIG } from '../src/domain/status.js'
import { isDraft, isOpenRequest, isRequestOverdue, todayISO } from '../src/domain/metrics.js'

const BD = ROLE.BUSINESS_DEVELOPMENT
const AM = ROLE.ACCOUNT_MANAGER
const as = (userId, activeRole) => ({ userId, activeRole })
const NOHA = as('u-noha', ROLE.COMMERCIAL_HEAD)
const AHMED = as('u-ahmed', BD)
const SHERINE = as('u-sherine', BD)
const MK_BD = as('u-mariam-elkhayat', BD)
const MK_AM = as('u-mariam-elkhayat', AM)
const MD_AM = as('u-mariam-dimitri', AM)

function setup(viewer, data = createDemoData()) {
  const usersById = Object.fromEntries(data.users.map((u) => [u.id, u]))
  const clientsById = Object.fromEntries(data.clients.map((c) => [c.id, c]))
  const ctx = { viewer, user: usersById[viewer.userId], usersById, clientsById, today: todayISO(), now: new Date() }
  const run = (over = {}) => {
    const state = {
      scope: over.scope ?? scopesFor(viewer.activeRole)[0].id,
      tab: over.tab ?? TAB.ALL,
      sort: over.sort ?? SORT.DEADLINE,
      filters: { ...EMPTY_FILTERS, ...(over.filters ?? {}) },
    }
    return queryTracker(data.proposalRequests, state, ctx)
  }
  const ids = (over) => run(over).rows.map((r) => r.id)
  return { data, ctx, run, ids }
}

// ---------- Scopes & visibility ----------

test('BD scopes: Mine = my requests + my drafts; Company = other owners\' non-draft requests; no overlap', () => {
  const { data, ctx, ids } = setup(AHMED)
  const mine = ids({ scope: SCOPE.MINE })
  const company = ids({ scope: SCOPE.COMPANY })
  assert.ok(mine.includes('PR-2026-0019'), "Ahmed's own draft")
  assert.ok(mine.every((id) => data.proposalRequests.find((r) => r.id === id).bdOwner === 'u-ahmed'))
  assert.ok(company.every((id) => { const r = data.proposalRequests.find((x) => x.id === id); return r.bdOwner !== 'u-ahmed' && !isDraft(r) }))
  assert.equal(mine.filter((id) => company.includes(id)).length, 0)
  const visibleNonDraft = data.proposalRequests.filter((r) => !isDraft(r))
  assert.equal(mine.filter((id) => !id.endsWith('0019')).length + company.length, visibleNonDraft.length)
  assert.deepEqual(scopesFor(BD).map((s) => s.id), [SCOPE.MINE, SCOPE.COMPANY])
  assert.equal(ctx.viewer, AHMED)
})

test('AM scopes: My brand = my brand\'s non-draft requests; Company = the other brand, only with "See all brands"', () => {
  const { data, ids } = setup(MD_AM)
  const mine = ids({ scope: SCOPE.MY_BRAND })
  const byId = (id) => data.proposalRequests.find((r) => r.id === id)
  assert.ok(mine.length > 0 && mine.every((id) => byId(id).brand === 'teamup' && !isDraft(byId(id))))
  assert.deepEqual(scopesFor(MD_AM.activeRole, data.users.find((u) => u.id === MD_AM.userId)).map((s) => s.id), [SCOPE.MY_BRAND])
  assert.deepEqual(ids({ scope: SCOPE.COMPANY }), [], 'no other-brand tab by default')

  const wide = createDemoData()
  wide.users.find((u) => u.id === MD_AM.userId).privileges.seeAllBrands = true
  const other = setup(MD_AM, wide).ids({ scope: SCOPE.COMPANY })
  assert.ok(other.length > 0 && other.every((id) => byId(id).brand === 'grasshoppers' && !isDraft(byId(id))))
})

test('Mariam El Khayat follows her active role: her drafts only in BD mode, Grasshoppers queue in AM mode', () => {
  const bd = setup(MK_BD).ids({ scope: SCOPE.MINE })
  const am = setup(MK_AM).ids({ scope: SCOPE.MY_BRAND })
  assert.ok(bd.includes('PR-2026-0018'))
  assert.equal(am.includes('PR-2026-0018'), false, 'draft is not AM work')
  assert.ok(am.includes('PR-2026-0016'), 'her own BD request appears in her AM queue (routed to herself)')
  assert.ok(am.includes('PR-2026-0014'), "another BD's Grasshoppers request")
})

test("Head sees every non-draft request plus her own drafts, never another person's draft", () => {
  const data = createDemoData()
  const created = saveRequest(data, { clientId: 'c-07', brand: 'teamup', service: 'family_day' }, {}, { viewer: NOHA })
  assert.equal(created.ok, true)
  data.proposalRequests = created.proposalRequests
  const { ids } = setup(NOHA, data)
  const all = ids({ scope: SCOPE.COMPANY })
  assert.ok(all.includes(created.request.id), 'her own draft')
  for (const draft of ['PR-2026-0018', 'PR-2026-0019']) assert.equal(all.includes(draft), false, draft)
  assert.equal(all.length, data.proposalRequests.filter((r) => !isDraft(r)).length + 1)
})

test('private drafts cannot leak through search, filters, tab counts or empty states', () => {
  const { run } = setup(NOHA)
  const byId = run({ filters: { q: 'PR-2026-0018' } })
  assert.deepEqual(byId.rows, [])
  assert.deepEqual(byId.counts, { all: 0, action: 0, overdue: 0, closed: 0 })
  const noMatch = run({ filters: { q: 'zzz-no-such-request' } })
  assert.deepEqual(byId.counts, noMatch.counts, 'a hidden draft looks exactly like no match')
  // Its client has other visible requests; searching the client never returns the draft.
  const client = run({ filters: { q: 'Crescent Valley' } }).rows
  assert.ok(client.length > 0 && client.every((r) => !isDraft(r)))
  assert.deepEqual(run({ filters: { status: [PS.DRAFT] } }).rows, [])
  // Sherine (BD) cannot see Mariam's draft in either scope.
  const s = setup(SHERINE)
  for (const scope of [SCOPE.MINE, SCOPE.COMPANY]) assert.equal(s.ids({ scope, filters: { q: '0018' } }).length, 0)
})

test('every row in every scope is viewable by its viewer', () => {
  for (const viewer of [NOHA, AHMED, SHERINE, MK_BD, MK_AM, MD_AM]) {
    const { data, ctx } = setup(viewer)
    for (const s of scopesFor(viewer.activeRole)) {
      for (const r of requestsInScope(data.proposalRequests, viewer, ctx.user, s.id)) {
        assert.ok(canViewRequest(r, viewer.userId), `${viewer.userId} ${s.id} ${r.id}`)
      }
    }
  }
})

// ---------- Search & filters ----------

test('search by request ID (partial, case-insensitive) and by client name', () => {
  const { ids } = setup(NOHA)
  assert.deepEqual(ids({ filters: { q: 'pr-2026-0007' } }), ['PR-2026-0007'])
  assert.ok(ids({ filters: { q: '0007' } }).includes('PR-2026-0007'))
  const harbor = ids({ filters: { q: 'harbor line' } })
  assert.ok(harbor.length >= 1)
  const { data } = setup(NOHA)
  assert.ok(harbor.every((id) => data.proposalRequests.find((r) => r.id === id).clientId === 'c-08'))
})

test('each filter narrows correctly: brand, status, assigned AM, BD owner, waiting on, open', () => {
  const { data, ids } = setup(NOHA)
  const get = (id) => data.proposalRequests.find((r) => r.id === id)
  const check = (filters, pred, label) => {
    const out = ids({ filters })
    assert.ok(out.length > 0, `${label} returns something`)
    assert.ok(out.every((id) => pred(get(id))), label)
  }
  check({ brand: 'grasshoppers' }, (r) => r.brand === 'grasshoppers', 'brand')
  check({ status: [PS.SUBMITTED] }, (r) => r.status === PS.SUBMITTED, 'single status')
  check({ status: [PS.SUBMITTED, PS.IN_PROGRESS] }, (r) => [PS.SUBMITTED, PS.IN_PROGRESS].includes(r.status), 'multi status')
  check({ assignedAM: 'u-mariam-dimitri' }, (r) => r.assignedAM === 'u-mariam-dimitri', 'assigned AM')
  check({ bdOwner: 'u-sherine' }, (r) => r.bdOwner === 'u-sherine', 'BD owner')
  check({ waitingOn: 'am' }, (r) => STATUS_CONFIG.proposal[r.status].waitingOn === 'am' && isOpenRequest(r), 'waiting on AM')
  check({ open: true }, isOpenRequest, 'open only')
})

test('deadline-state filter uses the existing deadline rules', () => {
  const { data, ids, ctx } = setup(NOHA)
  for (const state of Object.values(DEADLINE_STATE)) {
    const out = ids({ filters: { deadline: state } })
    assert.ok(out.every((id) => deadlineState(data.proposalRequests.find((r) => r.id === id), ctx.today) === state), state)
  }
  const overdue = ids({ filters: { deadline: DEADLINE_STATE.OVERDUE } })
  assert.deepEqual(overdue, data.proposalRequests.filter((r) => !isDraft(r) && isRequestOverdue(r, ctx.today)).map((r) => r.id))
  // Ready for BD / Shared are never "overdue": the AM has delivered.
  assert.equal(deadlineState(data.proposalRequests.find((r) => r.id === 'PR-2026-0007'), ctx.today), DEADLINE_STATE.NONE)
})

test('combined filters intersect; clearing filters restores the full scope', () => {
  const { run } = setup(NOHA)
  const all = run().rows.length
  const combo = run({ filters: { brand: 'teamup', waitingOn: 'am', bdOwner: 'u-abdelrahman' } }).rows
  assert.ok(combo.every((r) => r.brand === 'teamup' && r.bdOwner === 'u-abdelrahman'))
  const filters = { ...EMPTY_FILTERS, brand: 'teamup', status: [PS.SUBMITTED], q: 'x' }
  assert.equal(activeFilterCount(filters), 3)
  assert.equal(activeFilterCount(EMPTY_FILTERS), 0)
  assert.equal(run({ filters: EMPTY_FILTERS }).rows.length, all)
})

// ---------- Tabs ----------

test('tabs: Needs my action follows waitingOn + responsibility; Overdue; Closed', () => {
  const mkBD = setup(MK_BD).ids({ tab: TAB.ACTION })
  assert.ok(mkBD.includes('PR-2026-0018'), 'her draft')
  assert.ok(mkBD.includes('PR-2026-0011'), 'Ready for BD: she must share it')
  assert.equal(mkBD.includes('PR-2026-0016'), false, 'Submitted waits on the AM, not on her as BD')

  const mkAM = setup(MK_AM).ids({ tab: TAB.ACTION })
  assert.ok(mkAM.includes('PR-2026-0016') && mkAM.includes('PR-2026-0014'))
  assert.equal(mkAM.includes('PR-2026-0011'), false, 'Ready for BD waits on BD')

  const head = setup(NOHA)
  const stale = head.ids({ tab: TAB.ACTION })
  assert.ok(stale.length > 0 && stale.every((id) => {
    const r = head.data.proposalRequests.find((x) => x.id === id)
    return isOpenRequest(r) && needsMyAction(r, NOHA, head.ctx.usersById, head.ctx.now)
  }))

  const overdue = head.ids({ tab: TAB.OVERDUE })
  assert.ok(overdue.every((id) => isRequestOverdue(head.data.proposalRequests.find((r) => r.id === id), head.ctx.today)))
  const closed = head.ids({ tab: TAB.CLOSED })
  assert.ok(closed.length > 0 && closed.every((id) => STATUS_CONFIG.proposal[head.data.proposalRequests.find((r) => r.id === id).status].closed))
  const { counts } = head.run()
  assert.equal(counts.all, head.run().rows.length)
})

// ---------- Sorting ----------

test('default sort: active deadlines first (overdue on top), then other open/drafts, closed last; undated never invented', () => {
  const data = createDemoData()
  // A draft without a deadline (allowed for drafts) must not get a made-up date.
  const undated = saveRequest(data, { clientId: 'c-08', brand: 'teamup', service: 'team_building' }, {}, { viewer: AHMED })
  data.proposalRequests = undated.proposalRequests
  assert.equal(undated.request.requiredBy, null)

  for (const [viewer, scope] of [[AHMED, SCOPE.MINE], [NOHA, SCOPE.COMPANY]]) {
    const { run, ctx } = setup(viewer, data)
    const rows = run({ scope }).rows
    const group = (r) => (STATUS_CONFIG.proposal[r.status].closed ? 2
      : isOpenRequest(r) && STATUS_CONFIG.proposal[r.status].deadlinePending ? 0 : 1)
    const groups = rows.map(group)
    assert.deepEqual(groups, [...groups].sort(), `${viewer.userId}: groups in order`)
    for (const g of [0, 1]) {
      const dated = rows.filter((r) => group(r) === g && r.requiredBy).map((r) => r.requiredBy)
      assert.deepEqual(dated, [...dated].sort(), `${viewer.userId}: group ${g} by deadline`)
      const inGroup = rows.filter((r) => group(r) === g)
      const firstUndated = inGroup.findIndex((r) => !r.requiredBy)
      if (firstUndated !== -1) assert.ok(inGroup.slice(firstUndated).every((r) => !r.requiredBy), 'undated after dated')
    }
    const overdue = rows.filter((r) => isRequestOverdue(r, ctx.today))
    if (overdue.length) assert.ok(isRequestOverdue(rows[0], ctx.today), `${viewer.userId}: an overdue request is first`)
  }
  const ahmedRows = setup(AHMED, data).run({ scope: SCOPE.MINE }).rows
  const openOrDraft = ahmedRows.filter((r) => !STATUS_CONFIG.proposal[r.status].closed)
  assert.equal(openOrDraft.at(-1).id, undated.request.id, 'undated draft last among open work')
})

test('other sorts: last updated (newest first) and event date (month-only uses the 1st)', () => {
  const { data } = setup(NOHA)
  const updated = sortRequests(data.proposalRequests, SORT.UPDATED).map((r) => r.lastUpdated)
  assert.deepEqual(updated, [...updated].sort().reverse())
  const evt = sortRequests(data.proposalRequests.filter((r) => isOpenRequest(r)), SORT.EVENT)
  const starts = evt.map((r) => (r.eventDatePrecision === 'month' ? `${r.eventDate}-01` : r.eventDate))
  assert.deepEqual(starts, [...starts].sort())
})

// ---------- Rows, navigation, Ready vs Shared ----------

test('rows link to the detail page; own drafts open the editor when editable', () => {
  const { data, ctx } = setup(AHMED)
  const row = (id, viewerCtx = ctx) => trackerRow(data.proposalRequests.find((r) => r.id === id), viewerCtx)
  assert.equal(row('PR-2026-0013').href, '/proposals/PR-2026-0013')
  assert.equal(row('PR-2026-0019').href, '/proposals/PR-2026-0019/edit')
  assert.equal(row('PR-2026-0019').opensEditor, true)
  // Mariam in AM mode can't edit her draft: it falls back to the (permission-checked) detail page.
  const am = setup(MK_AM)
  assert.equal(trackerRow(am.data.proposalRequests.find((r) => r.id === 'PR-2026-0018'), am.ctx).href, '/proposals/PR-2026-0018')
})

test('Ready for BD and Shared with Client are shown distinctly', () => {
  const { data, ctx, ids } = setup(NOHA)
  const ready = trackerRow(data.proposalRequests.find((r) => r.status === PS.READY_FOR_BD), ctx)
  const shared = trackerRow(data.proposalRequests.find((r) => r.status === PS.SHARED_WITH_CLIENT), ctx)
  assert.equal(ready.statusLabel, 'Ready for BD')
  assert.equal(ready.statusHint, 'Not yet shared with the client')
  assert.equal(shared.statusLabel, 'Shared with Client')
  assert.equal(shared.statusHint, null)
  const readyOnly = ids({ filters: { status: [PS.READY_FOR_BD] } })
  assert.ok(readyOnly.every((id) => data.proposalRequests.find((r) => r.id === id).status === PS.READY_FOR_BD))
})

test('rows show waiting-on, month-only event dates as "Mon YYYY", and missing dates as a dash', () => {
  const { data, ctx } = setup(NOHA)
  const month = data.proposalRequests.find((r) => r.eventDatePrecision === 'month' && !isDraft(r))
  assert.match(trackerRow(month, ctx).eventDateLabel, /^[A-Z][a-z]{2} \d{4}$/)
  const submitted = data.proposalRequests.find((r) => r.status === PS.SUBMITTED)
  assert.deepEqual(trackerRow(submitted, ctx).waitingOn, { userId: submitted.assignedAM, role: AM })
  const closedRow = trackerRow(data.proposalRequests.find((r) => r.status === PS.ACCEPTED), ctx)
  assert.equal(closedRow.waitingOn, null)
  assert.equal(trackerRow({ ...submitted, eventDate: null }, ctx).eventDateLabel, '—')
})

// ---------- Empty states ----------

test('empty results are reported separately from an empty scope', () => {
  const { run } = setup(AHMED)
  const none = run({ filters: { brand: 'grasshoppers', status: [PS.REVISION_REQUESTED] } })
  assert.equal(none.rows.length, 0)
  assert.ok(none.scoped.length > 0, 'scope itself is not empty, so the UI says "no matches" + clear filters')
})

// ---------- URL parameters ----------

test('reads the existing dashboard links', () => {
  const { data } = setup(NOHA)
  const parse = (qs, viewer) => parseTrackerParams(new URLSearchParams(qs), viewer, data.users)
  const bd = parse('bdOwner=u-ahmed&waitingOn=am', AHMED)
  assert.equal(bd.scope, SCOPE.MINE)
  assert.equal(bd.filters.bdOwner, 'u-ahmed')
  assert.equal(bd.filters.waitingOn, 'am')
  const am = parse('brand=teamup&status=submitted,in_progress,not_a_status', MD_AM)
  assert.equal(am.scope, SCOPE.MY_BRAND)
  assert.deepEqual(am.filters.status, ['submitted', 'in_progress'])
  const head = parse('deadline=overdue&brand=teamup', NOHA)
  assert.equal(head.filters.deadline, DEADLINE_STATE.OVERDUE)
  assert.equal(head.filters.brand, 'teamup')
  const wl = parse('assignedAM=u-mariam-dimitri&open=true', NOHA)
  assert.equal(wl.filters.assignedAM, 'u-mariam-dimitri')
  assert.equal(wl.filters.open, true)
})

test('invalid or not-allowed URL values fall back to defaults; state round-trips through the URL', () => {
  const { data } = setup(NOHA)
  const parse = (qs, viewer) => parseTrackerParams(new URLSearchParams(qs), viewer, data.users)
  const bad = parse('scope=my_brand&tab=nope&brand=x&assignedAM=u-ahmed&bdOwner=u-noha&deadline=soon&sort=zzz', NOHA)
  assert.equal(bad.scope, SCOPE.COMPANY, 'Head has no "my brand" scope')
  assert.equal(bad.tab, TAB.ALL)
  assert.equal(bad.sort, SORT.UPDATED) // the default: most recent activity first
  assert.deepEqual([bad.filters.brand, bad.filters.assignedAM, bad.filters.bdOwner, bad.filters.deadline], ['', '', '', ''])
  assert.equal(parse('scope=company', MD_AM).scope, SCOPE.MY_BRAND, 'no other-brand tab without See all brands')
  const wide = data.users.map((u) => (u.id === MD_AM.userId ? { ...u, privileges: { ...u.privileges, seeAllBrands: true } } : u))
  assert.equal(parseTrackerParams(new URLSearchParams('scope=company'), MD_AM, wide).scope, SCOPE.COMPANY)

  const state = parse('scope=company&tab=overdue&q=harbor&brand=teamup&status=submitted,ready_for_bd&sort=updated', AHMED)
  const qs = new URLSearchParams(trackerParams(state, AHMED)).toString()
  assert.deepEqual(parse(qs, AHMED), state)
  assert.deepEqual(trackerParams(parse('', AHMED), AHMED), {}, 'defaults produce a clean URL')
})
