/**
 * The conversation on a request: comments, questions (and their answers), and detail updates.
 * Pure rules; the backend (app/domain/conversation.py) gives the same answers, checked by the
 * contract file's conversationCases.
 *
 * A message is { id, kind, body, about, parentId, author, role, createdAt }:
 *   comment   anyone who can see the request (Executives too)
 *   question  the BD owner, the assigned AM or the Commercial Head; optional "about" (questionAbout list)
 *   answer    a reply to a question (parentId); answers it
 *   answered  "Mark as answered" on a question (parentId), no text of its own
 * A question stays open until it has an answer or is marked answered. Nothing changes the status.
 */

import { actsAsBusinessDevelopment } from './access.js'
import { OTHER, checkCodes } from './lists.js'
import { ROLE } from './roles.js'
import { PROPOSAL_STATUS as PS, getStatus } from './status.js'
import { normalizeRequestFields, requestFields, validateRequestFields } from './workflow.js'

export const MESSAGE_KINDS = ['comment', 'question', 'answer', 'answered', 'change', 'picked_up']
export const CHANGE_ORIGINS = ['client', 'internal'] // "Client asked" · "Internal"
export const PICKED_UP_TEXT = 'Picked up'
export const MESSAGE_MAX_LENGTH = 2000
export const ANSWERED_TEXT = 'Marked as answered'

const ok = { allowed: true, reason: null }
const deny = (reason) => ({ allowed: false, reason })
const isClosed = (r) => getStatus('proposal', r.status).closed

/** The BD owner (acting as BD), the assigned AM (acting as AM) or the Commercial Head. */
function holdsTheRequest(r, viewer, usersById) {
  if (viewer.activeRole === ROLE.COMMERCIAL_HEAD) return true
  if (viewer.userId === r.bdOwner && actsAsBusinessDevelopment(viewer, usersById[viewer.userId])) return true
  return viewer.userId === r.assignedAM && viewer.activeRole === ROLE.ACCOUNT_MANAGER
}

/** Ask a question / answer one: BD ↔ AM both ways, and the Commercial Head; never on a draft or a closed request. */
export function canAskQuestion(r, viewer, usersById = {}) {
  if (r.status === PS.DRAFT) return deny('Questions start once the request is submitted.')
  if (isClosed(r)) return deny('This request is closed.')
  return holdsTheRequest(r, viewer, usersById) ? ok
    : deny('Only the BD owner, the assigned Account Manager or the Commercial Head can ask or answer questions.')
}

/** Ids of the questions that are still open. */
export function openQuestionIds(messages = []) {
  const closedIds = new Set(messages.filter((m) => m.kind === 'answer' || m.kind === 'answered').map((m) => m.parentId))
  return messages.filter((m) => m.kind === 'question' && !closedIds.has(m.id)).map((m) => m.id)
}

/**
 * A new message. input = { kind, body, about, parentId } -> { errors, values }.
 * ctx = { lists, messages } (messages: the request's, to check the question being answered).
 */
export function validateMessage(input = {}, { lists, messages = [] } = {}) {
  const errors = {}
  const kind = MESSAGE_KINDS.includes(input.kind) ? input.kind : input.kind === undefined || input.kind === null ? 'comment' : null
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  const values = {
    kind, body: kind === 'answered' ? ANSWERED_TEXT : kind === 'picked_up' ? PICKED_UP_TEXT : body, about: null, parentId: null, reasons: null,
  }
  if (!kind) {
    errors.kind = 'Choose comment, question or answer.'
    return { errors, values }
  }
  if (kind === 'change') {
    // "Change needed": what should change (whatShouldChange list) and who asked (about = client | internal).
    const codes = Array.isArray(input.reasons) ? input.reasons : []
    if (!codes.length) errors.reasons = 'Choose what should change.'
    else if (checkCodes(lists, 'whatShouldChange', codes, { multi: true })) errors.reasons = 'Choose from the list.'
    else values.reasons = [...codes]
    if (!CHANGE_ORIGINS.includes(input.about)) errors.about = 'Choose who asked for it.'
    else values.about = input.about
    if (codes.includes(OTHER) && !body) errors.body = 'Describe "Other".'
    else if (body.length > MESSAGE_MAX_LENGTH) errors.body = `Use at most ${MESSAGE_MAX_LENGTH} characters.`
    values.body = body || 'Change needed'
    return { errors, values }
  }
  if (kind === 'picked_up') {
    const parent = messages.find((m) => m.id === input.parentId)
    if (!parent || parent.kind !== 'change') errors.parentId = 'Choose the change you are picking up.'
    else if (!openChangeIds(messages).includes(parent.id)) errors.parentId = 'This change is already picked up.'
    else values.parentId = parent.id
    return { errors, values }
  }
  if (kind !== 'answered') {
    if (!body) errors.body = kind === 'question' ? 'Write your question.' : kind === 'answer' ? 'Write your answer.' : 'Write a message.'
    else if (body.length > MESSAGE_MAX_LENGTH) errors.body = `Use at most ${MESSAGE_MAX_LENGTH} characters.`
  }
  if (kind === 'question' && input.about !== undefined && input.about !== null && input.about !== '') {
    if (checkCodes(lists, 'questionAbout', [input.about], { multi: false })) errors.about = 'Choose from the list.'
    else values.about = input.about
  }
  if (kind === 'answer' || kind === 'answered') {
    const parent = messages.find((m) => m.id === input.parentId)
    if (!parent || parent.kind !== 'question') errors.parentId = 'Choose the question you are answering.'
    else if (!openQuestionIds(messages).includes(parent.id)) errors.parentId = 'This question is already answered.'
    else values.parentId = parent.id
  }
  return { errors, values }
}

