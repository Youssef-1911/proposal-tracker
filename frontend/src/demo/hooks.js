import { useCallback, useContext, useMemo } from 'react'
import { LIST_DEFS, effectiveLists, optionLabel } from '../domain/lists.js'
import { effectiveWaiting, getTeam, waitingLabel } from '../domain/waiting.js'
import { DemoStoreContext } from './DemoStore.jsx'
import { cairoTodayISO, canManageEvent, canSeeEvent, canSeeEventPrice, canSeePipelineItem, eventActions, eventStatusOf, eventTiming, pipelineItem } from '../domain/events.js'
import { BRANDS, getBrand } from '../domain/brands.js'
import { BRAND_AM_ROUTING } from '../domain/routing.js'
import { CLIENT_TYPES } from '../domain/catalog.js'
import { ROLE_CONFIG } from '../domain/roles.js'
import { LOST_REASONS, SHARE_CHANNELS, stageList, statusList } from '../domain/status.js'
import { PROPOSAL_FILE_MAX_BYTES, PROPOSAL_FILE_TYPES, UPLOAD_STATUSES } from '../domain/proposalFiles.js'
import { roleLabel } from '../domain/roles.js'
import { canEditDraft, getActions } from '../domain/workflow.js'
import { canOpenRequestForm, clientsForCreator } from '../domain/permissions.js'
import { queryTracker, scopesFor, trackerRow } from '../domain/tracker.js'
import {
  analyticsScope, canSeeAnalytics, inAnalyticsScope, isManagementView, scorecardKinds, canSeeBrand, canSeeClient, canSeeOpportunity, canSeeRequest, pageAccess,
  privilegesOf,
} from '../domain/access.js'
import { deactivationWarnings } from '../domain/accounts.js'
import { todayISO } from '../domain/metrics.js'

/**
 * Data-access hooks. Components use ONLY these to read data.
 *
 * Collection hooks return { data, isLoading, error } (the same shape a future
 * FastAPI-backed version will return) so components already handle loading
 * and errors and won't need rewriting when the demo store is replaced.
 */

function useStore() {
  const store = useContext(DemoStoreContext)
  if (!store) throw new Error('Demo data hooks must be used inside <DemoStoreProvider>')
  return store
}

function result(data) {
  return { data, isLoading: false, error: null }
}

/** The viewer and everyone by id: the same visibility rules as the server (domain/access.js). */
function useViewerAccess() {
  const { data, viewer } = useStore()
  const usersById = useMemo(() => Object.fromEntries(data.users.map((u) => [u.id, u])), [data.users])
  return { data, viewer, usersById, user: usersById[viewer.userId] }
}

/** The person the app is currently "viewing as", plus their active role. */
export function useCurrentUser() {
  const { data, viewer, switchUser, switchRole } = useStore()
  const user = data.users.find((u) => u.id === viewer.userId)
  const usersById = Object.fromEntries(data.users.map((u) => [u.id, u]))
  return {
    user,
    activeRole: viewer.activeRole,
    createRequests: canOpenRequestForm(viewer, usersById),
    createClients: { allowed: false, reason: DEMO_READ_ONLY },
    pages: pageAccess(viewer, user),
    privileges: privilegesOf(user),
    scopes: scopesFor(viewer.activeRole, user).map((s) => s.id),
    activeRoleLabel: roleLabel(viewer.activeRole, user),
    brand: user.brand ? getBrand(user.brand) : null,
    hasMultipleRoles: user.roles.length > 1,
    switchUser,
    switchRole,
  }
}

export function useUsers() {
  return result(useStore().data.users)
}

export function useBrands() {
  return result(BRANDS)
}

/** Clients, filtered like GET /api/clients (q on the name, type, brand, owner). */
export function useClients(params = {}) {
  const { data, viewer, usersById } = useViewerAccess()
  const q = params.q?.trim().toLowerCase()
  return result(data.clients.filter((c) => canSeeClient(c, viewer, usersById) &&
    (!q || c.name.toLowerCase().includes(q)) && (!params.type || c.type === params.type)
    && (!params.brand || c.brands.includes(params.brand)) && (!params.owner || c.owner === params.owner)))
}

export function useOpportunities() {
  const { data, viewer, usersById } = useViewerAccess()
  return result(data.opportunities.filter((o) => canSeeOpportunity(o, viewer, usersById)))
}

