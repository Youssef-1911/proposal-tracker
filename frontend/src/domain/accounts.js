/**
 * Managing accounts and brand routing: field checks, new account ids, the safeguards, and what
 * changed (for the user history). Pure rules; the backend (app/domain/accounts.py) runs the same
 * rules with the same wording, checked by the contract file's accountCases.
 *
 * users = every account (active and deactivated); routing = { [brandId]: amUserId }.
 */

import { BRANDS, getBrand } from './brands.js'
import { ROLE, ROLE_IDS } from './roles.js'
import { PRIVILEGE, PRIVILEGE_IDS, defaultPrivileges, hasPrivilege, privilegesOf } from './access.js'
import { isOpenRequest } from './metrics.js'
import { getStatus } from './status.js'

const ok = { allowed: true, reason: null }
const deny = (reason) => ({ allowed: false, reason })
const text = (v) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim())
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const KEEP_MANAGER = 'At least one active person must keep "Manage accounts".'
export const routingFirst = (brand) => `Change routing for ${getBrand(brand)?.name ?? brand} first.`

/** Only people with "Manage accounts" create or change accounts and routing (in any active role). */
export function canManageAccounts(viewer, usersById = {}) {
  return hasPrivilege(usersById[viewer.userId], PRIVILEGE.MANAGE_ACCOUNTS)
    ? ok
    : deny('Only people with "Manage accounts" can do this.')
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * input = { name, email, jobTitle, roles, brand, privileges }. Privileges not given are the
 * defaults of the chosen roles. The email is unique among ALL accounts (deactivated too),
 * ignoring case. -> { errors, values }
 */
export function validateAccountFields(input = {}, { users = [], id = null } = {}) {
  const roles = Array.isArray(input.roles) ? [...new Set(input.roles)] : []
  const isAM = roles.includes(ROLE.ACCOUNT_MANAGER)
  const given = input.privileges && typeof input.privileges === 'object' ? input.privileges : {}
  const defaults = defaultPrivileges(roles)
  const values = {
    name: text(input.name),
    email: text(input.email).toLowerCase(),
    jobTitle: text(input.jobTitle) || null,
    roles: ROLE_IDS.filter((r) => roles.includes(r)),
    brand: isAM ? text(input.brand) || null : null,
    privileges: Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, typeof given[p] === 'boolean' ? given[p] : defaults[p]])),
  }
  const errors = {}
  if (!values.name) errors.name = 'Enter the full name.'
  else if (values.name.length > 200) errors.name = 'Use at most 200 characters.'
  if (!values.email) errors.email = 'Enter the work email.'
  else if (values.email.length > 254 || !EMAIL.test(values.email)) errors.email = 'Enter a valid email address.'
  else if (users.some((u) => u.id !== id && text(u.email).toLowerCase() === values.email)) {
    errors.email = 'Another account already uses this email.'
  }
  if (values.jobTitle && values.jobTitle.length > 200) errors.jobTitle = 'Use at most 200 characters.'
  if (!roles.length) errors.roles = 'Choose at least one role.'
  else if (!roles.every((r) => ROLE_IDS.includes(r))) errors.roles = 'Choose from the listed roles.'
  if (isAM && !values.brand) errors.brand = 'Choose the brand this Account Manager works for.'
  else if (isAM && !getBrand(values.brand)) errors.brand = 'Choose Grasshoppers or Team Up.'
  return { errors, values }
}