/** Ids of "Change needed" cards the AM has not picked up yet. */
export function openChangeIds(messages = []) {
  const picked = new Set(messages.filter((m) => m.kind === 'picked_up').map((m) => m.parentId))
  return messages.filter((m) => m.kind === 'change' && !picked.has(m.id)).map((m) => m.id)
}

/** May this viewer post this kind of message? (comments: anyone who sees the request) */
export function canPostMessage(kind, r, viewer, usersById = {}) {
  if (kind === 'comment' || kind === undefined || kind === null) return ok
  if (kind === 'change') return canUpdateDetails(r, viewer, usersById).allowed ? ok
    : deny('Only the BD owner or the Commercial Head can ask for a change.')
  if (kind === 'picked_up') {
    if (isClosed(r)) return deny('This request is closed.')
    return (viewer.userId === r.assignedAM && viewer.activeRole === ROLE.ACCOUNT_MANAGER) || viewer.activeRole === ROLE.COMMERCIAL_HEAD
      ? ok : deny('Only the assigned Account Manager picks up a change.')
  }
  return canAskQuestion(r, viewer, usersById)
}

// ---------------------------------------------------------------------------
// "Update details" after submitting
// ---------------------------------------------------------------------------

export const DETAIL_FIELDS = [
  { id: 'eventName', label: 'Event name' },
  { id: 'eventDatePrecision', label: 'Event date type' },
  { id: 'eventDate', label: 'Event date' },
  { id: 'eventEndDate', label: 'End date' },
  { id: 'participants', label: 'Participants' },
  { id: 'requirementsSummary', label: 'Brief' },
  { id: 'specificRequirements', label: 'Specific requirements' },
  { id: 'requiredBy', label: 'Proposal deadline' },
]
const DETAIL_IDS = DETAIL_FIELDS.map((f) => f.id)

/** The BD owner (acting as BD) or the Commercial Head, on a submitted request that is still open. */
export function canUpdateDetails(r, viewer, usersById = {}) {
  if (r.status === PS.DRAFT) return deny('Edit the draft instead.')
  if (isClosed(r)) return deny('This request is closed.')
  if (viewer.activeRole === ROLE.COMMERCIAL_HEAD) return ok
  if (viewer.userId === r.bdOwner && actsAsBusinessDevelopment(viewer, usersById[viewer.userId])) return ok
  return deny('Only the BD owner or the Commercial Head can update the details.')
}

/**
 * input: any of DETAIL_FIELDS -> { errors, changes: [{ field, label, from, to }], values }.
 * Only the fields that change are checked (an imported request may lack others); nothing changed = no changes.
 */
export function validateDetailsUpdate(request, input = {}, { today, lists } = {}) {
  const before = requestFields(request)
  const picked = Object.fromEntries(Object.entries(input).filter(([k]) => DETAIL_IDS.includes(k)))
  const { errors, values } = validateRequestFields({ ...before, ...picked }, { mode: 'submit', today, lists })
  const was = normalizeRequestFields(before)
  const changes = DETAIL_FIELDS
    .filter((f) => JSON.stringify(was[f.id] ?? null) !== JSON.stringify(values[f.id] ?? null))
    .map((f) => ({ field: f.id, label: f.label, from: was[f.id] ?? null, to: values[f.id] ?? null }))
  const changed = new Set(changes.map((c) => c.field))
  return { errors: Object.fromEntries(Object.entries(errors).filter(([f]) => changed.has(f))), changes, values }
}

/** Show the "Details changed" banner: to the assigned AM (acting so) until they have seen the latest change. */
export function detailsChangedFor(r, viewer) {
  return viewer.userId === r.assignedAM && viewer.activeRole === ROLE.ACCOUNT_MANAGER && Boolean(r.detailsChangedAt)
    && (!r.detailsSeenAt || r.detailsSeenAt < r.detailsChangedAt)
}

// ---------------------------------------------------------------------------
// Why a version exists: "Internal change" (before the client saw it) or "Client revision"
// ---------------------------------------------------------------------------

export const CHANGE_KIND_LABELS = { internal: 'Internal change', client: 'Client revision' }

/** -> 'internal' | 'client' | null (version 1, or not reached yet). */
export function changeKind(r, version) {
  const h = r.statusHistory ?? []
  if (version <= 1) return null
  const i = h.findIndex((e) => e.version === version)
  if (i <= 0) return null
  const prev = h[i - 1]
  if (prev.status === PS.READY_FOR_BD) return 'internal' // taken back by the AM
  if (prev.status === PS.REVISION_REQUESTED) return h[i - 2]?.status === PS.READY_FOR_BD ? 'internal' : 'client'
  return 'client'
}

/** The open revision's kind while it is Revision requested (for its label). */
export function pendingChangeKind(r) {
  if (r.status !== PS.REVISION_REQUESTED) return null
  const h = r.statusHistory ?? []
  const i = h.map((e) => e.status).lastIndexOf(PS.REVISION_REQUESTED)
  return i > 0 && h[i - 1].status === PS.READY_FOR_BD ? 'internal' : 'client'
}

/** Small row markers: "2 questions" (open), "Details changed" (for the assigned AM until seen). */
export function rowMarkers(r, viewer) {
  const open = r.openQuestions ?? openQuestionIds(r.comments ?? []).length
  return [
    ...(open ? [open === 1 ? '1 question' : `${open} questions`] : []),
    ...(detailsChangedFor(r, viewer) ? ['Details changed'] : []),
  ]
}
