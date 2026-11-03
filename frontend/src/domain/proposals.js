/**
 * Read-only views derived from a single proposal request record.
 * Pure functions: no React, no store. Workflow ACTIONS are not defined here
 * (they come in a later checkpoint).
 */

import { PROPOSAL_STATUS, getStatus, stageOf } from './status.js'
import { ROLE } from './roles.js'
import { isDraft, isVisibleDraftFor } from './metrics.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** Has a proposal file been uploaded for this version? (request.files: [{ version, ... }]) */
export function hasProposalFile(request, version) {
  return (request.files ?? []).some((f) => f.version === version)
}

/** Price per participant, rounded to whole EGP; null when either number is missing. */
export function pricePerParticipant(price, participants) {
  if (price === null || price === undefined || !participants) return null
  return Math.round(price / participants)
}

/**
 * Counters for the UI ("with AM for 3 days", "shared 2 days ago"):
 *   stageSince / daysInStage: since the request entered its current display stage
 *   sharedAt / daysSinceShared: latest "Shared with Client"; the day count only while it is with the client
 * Whole days, rounded down.
 */
export function stageTiming(request, now = new Date()) {
  const h = request.statusHistory
  const stage = stageOf(request.status)
  let i = h.length - 1
  while (i > 0 && stageOf(h[i - 1].status) === stage) i -= 1
  const days = (iso) => Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS))
  const since = h[i]?.changedAt ?? null
  const shared = [...h].reverse().find((e) => e.status === PROPOSAL_STATUS.SHARED_WITH_CLIENT)
  return {
    stageSince: since,
    daysInStage: since ? days(since) : null,
    sharedAt: shared?.changedAt ?? null,
    daysSinceShared: shared && request.status === PROPOSAL_STATUS.SHARED_WITH_CLIENT ? days(shared.changedAt) : null,
  }
}

/**
 * The draft rule: a draft is seen only by its creator (even the Commercial Head); other
 * requests are not private. Which roles and brands see them is domain/access.js canSeeRequest.
 * Viewing never implies permission to act.
 */
export function canViewRequest(request, userId) {
  return !isDraft(request) || isVisibleDraftFor(request, userId)
}

/**
 * Who must act next, from STATUS_CONFIG.waitingOn:
 *   'am' -> the assigned AM (acting as Account Manager)
 *   'bd' -> the BD owner (acting as BD); for a draft, its creator
 *   'none' -> nobody (closed)
 */
export function responsibleFor(request) {
  const who = getStatus('proposal', request.status).waitingOn
  if (who === 'am') return { userId: request.assignedAM, role: ROLE.ACCOUNT_MANAGER }
  if (who === 'bd') {
    return isDraft(request)
      ? { userId: request.createdBy, role: null } // creator acts in whatever role created it
      : { userId: request.bdOwner, role: ROLE.BUSINESS_DEVELOPMENT }
  }
  return null
}

/** { text, responsible } from STATUS_CONFIG.nextStep + waitingOn, or null when closed. */
export function nextActionFor(request) {
  const text = getStatus('proposal', request.status).nextStep
  if (!text) return null
  return { text, responsible: responsibleFor(request) }
}

/**
 * Proposal versions from status history, newest first:
 *   [{ version, amPrice (null = not recorded), pricePerParticipant, changeNote, hasFile,
 *      readyAt, readyBy, isCurrent, isPending }]
 * A version that has started (after a revision) but not reached Ready for BD yet is
 * listed as pending without a price. Prices are never invented. changeNote is the
 * "what changed" note recorded when the version was marked ready.
 */
export function proposalVersions(request) {
  const readyEntries = request.statusHistory.filter((e) => e.status === PROPOSAL_STATUS.READY_FOR_BD)
  const byVersion = new Map()
  for (const e of readyEntries) {
    byVersion.set(e.version, {
      version: e.version, amPrice: e.amPrice ?? null, changeNote: e.note ?? null, readyAt: e.changedAt, readyBy: e.changedBy,
    })
  }
  const versions = [...byVersion.values()]
  const hasCurrent = byVersion.has(request.version)
  const reachedProposalWork = request.statusHistory.some((e) => e.status === PROPOSAL_STATUS.IN_PROGRESS)
  if (!hasCurrent && reachedProposalWork && !getStatus('proposal', request.status).closed) {
    versions.push({ version: request.version, amPrice: null, changeNote: null, readyAt: null, readyBy: null, isPending: true })
  }
  return versions
    .sort((a, b) => b.version - a.version)
    .map((v) => ({
      ...v,
      pricePerParticipant: pricePerParticipant(v.amPrice, request.participants),
      hasFile: hasProposalFile(request, v.version),
      isCurrent: v.version === request.version,
      isPending: Boolean(v.isPending),
    }))
}

/** Status history newest first; the first-ever entry is flagged as the origin. */
export function timeline(request) {
  return request.statusHistory
    .map((entry, index) => ({ ...entry, isOrigin: index === 0, key: `${index}-${entry.changedAt}` }))
    .reverse()
}
