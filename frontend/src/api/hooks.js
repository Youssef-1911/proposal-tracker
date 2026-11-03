import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ApiContext } from './ApiProvider.jsx'
import { api, failureFrom, NotFoundError } from './client.js'
import { toRequest, toTrackerRow, trackerQuery } from './adapters.js'
import { getBrand } from '../domain/brands.js'
import { roleLabel } from '../domain/roles.js'

/**
 * API-mode versions of the data hooks (same names and return shapes as src/demo/hooks.js).
 * Reads return { data, isLoading, error }. Writes are async and return the same result
 * objects the screens already handle: { ok: true, message, ... } | { ok: false, error, errors,
 * code, stale }. Nothing here computes permissions or transitions: they come from the server.
 */

function useApi() {
  const ctx = useContext(ApiContext)
  if (!ctx) throw new Error('API data hooks must be used inside <ApiProvider>')
  return ctx
}

/** Loads with `load(signal)` whenever `key` or the shared revision changes. */
function useResource(load, key, { skip = false } = {}) {
  const { revision } = useApi()
  const [state, setState] = useState({ data: null, isLoading: !skip, error: null })
  const [reloads, setReloads] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    if (skip) {
      setState({ data: null, isLoading: false, error: null })
      return undefined
    }
    const controller = new AbortController()
    setState((s) => ({ ...s, isLoading: true, error: null }))
    loadRef.current(controller.signal)
      .then((data) => setState({ data, isLoading: false, error: null }))
      .catch((error) => {
        if (error.name !== 'AbortError') setState({ data: null, isLoading: false, error })
      })
    return () => controller.abort()
  }, [key, revision, reloads, skip])

  const reload = useCallback(() => setReloads((n) => n + 1), [])
  return { ...state, reload }
}

export function useCurrentUser() {
  const { viewer, usersById, me, switchUser, switchRole } = useApi()
  const user = usersById[viewer.userId]
  // /api/me answers for the current identity; until it has reloaded after a switch, nothing is allowed.
  const meFresh = me?.user?.id === viewer.userId && me?.activeRole === viewer.activeRole
  return {
    user,
    activeRole: viewer.activeRole,
    activeRoleLabel: roleLabel(viewer.activeRole, user),
    brand: user.brand ? getBrand(user.brand) : null,
    hasMultipleRoles: user.roles.length > 1,
    createRequests: meFresh ? me.createRequests : { allowed: false, reason: null },
    createClients: meFresh ? me.createClients : { allowed: false, reason: null },
    // What this person sees in this role, from the server (nothing beyond Home until it has answered).
    pages: meFresh ? me.pages : HOME_ONLY,
    privileges: meFresh ? me.privileges : {},
    dataKind: me?.dataKind ?? null, // 'real' | 'demo': which database the server is using
    scopes: meFresh ? me.scopes : [],
    switchUser,
    switchRole,
  }
}

const HOME_ONLY = { home: true }

/** Active people (pickers, the identity switcher). Names of deactivated people: useLookups().usersById. */
export function useUsers() {
  return { data: useApi().users, isLoading: false, error: null }
}

export function useLookups() {
  const { usersById, clientsById } = useApi()
  // Opportunities come with each request (request.opportunity) in API mode.
  return useMemo(() => ({ usersById, clientsById, opportunitiesById: {} }), [usersById, clientsById])
}

/** Tracker results from the server: { rows, counts, scopeSize, total, page, pageSize }. */
export function useTracker(state, { page = 1, pageSize = 50 } = {}) {
  const query = trackerQuery(state, page, pageSize)
  const key = JSON.stringify(query)
  const res = useResource(
    (signal) => api.get('/api/proposal-requests', query, { signal }).then((body) => ({
      rows: body.items.map(toTrackerRow),
      counts: body.counts,
      bucketCounts: body.bucketCounts,
      scopeSize: body.scopeSize,
      total: body.total,
      page: body.page,
      pageSize: body.pageSize,
    })),
    key,
  )
  return res
}