export function useProposalRequests() {
  return result(useStore().data.proposalRequests)
}

/** Same as useProposalRequests in demo mode (the dashboards' rules leave other people's drafts out). */
export function useAllRequests() {
  const { data, viewer, usersById } = useViewerAccess()
  return result(data.proposalRequests.filter((r) => !r.brand || canSeeBrand(viewer, usersById[viewer.userId], r.brand)))
}

/**
 * Workflow actions for one request, for the current viewer (active role applies).
 * actions: [{ action, label, allowed, reason, requires, confirm, ... }] for the current status.
 * perform(action, input) -> workflow result; the store is already updated when ok is true.
 * validate(action, input) -> same checks, nothing saved (use before a confirmation step).
 */
export function useRequestActions(request) {
  const { data, viewer, performRequestAction } = useStore()
  const usersById = useMemo(() => Object.fromEntries(data.users.map((u) => [u.id, u])), [data.users])
  const actions = request ? getActions(request, viewer, usersById) : []
  const perform = useCallback(
    (action, input) => performRequestAction(request.id, action, input),
    [performRequestAction, request?.id],
  )
  const validate = useCallback(
    (action, input) => performRequestAction(request.id, action, input, { dryRun: true }),
    [performRequestAction, request?.id],
  )
  const editable = request ? canEditDraft(request, viewer, usersById) : false
  return { actions, perform, validate, editable, reload: () => {} }
}

/** Tracker results computed from the demo store, in the same shape as the API version. */
export function useTracker(state) {
  const { data, viewer } = useStore()
  const lookups = useLookups()
  const user = data.users.find((u) => u.id === viewer.userId)
  const ctx = { viewer, user, usersById: lookups.usersById, clientsById: lookups.clientsById, today: todayISO(), now: new Date() }
  const { scoped, rows, counts, bucketCounts } = queryTracker(data.proposalRequests, state, ctx)
  const out = { rows: rows.map((r) => trackerRow(r, ctx)), counts, bucketCounts, scopeSize: scoped.length, total: rows.length, page: 1,
    pageSize: Math.max(rows.length, 1) }
  return { data: out, isLoading: false, error: null, reload: () => {} }
}

/** Uploading needs the backend (Phase 4 uses the API); the demo store has no upload. */
export function useProposalFileUpload() {
  return { available: false, upload: null, download: null, reload: () => {} }
}

/**
 * Everything the New Proposal Request form needs, for the current viewer.
 * access: { allowed, reason } · clients: only those this viewer may pick
 * save(input, { draftId, submit }) -> store result (saved only when ok)
 */
export function useRequestForm() {
  const { data, viewer, saveRequestDraft } = useStore()
  const usersById = useMemo(() => Object.fromEntries(data.users.map((u) => [u.id, u])), [data.users])
  return {
    viewer,
    access: canOpenRequestForm(viewer, usersById),
    clients: clientsForCreator(viewer, data.clients, usersById),
    opportunities: data.opportunities,
    allRequests: data.proposalRequests,
    usersById,
    isLoading: false,
    error: null,
    save: saveRequestDraft,
  }
}

/** One request by id. data is null when the id doesn't exist. */
export function useProposalRequest(id) {
  const { data, viewer, usersById } = useViewerAccess()
  const found = data.proposalRequests.find((r) => r.id === id) ?? null
  const request = found && canSeeRequest(found, viewer, usersById) ? found : null
  return { ...result(request), notFound: Boolean(id) && !request, reload: () => {} }
}

export function useTasks() {
  return result(useStore().data.tasks)
}

/** id -> record maps for showing names (client, person, opportunity) next to references. */
export function useLookups() {
  const { data } = useStore()
  return useMemo(
    () => ({
      usersById: Object.fromEntries(data.users.map((u) => [u.id, u])),
      clientsById: Object.fromEntries(data.clients.map((c) => [c.id, c])),
      opportunitiesById: Object.fromEntries(data.opportunities.map((o) => [o.id, o])),
    }),
    [data],
  )
}

// ---------- read-only pages (same shapes as the API versions) ----------

/** The demo stores one contact per client; it is shown as the (main) contact list, read-only. */
export function useClient(id) {
  const found = useStore().data.clients.find((c) => c.id === id) ?? null
  const client = found && {
    ...found,
    contacts: found.contact?.name ? [{ id: 1, ...found.contact, notes: null, isPrimary: true, rowVersion: 1 }] : [],
  }
  return { ...result(client), notFound: !client, reload: () => {} }
}

