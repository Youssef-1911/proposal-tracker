/**
 * Who is told about what on a request, and what is "New for you". Pure rules; the backend
 * (app/domain/activity.py) gives the same answers, checked by the contract file's activityCases.
 *
 * Messages (comments) go to the other side: the BD owner ↔ the assigned AM (both, when someone else
 * writes), plus anyone @mentioned. The Commercial Head sees every message she can view but is told
 * only when @mentioned or for "Change needed". An answer goes to whoever asked the question.
 * "New for you": anything that concerns you, done by someone else, since you last opened the request.
 */

import { canSeeRequest } from './access.js'
import { DEFAULT_LISTS, optionLabel } from './lists.js'
import { ROLE } from './roles.js'
import { PROPOSAL_STATUS as PS } from './status.js'

const ORIGIN_LABELS = { client: 'client', internal: 'internal' }
const short = (text, n = 60) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** "@Mariam Dimitri" (full name) or "@Sherine" (a first name only one active person has) -> user ids, sorted. */
export function findMentions(body, users = []) {
  const text = String(body ?? '').toLowerCase()
  const active = users.filter((u) => u.active !== false)
  const firstCounts = {}
  for (const u of active) {
    const first = u.name.split(' ')[0].toLowerCase()
    firstCounts[first] = (firstCounts[first] ?? 0) + 1
  }
  const found = new Set()
  const at = (word) => {
    let i = text.indexOf(`@${word}`)
    while (i !== -1) {
      const next = text[i + word.length + 1]
      if (next === undefined || !/[a-z0-9]/.test(next)) return true
      i = text.indexOf(`@${word}`, i + 1)
    }
    return false
  }
  for (const u of active) {
    const name = u.name.toLowerCase()
    const first = name.split(' ')[0]
    if (at(name) || (firstCounts[first] === 1 && at(first))) found.add(u.id)
  }
  return [...found].sort()
}

/** May this person see the request in any of their roles? (and are they active) */
export function recipientCanView(r, user, usersById = {}) {
  if (!user || user.active === false) return false
  return user.roles.some((role) => canSeeRequest(r, { userId: user.id, activeRole: role }, usersById))
}

/**
 * Who is told about a new message. m = { kind, author, body, parentId }; messages = the request's
 * (to find who asked a question). -> sorted user ids (never the author; only people who can view it).
 */
export function messageRecipients(m, r, usersById = {}, messages = []) {
  if (m.kind === 'answered' || m.kind === 'picked_up') return []
  const side = m.author === r.bdOwner ? [r.assignedAM] : m.author === r.assignedAM ? [r.bdOwner] : [r.bdOwner, r.assignedAM]
  let ids = []
  if (m.kind === 'answer') ids = [messages.find((x) => x.id === m.parentId)?.author].filter(Boolean)
  else ids = [...side]
  if (m.kind === 'change') {
    ids.push(...Object.values(usersById).filter((u) => u.roles.includes(ROLE.COMMERCIAL_HEAD) && u.active !== false).map((u) => u.id))
  }
  ids.push(...findMentions(m.body, Object.values(usersById)))
  return [...new Set(ids)].filter((id) => id && id !== m.author && recipientCanView(r, usersById[id], usersById)).sort()
}

/** The words a message carries into the bell and the "New" line. */
export function messageLine(m, authorName, lists = DEFAULT_LISTS) {
  if (m.kind === 'question') return `${authorName} asked: "${short(m.body)}"`
  if (m.kind === 'answer') return `${authorName} answered your question`
  if (m.kind === 'change') {
    const what = (m.reasons ?? []).map((c) => optionLabel(lists, 'whatShouldChange', c)).join(', ').toLowerCase()
    return `Change needed (${ORIGIN_LABELS[m.about] ?? m.about}): ${what}`
  }
  return `${authorName}: "${short(m.body)}"`
}

const STATUS_FOR = { am: 'assignedAM', bd: 'bdOwner' }
// The role a status step is addressed to ("slot"). It only matters for people holding both roles
// (Mariam El Khayat): something from someone else shows as new in the role it concerns.
const SLOT_ROLE = { am: ROLE.ACCOUNT_MANAGER, bd: ROLE.BUSINESS_DEVELOPMENT }

/** Everyone holding a waiting-on team's roles (a team with no one named: Marketing, Operations). */
function teamMembers(team, usersById) {
  const roles = { bd: [ROLE.BUSINESS_DEVELOPMENT], am: [ROLE.ACCOUNT_MANAGER], marketing: [ROLE.MARKETING],
    operations: [ROLE.OPERATIONS], management: [ROLE.COMMERCIAL_HEAD, ROLE.EXECUTIVE] }[team] ?? []
  return Object.values(usersById).filter((u) => u.active !== false && u.roles.some((x) => roles.includes(x))).map((u) => u.id).sort()
}

/**
 * Everything that happened on a request, each with who it concerns and one line of plain words.
 * -> [{ at, by, byRole, to: [userIds], slots: { userId: 'am' | 'bd' }, line }]
 */