/** "u-sara-mostafa"; "u-sara-mostafa-2" when taken. Made once; it never changes when the name does. */
export function newAccountId(name, existingIds = []) {
  const slug = text(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'user'
  const taken = new Set(existingIds)
  const base = `u-${slug}`
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/** "Noha El Kenawy" -> "NK", "Doaa" -> "DO". */
export function initialsFor(name) {
  const words = text(name).split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words.at(-1)[0]).toUpperCase()
}

/** Avatar colour for the n-th account (1–6, in turn). */
export function avatarToneFor(accountCount) {
  return (accountCount % 6) + 1
}

// ---------------------------------------------------------------------------
// Safeguards
// ---------------------------------------------------------------------------

const managers = (users) => users.filter((u) => u.active !== false && hasPrivilege(u, PRIVILEGE.MANAGE_ACCOUNTS))

/** The brands this person is the routed Account Manager for. */
export function routedBrands(userId, routing = {}) {
  return BRANDS.map((b) => b.id).filter((b) => routing[b] === userId)
}

/**
 * Checks an edit (values from validateAccountFields) against the safeguards:
 * - you cannot remove your own "Manage accounts";
 * - at least one active person keeps "Manage accounts";
 * - the Account Manager a brand is routed to keeps that role and brand until routing changes.
 * -> { errors }
 */
export function checkAccountUpdate(target, values, { actorId, users = [], routing = {} } = {}) {
  const errors = {}
  const had = hasPrivilege(target, PRIVILEGE.MANAGE_ACCOUNTS)
  if (had && !values.privileges.manageAccounts) {
    if (target.id === actorId) errors.privileges = 'You cannot remove your own "Manage accounts".'
    else if (target.active !== false && managers(users).every((u) => u.id === target.id)) errors.privileges = KEEP_MANAGER
  }
  for (const brand of routedBrands(target.id, routing)) {
    if (!values.roles.includes(ROLE.ACCOUNT_MANAGER)) errors.roles = routingFirst(brand)
    else if (values.brand !== brand) errors.brand = routingFirst(brand)
  }
  return { errors }
}

/** -> { allowed, reason }. Clients and open requests the person owns only warn (deactivationWarnings). */
export function canDeactivate(target, { actorId, users = [], routing = {} } = {}) {
  if (target.active === false) return deny('This account is already deactivated.')
  if (target.id === actorId) return deny('You cannot deactivate your own account.')
  const routed = routedBrands(target.id, routing)
  if (routed.length) return deny(routingFirst(routed[0]))
  if (hasPrivilege(target, PRIVILEGE.MANAGE_ACCOUNTS) && managers(users).every((u) => u.id === target.id)) return deny(KEEP_MANAGER)
  return ok
}

export function canReactivate(target) {
  return target.active === false ? ok : deny('This account is already active.')
}

/** What a deactivated person still owns: shown as a warning with a link to transfer them first. */
export function deactivationWarnings(target, { clients = [], requests = [] } = {}) {
  const ownedClients = clients.filter((c) => c.owner === target.id && !c.archivedAt).length
  const openRequests = requests.filter((r) => r.bdOwner === target.id && isOpenRequest(r)).length
  return { clients: ownedClients, openRequests }
}

/**
 * An Account Manager's requests that are not closed (drafts included): deactivating them is
 * blocked unless these move to another active Account Manager of the same brand, in the same step.
 * -> { requestIds, count, brand, choices: [userIds], blocked: reason | null }
 */
export function deactivationMove(target, { users = [], requests = [] } = {}) {
  const requestIds = requests
    .filter((r) => r.assignedAM === target.id && !getStatus('proposal', r.status).closed)
    .map((r) => r.id)
  const choices = routingChoices(target.brand, users).filter((u) => u.id !== target.id).map((u) => u.id)
  const blocked = requestIds.length && !choices.length
    ? `Add another Account Manager for ${getBrand(target.brand)?.name ?? 'this brand'} first.`
    : null
  return { requestIds, count: requestIds.length, brand: target.brand ?? null, choices, blocked }
}

/** input = { moveTo } -> { errors }. Nothing to move: no errors. */
export function validateDeactivationMove(target, input = {}, ctx = {}) {
  const plan = deactivationMove(target, ctx)
  if (!plan.count) return { errors: {} }
  if (plan.blocked) return { errors: { moveTo: plan.blocked } }
  if (!plan.choices.includes(input.moveTo)) {
    return { errors: { moveTo: `Choose who takes over ${target.name}'s ${plural(plan.count, 'open request', 'open requests')}.` } }
  }
  return { errors: {} }
}

/** History wording on each moved request: "Assigned AM changed from X to Y by Noha — deactivation". */
export function assignedAmChangeNote(fromName, toName, byName) {
  return `Assigned AM changed from ${fromName} to ${toName} by ${byName} — deactivation`
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const HISTORY_FIELDS = ['name', 'email', 'jobTitle', 'roles', 'brand']

/** { field: { from, to } } for what an edit changed; privileges as privileges.<id>. */
export function accountChanges(before, values) {
  const changes = {}
  for (const f of HISTORY_FIELDS) {
    const from = before[f] ?? null
    const to = values[f] ?? null
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[f] = { from, to }
  }
  const was = privilegesOf(before)
  for (const p of PRIVILEGE_IDS) {
    if (was[p] !== values.privileges[p]) changes[`privileges.${p}`] = { from: was[p], to: values.privileges[p] }
  }
  return changes
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Active Account Managers of a brand (who it may be routed to). */
export function routingChoices(brand, users = []) {
  return users.filter((u) => u.active !== false && u.roles.includes(ROLE.ACCOUNT_MANAGER) && u.brand === brand)
}

/** -> { errors } for routing a brand to amId. */
export function validateRouting(brand, amId, { users = [], routing = {} } = {}) {
  const b = getBrand(brand)
  if (!b) return { errors: { brand: 'Choose Grasshoppers or Team Up.' } }
  if (!routingChoices(brand, users).some((u) => u.id === amId)) {
    return { errors: { amId: `Choose an active Account Manager for ${b.name}.` } }
  }
  if (routing[brand] === amId) return { errors: { amId: `${b.name} requests already go to this Account Manager.` } }
  return { errors: {} }
}