/** One request with its history, files, allowedActions and rowVersion. data is null when not found. */
export function useProposalRequest(id) {
  const res = useResource(
    (signal) => api.get(`/api/proposal-requests/${encodeURIComponent(id)}`, undefined, { signal }).then(toRequest),
    id ?? '',
    { skip: !id },
  )
  const notFound = res.error instanceof NotFoundError
  return { ...res, error: notFound ? null : res.error, notFound }
}

/**
 * Actions for one request, exactly as the server lists them (allowedActions, with reasons).
 * perform(action, input) -> async result; on success the request and lists are refetched.
 */
export function useRequestActions(request) {
  const { invalidate } = useApi()
  const actions = request?.allowedActions ?? []

  const perform = useCallback(async (action, input) => {
    try {
      const body = await api.post(`/api/proposal-requests/${encodeURIComponent(request.id)}/actions`,
        { action, expectedRowVersion: request.rowVersion, ...cleanInput(input) })
      invalidate()
      return { ok: true, message: body.message, warnings: body.warnings, request: body.request }
    } catch (e) {
      return failureFrom(e)
    }
  }, [request?.id, request?.rowVersion, invalidate])

  // The server validates when the action is sent; nothing is checked locally first.
  const validate = useCallback(async () => ({ ok: true }), [])

  return { actions, perform, validate, editable: Boolean(request?.canEditDraft), reload: invalidate }
}

/** Only the inputs an action uses, with the AM price as a number when it is one. */
function cleanInput(input) {
  const out = {}
  if (input.note?.trim()) out.note = input.note
  if (input.amPrice !== '' && input.amPrice !== undefined) {
    out.amPrice = /^\s*-?\d+(\.\d+)?\s*$/.test(String(input.amPrice)) ? Number(input.amPrice) : input.amPrice
  }
  if (input.newRequiredBy) out.newRequiredBy = input.newRequiredBy
  if (input.followUpOn) out.followUpOn = input.followUpOn
  if (input.reasons?.length) out.reasons = input.reasons
  for (const k of ['eventDate', 'eventEndDate', 'finalParticipants', 'finalPrice', 'venue', 'teamNotes', 'eventStatus']) {
    if (input[k] !== undefined && input[k] !== '') out[k] = input[k] // "Mark confirmed"
  }
  if (input.confirmShared) out.confirmShared = true
  if (input.lostReason) out.lostReason = input.lostReason
  if (input.channel) out.channel = input.channel
  return out
}

/** Upload of the proposal file for the version being prepared (the server says who and when). */
export function useProposalFileUpload(request) {
  const { invalidate } = useApi()
  const upload = useCallback(async (file) => {
    try {
      const body = await api.upload(`/api/proposal-requests/${encodeURIComponent(request.id)}/files`, file,
        { expectedRowVersion: request.rowVersion })
      invalidate()
      return { ok: true, message: body.message }
    } catch (e) {
      return failureFrom(e)
    }
  }, [request?.id, request?.rowVersion, invalidate])
  const download = useCallback((file) => api.download(file.downloadUrl, file.downloadName), [])
  return { available: true, upload, download, reload: invalidate }
}

/**
 * Everything the New Proposal Request form needs, from the server.
 * save(values, { draftId, submit, rowVersion }) -> async { ok, request: { id }, message, warnings } | failure
 */
export function useRequestForm() {
  const { viewer, usersById, invalidate } = useApi()
  const { createRequests } = useCurrentUser()
  const key = `${viewer.userId}:${viewer.activeRole}`
  const clients = useResource((signal) => api.get('/api/clients', { creatable: true }, { signal }).then((b) => b.items), key)
  const opportunities = useResource((signal) => api.get('/api/opportunities', { open: true }, { signal }).then((b) => b.items), key)

  const save = useCallback(async (values, { draftId = null, submit = false, rowVersion } = {}) => {
    const fields = {
      clientId: values.clientId, eventName: values.eventName, brand: values.brand, service: values.service,
      opportunityId: values.opportunityId, eventDatePrecision: values.eventDatePrecision, eventDate: values.eventDate,
      eventEndDate: values.eventEndDate, requiredBy: values.requiredBy, participants: values.participants,
      requirementsSummary: values.requirementsSummary, specificRequirements: values.specificRequirements,
      briefTags: values.briefTags ?? [],
      occasionId: values.occasionId ? Number(values.occasionId) : null,
      ...(values.newClient ? { newClient: values.newClient } : {}),
      ...(!draftId && values.fromRadar ? { fromRadar: true } : {}),
    }
    try {
      const body = draftId
        ? await api.patch(`/api/proposal-requests/${encodeURIComponent(draftId)}`, { ...fields, submit, expectedRowVersion: rowVersion })
        : await api.post('/api/proposal-requests', { ...fields, submit })
      invalidate()
      return { ok: true, request: body.request, message: body.message, warnings: body.warnings }
    } catch (e) {
      return failureFrom(e)
    }
  }, [invalidate])

  return {
    viewer,
    access: createRequests,
    clients: clients.data ?? [],
    opportunities: opportunities.data ?? [],
    allRequests: [], // possible duplicates are reported by the server after saving
    usersById,
    isLoading: clients.isLoading || opportunities.isLoading,
    error: clients.error ?? opportunities.error,
    save,
  }
}