/** Demo opportunities have no stored stage history; the page says so. */
export function useOpportunity(id) {
  const opp = useStore().data.opportunities.find((o) => o.id === id) ?? null
  return { ...result(opp && { ...opp, history: [] }), notFound: !opp, reload: () => {} }
}

// ---------- CRM writes: the demo is read-only for clients and opportunities ----------

const DEMO_READ_ONLY = 'Clients and opportunities are read-only in the demo. Run with the backend to change them.'
const readOnly = async () => ({ ok: false, error: DEMO_READ_ONLY, errors: {} })
const READ_ONLY_ACTIONS = {
  available: false, update: readOnly, archive: readOnly, transfer: readOnly, addContact: readOnly,
  updateContact: readOnly, archiveContact: readOnly, move: readOnly,
}

export function useCreateClient() {
  return { available: false, create: readOnly }
}

export function useClientActions() {
  return READ_ONLY_ACTIONS
}

export function useClientHistory() {
  return { ...result([]), reload: () => {} }
}

export function useCreateOpportunity() {
  return { available: false, create: readOnly }
}

export function useOpportunityActions() {
  return READ_ONLY_ACTIONS
}

// ---------- Accounts and routing: read-only in the demo ----------

const DEMO_ACCOUNTS_READ_ONLY = 'Accounts and routing are read-only in the demo. Run with the backend to change them.'
const accountsReadOnly = async () => ({ ok: false, error: DEMO_ACCOUNTS_READ_ONLY, errors: {} })

export function useTeam() {
  return result(useStore().data.users)
}

/** A person's page from the demo store: no history is stored, and nothing can be changed. */
export function useAccount(id) {
  const { data, usersById } = useViewerAccess()
  const found = usersById[id] ?? null
  const none = { allowed: false, reason: DEMO_ACCOUNTS_READ_ONLY }
  const account = found && {
    ...found,
    rowVersion: 1,
    history: [],
    owns: deactivationWarnings(found, { clients: data.clients, requests: data.proposalRequests }),
    permissions: { edit: none, deactivate: none, reactivate: none },
  }
  return { ...result(account), notFound: !found, reload: () => {} }
}

export function useCreateAccount() {
  return { available: false, create: accountsReadOnly }
}

export function useAccountActions() {
  return { available: false, update: accountsReadOnly, deactivate: accountsReadOnly, reactivate: accountsReadOnly }
}

export function useRouting() {
  const { data } = useStore()
  const items = BRANDS.map((b) => ({
    brand: b.id, amUserId: BRAND_AM_ROUTING[b.id], rowVersion: 1,
    choices: data.users.filter((u) => u.active !== false && u.roles.includes('account_manager') && u.brand === b.id).map((u) => u.id),
  }))
  return { ...result({ items, history: [] }), available: false, set: accountsReadOnly, reload: () => {} }
}

/** People whose scorecard management may open: [{ id, name, as, active }] (inactive ones too). */
function scorecardPeople(users) {
  return users.flatMap((u) => scorecardKinds(u).map((as) => ({ id: u.id, name: u.name, as, active: u.active !== false })))
}

/** The data behind Analytics, by the same rule as GET /api/analytics. */
export function useAnalyticsData(params = {}) {
  const { data, viewer, user } = useViewerAccess()
  const usersById = Object.fromEntries(data.users.map((u) => [u.id, u]))
  const scope = analyticsScope(viewer, user, usersById, params)
  if (!scope || scope.error) {
    return { data: null, isLoading: false, error: new Error(scope?.error ?? canSeeAnalytics(user, viewer).reason), reload: () => {} }
  }
  const brands = scope.brands ?? null
  return {
    ...result({
      brands,
      scope,
      people: isManagementView(viewer, user) ? scorecardPeople(data.users) : [],
      requests: data.proposalRequests.filter((r) => inAnalyticsScope(r, scope, viewer)),
      opportunities: data.opportunities.filter((o) => brands === null || brands.includes(o.brand)),
    }),
    reload: () => {},
  }
}

