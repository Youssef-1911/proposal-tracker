import { createContext, useCallback, useEffect, useMemo, useState } from 'react'
import { api, setIdentity, UnauthenticatedError } from './client.js'
import { DEFAULT_DEMO_USER_ID } from '../demo/seed.js'

/**
 * API mode: the development identity (who the requests are sent as) and the reference data
 * every screen needs (users, clients, config, /api/me). Screens read it through the hooks in
 * src/data/hooks.js, never directly.
 *
 * `revision` goes up after every successful write; data hooks refetch when it changes, so
 * the tracker and the detail page always show what the server has.
 */
export const ApiContext = createContext(null)

const STORAGE_KEY = 'eventflow.devIdentity'
// Everyone, deactivated people included: their names still appear in history. Pickers use active people only.
const ALL = { includeInactive: true }
const FALLBACK = { userId: DEFAULT_DEMO_USER_ID, activeRole: 'commercial_head' }

function readSaved() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function save(viewer) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(viewer))
  } catch {
    // Storage unavailable: the choice just won't survive a reload.
  }
}

/** A valid { userId, activeRole } among ACTIVE accounts (falls back to the first role / default user). */
function resolve(everyone, wanted) {
  const users = everyone.filter((u) => u.active !== false)
  const user = users.find((u) => u.id === wanted?.userId) ?? users.find((u) => u.id === DEFAULT_DEMO_USER_ID) ?? users[0]
  return { userId: user.id, activeRole: user.roles.includes(wanted?.activeRole) ? wanted.activeRole : user.roles[0] }
}

export function ApiProvider({ children }) {
  const [viewer, setViewer] = useState(() => readSaved() ?? FALLBACK)
  const [users, setUsers] = useState(null)
  const [reference, setReference] = useState(null) // { me, config, clients }
  const [failure, setFailure] = useState(null)
  const [revision, setRevision] = useState(0)

  setIdentity(viewer) // every request from now on is sent as this viewer

  // Users first (needs any valid identity), then make sure the viewer is a real user + role.
  useEffect(() => {
    let cancelled = false
    async function loadUsers() {
      try {
        let list
        try {
          list = (await api.get('/api/users', ALL)).items
        } catch (e) {
          if (e.status !== 401 && e.status !== 403) throw e
          setIdentity(FALLBACK) // a saved identity that no longer exists (or was deactivated): try the default once
          list = (await api.get('/api/users', ALL)).items
        }
        if (cancelled) return
        const next = resolve(list, viewer)
        setUsers(list)
        if (next.userId !== viewer.userId || next.activeRole !== viewer.activeRole) {
          save(next)
          setViewer(next)
        }
      } catch (e) {
        if (!cancelled) setFailure(e)
      }
    }
    loadUsers()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Viewer-dependent reference data: /api/me (create permissions), config, and all clients (archived
  // included, so names still resolve). Reloaded after every write: a new client is usable at once.
  useEffect(() => {
    if (!users) return undefined
    let cancelled = false
    setIdentity(viewer)
    Promise.all([api.get('/api/me'), api.get('/api/config'), api.get('/api/clients', { includeArchived: true }),
      api.get('/api/users', ALL)])
      .then(([me, config, clients, everyone]) => {
        if (!cancelled) setReference({ me, config, clients: clients.items, users: everyone.items })
      })
      .catch((e) => { if (!cancelled) setFailure(e) })
    return () => { cancelled = true }
  }, [users, viewer, revision])

  // The freshest list of people (reloaded after every write), so a new account can be chosen at once.
  const everyone = reference?.users ?? users

  const switchUser = useCallback((userId) => {
    const next = resolve(everyone, { userId })
    save(next)
    setViewer(next)
  }, [everyone])

  const switchRole = useCallback((role) => {
    setViewer((current) => {
      const next = resolve(everyone, { userId: current.userId, activeRole: role })
      save(next)
      return next
    })
  }, [everyone])

  const invalidate = useCallback(() => setRevision((r) => r + 1), [])

  const value = useMemo(() => {
    if (!users || !reference) return null
    return {
      viewer,
      users: everyone.filter((u) => u.active !== false), // pickers, the identity switcher
      allUsers: everyone, // Team & Users
      usersById: Object.fromEntries(everyone.map((u) => [u.id, u])), // names, also of deactivated people
      clients: reference.clients,
      clientsById: Object.fromEntries(reference.clients.map((c) => [c.id, c])),
      config: reference.config,
      me: reference.me,
      revision,
      invalidate,
      switchUser,
      switchRole,
    }
  }, [viewer, users, everyone, reference, revision, invalidate, switchUser, switchRole])

  if (failure) return <ApiUnavailable error={failure} />
  if (!value) return <div className="api-boot" role="status">Connecting to IEE…</div>
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>
}

/** Shown when the app cannot start in API mode (backend down, or the development identity is off). */
function ApiUnavailable({ error }) {
  const identity = error instanceof UnauthenticatedError
  return (
    <div className="api-boot api-boot--error" role="alert">
      <h1>{identity ? 'Development identity missing' : 'Cannot reach the IEE server'}</h1>
      <p>{error.message}</p>
      <p className="muted">
        Start everything with <code>./start-dev.ps1</code> (see README), or run the demo without a backend with
        {' '}<code>VITE_DATA_SOURCE=demo</code>.
      </p>
      <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>Try again</button>
    </div>
  )
}
