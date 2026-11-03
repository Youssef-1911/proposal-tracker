/**
 * Who SEES what: data visibility by active role, the per-person privileges, and which pages
 * a person gets. Pure rules; the backend (app/domain/access.py) runs the same rules, checked by
 * the contract file's accountCases.
 *
 * - Visibility follows the ACTIVE role (as every other rule does).
 * - Privileges belong to the PERSON: the same switches whichever role they are acting in.
 * - Privileges only widen what a person sees (or allow reminders later). They never allow a
 *   workflow action outside the role's rules.
 *
 * viewer = { userId, activeRole }; user = the viewer's user record (roles, brand, privileges).
 */

import { ROLE } from './roles.js'
import { canViewRequest } from './proposals.js'

export const PRIVILEGE = {
  MANAGE_ACCOUNTS: 'manageAccounts',
  SEE_ANALYTICS: 'seeAnalytics',
  SEND_REMINDERS: 'sendReminders',
  SEE_ALL_BRANDS: 'seeAllBrands',
  BRINGS_IN_CLIENTS: 'bringsInClients',
}

/** In the order the account screen lists them. */
export const PRIVILEGES = [
  { id: PRIVILEGE.MANAGE_ACCOUNTS, label: 'Manage accounts', description: 'Create and change accounts, and change routing.' },
  { id: PRIVILEGE.SEE_ANALYTICS, label: 'See analytics', description: 'Open Analytics.' },
  { id: PRIVILEGE.SEND_REMINDERS, label: 'Send reminders', description: 'Used in a later phase.' },
  { id: PRIVILEGE.SEE_ALL_BRANDS, label: 'See all brands', description: 'An Account Manager also sees the other brand.' },
  {
    id: PRIVILEGE.BRINGS_IN_CLIENTS, label: 'Brings in clients',
    description: 'Can own clients and send proposal requests for them, without switching role.',
  },
]
export const PRIVILEGE_IDS = PRIVILEGES.map((p) => p.id)

const NONE = Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, false]))
const ALL = Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, true]))

/** Switches each role turns on when it is selected for a person. */
export const ROLE_DEFAULT_PRIVILEGES = {
  // "Brings in clients" is turned on per person for the Head and Executives (Noha, Doaa), not by role.
  [ROLE.COMMERCIAL_HEAD]: { ...ALL, bringsInClients: false },
  [ROLE.EXECUTIVE]: { ...NONE, seeAnalytics: true, sendReminders: true, seeAllBrands: true },
  [ROLE.BUSINESS_DEVELOPMENT]: { ...NONE, bringsInClients: true },
  [ROLE.ACCOUNT_MANAGER]: NONE,
  [ROLE.MARKETING]: NONE,
  [ROLE.OPERATIONS]: NONE,
}

/** Defaults for a set of roles: a switch is on when any of the roles turns it on. */
export function defaultPrivileges(roles = []) {
  return Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, roles.some((r) => ROLE_DEFAULT_PRIVILEGES[r]?.[p])]))
}

/** A person's switches (their role defaults when none are stored). */
export function privilegesOf(user) {
  if (!user) return { ...NONE }
  const stored = user.privileges ?? {}
  const defaults = defaultPrivileges(user.roles)
  return Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, typeof stored[p] === 'boolean' ? stored[p] : defaults[p]]))
}

export function hasPrivilege(user, privilege) {
  return privilegesOf(user)[privilege] === true
}

/**
 * Does this viewer do the Business Development steps for their own clients right now? Acting as
 * BD, or — for someone without the BD role, like Noha or Doaa — having "Brings in clients" (no
 * role switch). A person who HAS the BD role (Mariam El Khayat) still switches to it.
 */
export function actsAsBusinessDevelopment(viewer, user) {
  if (viewer.activeRole === ROLE.BUSINESS_DEVELOPMENT) return true
  return Boolean(user) && !user.roles.includes(ROLE.BUSINESS_DEVELOPMENT) && hasPrivilege(user, PRIVILEGE.BRINGS_IN_CLIENTS)
}

/** Who may own clients (be a client's relationship owner): an active person with the BD role or "Brings in clients". */
export function canOwnClients(user) {
  return Boolean(user) && user.active !== false
    && (user.roles.includes(ROLE.BUSINESS_DEVELOPMENT) || hasPrivilege(user, PRIVILEGE.BRINGS_IN_CLIENTS))
}