/**
 * Every request this viewer may see, WITH status history (for dashboards and analytics).
 * The union of the viewer's tracker scopes (they never overlap; together they are everything
 * visible). Pages are fetched at the server's limit of 100 until the total is reached, never
 * by raising the limit. Visibility (other people's drafts) is the server's.
 */
export function useAllRequests() {
  const { viewer } = useApi()
  const { scopes } = useCurrentUser() // the server's scopes for this person in this role
  const key = `${viewer.userId}:${viewer.activeRole}:${scopes.join(',')}`
  return useResource(async (signal) => {
    const byId = new Map()
    for (const scope of scopes) {
      for (let page = 1; ; page += 1) {
        const body = await api.get('/api/proposal-requests',
          { scope, include: 'history', pageSize: PAGE_LIMIT, page }, { signal })
        for (const item of body.items) byId.set(item.id, toRequest(item))
        if (page * PAGE_LIMIT >= body.total) break
      }
    }
    return [...byId.values()]
  }, key)
}

const PAGE_LIMIT = 100 // the server's maximum page size

/** All (non-archived) opportunities. Everyone may read them. */
export function useOpportunities() {
  return useResource((signal) => api.get('/api/opportunities', undefined, { signal }).then((b) => b.items), 'all')
}

/** Clients from GET /api/clients with the server's filters (q, type, brand, owner). */
export function useClients(params = {}) {
  const query = { q: params.q?.trim(), type: params.type, brand: params.brand, owner: params.owner }
  return useResource((signal) => api.get('/api/clients', query, { signal }).then((b) => b.items), JSON.stringify(query))
}

/** One client (contact details, owner, brands). data null + notFound when it doesn't exist. */
export function useClient(id) {
  const res = useResource((signal) => api.get(`/api/clients/${encodeURIComponent(id)}`, undefined, { signal }), id)
  const notFound = res.error instanceof NotFoundError
  return { ...res, error: notFound ? null : res.error, notFound }
}

/** One opportunity with its stage history (reason codes, lost reasons). */
export function useOpportunity(id) {
  const res = useResource((signal) => api.get(`/api/opportunities/${encodeURIComponent(id)}`, undefined, { signal }), id)
  const notFound = res.error instanceof NotFoundError
  return { ...res, error: notFound ? null : res.error, notFound }
}

// ---------- CRM writes (clients, contacts, opportunities) ----------

/** Like failureFrom, but keeps the server's own stale message ("This client was changed by someone else..."). */
function crmFailure(e) {
  const failure = failureFrom(e)
  return failure.stale ? { ...failure, error: e.message } : failure
}

/** send() -> the server's { message, warnings, client | opportunity }; lists refetch after a success. */
function useWrite() {
  const { invalidate } = useApi()
  return useCallback(async (send) => {
    try {
      const body = await send()
      invalidate()
      return { ok: true, ...body, warnings: body.warnings ?? [] }
    } catch (e) {
      return crmFailure(e)
    }
  }, [invalidate])
}

/** create(values) -> { ok, client, message, warnings } | failure. The server sets the id and (for BD) the owner. */
export function useCreateClient() {
  const write = useWrite()
  const create = useCallback((values) => write(() => api.post('/api/clients', values)), [write])
  return { available: true, create }
}

