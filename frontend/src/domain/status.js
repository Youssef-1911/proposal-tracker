/**
 * THE single source for status/stage labels, colours and meaning.
 * Components must read from here; never hard-code a status string or colour elsewhere.
 * tone: success | warning | danger | info | neutral  (maps to Badge tones / status tokens)
 *
 * Proposal statuses also define:
 *   waitingOn        'am' | 'bd' | 'none': who must act next (used for bottlenecks).
 *   deadlinePending  true while the AM still owes the proposal, so requiredBy can be overdue.
 *   nextStep         what should happen next (null when closed); the responsible person comes
 *                    from waitingOn: 'am' = assignedAM, 'bd' = bdOwner (a draft's creator).
 *   stage            one of the 5 display stages (STATUS_CONFIG.stage); display only, never a rule
 *   subLabel         short display text under the stage ("{nextVersion}" = the version being prepared)
 * Opportunity stages also define:
 *   outcome          'won' | 'lost' on closed stages.
 * "Open request" and other derived rules live in src/domain/metrics.js.
 */

export const PROPOSAL_STATUS = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  IN_PROGRESS: 'in_progress',
  AWAITING_BD_INFO: 'awaiting_bd_info',
  READY_FOR_BD: 'ready_for_bd',
  SHARED_WITH_CLIENT: 'shared_with_client',
  POSTPONED: 'postponed',
  REVISION_REQUESTED: 'revision_requested',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  // Earlier "closed history" statuses: no longer used (python -m app.apply_tracker_mapping moves them back); kept valid.
  CLOSED_UNRECORDED: 'closed_unrecorded',
  CLOSED_POSTPONED: 'closed_postponed',
}

export const OPPORTUNITY_STAGE = {
  NEW_LEAD: 'new_lead',
  CONTACTED: 'contacted',
  REQUIREMENTS_GATHERED: 'requirements_gathered',
  PROPOSAL_REQUESTED: 'proposal_requested',
  NEGOTIATION: 'negotiation',
  WON: 'won',
  LOST: 'lost',
  CLOSED_NO_RESULT: 'closed_no_result',
}

