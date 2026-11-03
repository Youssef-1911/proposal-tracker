/**
 * Builds links to list pages with filters in the URL, e.g.
 *   proposalsLink({ status: ['submitted', 'in_progress'], brand: 'teamup' })
 *   -> /proposals?status=submitted,in_progress&brand=teamup
 * Arrays are comma-joined; empty values are dropped. The list pages (built in
 * later phases) read these same parameter names.
 */
function build(path, params = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue
    if (Array.isArray(value)) {
      if (value.length) query.set(key, value.join(','))
    } else {
      query.set(key, String(value))
    }
  }
  const qs = query.toString().replace(/%2C/g, ',')
  return qs ? `${path}?${qs}` : path
}

export const proposalsLink = (params) => build('/proposals', params)
/** Detail page of one request. (/proposals?id=… also works and redirects here.) */
export const proposalLink = (id) => `/proposals/${encodeURIComponent(id)}`
/** The New Proposal Request form, and the same form for editing one of my drafts. */
export const newRequestLink = (params) => build('/proposals/new', params)
export const editDraftLink = (id) => `/proposals/${encodeURIComponent(id)}/edit`

export const opportunitiesLink = (params) => build('/opportunities', params)
export const tasksLink = (params) => build('/tasks', params)
/** Detail pages of one client / one opportunity. (/opportunities?id=… also works and redirects.) */
export const clientsLink = (params) => build('/clients', params)
export const clientLink = (id) => `/clients/${encodeURIComponent(id)}`
export const opportunityLink = (id) => `/opportunities/${encodeURIComponent(id)}`