/** Writes for one loaded client (each sends the rowVersion it was loaded with; 409 when stale). */
export function useClientActions(client) {
  const write = useWrite()
  const path = client ? `/api/clients/${encodeURIComponent(client.id)}` : null
  const version = client?.rowVersion
  return useMemo(() => ({
    available: true,
    update: (fields) => write(() => api.patch(path, { ...fields, expectedRowVersion: version })),
    archive: () => write(() => api.post(`${path}/archive`, { expectedRowVersion: version })),
    transfer: (input) => write(() => api.post(`${path}/transfer`, { ...input, expectedRowVersion: version })),
    addContact: (fields) => write(() => api.post(`${path}/contacts`, { ...fields, expectedRowVersion: version })),
    updateContact: (contact, fields) => write(() => api.patch(`${path}/contacts/${contact.id}`,
      { ...fields, expectedRowVersion: contact.rowVersion })),
    archiveContact: (contact) => write(() => api.post(`${path}/contacts/${contact.id}/archive`,
      { expectedRowVersion: contact.rowVersion })),
  }), [write, path, version])
}

/** A client's change history, newest first. */
export function useClientHistory(id) {
  return useResource((signal) => api.get(`/api/clients/${encodeURIComponent(id)}/history`, undefined, { signal })
    .then((b) => b.items), id ?? '', { skip: !id })
}

/** create(values with clientId) -> { ok, opportunity, message } | failure. The owner is the client's owner. */
export function useCreateOpportunity() {
  const write = useWrite()
  const create = useCallback((values) => write(() => api.post('/api/opportunities', values)), [write])
  return { available: true, create }
}

/** Edit details / move stage for one loaded opportunity. move({ stage, lostReason, note }). */
export function useOpportunityActions(opportunity) {
  const write = useWrite()
  const path = opportunity ? `/api/opportunities/${encodeURIComponent(opportunity.id)}` : null
  const version = opportunity?.rowVersion
  return useMemo(() => ({
    available: true,
    update: (fields) => write(() => api.patch(path, { ...fields, expectedRowVersion: version })),
    move: (input) => write(() => api.post(`${path}/stage`, { ...input, expectedRowVersion: version })),
  }), [write, path, version])
}

// ---------- Accounts, routing, analytics ----------

/** Everyone, deactivated people included (Team & Users). */
export function useTeam() {
  return { data: useApi().allUsers, isLoading: false, error: null }
}

/** One person's page: details, what they own, their history and what this viewer may do. */
export function useAccount(id) {
  const res = useResource((signal) => api.get(`/api/users/${encodeURIComponent(id)}`, undefined, { signal }), id ?? '',
    { skip: !id })
  const notFound = res.error instanceof NotFoundError
  return { ...res, error: notFound ? null : res.error, notFound }
}

/** create(values) -> { ok, user, message } | failure. The id, initials and colour come from the server. */
export function useCreateAccount() {
  const write = useWrite()
  const create = useCallback((values) => write(() => api.post('/api/users', values)), [write])
  return { available: true, create }
}

/** Edit / deactivate / reactivate one loaded account (each sends the rowVersion it was loaded with). */
export function useAccountActions(account) {
  const write = useWrite()
  const path = account ? `/api/users/${encodeURIComponent(account.id)}` : null
  const version = account?.rowVersion
  return useMemo(() => ({
    available: true,
    update: (fields) => write(() => api.patch(path, { ...fields, expectedRowVersion: version })),
    // moveTo: the Account Manager who takes over this AM's open requests (in the same transaction).
    deactivate: (moveTo = null) => write(() => api.post(`${path}/deactivate`,
      { expectedRowVersion: version, ...(moveTo ? { moveRequestsTo: moveTo } : {}) })),
    reactivate: () => write(() => api.post(`${path}/reactivate`, { expectedRowVersion: version })),
  }), [write, path, version])
}

/** Brand routing with who it may change to, its history, and set(brand, amUserId, rowVersion). */
export function useRouting() {
  const write = useWrite()
  const res = useResource((signal) => api.get('/api/routing', undefined, { signal }), 'routing')
  const set = useCallback((brand, amUserId, rowVersion) => write(() => api.patch(`/api/routing/${brand}`,
    { amUserId, expectedRowVersion: rowVersion })), [write])
  return { ...res, available: true, set }
}

