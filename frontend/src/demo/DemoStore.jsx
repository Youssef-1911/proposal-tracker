import { createContext, useCallback, useMemo, useRef, useState } from 'react'
import { createDemoData, DEFAULT_DEMO_USER_ID } from './seed.js'
import { applyAction, saveRequest } from '../domain/workflow.js'
import { canClearWaitingOn, canSetWaitingOn, validateWaitingOn } from '../domain/waiting.js'
import { DEFAULT_LISTS } from '../domain/lists.js'
import { canPostMessage, canUpdateDetails, validateDetailsUpdate, validateMessage } from '../domain/conversation.js'
import { todayISO } from '../domain/metrics.js'

/**
 * The single in-memory store for demo data. Every page reads it through the
 * hooks in ./hooks.js, never directly, so it can later be swapped for API calls.
 *
 * Changes go through ONE path, performRequestAction(), which runs the workflow
 * rules (domain/workflow.js) and saves the result only if they pass.
 * Data lives in memory and resets on reload; only the selected demo user/role is remembered.
 */
export const DemoStoreContext = createContext(null)

const STORAGE_KEY = 'eventflow.demoViewer'

function readSavedViewer() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveViewer(viewer) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(viewer))
  } catch {
    // Storage unavailable (private mode, blocked): selection just won't persist.
  }
}

/** Returns a valid { userId, activeRole }, falling back to defaults for stale/invalid saves. */
function resolveViewer(users, saved) {
  const user = users.find((u) => u.id === saved?.userId) ?? users.find((u) => u.id === DEFAULT_DEMO_USER_ID)
  const activeRole = user.roles.includes(saved?.activeRole) ? saved.activeRole : user.roles[0]
  return { userId: user.id, activeRole }
}