export function activityItems(r, usersById = {}, lists = DEFAULT_LISTS) {
  const name = (id) => usersById[id]?.name ?? 'Someone'
  const items = []
  const h = r.statusHistory ?? []
  h.forEach((e, i) => {
    if (e.imported || e.corrected || e.status === PS.DRAFT) return // data fixes and records from before IEE never notify
    const prev = h[i - 1]?.status
    const by = e.changedBy
    const push = (who, line) => {
      const slots = {}
      for (const k of who) if (r[STATUS_FOR[k]]) slots[r[STATUS_FOR[k]]] ??= k
      items.push({ at: e.changedAt, by, byRole: e.role ?? null, to: Object.keys(slots), slots, line })
    }
    if (e.status === PS.SUBMITTED) push(['am'], prev === PS.AWAITING_BD_INFO ? `${name(by)} sent the information` : `New request from ${name(by)}`)
    else if (e.status === PS.AWAITING_BD_INFO) push(['bd'], `${name(by)} needs an answer to continue`)
    else if (e.status === PS.READY_FOR_BD) push(['bd'], 'Proposal ready for you')
    else if (e.status === PS.REVISION_REQUESTED) push(['am'], prev === PS.READY_FOR_BD ? `Changes requested by ${name(by)}` : `Client revision recorded by ${name(by)}`)
    else if (e.status === PS.IN_PROGRESS && prev === PS.READY_FOR_BD) push(['bd'], `${name(by)} took the proposal back to edit`)
    else if (e.status === PS.ACCEPTED) push(['am'], `Confirmed by ${name(by)}`)
    else if (e.status === PS.REJECTED) push(['am'], `Marked lost by ${name(by)}`)
    else if (e.status === PS.CANCELLED) push(['am', 'bd'], `Cancelled by ${name(by)}`)
  })
  const messages = r.comments ?? []
  for (const m of messages) {
    if (m.kind === 'answered' || m.kind === 'picked_up') continue
    const line = m.kind === 'question' ? `New question from ${name(m.author)}` : messageLine(m, name(m.author), lists)
    items.push({ at: m.createdAt, by: m.author, byRole: m.role ?? null, to: messageRecipients(m, r, usersById, messages), slots: {}, line })
  }
  for (const ev of r.events ?? []) {
    const base = { at: ev.changedAt, by: ev.changedBy, byRole: ev.role ?? null }
    if (ev.event === 'details_updated' && r.assignedAM) {
      items.push({ ...base, to: [r.assignedAM], slots: { [r.assignedAM]: 'am' }, line: `Details changed by ${name(ev.changedBy)}` })
    } else if (ev.event === 'waiting_on_set' && (ev.toUser || ev.details?.team)) {
      // Waiting on a team with no one named (e.g. Marketing): everyone in that team is told.
      const to = ev.toUser ? [ev.toUser] : teamMembers(ev.details.team, usersById)
      items.push({ ...base, to, slots: {}, line: `Waiting on you — set by ${name(ev.changedBy)}` })
    } else if (ev.event === 'reminder_sent' && ev.toUser) {
      items.push({ ...base, to: [ev.toUser], slots: {}, line: `Reminder from ${name(ev.changedBy)}` })
    }
  }
  return items
}

const time = (v) => (v ? new Date(v).getTime() : 0)

/** The role an item is addressed to for this person: only for people holding more than one role. */
export function itemRole(item, user) {
  const role = SLOT_ROLE[item.slots?.[user?.id]]
  return role && user.roles.length > 1 && user.roles.includes(role) ? role : null
}

/**
 * The one shared rule: is this item new for this person in this role? Only what OTHER people did counts
 * (a person's own action is never new for them, in either role); for someone with two roles, an item
 * addressed to one role (e.g. "New request" to the AM) shows only while working in that role.
 */
export function isNewFor(item, viewer, usersById = {}) {
  if (!item.to.includes(viewer.userId) || item.by === viewer.userId) return false
  const role = itemRole(item, usersById[viewer.userId])
  return !role || role === viewer.activeRole
}

/**
 * Who an item is new for -> [{ userId, role }] (role null: any of their roles). Every one of them also
 * gets a bell notification: anything marked New for someone notifies them.
 */
export function newRecipients(item, usersById = {}) {
  return item.to.map((userId) => ({ userId, role: itemRole(item, usersById[userId]) }))
    .filter(({ userId, role }) => usersById[userId] && isNewFor(item, { userId, activeRole: role }, usersById))
}

/**
 * "New for you": the latest thing that concerns this person in this role, since they last opened the
 * request in this role (never opened: everything). viewer = { userId, activeRole } -> { line, at, count } | null
 */
export function newForYou(r, viewer, lastReadAt, usersById = {}, lists = DEFAULT_LISTS) {
  const since = time(lastReadAt)
  const mine = activityItems(r, usersById, lists)
    .filter((it) => time(it.at) > since && isNewFor(it, viewer, usersById))
    .sort((a, b) => time(b.at) - time(a.at))
  return mine.length ? { line: mine[0].line, at: mine[0].at, count: mine.length } : null
}