/**
 * The data behind Analytics, scoped by the server: { brands, scope, people, requests, opportunities }.
 * params = { person, as } (management opening one person's scorecard).
 */
export function useAnalyticsData(params = {}) {
  const { viewer } = useApi()
  const query = params.person ? { person: params.person, as: params.as } : undefined
  return useResource((signal) => api.get('/api/analytics', query, { signal }).then((body) => ({
    ...body, requests: body.requests.map(toRequest),
  })), `${viewer.userId}:${viewer.activeRole}:${params.person ?? ''}:${params.as ?? ''}`)
}

/** The dropdown lists as Settings left them: { definitions, options: { listId: [{ code, label, hidden }] } }. */
export function useLists() {
  const lists = useApi().config?.lists
  return { data: lists?.options ?? null, definitions: lists?.definitions ?? [], isLoading: false, error: null }
}

/** Settings: add, rename, hide or show one option ("Manage accounts"). change(listId, { action, code, label }). */
export function useListActions() {
  const write = useWrite() // reloads /api/config too, so the new lists show at once
  const change = useCallback((listId, input) => write(() => api.post(`/api/settings/lists/${encodeURIComponent(listId)}`, input)),
    [write])
  return { available: true, change }
}

/** "Set waiting on" for one loaded request: set({ team, userId, reason, expectedBy, note }), clear(). */
export function useWaitingActions(request) {
  const write = useWrite()
  const path = request ? `/api/proposal-requests/${encodeURIComponent(request.id)}/waiting-on` : null
  const version = request?.rowVersion
  return useMemo(() => ({
    available: true,
    set: (values) => write(() => api.post(path, { ...values, expectedRowVersion: version })),
    clear: () => write(() => api.post(`${path}/clear`, { expectedRowVersion: version })),
  }), [write, path, version])
}

/** What is waiting on me (set by hand): the Marketing / Operations Home. done(item) clears it. */
export function useWaitingOnMe() {
  const { viewer } = useApi()
  const write = useWrite()
  const res = useResource((signal) => api.get('/api/proposal-requests/waiting-on-me', undefined, { signal }),
    `${viewer.userId}:${viewer.activeRole}`)
  const done = useCallback((item) => write(() => api.post(
    `/api/proposal-requests/${encodeURIComponent(item.id)}/waiting-on/clear`, { expectedRowVersion: item.rowVersion })), [write])
  return { ...res, items: res.data?.items ?? [], done }
}

/** Read-only business configuration from GET /api/config. */
export function useConfig() {
  return { data: useApi().config, isLoading: false, error: null }
}


/** The conversation on one loaded request: post({ kind, body, about, parentId }). Comments, questions, answers. */
export function useConversation(request) {
  const write = useWrite()
  const path = request ? `/api/proposal-requests/${encodeURIComponent(request.id)}/comments` : null
  const post = useCallback((message) => write(() => api.post(path, message)), [write, path])
  return { available: true, post }
}

/** "Update details" (BD owner, Commercial Head) and the AM's "seen" for one loaded request. */
export function useDetailsActions(request) {
  const write = useWrite()
  const path = request ? `/api/proposal-requests/${encodeURIComponent(request.id)}/details` : null
  const version = request?.rowVersion
  return useMemo(() => ({
    available: true,
    update: (fields) => write(() => api.patch(path, { ...fields, expectedRowVersion: version })),
    seen: () => write(() => api.post(`${path}/seen`, { expectedRowVersion: version })),
  }), [write, path, version])
}


/** Confirmed events this person may see (Marketing and Operations: no prices). */
export function useEvents() {
  const { viewer } = useApi()
  return useResource((signal) => api.get('/api/events', undefined, { signal }), `${viewer.userId}:${viewer.activeRole}`)
}

/** One confirmed event (404 for anything not confirmed or not visible). */
export function useEvent(id) {
  const res = useResource((signal) => api.get(`/api/events/${encodeURIComponent(id)}`, undefined, { signal }), id ?? '', { skip: !id })
  const notFound = res.error instanceof NotFoundError
  return { ...res, error: notFound ? null : res.error, notFound }
}

