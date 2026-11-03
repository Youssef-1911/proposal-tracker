/**
 * Clients, contacts and opportunities: who may change what, field validation, manual stage
 * moves, duplicate warnings and the owner-transfer plan. Pure rules; the backend
 * (app/domain/crm.py) uses the same rules and wording, checked by the shared contract file.
 *
 * viewer = { userId, activeRole }. Permissions follow the ACTIVE role, as everywhere else.
 */

import { BRANDS, getBrand } from './brands.js'
import { CLIENT_TYPES } from './catalog.js'
import { ROLE, roleLabel } from './roles.js'
import { LOST_REASONS_FOR_FORMS, LOST_REASON_OTHER, OPPORTUNITY_STAGE, getStatus, statusList } from './status.js'
import { actsAsBusinessDevelopment, canOwnClients } from './access.js'
import { isActiveOpportunity, isOpenRequest } from './metrics.js'

const CH = ROLE.COMMERCIAL_HEAD
const BD = ROLE.BUSINESS_DEVELOPMENT
const ok = { allowed: true, reason: null }
const deny = (reason) => ({ allowed: false, reason })
const nameOf = (usersById, id) => usersById[id]?.name ?? 'someone else'

/** The right person in the wrong active role is told to switch (as for proposal requests). */
function switchToBD(viewer, usersById) {
  const user = usersById[viewer.userId]
  if (viewer.activeRole !== BD && user?.roles.includes(BD)) {
    return `You are acting as ${roleLabel(viewer.activeRole, user)}. Switch your active role to Business Development to do this.`
  }
  return null
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** Any BD (acting as BD), anyone with "Brings in clients" (no role switch), or the Commercial Head. */
export function canCreateClient(viewer, usersById = {}) {
  if (viewer.activeRole === CH || actsAsBusinessDevelopment(viewer, usersById[viewer.userId])) return ok
  return deny(switchToBD(viewer, usersById) ?? 'Only Business Development or the Commercial Head can create clients.')
}

/** Edit details, manage contacts, archive, add opportunities: the relationship owner (as BD) or the Commercial Head. */
export function canEditClient(client, viewer, usersById = {}) {
  if (client.archivedAt) return deny('This client is archived.')
  if (viewer.activeRole === CH) return ok
  if (viewer.userId === client.owner) {
    if (actsAsBusinessDevelopment(viewer, usersById[viewer.userId])) return ok
    const s = switchToBD(viewer, usersById)
    if (s) return deny(s)
  }
  return deny(`Only the relationship owner, ${nameOf(usersById, client.owner)}, or the Commercial Head can do this.`)
}

/** Transfer to another relationship owner: the Commercial Head only. */
export function canTransferClient(client, viewer) {
  if (client.archivedAt) return deny('This client is archived.')
  if (viewer.activeRole === CH) return ok
  return deny('Only the Commercial Head can transfer a client to another owner.')
}

/** Edit an opportunity or move its stage: its owner (as BD) or the Commercial Head. */
export function canEditOpportunity(opportunity, viewer, usersById = {}) {
  if (opportunity.archivedAt) return deny('This opportunity is archived.')
  if (viewer.activeRole === CH) return ok
  if (viewer.userId === opportunity.owner) {
    if (actsAsBusinessDevelopment(viewer, usersById[viewer.userId])) return ok
    const s = switchToBD(viewer, usersById)
    if (s) return deny(s)
  }
  return deny(`Only the opportunity owner, ${nameOf(usersById, opportunity.owner)}, or the Commercial Head can do this.`)
}

/** Everything one viewer may do on one client (what the UI shows; the server enforces the same). */
export function clientPermissions(client, viewer, usersById = {}) {
  const edit = canEditClient(client, viewer, usersById)
  return {
    edit,
    contacts: edit,
    archive: edit,
    addOpportunity: edit,
    transfer: canTransferClient(client, viewer),
  }
}

// ---------------------------------------------------------------------------
// Manual stage moves
// ---------------------------------------------------------------------------

const STAGE_IDS = statusList('opportunity').map((s) => s.id)

/** Stages a person may move this opportunity to by hand. Won is never one of them, and Won is final. */
export function manualStageTargets(opportunity) {
  const final = [OPPORTUNITY_STAGE.WON, OPPORTUNITY_STAGE.CLOSED_NO_RESULT]
  if (final.includes(opportunity.stage)) return []
  return STAGE_IDS.filter((s) => !final.includes(s) && s !== opportunity.stage)
}

/**
 * Checks a manual stage move. input = { stage, lostReason, note }
 * -> { ok: true, stage, lostReason, note, reasonCode: 'manual_change' } | { ok: false, code, error, errors }
 */
export function validateStageMove(opportunity, input = {}) {
  const fail = (code, error, errors = {}) => ({ ok: false, code, error, errors })
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (opportunity.stage === OPPORTUNITY_STAGE.WON) {
    return fail('invalid_transition', 'Confirmed is final: it is set only when a proposal is confirmed.')
  }
  if (input.stage === OPPORTUNITY_STAGE.WON) {
    return fail('invalid_transition', 'Confirmed is set only when a proposal is confirmed (Mark confirmed on the request).')
  }
  if (!manualStageTargets(opportunity).includes(input.stage)) {
    return fail('validation', 'Please fix the highlighted fields.', { stage: 'Choose a different stage.' })
  }
  const errors = {}
  if (input.stage === OPPORTUNITY_STAGE.LOST) {
    if (!LOST_REASONS_FOR_FORMS.some((r) => r.id === input.lostReason)) errors.lostReason = 'Choose why the opportunity was lost.'
    else if (input.lostReason === LOST_REASON_OTHER && !note) errors.note = 'Describe the reason when choosing "Other".'
  }
  if (opportunity.stage === OPPORTUNITY_STAGE.LOST && !note) {
    errors.note = 'Add a short note on why the opportunity is reopened.'
  }
  if (Object.keys(errors).length) return fail('validation', 'Please fix the highlighted fields.', errors)
  return {
    ok: true, stage: input.stage, reasonCode: 'manual_change', note: note || null,
    lostReason: input.stage === OPPORTUNITY_STAGE.LOST ? input.lostReason : null,
  }
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

const text = (v) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim())
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const REAL_DATE = /^\d{4}-\d{2}-\d{2}$/
const REAL_MONTH = /^\d{4}-\d{2}$/

function isRealDate(v) {
  if (!REAL_DATE.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function isRealMonth(v) {
  return REAL_MONTH.test(v) && Number(v.slice(5)) >= 1 && Number(v.slice(5)) <= 12
}

/** -> { errors, values } */
export function validateClientFields(input = {}) {
  const values = {
    name: text(input.name),
    type: text(input.type),
    brands: Array.isArray(input.brands) ? [...new Set(input.brands)] : [],
    city: text(input.city) || null,
    notes: text(input.notes) || null,
  }
  const errors = {}
  if (!values.name) errors.name = 'Enter the client name.'
  else if (values.name.length > 200) errors.name = 'Use at most 200 characters.'
  if (!CLIENT_TYPES[values.type]) errors.type = 'Choose the client type.'
  if (!values.brands.length) errors.brands = 'Choose at least one brand.'
  else if (!values.brands.every((b) => BRANDS.some((x) => x.id === b))) errors.brands = 'Choose Grasshoppers, Team Up or both.'
  if (values.city && values.city.length > 100) errors.city = 'Use at most 100 characters.'
  if (values.notes && values.notes.length > 2000) errors.notes = 'Use at most 2,000 characters.'
  return { errors, values }
}

/** -> { errors, values } */
export function validateContactFields(input = {}) {
  const values = {
    name: text(input.name),
    title: text(input.title) || null,
    phone: text(input.phone) || null,
    email: text(input.email) || null,
    notes: text(input.notes) || null,
    isPrimary: input.isPrimary === true,
  }
  const errors = {}
  if (!values.name) errors.name = 'Enter the contact\'s name.'
  else if (values.name.length > 200) errors.name = 'Use at most 200 characters.'
  if (values.title && values.title.length > 200) errors.title = 'Use at most 200 characters.'
  if (values.phone && !/^[+\d][\d\s\-()]{5,24}$/.test(values.phone)) errors.phone = 'Enter a valid phone number.'
  if (values.email && !EMAIL.test(values.email)) errors.email = 'Enter a valid email address.'
  if (values.notes && values.notes.length > 1000) errors.notes = 'Use at most 1,000 characters.'
  return { errors, values }
}

const wholeNumber = (v) => {
  if (v === '' || v === null || v === undefined) return { value: null }
  const n = Number(v)
  return Number.isInteger(n) ? { value: n } : { invalid: true }
}

/**
 * Opportunity fields. current = the opportunity being edited (null when creating): a date that
 * is not changed may stay in the past; a new or changed date may not.
 * -> { errors, values }
 */
export function validateOpportunityFields(input = {}, { today, current = null } = {}) {
  const precision = input.eventDatePrecision === 'month' ? 'month' : 'day'
  const values = {
    brand: text(input.brand),
    service: text(input.service),
    estimatedValue: null,
    participants: null,
    eventDatePrecision: precision,
    eventDate: text(input.eventDate) || null,
    eventEndDate: precision === 'day' ? text(input.eventEndDate) || null : null, // optional, exact dates only
    eventName: text(input.eventName) || null, // optional, at most 80 characters
    nextAction: text(input.nextAction) || null,
    nextActionDate: text(input.nextActionDate) || null,
  }
  const errors = {}
  const brand = getBrand(values.brand)
  if (!brand) errors.brand = 'Choose Grasshoppers or Team Up.'
  if (!values.service) errors.service = 'Choose a service.'
  else if (brand && !brand.services.some((s) => s.id === values.service)) errors.service = `Choose a ${brand.name} service.`

  // Both optional: empty stays null.
  const value = wholeNumber(input.estimatedValue)
  if (value.invalid || (value.value !== null && value.value < 0)) errors.estimatedValue = 'Use a whole EGP amount of 0 or more.'
  else values.estimatedValue = value.value
  const people = wholeNumber(input.participants)
  if (people.invalid || (people.value !== null && people.value <= 0)) errors.participants = 'Use a whole number greater than 0.'
  else values.participants = people.value

  const changed = (field) => !current || current[field] !== values[field]
  if (values.eventDate) {
    if (precision === 'month' ? !isRealMonth(values.eventDate) : !isRealDate(values.eventDate)) {
      errors.eventDate = precision === 'month' ? 'Enter a valid month and year.' : 'Enter a valid event date.'
    } else if (changed('eventDate') && (precision === 'month' ? values.eventDate < today.slice(0, 7) : values.eventDate < today)) {
      errors.eventDate = 'The event date cannot be in the past.'
    }
  }
  if (values.eventEndDate) {
    if (!values.eventDate) errors.eventEndDate = 'Enter the start date first.'
    else if (!isRealDate(values.eventEndDate)) errors.eventEndDate = 'Enter a valid end date.'
    else if (!errors.eventDate && values.eventEndDate < values.eventDate) errors.eventEndDate = 'The end date cannot be before the start date.'
  }
  if (values.eventName && values.eventName.length > 80) errors.eventName = 'Use at most 80 characters.'
  if (values.nextAction && values.nextAction.length > 300) errors.nextAction = 'Use at most 300 characters.'
  if (values.nextActionDate) {
    if (!isRealDate(values.nextActionDate)) errors.nextActionDate = 'Enter a valid date.'
    else if (changed('nextActionDate') && values.nextActionDate < today) errors.nextActionDate = 'The next action date cannot be in the past.'
  }
  return { errors, values }
}

// ---------------------------------------------------------------------------
// Possible duplicates (a warning, never a block)
// ---------------------------------------------------------------------------

/** Lower case, letters and digits only (any script). */
export function normalizeName(name) {
  return String(name ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Egyptian numbers compared without +20 / 0020 / 0 prefixes, spaces or dashes. */
export function normalizePhone(phone) {
  let d = String(phone ?? '').replace(/\D+/g, '')
  if (d.startsWith('0020')) d = d.slice(4)
  else if (d.startsWith('20') && d.length >= 11) d = d.slice(2)
  if (d.startsWith('0')) d = d.slice(1)
  return d
}

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase()
}

function similarNames(a, b) {
  const x = normalizeName(a)
  const y = normalizeName(b)
  if (!x || !y) return false
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.length >= 4 && long.includes(short)
}

/**
 * Existing clients that look like the candidate: a very similar name, or the same contact
 * phone or email. candidate = { name, contacts: [{ phone, email }] }; clients carry contacts.
 * -> [{ id, name, matches: ['name' | 'phone' | 'email'] }] (archived clients included: still a duplicate)
 */
export function findPossibleDuplicateClients(candidate, clients, excludeId = null) {
  const phones = new Set((candidate.contacts ?? []).map((c) => normalizePhone(c.phone)).filter((p) => p.length >= 6))
  const emails = new Set((candidate.contacts ?? []).map((c) => normalizeEmail(c.email)).filter(Boolean))
  return clients
    .filter((c) => c.id !== excludeId)
    .map((c) => {
      const contacts = c.contacts ?? []
      const matches = []
      if (similarNames(candidate.name, c.name)) matches.push('name')
      if (contacts.some((x) => phones.has(normalizePhone(x.phone)))) matches.push('phone')
      if (contacts.some((x) => emails.has(normalizeEmail(x.email)))) matches.push('email')
      return { id: c.id, name: c.name, matches }
    })
    .filter((c) => c.matches.length)
}

// ---------------------------------------------------------------------------
// Client field: type to search, or add new
// ---------------------------------------------------------------------------

/**
 * Clients (from those this person may use) whose name contains what was typed, ignoring case,
 * spaces and punctuation; names starting with it first, then alphabetical. -> [client ids]
 */
export function searchClients(query, clients, limit = 8) {
  const q = normalizeName(query)
  if (!q) return []
  const key = (c) => [normalizeName(c.name).startsWith(q) ? 0 : 1, c.name.toLowerCase(), c.id]
  const before = (a, b) => {
    const [x, y] = [key(a), key(b)]
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    return 0
  }
  return clients.filter((c) => !c.archivedAt && normalizeName(c.name).includes(q)).sort(before).slice(0, limit).map((c) => c.id)
}

/** "Did you mean Talabat?" while a new client's name is typed: the first similar existing client, or null. */
export function didYouMean(name, clients) {
  const found = findPossibleDuplicateClients({ name, contacts: [] }, clients.filter((c) => !c.archivedAt))
  return found.find((d) => d.matches.includes('name'))?.id ?? null
}

// ---------------------------------------------------------------------------
// Owner transfer
// ---------------------------------------------------------------------------

/**
 * What a transfer moves to the new owner:
 * - the client's OPEN opportunities (closed ones keep their owner);
 * - with moveRequests, every OPEN request for the client (not drafts, not closed).
 * -> { opportunityIds, requestIds, openRequestCount }
 */
export function transferPlan(client, { opportunities = [], requests = [] }, { moveRequests = true } = {}) {
  const openRequests = requests.filter((r) => r.clientId === client.id && isOpenRequest(r))
  return {
    opportunityIds: opportunities.filter((o) => o.clientId === client.id && isActiveOpportunity(o)).map((o) => o.id),
    requestIds: moveRequests ? openRequests.map((r) => r.id) : [],
    openRequestCount: openRequests.length,
  }
}

/** input = { toOwner, reason, moveRequests } -> { errors } */
export function validateTransfer(client, input = {}, usersById = {}) {
  const errors = {}
  const reason = text(input.reason)
  if (!canOwnClients(usersById[input.toOwner]) || input.toOwner === client.owner) {
    errors.toOwner = 'Choose a new owner other than the current one.'
  }
  if (!reason) errors.reason = 'Give a short reason for the transfer.'
  else if (reason.length > 500) errors.reason = 'Use at most 500 characters.'
  return { errors }
}

/**
 * Relationship owner of a NEW client: the Commercial Head chooses anyone who can own clients
 * (herself too, with "Brings in clients"); a BD, or anyone else with "Brings in clients" (Doaa),
 * becomes the owner (anything sent is ignored). -> { owner } | { errors }
 */
export function newClientOwner(viewer, requestedOwner, usersById = {}) {
  if (viewer.activeRole !== CH && actsAsBusinessDevelopment(viewer, usersById[viewer.userId])) return { owner: viewer.userId }
  if (canOwnClients(usersById[requestedOwner])) return { owner: requestedOwner }
  return { errors: { owner: 'Choose the relationship owner.' } }
}

/** History wording for a moved request: "BD owner transferred from X to Y by Noha — reason". */
export function requestTransferNote(fromName, toName, byName, reason) {
  return `BD owner transferred from ${fromName} to ${toName} by ${byName} — ${reason}`
}

export function stageLabel(stage) {
  return getStatus('opportunity', stage).label
}
