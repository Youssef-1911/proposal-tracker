/**
 * Who may ACT on a request. Separate from who may VIEW it (domain/proposals.js
 * canViewRequest) and from the workflow table (domain/workflow.js), which only
 * names the responsibility each action needs.
 *
 * IMPORTANT: this runs in the browser against the demo "Viewing as" switcher.
 * It models the business rules; it is NOT security. Real enforcement must be
 * repeated on the backend once there is authentication.
 *
 * viewer = { userId, activeRole }  (actions follow the ACTIVE role)
 */

import { ROLE, roleLabel } from './roles.js'
import { actsAsBusinessDevelopment, canSeeRequest } from './access.js'

/** Responsibilities an action can require. */
export const ACTOR = {
  CREATOR: 'creator', // the person who created the draft (BD for own client, or Commercial Head on behalf)
  BD_OWNER: 'bdOwner', // the client relationship owner, acting as Business Development
  ASSIGNED_AM: 'assignedAM', // the routed Account Manager, acting as Account Manager
  COMMERCIAL_HEAD: 'commercialHead', // anyone acting as Commercial Head
}

/**
 * Does this viewer hold this responsibility on this request right now?
 * "BD" here means acting as Business Development, or having "Brings in clients" without the BD
 * role (Noha, Doaa) — see actsAsBusinessDevelopment (needs usersById for the privilege).
 */
export function holdsResponsibility(actor, request, viewer, usersById = {}) {
  const asBD = actsAsBusinessDevelopment(viewer, usersById[viewer.userId])
  switch (actor) {
    case ACTOR.CREATOR:
      return (
        viewer.userId === request.createdBy &&
        // A BD may only act for their own client; the Commercial Head may act on behalf of the owner.
        ((asBD && viewer.userId === request.bdOwner) || viewer.activeRole === ROLE.COMMERCIAL_HEAD)
      )
    case ACTOR.BD_OWNER:
      return viewer.userId === request.bdOwner && asBD
    case ACTOR.ASSIGNED_AM:
      return viewer.userId === request.assignedAM && viewer.activeRole === ROLE.ACCOUNT_MANAGER
    case ACTOR.COMMERCIAL_HEAD:
      return viewer.activeRole === ROLE.COMMERCIAL_HEAD
    default:
      return false
  }
}

/**
 * { allowed, reason } for a set of acceptable responsibilities (any one is enough).
 * The reason names the person who CAN act, and tells a multi-role person to switch role.
 */
export function checkActors(actors, request, viewer, usersById = {}) {
  if (!canSeeRequest(request, viewer, usersById)) return { allowed: false, reason: 'You cannot view this request.' }
  if (actors.some((a) => holdsResponsibility(a, request, viewer, usersById))) return { allowed: true, reason: null }
  return { allowed: false, reason: denialReason(actors, request, viewer, usersById) }
}

function nameOf(usersById, id) {
  return usersById[id]?.name ?? 'someone else'
}

function denialReason(actors, request, viewer, usersById) {
  // e.g. "Only the BD owner, Ahmed Seif, can do this."
  const parts = actors.map((a) => {
    if (a === ACTOR.BD_OWNER) return `the BD owner, ${nameOf(usersById, request.bdOwner)},`
    if (a === ACTOR.ASSIGNED_AM) return `the assigned Account Manager, ${nameOf(usersById, request.assignedAM)},`
    if (a === ACTOR.CREATOR) return `the person who created this draft, ${nameOf(usersById, request.createdBy)},`
    if (a === ACTOR.COMMERCIAL_HEAD) return 'the Commercial Head'
    return a
  })
  // Right person, wrong active role (e.g. Mariam El Khayat viewing as AM on a BD step).
  const user = usersById[viewer.userId]
  const switchTo = actors
    .map((a) =>
      a === ACTOR.BD_OWNER && viewer.userId === request.bdOwner ? ROLE.BUSINESS_DEVELOPMENT
      : a === ACTOR.ASSIGNED_AM && viewer.userId === request.assignedAM ? ROLE.ACCOUNT_MANAGER
      : null,
    )
    .find(Boolean)
  if (switchTo && user?.roles.includes(switchTo)) {
    return `You are acting as ${roleLabel(viewer.activeRole, user)}. Switch your active role to ${roleLabel(switchTo, user)} to do this.`
  }
  return `Only ${parts.join(' or ')} can do this.`
}

// ---------------------------------------------------------------------------
// Creating requests (the New Proposal Request form)
// ---------------------------------------------------------------------------

/**
 * Only Business Development (in their BD role) and the Commercial Head may open the form.
 * A person who has a BD role but is acting in another role is told to switch.
 */
export function canOpenRequestForm(viewer, usersById = {}) {
  if (viewer.activeRole === ROLE.COMMERCIAL_HEAD || actsAsBusinessDevelopment(viewer, usersById[viewer.userId])) {
    return { allowed: true, reason: null }
  }
  const user = usersById[viewer.userId]
  if (user?.roles.includes(ROLE.BUSINESS_DEVELOPMENT)) {
    return {
      allowed: false,
      reason: `You are acting as ${roleLabel(viewer.activeRole, user)}. Switch your active role to Business Development to create a proposal request.`,
    }
  }
  return { allowed: false, reason: 'Only Business Development or the Commercial Head can create proposal requests.' }
}

/**
 * Clients a creator may pick: the Commercial Head all; a BD (or someone with "Brings in clients")
 * only their own (relationship owner).
 */
export function clientsForCreator(viewer, clients, usersById = {}) {
  if (viewer.activeRole === ROLE.COMMERCIAL_HEAD) return clients
  if (actsAsBusinessDevelopment(viewer, usersById[viewer.userId])) return clients.filter((c) => c.owner === viewer.userId)
  return []
}