/** "Confirm event", "Event postponed", "Change date", "Event cancelled", comments and "seen" on one loaded event. */
export function useEventActions(event) {
  const write = useWrite()
  const path = event ? `/api/events/${encodeURIComponent(event.id)}` : null
  const version = event?.rowVersion
  return useMemo(() => ({
    available: true,
    changeDate: (values) => write(() => api.patch(`${path}/date`, { ...values, expectedRowVersion: version })),
    cancel: (values) => write(() => api.post(`${path}/cancel`, { ...values, expectedRowVersion: version })),
    confirm: (values) => write(() => api.post(`${path}/confirm`, { ...values, expectedRowVersion: version })),
    postpone: (values) => write(() => api.post(`${path}/postpone`, { ...values, expectedRowVersion: version })),
    markRead: () => (path ? write(() => api.post(`${path}/read`, {})) : Promise.resolve({ ok: true })),
    comment: (body) => write(() => api.post(`${path}/comments`, { body })),
    fileUrl: `${path}/file`,
  }), [write, path, version])
}

/** The bell: { items (latest 20), unread }, read(id), readAll(). */
export function useNotifications() {
  const { viewer } = useApi()
  const write = useWrite()
  const res = useResource((signal) => api.get('/api/notifications', undefined, { signal }), `${viewer.userId}:${viewer.activeRole}`)
  const read = useCallback((id) => write(() => api.post(`/api/notifications/${id}/read`, {})), [write])
  const readAll = useCallback(() => write(() => api.post('/api/notifications/read-all', {})), [write])
  return { available: true, items: res.data?.items ?? [], unread: res.data?.unread ?? 0, read, readAll }
}

/** "Remind": nextAt per recipient (when the next reminder is possible) and remind(requestId). */
export function useReminders() {
  const { viewer } = useApi()
  const write = useWrite()
  const res = useResource((signal) => api.get('/api/reminders', undefined, { signal }), `${viewer.userId}:${viewer.activeRole}`)
  const remind = useCallback((requestId) => write(() => api.post('/api/reminders', { requestId })), [write])
  return { available: true, nextAt: res.data?.nextAt ?? {}, remind }
}


/** Opening a request clears "New for you" for this person: markRead() once the page has shown it. */
export function useMarkRead(requestId) {
  const write = useWrite()
  return useCallback(() => (requestId ? write(() => api.post(`/api/proposal-requests/${encodeURIComponent(requestId)}/read`, {}))
    : Promise.resolve({ ok: true })), [write, requestId])
}

/** How many requests have something new for me (sidebar "My Work", the browser tab). Checked every minute too. */
export function useNewCount() {
  const { viewer } = useApi()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60000)
    return () => clearInterval(t)
  }, [])
  const res = useResource((signal) => api.get('/api/proposal-requests/new-count', undefined, { signal }),
    `${viewer.userId}:${viewer.activeRole}:${tick}`)
  return res.data?.count ?? 0
}

/**
 * Data fixes: correctStatus(request, values) ("Correct status (data fix)"), addPastRecord(values) and
 * uploadPastFile(requestId, file) ("Add past proposal or event"). The server records them without notifying.
 */
export function useDataFixes() {
  const write = useWrite()
  return useMemo(() => ({
    available: true,
    correctStatus: (request, values) => write(() => api.post(
      `/api/proposal-requests/${encodeURIComponent(request.id)}/correct-status`, { ...values, expectedRowVersion: request.rowVersion })),
    addPastRecord: (values) => write(() => api.post('/api/proposal-requests/past', values)),
    uploadPastFile: (requestId, file) => write(() => api.upload(`/api/proposal-requests/${encodeURIComponent(requestId)}/past-file`, file)),
  }), [write])
}

// ---------------------------------------------------------------------------
// Repeat-client radar, occasions, HR staffing, the office screen
// ---------------------------------------------------------------------------

/** The occasions and their dates per year (Settings). */
export function useOccasions() {
  const write = useWrite()
  const res = useResource((signal) => api.get('/api/occasions', undefined, { signal }), 'occasions')
  return {
    ...res, items: res.data?.items ?? [], available: true,
    addPeriod: (id, values) => write(() => api.post(`/api/occasions/${id}/periods`, values)),
    removePeriod: (pid) => write(() => api.post(`/api/occasions/periods/${pid}/remove`, {})),
  }
}