// ---------------------------------------------------------------------------
// Data visibility (follows the ACTIVE role)
// ---------------------------------------------------------------------------

/** all = both brands · brand = the person's own brand (unless "See all brands") · none = no proposal data. */
const DATA_ACCESS = {
  [ROLE.COMMERCIAL_HEAD]: 'all',
  [ROLE.EXECUTIVE]: 'all',
  [ROLE.BUSINESS_DEVELOPMENT]: 'all',
  [ROLE.ACCOUNT_MANAGER]: 'brand',
  [ROLE.MARKETING]: 'none',
  [ROLE.OPERATIONS]: 'none',
  [ROLE.HR]: 'none',
  [ROLE.OFFICE_SCREEN]: 'none',
}

/** Roles that may look but never change anything (except commenting). */
export const READ_ONLY_ROLES = [ROLE.EXECUTIVE]

/** Does this role see proposal requests, clients and opportunities at all? */
export function seesProposalData(activeRole) {
  return (DATA_ACCESS[activeRole] ?? 'none') !== 'none'
}

/** The brands this viewer sees: null = every brand, otherwise a list (possibly empty). */
export function visibleBrands(viewer, user) {
  const access = DATA_ACCESS[viewer.activeRole] ?? 'none'
  if (access === 'all') return null
  if (access === 'brand') return hasPrivilege(user, PRIVILEGE.SEE_ALL_BRANDS) ? null : (user?.brand ? [user.brand] : [])
  return []
}

export function canSeeBrand(viewer, user, brand) {
  const brands = visibleBrands(viewer, user)
  return brands === null || brands.includes(brand)
}

/** The draft rule (a draft only for its creator) AND this role's brands. */
export function canSeeRequest(request, viewer, usersById = {}) {
  return canViewRequest(request, viewer.userId) && canSeeBrand(viewer, usersById[viewer.userId], request.brand)
}

/** A client is seen when it works with a brand the viewer sees. */
export function canSeeClient(client, viewer, usersById = {}) {
  const brands = visibleBrands(viewer, usersById[viewer.userId])
  return brands === null || client.brands.some((b) => brands.includes(b))
}

export function canSeeOpportunity(opportunity, viewer, usersById = {}) {
  return canSeeBrand(viewer, usersById[viewer.userId], opportunity.brand)
}

