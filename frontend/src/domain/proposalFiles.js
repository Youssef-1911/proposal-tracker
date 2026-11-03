/**
 * Proposal files and comments: who may upload which version's file, the download name,
 * and comment validation. Pure rules; the backend (app/domain/proposal_files.py) uses the
 * same rules and wording, checked by the shared contract scenarios.
 *
 * Checking the real file type (content, not extension) is done on the server only.
 */

import { PROPOSAL_STATUS as PS } from './status.js'
import { ACTOR, checkActors } from './permissions.js'
import { ROLE } from './roles.js'
import { hasProposalFile } from './proposals.js'
import { canSeeRequest } from './access.js'

export const PROPOSAL_FILE_TYPES = [
  { id: 'pdf', extension: '.pdf', label: 'PDF' },
  { id: 'pptx', extension: '.pptx', label: 'PowerPoint' },
]
export const PROPOSAL_FILE_MAX_BYTES = 25 * 1024 * 1024

/** Uploading is possible only while the request is with the AM (the With AM stage). */
export const UPLOAD_STATUSES = [PS.SUBMITTED, PS.IN_PROGRESS, PS.AWAITING_BD_INFO, PS.REVISION_REQUESTED]

/** A version is locked once it has been marked Ready for BD. */
export function isVersionLocked(request, version) {
  return request.statusHistory.some((e) => e.status === PS.READY_FOR_BD && e.version === version)
}

/**
 * May this viewer upload the proposal file now, and for which version?
 * The version being prepared is the current one, or the next one while a revision is requested.
 * -> { allowed, code, reason, version, replaces, startsWork }
 *    code (when not allowed): not_found · invalid_transition · forbidden   (the API's 404 / 409 / 403)
 *    replaces: an upload would replace that version's current file
 *    startsWork: the request is Submitted, so the upload also moves it to In Progress (one history entry)
 */
export function uploadTarget(request, viewer, usersById = {}) {
  const deny = (code, reason, version = null) => ({ allowed: false, code, reason, version, replaces: false, startsWork: false })
  if (!canSeeRequest(request, viewer, usersById)) return deny('not_found', `Request ${request.id} not found.`)
  if (!UPLOAD_STATUSES.includes(request.status)) {
    return deny('invalid_transition',
      'Proposal files can only be uploaded while the request is with the AM (Submitted, In Progress, Awaiting BD Information or Revision Requested).')
  }
  const version = request.status === PS.REVISION_REQUESTED ? request.version + 1 : request.version
  const permission = checkActors([ACTOR.ASSIGNED_AM], request, viewer, usersById)
  if (!permission.allowed) return deny('forbidden', permission.reason, version)
  if (isVersionLocked(request, version)) {
    return deny('invalid_transition',
      `Version ${version} was marked Ready for BD, so its file is locked. Request a revision to prepare version ${version + 1}.`,
      version)
  }
  return {
    allowed: true, code: null, reason: null, version, replaces: hasProposalFile(request, version),
    startsWork: request.status === PS.SUBMITTED,
  }
}

/**
 * Files replaced before their version was marked Ready for BD are visible (and downloadable)
 * only to the assigned AM (acting as AM) and the Commercial Head. Everyone else sees each
 * version's current file only.
 */
export function canSeeReplacedFiles(request, viewer) {
  return viewer.activeRole === ROLE.COMMERCIAL_HEAD
    || (viewer.userId === request.assignedAM && viewer.activeRole === ROLE.ACCOUNT_MANAGER)
}

/** "PR-2026-0042_Papyrus_Fintech_v2.pdf": letters, digits, dashes and underscores only. */
export function downloadFileName(requestId, clientName, version, fileType) {
  const client = String(clientName ?? '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Client'
  return `${requestId}_${client}_v${version}.${fileType}`
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export const COMMENT_MAX_LENGTH = 2000

/** Plain text, 1 to 2,000 characters after trimming. -> { errors, body } */
export function validateComment(body) {
  const text = typeof body === 'string' ? body.trim() : ''
  if (!text) return { errors: { body: 'Write a comment first.' }, body: null }
  const length = [...text].length
  if (length > COMMENT_MAX_LENGTH) {
    return { errors: { body: `Comments can be up to 2,000 characters (this one has ${length}).` }, body: null }
  }
  return { errors: {}, body: text }
}
