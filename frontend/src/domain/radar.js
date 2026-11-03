/**
 * "Likely to book soon": the repeat-client radar. Rules only (no AI); the backend (app/domain/radar.py)
 * gives the same answers (contract: radarCases).
 *
 * A client appears when either is true:
 *   a) Occasion match: they had a request for an occasion before, the next occurrence of that occasion
 *      (its dates come from Settings) starts within 8 weeks, and they have no request for it yet.
 *   b) Repeat rhythm: they had 2+ confirmed events and the usual gap between them has passed with no new
 *      request (with one confirmed event: 6 months since it).
 * "Not this time" hides an item until its `until` date (the occasion's end, or one more gap).
 */

import { PROPOSAL_STATUS as PS, getStatus } from './status.js'

export const OCCASION_WINDOW_DAYS = 56 // 8 weeks
export const ONE_EVENT_GAP_DAYS = 182 // about 6 months
const DAY = 86400000

const utc = (iso) => new Date(`${iso}T00:00:00Z`)
const days = (from, to) => Math.round((utc(to) - utc(from)) / DAY)
export const plusDays = (iso, n) => {
  const d = utc(iso)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const isOpen = (r) => r.status !== PS.DRAFT && !getStatus('proposal', r.status).closed
const dayOf = (ts) => (ts ? String(ts).slice(0, 10) : null)
const submittedDay = (r) => dayOf(r.submittedAt) ?? dayOf((r.statusHistory ?? []).find((e) => e.status === PS.SUBMITTED)?.changedAt)
/** The day an event happened (its last day, else its first; a month-only date is its 1st). */
function eventDay(r) {
  const d = r.eventEndDate || r.eventDate
  if (!d) return dayOf((r.statusHistory ?? []).find((e) => e.status === PS.ACCEPTED)?.changedAt)
  return d.length === 7 ? `${d}-01` : d
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthYear = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`

/** "in about 6 weeks" · "in 5 days" · "today". */
export function inAbout(n) {
  if (n <= 0) return 'today'
  if (n < 14) return `in ${n} day${n === 1 ? '' : 's'}`
  return `in about ${Math.round(n / 7)} weeks`
}

/** When it was: "this year" · "last year" · "in 2024". */
const whenYear = (iso, today) => (iso.slice(0, 4) === today.slice(0, 4) ? 'this year'
  : Number(iso.slice(0, 4)) === Number(today.slice(0, 4)) - 1 ? 'last year' : `in ${iso.slice(0, 4)}`)

/**
 * requests: every non-draft request (any client); periods: [{ occasionId, name, startsOn, endsOn }];
 * dismissals: [{ clientId, signal, until }]; clients: { id: { name, owner } }.
 * -> [{ clientId, signal, occasionId, sentence, bdOwner, sourceRequestId, until, sortDays }], most urgent first.
 */
export function radarItems(requests, periods, dismissals, clients, today) {
  const byClient = new Map()
  for (const r of requests) {
    if (r.status === PS.DRAFT || !clients[r.clientId]) continue
    if (!byClient.has(r.clientId)) byClient.set(r.clientId, [])
    byClient.get(r.clientId).push(r)
  }
  const hidden = (clientId, signal) => dismissals.some((d) => d.clientId === clientId && d.signal === signal && d.until >= today)
  const out = []
  for (const [clientId, list] of [...byClient.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const client = clients[clientId]
    // a) Occasion match.
    const occasionIds = [...new Set(list.filter((r) => r.occasionId).map((r) => r.occasionId))].sort((a, b) => a - b)
    for (const occasionId of occasionIds) {
      const mine = periods.filter((p) => p.occasionId === occasionId).sort((a, b) => a.startsOn.localeCompare(b.startsOn))
      const next = mine.find((p) => p.startsOn >= today)
      if (!next || days(today, next.startsOn) > OCCASION_WINDOW_DAYS) continue
      const previous = [...mine].reverse().find((p) => p.endsOn < next.startsOn)
      const since = previous ? previous.endsOn : plusDays(next.startsOn, -300)
      const forIt = list.filter((r) => r.occasionId === occasionId)
      const covered = forIt.some((r) => isOpen(r) || (submittedDay(r) ?? '') > since)
      const signal = `occasion:${occasionId}`
      if (covered || hidden(clientId, signal)) continue
      const past = [...forIt].sort((a, b) => (eventDay(b) ?? '').localeCompare(eventDay(a) ?? '') || b.id.localeCompare(a.id))[0]
      const booked = forIt.find((r) => r.status === PS.ACCEPTED)
      const when = eventDay(past) ?? submittedDay(past) ?? today
      const what = past.eventName ?? next.name
      const n = days(today, next.startsOn)
      out.push({
        clientId, signal, occasionId, bdOwner: client.owner, sourceRequestId: past.id, until: next.endsOn, sortDays: n,
        sentence: `${client.name} ${booked ? 'booked' : 'asked about'} ${what} ${whenYear(when, today)}. ${next.name} starts ${inAbout(n)}. No request yet.`,
      })
    }
    // b) Repeat rhythm.
    const confirmed = list.filter((r) => r.status === PS.ACCEPTED && eventDay(r))
      .sort((a, b) => eventDay(a).localeCompare(eventDay(b)) || a.id.localeCompare(b.id))
    if (!confirmed.length) continue
    const last = confirmed[confirmed.length - 1]
    const lastDay = eventDay(last)
    let gap = ONE_EVENT_GAP_DAYS
    if (confirmed.length >= 2) {
      const gaps = confirmed.slice(1).map((r, i) => days(eventDay(confirmed[i]), eventDay(r))).sort((a, b) => a - b)
      gap = Math.max(1, gaps[Math.floor((gaps.length - 1) / 2)]) // the median gap: "the usual gap"
    }
    const due = plusDays(lastDay, gap)
    const newer = list.some((r) => r.id !== last.id && (submittedDay(r) ?? '') > lastDay)
    if (due > today || newer || hidden(clientId, 'rhythm')) continue
    const what = last.eventName ? `${last.eventName} (${monthYear(lastDay)})` : monthYear(lastDay)
    out.push({
      clientId, signal: 'rhythm', occasionId: null, bdOwner: client.owner, sourceRequestId: last.id,
      until: plusDays(today, gap), sortDays: -days(due, today),
      sentence: confirmed.length >= 2
        ? `${client.name} usually books every ${Math.max(1, Math.round(gap / 30))} month${Math.round(gap / 30) === 1 ? '' : 's'}; the last was ${what}. No new request since.`
        : `${client.name} booked ${what}, ${Math.max(1, Math.round(days(lastDay, today) / 30))} months ago. No new request since.`,
    })
  }
  return out.sort((a, b) => a.sortDays - b.sortDays || a.clientId.localeCompare(b.clientId) || a.signal.localeCompare(b.signal))
}

/**
 * "Create request from previous": the new request's fields from a past one (dates left empty).
 * brand, service, event name, brief, quick tags, requirements, participants, occasion.
 */
export function prefillFrom(r) {
  return {
    clientId: r.clientId, brand: r.brand, service: r.service, eventName: r.eventName ?? '',
    requirementsSummary: r.requirementsSummary ?? '', briefTags: [...(r.briefTags ?? [])],
    specificRequirements: r.specificRequirements ?? '', participants: r.confirmedParticipants ?? r.participants ?? null,
    occasionId: r.occasionId ?? null, eventDate: null, eventEndDate: null, requiredBy: null,
  }
}