/** Anyone who can see a request may comment on it, Executives included. */
export function canCommentOnRequest(request, viewer, usersById = {}) {
  return canSeeRequest(request, viewer, usersById)
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/**
 * Analytics: everyone with "See analytics" (company numbers), and every Business Development or
 * Account Manager (acting in that role) for their own scorecard.
 */
export function canSeeAnalytics(user, viewer = null) {
  if (hasPrivilege(user, PRIVILEGE.SEE_ANALYTICS)) return { allowed: true, reason: null }
  if (viewer && [ROLE.BUSINESS_DEVELOPMENT, ROLE.ACCOUNT_MANAGER].includes(viewer.activeRole)) return { allowed: true, reason: null }
  return { allowed: false, reason: 'Only people with "See analytics" can open Analytics.' }
}

const MANAGEMENT_ROLES = [ROLE.COMMERCIAL_HEAD, ROLE.EXECUTIVE]
/** Noha, Doaa, Tony: company numbers, a person picker, the BD and AM tables and the CSV download. */
export const isManagementView = (viewer, user) =>
  MANAGEMENT_ROLES.includes(viewer.activeRole) && hasPrivilege(user, PRIVILEGE.SEE_ANALYTICS)

/** Can this person's scorecard be opened as Business Development ('bd') or Account Manager ('am')? */
export function scorecardKinds(person) {
  if (!person) return []
  return [
    ...(person.roles.includes(ROLE.BUSINESS_DEVELOPMENT) || hasPrivilege(person, PRIVILEGE.BRINGS_IN_CLIENTS) ? ['bd'] : []),
    ...(person.roles.includes(ROLE.ACCOUNT_MANAGER) ? ['am'] : []),
  ]
}

/**
 * Whose numbers Analytics shows (the server applies the same rule).
 *   Business Development (as BD): their own requests · Account Manager (as AM): their assigned requests
 *   Management: the company, or one person's scorecard (person + as) · anyone else allowed: the company
 * -> { kind: 'company' | 'bd' | 'am', userId, brands } | { error } | null (not allowed)
 */
export function analyticsScope(viewer, user, usersById = {}, { person = null, as = null } = {}) {
  if (!canSeeAnalytics(user, viewer).allowed) return null
  if (viewer.activeRole === ROLE.BUSINESS_DEVELOPMENT) return { kind: 'bd', userId: viewer.userId, brands: null }
  if (viewer.activeRole === ROLE.ACCOUNT_MANAGER) return { kind: 'am', userId: viewer.userId, brands: analyticsBrands(viewer, user) }
  if (person && isManagementView(viewer, user)) {
    return scorecardKinds(usersById[person]).includes(as) ? { kind: as, userId: person, brands: null }
      : { error: 'Choose a person from the list.' }
  }
  return { kind: 'company', userId: null, brands: analyticsBrands(viewer, user) }
}

/** Is this request part of the scope? (never someone else's draft) */
export function inAnalyticsScope(r, scope, viewer) {
  if (!scope || scope.error || !canViewRequest(r, viewer.userId)) return false
  if (scope.kind === 'bd') return r.bdOwner === scope.userId
  if (scope.kind === 'am') return r.assignedAM === scope.userId
  return scope.brands === null || scope.brands.includes(r.brand)
}

/**
 * Brands Analytics covers for someone allowed to see it: every brand, except an Account Manager
 * (acting as AM) without "See all brands", who sees their own brand. null = every brand.
 */
export function analyticsBrands(viewer, user) {
  return DATA_ACCESS[viewer.activeRole] === 'brand' ? visibleBrands(viewer, user) : null
}

/** The requests Analytics uses: never someone else's draft; the brands above. */
export function analyticsRequests(requests, viewer, user) {
  const brands = analyticsBrands(viewer, user)
  return requests.filter((r) => canViewRequest(r, viewer.userId) && (brands === null || brands.includes(r.brand)))
}

// ---------------------------------------------------------------------------
// Pages (the menu and the pages themselves)
// ---------------------------------------------------------------------------

const WORKING_ROLES = [ROLE.BUSINESS_DEVELOPMENT, ROLE.ACCOUNT_MANAGER, ROLE.COMMERCIAL_HEAD]

/** Which pages this person sees in this role. Home is always there. */
export function pageAccess(viewer, user) {
  const data = seesProposalData(viewer.activeRole)
  const privileges = privilegesOf(user)
  const role = viewer.activeRole
  const menu = MENUS[role] ?? []
  const admin = menu.includes('admin') && privileges.manageAccounts
  return {
    home: menu.includes('home'), queue: menu.includes('queue'), proposals: menu.includes('proposals') && data,
    events: menu.includes('events'), clients: menu.includes('clients') && data, dashboard: menu.includes('dashboard'),
    myNumbers: [ROLE.BUSINESS_DEVELOPMENT, ROLE.ACCOUNT_MANAGER].includes(role),
    analytics: menu.includes('analytics') && hasPrivilege(user, PRIVILEGE.SEE_ANALYTICS), // "See analytics"
    team: admin, settings: admin, staffing: menu.includes('staffing'), facilitators: menu.includes('facilitators'),
    screen: menu.includes('screen'), opportunities: false, tasks: false,
  }
}

/** Each role's menu (the server's access.py MENUS is the same; it refuses the rest). */
export const MENUS = {
  [ROLE.BUSINESS_DEVELOPMENT]: ['home', 'proposals', 'events', 'clients', 'dashboard'],
  [ROLE.ACCOUNT_MANAGER]: ['home', 'queue', 'proposals', 'events', 'dashboard'],
  [ROLE.COMMERCIAL_HEAD]: ['home', 'proposals', 'events', 'clients', 'dashboard', 'analytics', 'admin', 'screen'],
  [ROLE.EXECUTIVE]: ['dashboard', 'analytics', 'proposals', 'events', 'clients', 'screen'],
  [ROLE.OPERATIONS]: ['home', 'events', 'staffing', 'facilitators'],
  [ROLE.HR]: ['home', 'staffing', 'facilitators', 'events'],
  [ROLE.MARKETING]: ['home', 'events'],
  [ROLE.OFFICE_SCREEN]: ['screen'],
}