export function DemoStoreProvider({ children }) {
  const [data, setData] = useState(createDemoData)
  const [viewer, setViewer] = useState(() => resolveViewer(data.users, readSavedViewer()))

  // Latest values for the update path, so an action always validates against current state.
  const dataRef = useRef(data)
  const viewerRef = useRef(viewer)
  dataRef.current = data
  viewerRef.current = viewer

  const switchUser = useCallback(
    (userId) => {
      const next = resolveViewer(data.users, { userId })
      setViewer(next)
      saveViewer(next)
    },
    [data.users],
  )

  const switchRole = useCallback(
    (role) => {
      setViewer((current) => {
        const next = resolveViewer(data.users, { userId: current.userId, activeRole: role })
        saveViewer(next)
        return next
      })
    },
    [data.users],
  )

  /**
   * The only way to change a proposal request. Returns the workflow result;
   * on success the new request (and linked opportunity, if affected) are saved
   * before this returns, so callers never report success for an unsaved change.
   * options.dryRun: validate only (used before asking for confirmation); nothing is saved.
   */
  const performRequestAction = useCallback((requestId, action, input, options = {}) => {
    const current = dataRef.current
    const request = current.proposalRequests.find((r) => r.id === requestId)
    if (!request) return { ok: false, error: `Request ${requestId} not found.`, errors: {} }

    const result = applyAction(request, action, input, {
      viewer: viewerRef.current,
      usersById: Object.fromEntries(current.users.map((u) => [u.id, u])),
      clients: current.clients,
      opportunities: current.opportunities,
      allRequests: current.proposalRequests,
      now: new Date(),
    })
    if (!result.ok || options.dryRun) return result

    const next = {
      ...current,
      proposalRequests: current.proposalRequests.map((r) => (r.id === requestId ? result.request : r)),
      opportunities: result.opportunity
        ? current.opportunities.map((o) => (o.id === result.opportunity.id ? result.opportunity : o))
        : current.opportunities,
    }
    dataRef.current = next // visible to an immediate follow-up action, before React re-renders
    setData(next)
    return result
  }, [])

  /**
   * Create a draft, or edit an existing draft (draftId), and optionally submit it.
   * The rules live in workflow.saveRequest; the store saves only if it returns ok.
   * -> { ok, request, message } | { ok: false, error, errors }
   */
  const saveRequestDraft = useCallback((input, options = {}) => {
    const current = dataRef.current
    const result = saveRequest(current, input, options, { viewer: viewerRef.current, now: new Date() })
    if (!result.ok) return result // nothing saved

    const next = { ...current, proposalRequests: result.proposalRequests, opportunities: result.opportunities }
    dataRef.current = next
    setData(next)
    return { ok: true, request: result.request, message: result.message }
  }, [])

  /**
   * "Set waiting on" (values) or clear it (values = null), with the same rules as the server
   * (domain/waiting.js). -> { ok, message } | { ok: false, error, errors }
   */
  const setRequestWaiting = useCallback((requestId, values) => {
    const current = dataRef.current
    const request = current.proposalRequests.find((r) => r.id === requestId)
    if (!request) return { ok: false, error: `Request ${requestId} not found.`, errors: {} }
    const usersById = Object.fromEntries(current.users.map((u) => [u.id, u]))
    const v = viewerRef.current
    let waiting = null
    if (values) {
      const permission = canSetWaitingOn(request, v, usersById)
      if (!permission.allowed) return { ok: false, error: permission.reason, errors: {} }
      const checked = validateWaitingOn(values, { lists: DEFAULT_LISTS, usersById, today: todayISO() })
      if (Object.keys(checked.errors).length) return { ok: false, error: 'Please fix the highlighted fields.', errors: checked.errors }
      waiting = { ...checked.values, setAt: new Date().toISOString(), setBy: v.userId }
    } else {
      const permission = canClearWaitingOn(request, v, usersById)
      if (!permission.allowed) return { ok: false, error: permission.reason, errors: {} }
    }
    const next = { ...current, proposalRequests: current.proposalRequests.map((r) => (r.id === requestId ? { ...r, waiting } : r)) }
    dataRef.current = next
    setData(next)
    return { ok: true, message: values ? 'Saved.' : 'Back to automatic.', warnings: [] }
  }, [])

  /** Replace one request in the store (after a message or a detail change). */
  const putRequest = useCallback((next) => {
    const current = dataRef.current
    const updated = { ...current, proposalRequests: current.proposalRequests.map((r) => (r.id === next.id ? next : r)) }
    dataRef.current = updated
    setData(updated)
  }, [])

  const findRequest = (id) => dataRef.current.proposalRequests.find((r) => r.id === id)
  const usersMap = () => Object.fromEntries(dataRef.current.users.map((u) => [u.id, u]))

  /** A comment, question, answer or "Mark as answered" (domain/conversation.js). */
  const addRequestMessage = useCallback((requestId, input) => {
    const request = findRequest(requestId)
    if (!request) return { ok: false, error: `Request ${requestId} not found.`, errors: {} }
    const v = viewerRef.current
    const permission = canPostMessage(input.kind, request, v, usersMap())
    if (!permission.allowed) return { ok: false, error: permission.reason, errors: {} }
    const messages = request.comments ?? []
    const checked = validateMessage(input, { lists: DEFAULT_LISTS, messages })
    if (Object.keys(checked.errors).length) return { ok: false, error: 'Please fix the highlighted fields.', errors: checked.errors }
    const id = Math.max(0, ...messages.map((m) => m.id)) + 1
    const message = { id, ...checked.values, author: v.userId, role: v.activeRole, createdAt: new Date().toISOString() }
    putRequest({ ...request, comments: [...messages, message] })
    return { ok: true, message: 'Sent.', warnings: [] }
  }, [putRequest])

  /** "Update details": before -> after recorded; the AM sees "Details changed". */
  const updateRequestDetails = useCallback((requestId, input) => {
    const request = findRequest(requestId)
    if (!request) return { ok: false, error: `Request ${requestId} not found.`, errors: {} }
    const v = viewerRef.current
    const permission = canUpdateDetails(request, v, usersMap())
    if (!permission.allowed) return { ok: false, error: permission.reason, errors: {} }
    const checked = validateDetailsUpdate(request, input, { today: todayISO(), lists: DEFAULT_LISTS })
    if (Object.keys(checked.errors).length) return { ok: false, error: 'Please fix the highlighted fields.', errors: checked.errors }
    if (!checked.changes.length) return { ok: false, error: 'Nothing changed.', errors: {} }
    const now = new Date().toISOString()
    const next = { ...request, detailsChangedAt: now }
    for (const c of checked.changes) next[c.field] = c.to
    const events = [...(request.events ?? []), { id: (request.events?.length ?? 0) + 1, event: 'details_updated', changedBy: v.userId,
      role: v.activeRole, changedAt: now, note: input.note?.trim() || null, details: { changes: checked.changes } }]
    putRequest({ ...next, events })
    return { ok: true, message: 'Details updated.', warnings: [] }
  }, [putRequest])

  const markRequestDetailsSeen = useCallback((requestId) => {
    const request = findRequest(requestId)
    if (!request) return { ok: false, error: `Request ${requestId} not found.`, errors: {} }
    putRequest({ ...request, detailsSeenAt: new Date().toISOString() })
    return { ok: true, message: 'Noted: no change needed.', warnings: [] }
  }, [putRequest])

  const value = useMemo(
    () => ({ data, viewer, switchUser, switchRole, performRequestAction, saveRequestDraft, setRequestWaiting,
      addRequestMessage, updateRequestDetails, markRequestDetailsSeen }),
    [data, viewer, switchUser, switchRole, performRequestAction, saveRequestDraft, setRequestWaiting,
      addRequestMessage, updateRequestDetails, markRequestDetailsSeen],
  )

  return <DemoStoreContext.Provider value={value}>{children}</DemoStoreContext.Provider>
}