/** The same configuration the API serves, built from the frontend's domain modules. */
export function useConfig() {
  return useMemo(() => result({
    roles: Object.entries(ROLE_CONFIG).map(([id, r]) => ({ id, label: r.label })),
    brands: BRANDS.map((b) => ({ id: b.id, name: b.name, services: b.services })),
    routing: BRAND_AM_ROUTING,
    clientTypes: Object.entries(CLIENT_TYPES).map(([id, t]) => ({ id, label: t.label })),
    proposalStatuses: statusList('proposal'),
    proposalStages: stageList(),
    opportunityStages: statusList('opportunity'),
    lostReasons: LOST_REASONS,
    shareChannels: SHARE_CHANNELS,
    proposalFiles: { types: PROPOSAL_FILE_TYPES, maxBytes: PROPOSAL_FILE_MAX_BYTES, uploadStatuses: UPLOAD_STATUSES },
    businessTimezone: 'Africa/Cairo',
    currency: 'EGP',
  }), [])
}


// ---------------------------------------------------------------------------
// Waiting on, lists (demo store)
// ---------------------------------------------------------------------------

/** The dropdown lists (the demo shows the defaults; Settings' changes need the API). */
export function useLists() {
  return { data: effectiveLists(), definitions: LIST_DEFS, isLoading: false, error: null }
}

export function useListActions() {
  return { available: false, change: async () => ({ ok: false, error: 'Editing the lists needs the API (demo data is read-only here).', errors: {} }) }
}

export function useWaitingActions(request) {
  const { setRequestWaiting } = useStore()
  return useMemo(() => ({
    available: true,
    set: async (values) => setRequestWaiting(request.id, values),
    clear: async () => setRequestWaiting(request.id, null),
  }), [setRequestWaiting, request?.id])
}

/** What is waiting on me (set by hand), in the same shape as GET /api/proposal-requests/waiting-on-me. */
export function useWaitingOnMe() {
  const { data, viewer, setRequestWaiting } = useStore()
  const usersById = Object.fromEntries(data.users.map((u) => [u.id, u]))
  const clientsById = Object.fromEntries(data.clients.map((c) => [c.id, c]))
  const items = data.proposalRequests.filter((r) => {
    const w = r.waiting
    if (!w?.team || !effectiveWaiting(r)) return false
    return w.userId === viewer.userId || (!w.userId && getTeam(w.team)?.roles.includes(viewer.activeRole))
  }).map((r) => ({
    id: r.id, clientName: clientsById[r.clientId]?.name ?? null, eventName: r.eventName ?? null, brand: r.brand,
    service: r.service, ...r.waiting, reasonLabel: optionLabel(null, getTeam(r.waiting.team).reasons, r.waiting.reason),
    backTo: waitingLabel(effectiveWaiting({ ...r, waiting: null }), usersById), rowVersion: 1,
    canOpen: canSeeRequest(r, viewer, usersById),
  }))
  return { ...result({ items, total: items.length }), items, done: async (item) => setRequestWaiting(item.id, null) }
}


// ---------------------------------------------------------------------------
// Conversation and "Update details" (demo store)
// ---------------------------------------------------------------------------

export function useConversation(request) {
  const { addRequestMessage } = useStore()
  return { available: true, post: async (message) => addRequestMessage(request.id, message) }
}

export function useDetailsActions(request) {
  const { updateRequestDetails, markRequestDetailsSeen } = useStore()
  return useMemo(() => ({
    available: true,
    update: async (fields) => updateRequestDetails(request.id, fields),
    seen: async () => markRequestDetailsSeen(request.id),
  }), [updateRequestDetails, markRequestDetailsSeen, request?.id])
}


// ---------------------------------------------------------------------------
// Confirmed events, the bell and reminders (demo store)
// ---------------------------------------------------------------------------

function eventItem(r, viewer, usersById, clientsById, today) {
  const item = {
    ...r, clientName: clientsById[r.clientId]?.name ?? null,
    participants: r.confirmedParticipants ?? r.participants ?? null, timing: eventTiming(r, today),
    canOpenRequest: canSeeRequest(r, viewer, usersById), canManage: canManageEvent(r, viewer, usersById), rowVersion: 1,
    eventStatus: eventStatusOf(r), eventActions: eventActions(r, viewer, usersById),
  }
  if (canSeeEventPrice(viewer)) item.finalPrice = r.finalPrice ?? r.amPrice ?? null
  else { delete item.finalPrice; delete item.amPrice }
  return item
}