/** My personal to-dos (the server only ever returns the caller's own): add, edit, tick, delete. */
export function useTodos() {
  const { viewer } = useApi()
  const write = useWrite()
  const res = useResource((signal) => api.get('/api/todos', undefined, { signal }).then((b) => b.items), viewer.userId)
  return {
    ...res, items: res.data ?? [], available: true,
    add: (values) => write(() => api.post('/api/todos', values)),
    update: (id, values) => write(() => api.patch(`/api/todos/${id}`, values)),
    setDone: (id, done) => write(() => api.post(`/api/todos/${id}/done`, { done })),
    remove: (id) => write(() => api.post(`/api/todos/${id}/delete`, {})),
  }
}

/** "Likely to book soon": { items, clients, turnedIntoRequests }, and "Not this time". */
export function useRadar() {
  const { viewer } = useApi()
  const write = useWrite()
  const res = useResource((signal) => api.get('/api/radar', undefined, { signal }), `${viewer.userId}:${viewer.activeRole}`)
  return { ...res, available: true, dismiss: (item, reason) => write(() => api.post('/api/radar/dismiss', { clientId: item.clientId, signal: item.signal, reason })) }
}

/** Staffing: events to staff, ratios, the HR numbers, "Rate facilitators". */
export function useStaffing() {
  const { viewer } = useApi()
  const key = `${viewer.userId}:${viewer.activeRole}`
  const write = useWrite()
  const list = useResource((signal) => api.get('/api/staffing', undefined, { signal }), key)
  const numbers = useResource((signal) => api.get('/api/staffing/dashboard', undefined, { signal }), key)
  return {
    ...list, numbers: numbers.data, available: true,
    setRatio: (brand, service, perFacilitator) => write(() => api.post(`/api/staffing/ratios/${brand}/${service}`, { perFacilitator })),
  }
}

export function useToRate() {
  const { viewer } = useApi()
  const res = useResource((signal) => api.get('/api/staffing/to-rate', undefined, { signal }), `${viewer.userId}:${viewer.activeRole}`)
  return res.data?.items ?? []
}

export function useFacilitators() {
  const { viewer } = useApi()
  const write = useWrite()
  const res = useResource((signal) => api.get('/api/facilitators', undefined, { signal }), `${viewer.userId}:${viewer.activeRole}`)
  return { ...res, available: true, create: (values) => write(() => api.post('/api/facilitators', values)) }
}

export function useFacilitator(id) {
  const write = useWrite()
  const res = useResource((signal) => api.get(`/api/facilitators/${id}`, undefined, { signal }), String(id), { skip: !id })
  return {
    ...res, available: true,
    update: (values) => write(() => api.patch(`/api/facilitators/${id}`, values)),
    addNote: (body) => write(() => api.post(`/api/facilitators/${id}/notes`, { body })),
  }
}

/** On one event: facilitators needed, assign (or add and assign), remove, rate. */
export function useEventStaffing(event) {
  const write = useWrite()
  const path = event ? `/api/events/${encodeURIComponent(event.id)}` : null
  return useMemo(() => ({
    available: true,
    setNeeded: (value) => write(() => api.patch(`${path}/facilitators-needed`, { value, expectedRowVersion: event?.rowVersion })),
    assign: (facilitatorId) => write(() => api.post(`${path}/facilitators`, { facilitatorId })),
    addAndAssign: (values) => write(() => api.post(`${path}/facilitators`, { newFacilitator: values })),
    remove: (fid) => write(() => api.post(`${path}/facilitators/${fid}/remove`, {})),
    rate: (fid, values) => write(() => api.post(`${path}/facilitators/${fid}/rating`, values)),
  }), [write, path, event?.rowVersion])
}

/** The office screen's data, refreshed every 60 seconds. */
export function useScreen() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60000)
    return () => clearInterval(t)
  }, [])
  return useResource((signal) => api.get('/api/screen', undefined, { signal }), `screen:${tick}`)
}