export const STATUS_CONFIG = {
  proposal: {
    [PROPOSAL_STATUS.DRAFT]: {
      label: 'Draft', tone: 'neutral', order: 1, closed: false, waitingOn: 'bd', deadlinePending: false,
      stage: 'draft', subLabel: null,
      nextStep: 'Complete the request and submit it to the Account Manager.',
      description: 'BD is still preparing the request; not yet sent to the Account Manager.',
    },
    [PROPOSAL_STATUS.SUBMITTED]: {
      label: 'Submitted', tone: 'info', order: 2, closed: false, waitingOn: 'am', deadlinePending: true,
      stage: 'with_am', subLabel: 'New',
      nextStep: 'Pick up the request and start preparing the proposal.',
      description: 'Sent to the Account Manager and waiting to be picked up.',
    },
    [PROPOSAL_STATUS.IN_PROGRESS]: {
      label: 'In Progress', tone: 'info', order: 3, closed: false, waitingOn: 'am', deadlinePending: true,
      stage: 'with_am', subLabel: 'Preparing',
      nextStep: 'Finish the proposal and set the price, or ask BD for missing information.',
      description: 'The Account Manager is preparing the proposal and pricing.',
    },
    [PROPOSAL_STATUS.AWAITING_BD_INFO]: {
      label: 'Awaiting BD Information', tone: 'warning', order: 4, closed: false, waitingOn: 'bd', deadlinePending: true,
      stage: 'with_am', subLabel: 'Needs BD info',
      nextStep: 'Provide the missing information so the Account Manager can continue.',
      description: 'The Account Manager needs more details from BD before continuing.',
    },
    [PROPOSAL_STATUS.READY_FOR_BD]: {
      label: 'Ready for BD', tone: 'success', order: 5, closed: false, waitingOn: 'bd', deadlinePending: false,
      stage: 'ready_to_send', subLabel: 'Proposal ready',
      nextStep: 'Share the proposal with the client, then record that it was shared.',
      description: 'Proposal is priced and ready for BD to share with the client.',
    },
    [PROPOSAL_STATUS.SHARED_WITH_CLIENT]: {
      label: 'Shared with Client', tone: 'info', order: 6, closed: false, waitingOn: 'bd', deadlinePending: false,
      stage: 'with_client', subLabel: 'Awaiting reply',
      nextStep: 'Follow up with the client and record their decision or revision request.',
      description: 'BD has sent the proposal; waiting for client feedback.',
    },
    [PROPOSAL_STATUS.POSTPONED]: {
      label: 'Postponed', tone: 'neutral', order: 7, closed: false, waitingOn: 'bd', deadlinePending: false,
      stage: 'with_client', subLabel: 'Postponed',
      nextStep: 'Follow up with the client on the follow-up date.',
      description: 'The client put the decision off; BD follows up on the date set.',
    },
    [PROPOSAL_STATUS.REVISION_REQUESTED]: {
      label: 'Revision Requested', tone: 'warning', order: 8, closed: false, waitingOn: 'am', deadlinePending: true,
      stage: 'with_am', subLabel: 'Revision (v{nextVersion})',
      nextStep: 'Prepare a revised version of the proposal.',
      description: 'The client asked for changes; a new version is needed.',
    },
    [PROPOSAL_STATUS.ACCEPTED]: {
      label: 'Confirmed', tone: 'success', order: 9, closed: true, waitingOn: 'none', deadlinePending: false,
      stage: 'closed', subLabel: 'Confirmed',
      nextStep: null,
      description: 'The client accepted the proposal.',
    },
    [PROPOSAL_STATUS.REJECTED]: {
      label: 'Rejected', tone: 'danger', order: 10, closed: true, waitingOn: 'none', deadlinePending: false,
      stage: 'closed', subLabel: 'Lost',
      nextStep: null,
      description: 'The client declined the proposal.',
    },
    [PROPOSAL_STATUS.CANCELLED]: {
      label: 'Cancelled', tone: 'neutral', order: 11, closed: true, waitingOn: 'none', deadlinePending: false,
      stage: 'closed', subLabel: 'Cancelled',
      nextStep: null,
      description: 'The request was withdrawn before completion.',
    },
    [PROPOSAL_STATUS.CLOSED_UNRECORDED]: {
      label: 'Closed · outcome not recorded', tone: 'neutral', order: 12, closed: true, waitingOn: 'none', deadlinePending: false,
      stage: 'closed', subLabel: 'Outcome not recorded',
      nextStep: null,
      description: 'Finished in the 2026 tracker without a recorded result. The BD owner or the Commercial Head can set it.',
    },
    [PROPOSAL_STATUS.CLOSED_POSTPONED]: {
      label: 'Closed · postponed', tone: 'neutral', order: 13, closed: true, waitingOn: 'none', deadlinePending: false,
      stage: 'closed', subLabel: 'Postponed (closed)',
      nextStep: null,
      description: 'Postponed in the 2026 tracker and closed as history (not the active Postponed status).',
    },
  },
  /**
   * The 5 display stages that group the 10 proposal statuses. Display only: workflow
   * rules always use the detailed status. tone null = use the detailed status's tone
   * (so Closed shows Won green, Lost red, Cancelled grey).
   */
  stage: {
    draft: { label: 'Draft', tone: 'neutral', order: 1 },
    with_am: { label: 'With AM', tone: 'info', order: 2 },
    ready_to_send: { label: 'Ready to send', tone: 'success', order: 3 },
    with_client: { label: 'With client', tone: 'accent', order: 4 },
    closed: { label: 'Closed', tone: null, order: 5 },
  },
  opportunity: {
    [OPPORTUNITY_STAGE.NEW_LEAD]: {
      label: 'New Lead', tone: 'neutral', order: 1, closed: false,
      description: 'A potential client or event has been identified.',
    },
    [OPPORTUNITY_STAGE.CONTACTED]: {
      label: 'Contacted', tone: 'info', order: 2, closed: false,
      description: 'First contact made with the client.',
    },
    [OPPORTUNITY_STAGE.REQUIREMENTS_GATHERED]: {
      label: 'Requirements Gathered', tone: 'info', order: 3, closed: false,
      description: 'Event needs, dates and headcount are understood.',
    },
    [OPPORTUNITY_STAGE.PROPOSAL_REQUESTED]: {
      label: 'Proposal Requested', tone: 'info', order: 4, closed: false,
      description: 'A proposal request has been raised with the Account Manager.',
    },
    [OPPORTUNITY_STAGE.NEGOTIATION]: {
      label: 'Negotiation', tone: 'warning', order: 5, closed: false,
      description: 'The proposal is with the client and terms are being discussed.',
    },
    [OPPORTUNITY_STAGE.WON]: {
      label: 'Confirmed', tone: 'success', order: 6, closed: true, outcome: 'won',
      description: 'The client confirmed the booking.',
    },
    [OPPORTUNITY_STAGE.LOST]: {
      label: 'Lost', tone: 'danger', order: 7, closed: true, outcome: 'lost',
      description: 'The opportunity did not convert.',
    },
    [OPPORTUNITY_STAGE.CLOSED_NO_RESULT]: {
      label: 'Closed · no result', tone: 'neutral', order: 8, closed: true, outcome: null,
      description: 'Closed as history from the 2026 tracker, without a recorded result.',
    },
  },
}

