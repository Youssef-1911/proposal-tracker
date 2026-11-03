/**
 * Converts API responses into the shapes the existing screens already use, so display
 * components work the same in demo and API mode. Nothing here decides permissions or
 * transitions: allowedActions, canEditDraft, upload, needsMyAction, waitingOn and the
 * deadline state all come from the server as they are.
 */

import { getBrand, serviceLabel } from '../domain/brands.js'
import { PROPOSAL_STATUS, getStage, getStatus } from '../domain/status.js'
import { formatEventDate } from '../lib/format.js'
import { editDraftLink, proposalLink } from '../lib/links.js'

/** GET /api/proposal-requests/{id} -> a request with statusHistory (plus the server's extras). */
export function toRequest(detail) {
  return {
    ...detail, // allowedActions, canEditDraft, upload, files, comments, opportunity, rowVersion, ...
    statusHistory: detail.history.map(({ seq, stage, subLabel, ...entry }) => entry),
  }
}

/** One item of GET /api/proposal-requests -> a tracker row (same fields as domain/tracker.js trackerRow). */
export function toTrackerRow(item) {
  const editable = Boolean(item.canEditDraft)
  return {
    request: item,
    id: item.id,
    href: editable ? editDraftLink(item.id) : proposalLink(item.id),
    opensEditor: editable,
    clientName: item.clientName ?? '—',
    brandName: getBrand(item.brand)?.name ?? item.brand,
    serviceName: item.service ? serviceLabel(item.brand, item.service) : '—',
    eventDateLabel: formatEventDate(item.eventDate, item.eventEndDate),
    deadlineState: item.deadlineState,
    deadlineActive: item.deadlineActive,
    statusLabel: getStatus('proposal', item.status).label,
    stage: item.stage,
    stageLabel: getStage(item.stage).label,
    subLabel: item.subLabel,
    statusHint: item.status === PROPOSAL_STATUS.READY_FOR_BD ? 'Not yet shared with the client' : null,
    waitingOn: item.waitingOn,
    needsMyAction: item.needsMyAction,
  }
}

/** Tracker state (domain/tracker.js parseTrackerParams) -> GET /api/proposal-requests query. */
export function trackerQuery(state, page, pageSize) {
  const f = state.filters
  return {
    scope: state.scope, tab: state.tab, sort: state.sort, q: f.q.trim(), brand: f.brand,
    status: f.status, stage: f.stage, assignedAM: f.assignedAM, bdOwner: f.bdOwner,
    deadline: f.deadline, waitingOn: f.waitingOn, open: f.open ? 'true' : '', needsReview: f.needsReview ? 'true' : '',
    waiting: f.waiting, hideEvents: f.hideEvents ? 'true' : '', bucket: f.bucket || '', page, pageSize,
  }
}
