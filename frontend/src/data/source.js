/**
 * Where the screens get their data:
 *   'api'  the FastAPI backend (via the Vite proxy at /api)
 *   'demo' the in-memory demo store (resets on reload)
 * Set VITE_DATA_SOURCE=api|demo. Default: api in development (npm run dev), demo in a build.
 * Fixed at build time, so the hooks never switch implementation while the app runs.
 */
const configured = import.meta.env.VITE_DATA_SOURCE

export const DATA_SOURCE = configured === 'api' || configured === 'demo'
  ? configured
  : import.meta.env.DEV ? 'api' : 'demo'

export const API_MODE = DATA_SOURCE === 'api'
