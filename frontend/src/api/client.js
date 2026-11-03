/**
 * Small fetch wrapper for the IEE API (no dependencies).
 *
 * - Sends the DEVELOPMENT identity headers (X-Dev-User / X-Dev-Role) chosen in the
 *   "Development identity" switcher. This is not a login; the backend accepts it only in
 *   development, from this computer.
 * - Turns the API's error format {"error": {"code", "message", "fields"}} into typed errors:
 *   401 UnauthenticatedError · 403 ForbiddenError · 404 NotFoundError · 409 ConflictError ·
 *   422 ValidationError · anything else ApiError · no answer at all NetworkError.
 */

export class ApiError extends Error {
  constructor(status, code, message, fields = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.fields = fields ?? {}
  }
}
export class UnauthenticatedError extends ApiError {}
export class ForbiddenError extends ApiError {}
export class NotFoundError extends ApiError {}
/** 409: stale data (code "stale") or not possible at the current status. */
export class ConflictError extends ApiError {
  get isStale() { return this.code === 'stale' }
}
export class ValidationError extends ApiError {}
export class NetworkError extends ApiError {}

const ERROR_CLASSES = {
  401: UnauthenticatedError, 403: ForbiddenError, 404: NotFoundError, 409: ConflictError, 422: ValidationError,
}

export const STALE_MESSAGE = 'This request was changed by someone else. Reload to see the latest version; what you typed is kept.'
export const IDENTITY_MISSING_MESSAGE =
  'Development identity missing: the backend did not accept the X-Dev-User / X-Dev-Role headers. ' +
  'Start it with EVENTFLOW_ENV=development and EVENTFLOW_DEV_IDENTITY=true (see README).'

let identity = null

/** The development identity sent with every request ({ userId, activeRole }). */
export function setIdentity(viewer) {
  identity = viewer
}

function identityHeaders() {
  return identity?.userId && identity?.activeRole
    ? { 'X-Dev-User': identity.userId, 'X-Dev-Role': identity.activeRole }
    : {}
}

function withParams(path, params) {
  if (!params) return path
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue
    query.set(key, Array.isArray(value) ? value.join(',') : String(value))
  }
  const qs = query.toString()
  return qs ? `${path}?${qs}` : path
}

async function toError(res) {
  let body = null
  try {
    body = await res.json()
  } catch {
    // Not JSON (e.g. the proxy's own error page when the backend is down).
  }
  if (!body?.error && (res.status === 502 || res.status === 503 || res.status === 504)) {
    return new NetworkError(0, 'network', 'Cannot reach the IEE server. Is the backend running? (see README)')
  }
  const { code = `http_${res.status}`, message = `Request failed (${res.status}).`, fields = {} } = body?.error ?? {}
  const Cls = ERROR_CLASSES[res.status] ?? ApiError
  return new Cls(res.status, code, res.status === 401 ? `${IDENTITY_MISSING_MESSAGE} (${message})` : message, fields)
}

/**
 * request(path, { method, params, json, body, headers, signal }) -> parsed JSON, or the Response when raw.
 * json: a value sent as JSON · body: sent as is (e.g. a File)
 */
export async function request(path, { method = 'GET', params, json, body, headers = {}, signal, raw = false } = {}) {
  const init = { method, signal, headers: { Accept: 'application/json', ...identityHeaders(), ...headers } }
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(json)
  } else if (body !== undefined) {
    init.body = body
  }
  let res
  try {
    res = await fetch(withParams(path, params), init)
  } catch (e) {
    if (e.name === 'AbortError') throw e
    throw new NetworkError(0, 'network', 'Cannot reach the IEE server. Is the backend running? (see README)')
  }
  if (!res.ok) throw await toError(res)
  if (raw) return res
  return res.status === 204 ? null : res.json()
}

export const api = {
  get: (path, params, options) => request(path, { ...options, params }),
  post: (path, json, options) => request(path, { ...options, method: 'POST', json }),
  patch: (path, json, options) => request(path, { ...options, method: 'PATCH', json }),

  /** Uploads a File as the raw request body; its name goes in X-File-Name (URL-encoded). */
  upload: (path, file, params) => request(path, {
    method: 'POST', params, body: file,
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
  }),

  /** Downloads a permission-checked file (needs the identity headers, so a plain link won't do). */
  async download(url, fallbackName = 'proposal') {
    const res = await request(url, { raw: true, headers: { Accept: '*/*' } })
    const disposition = res.headers.get('Content-Disposition') ?? ''
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName
    const blobUrl = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000)
  },
}

/** { ok: false, error, errors, code, stale, status } for screens that show errors next to fields. */
export function failureFrom(e) {
  if (!(e instanceof ApiError)) throw e
  const stale = e instanceof ConflictError && e.isStale
  return {
    ok: false, status: e.status, code: e.code, stale,
    error: stale ? STALE_MESSAGE : e.message,
    errors: e.fields ?? {},
  }
}