export function useEvents() {
  const { data, viewer } = useStore()
  const usersById = Object.fromEntries(data.users.map((u) => [u.id, u]))
  const clientsById = Object.fromEntries(data.clients.map((c) => [c.id, c]))
  const today = cairoTodayISO()
  const items = data.proposalRequests.filter((r) => canSeeEvent(r, viewer, usersById))
    .map((r) => eventItem(r, viewer, usersById, clientsById, today))
  const pipeline = data.proposalRequests.filter((r) => canSeePipelineItem(r, viewer, usersById))
    .map((r) => pipelineItem(r, clientsById[r.clientId]?.name ?? null))
  return result({ items, total: items.length, pipeline, today, seePrices: canSeeEventPrice(viewer), newIds: [] })
}

export function useEvent(id) {
  const { data, viewer } = useStore()
  const usersById = Object.fromEntries(data.users.map((u) => [u.id, u]))
  const clientsById = Object.fromEntries(data.clients.map((c) => [c.id, c]))
  const r = data.proposalRequests.find((x) => x.id === id)
  if (!r || !canSeeEvent(r, viewer, usersById)) return { ...result(null), notFound: Boolean(id) }
  const client = clientsById[r.clientId]
  const contact = client?.contacts?.find((c) => c.isPrimary) ?? null
  return {
    ...result({ ...eventItem(r, viewer, usersById, clientsById, cairoTodayISO()), brief: r.requirementsSummary,
      specificRequirements: r.specificRequirements, briefTags: r.briefTags ?? [], teamNotes: r.teamNotes ?? null,
      contact: contact && { name: contact.name, phone: contact.phone, email: contact.email }, file: null,
      comments: (r.comments ?? []).filter((m) => m.kind === 'comment'), changes: [],
      confirmedBy: [...(r.statusHistory ?? [])].reverse().find((e) => e.status === 'accepted')?.changedBy ?? null }),
    notFound: false,
  }
}

export function useEventActions() {
  const unavailable = async () => ({ ok: false, error: 'Changing confirmed events needs the server (demo data is read-only here).', errors: {} })
  return {
    available: false, changeDate: unavailable, cancel: unavailable, confirm: unavailable, postpone: unavailable,
    comment: unavailable, markRead: async () => ({ ok: true }), fileUrl: null,
  }
}

/** The bell needs the server; the demo has none. */
export function useNotifications() {
  return { available: false, items: [], unread: 0, read: async () => ({ ok: true }), readAll: async () => ({ ok: true }) }
}

export function useReminders() {
  return { available: false, nextAt: {}, remind: async () => ({ ok: false, error: 'Reminders need the server.', errors: {} }) }
}


/** The demo has no read tracking: nothing is "New for you" there. */
export function useMarkRead() {
  return useCallback(async () => ({ ok: true }), [])
}

export function useNewCount() {
  return 0
}

/** Data fixes need the server (the demo data is read-only here). */
export function useDataFixes() {
  const unavailable = async () => ({ ok: false, error: 'Data fixes need the server (demo data is read-only here).', errors: {} })
  return { available: false, correctStatus: unavailable, addPastRecord: unavailable, uploadPastFile: unavailable }
}

// Radar, staffing and the office screen need the server; the demo shows them empty.
const needsServer = async () => ({ ok: false, error: 'This needs the server (demo data is read-only here).', errors: {} })
export function useTodos() {
  return { ...result([]), items: [], available: false, add: needsServer, update: needsServer, setDone: needsServer, remove: needsServer }
}
export function useOccasions() { return { ...result({ items: [] }), items: [], available: false, addPeriod: needsServer, removePeriod: needsServer } }
export function useRadar() { return { ...result({ items: [], clients: 0, turnedIntoRequests: 0 }), available: false, dismiss: needsServer } }
export function useStaffing() { return { ...result({ items: [], ratios: {} }), numbers: null, available: false, setRatio: needsServer } }
export function useToRate() { return [] }
export function useFacilitators() { return { ...result({ items: [], canManage: false, seeRatings: false }), available: false, create: needsServer } }
export function useFacilitator() { return { ...result(null), available: false, update: needsServer, addNote: needsServer } }
export function useEventStaffing() {
  return { available: false, setNeeded: needsServer, assign: needsServer, addAndAssign: needsServer, remove: needsServer, rate: needsServer }
}
export function useScreen() { return result(null) }