/** Ordered list of statuses for a kind ('proposal' | 'opportunity'), e.g. for filters. */
export function statusList(kind) {
  return Object.entries(STATUS_CONFIG[kind])
    .map(([id, cfg]) => ({ id, ...cfg }))
    .sort((a, b) => a.order - b.order)
}

export function getStatus(kind, id) {
  return STATUS_CONFIG[kind][id] ?? { label: id, tone: 'neutral', description: '' }
}

// ---------------------------------------------------------------------------
// Display stages
// ---------------------------------------------------------------------------

export const PROPOSAL_STAGE = {
  DRAFT: 'draft', WITH_AM: 'with_am', READY_TO_SEND: 'ready_to_send', WITH_CLIENT: 'with_client', CLOSED: 'closed',
}

export function stageList() {
  return Object.entries(STATUS_CONFIG.stage)
    .map(([id, cfg]) => ({ id, ...cfg }))
    .sort((a, b) => a.order - b.order)
}

/** The display stage of a detailed proposal status. */
export function stageOf(status) {
  return STATUS_CONFIG.proposal[status]?.stage ?? null
}

export function getStage(stageId) {
  return STATUS_CONFIG.stage[stageId] ?? { label: stageId, tone: 'neutral', order: 99 }
}

/** Detailed statuses inside a stage, in status order. */
export function statusesInStage(stageId) {
  return statusList('proposal').filter((s) => s.stage === stageId).map((s) => s.id)
}

/**
 * Sub-label shown under the stage. For Revision Requested it names the version being
 * prepared next: a request at version 1 with a revision requested shows "Revision (v2)".
 */
export function subLabelFor(status, version = 1) {
  const template = STATUS_CONFIG.proposal[status]?.subLabel
  return template ? template.replace('{nextVersion}', String(version + 1)) : null
}

// ---------------------------------------------------------------------------
// Lost reasons (required when marking a proposal lost)
// ---------------------------------------------------------------------------

export const LOST_REASONS = [
  { id: 'price', label: 'Price' },
  { id: 'timing', label: 'Timing' },
  { id: 'competitor', label: 'Chose a competitor' },
  { id: 'no_response', label: 'No response' },
  { id: 'budget_cancelled', label: 'Budget cancelled' },
  { id: 'other', label: 'Other' },
  // Only for records imported from the 2026 tracker, which never recorded a reason. Never offered in a form.
  { id: 'not_recorded', label: 'Not recorded', importOnly: true },
]
export const LOST_REASON_OTHER = 'other'
export const LOST_REASON_NOT_RECORDED = 'not_recorded'
/** The reasons a person can choose when marking something lost. */
export const LOST_REASONS_FOR_FORMS = LOST_REASONS.filter((r) => !r.importOnly)

export function lostReasonLabel(id) {
  return LOST_REASONS.find((r) => r.id === id)?.label ?? id
}

/** How BD sent the proposal to the client (recorded on the "Shared with Client" history entry). */
export const SHARE_CHANNELS = [
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'email', label: 'Email' },
  { id: 'in_person', label: 'In person' },
  { id: 'other', label: 'Other' },
]

export function shareChannelLabel(id) {
  return SHARE_CHANNELS.find((c) => c.id === id)?.label ?? id
}
