/**
 * THE numbers for Home and Analytics (one module, one set of definitions).
 *
 *   Received   submitted in the period
 *   Prepared   first reached Ready for BD in the period
 *   Sent       first reached Shared with Client in the period (Ready for BD is never "sent")
 *   Won / Lost / Postponed   reached in the period (Lost = Rejected + Cancelled)
 *   In progress  open now (submitted, not closed), whatever the period
 *   Win rate   Won ÷ (Won + Lost), shown as "43% · 36 of 83"; "—" under 5 closed
 *   Confirmed value  the final price of what was confirmed (else the AM's price), where priced
 *   Pipeline value   the AM's price of proposals sent and not yet decided (with the client, postponed)
 * Each request counts once per measure (a revision never counts twice). Imported rows without
 * dates are left out of time-based numbers, which say "based on N". An outcome replaced by a
 * "Correct status (data fix)" no longer counts (countedHistory).
 * Values: confirmed = the final price (else the proposal price); sent and lost = the proposal price.
 * Each value says "based on N with a price".
 * Dates are compared as Cairo calendar days. requests carry statusHistory (API: ?include=history).
 */

import { cairoTodayISO } from './events.js'
import { LOST_REASONS, PROPOSAL_STATUS as PS, getStatus } from './status.js'
import { amTurnaroundDays } from './metrics.js'

export const PERIODS = [
  { id: 'month', label: 'This month' },
  { id: 'quarter', label: 'This quarter' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
]
export const PERIOD_IDS = PERIODS.map((p) => p.id)
export const MIN_CLOSED = 5
const LOST_STATUSES = [PS.REJECTED, PS.CANCELLED]
const DAY_MS = 86400000

/** A timestamp's Cairo calendar day. */
export const cairoDay = (ts) => (ts ? cairoTodayISO(new Date(ts)) : null)

const quarter = (iso) => `${iso.slice(0, 4)}-Q${Math.ceil(Number(iso.slice(5, 7)) / 3)}`
export function inPeriod(day, period, today) {
  if (!day) return false
  if (period === 'all') return day <= today
  if (period === 'year') return day.slice(0, 4) === today.slice(0, 4) && day <= today
  if (period === 'quarter') return quarter(day) === quarter(today) && day <= today
  return day.slice(0, 7) === today.slice(0, 7) && day <= today
}

const OUTCOMES = [PS.ACCEPTED, PS.REJECTED, PS.CANCELLED, PS.POSTPONED, PS.CLOSED_UNRECORDED, PS.CLOSED_POSTPONED]

/** The history the numbers count: outcomes before the last status correction were wrong, so they are left out. */
export function countedHistory(r) {
  const h = r.statusHistory ?? []
  const last = h.map((e) => Boolean(e.corrected)).lastIndexOf(true)
  return last < 0 ? h : h.filter((e, i) => i >= last || !OUTCOMES.includes(e.status))
}

/** When the request FIRST reached one of these statuses (ISO timestamp) or null. */
export function firstAt(r, statuses) {
  const list = Array.isArray(statuses) ? statuses : [statuses]
  return countedHistory(r).find((e) => list.includes(e.status))?.changedAt ?? null
}
const submittedAt = (r) => (r.status === PS.DRAFT ? null : r.submittedAt ?? firstAt(r, PS.SUBMITTED))
const isOpenNow = (r) => r.status !== PS.DRAFT && !getStatus('proposal', r.status).closed

/** Which measures this request counts in, for the period. */
export function measuresOf(r, period, today) {
  const at = (ts) => inPeriod(cairoDay(ts), period, today)
  return {
    received: at(submittedAt(r)),
    prepared: at(firstAt(r, PS.READY_FOR_BD)),
    sent: at(firstAt(r, PS.SHARED_WITH_CLIENT)),
    won: at(firstAt(r, PS.ACCEPTED)),
    lost: at(firstAt(r, LOST_STATUSES)),
    postponed: at(firstAt(r, PS.POSTPONED)),
  }
}

/** "43% · 36 of 83", or "— · 3 of 4" under MIN_CLOSED (or when there is nothing to divide). */
export function rate(part, whole, min = MIN_CLOSED) {
  const value = whole >= min && whole > 0 ? Math.round((part / whole) * 100) : null
  return { value, part, whole, text: `${value === null ? '—' : `${value}%`} · ${part} of ${whole}` }
}

/** The funnel strip: Received → Prepared → Sent → Won · Lost · Postponed | In progress. */
export function funnel(requests, period, today) {
  const out = { received: 0, prepared: 0, sent: 0, won: 0, lost: 0, postponed: 0, inProgress: 0 }
  for (const r of requests) {
    const m = measuresOf(r, period, today)
    for (const k of Object.keys(m)) if (m[k]) out[k] += 1
    if (isOpenNow(r)) out.inProgress += 1
  }
  return out
}

export const winRate = (f) => rate(f.won, f.won + f.lost)

/** Average days between two moments of each request; imported rows without both dates are left out. */
function averageDays(requests, from, to) {
  const values = []
  for (const r of requests) {
    const a = from(r)
    const b = to(r)
    if (a && b && b >= a) values.push((new Date(b) - new Date(a)) / DAY_MS)
  }
  return { value: values.length ? values.reduce((x, y) => x + y, 0) / values.length : null, basedOn: values.length }
}
export const daysText = (avg) => (avg.value === null ? `— · based on ${avg.basedOn}` : `${avg.value.toFixed(1)} days · based on ${avg.basedOn}`)

/** The months the chart shows: the period's months (at least the last 6). -> ['2026-05', …] */
export function chartMonths(period, today) {
  const [y, m] = today.split('-').map(Number)
  const count = period === 'all' ? 12 : period === 'year' ? Math.max(m, 6) : 6
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  })
}

/** Received / won / lost per month. */
export function monthly(requests, period, today) {
  const months = chartMonths(period, today)
  const rows = months.map((month) => ({ month, received: 0, won: 0, lost: 0 }))
  const byMonth = Object.fromEntries(rows.map((r) => [r.month, r]))
  for (const r of requests) {
    const add = (ts, key) => { const d = cairoDay(ts); if (d && byMonth[d.slice(0, 7)] && d <= today) byMonth[d.slice(0, 7)][key] += 1 }
    add(submittedAt(r), 'received')
    add(firstAt(r, PS.ACCEPTED), 'won')
    add(firstAt(r, LOST_STATUSES), 'lost')
  }
  return rows
}

/** Results list: Won · Lost · Postponed in the period, newest first, at most `limit` each. */
export function results(requests, period, today, limit = 10) {
  const pick = (statuses) => requests
    .map((r) => ({ request: r, at: firstAt(r, statuses) }))
    .filter((x) => x.at && inPeriod(cairoDay(x.at), period, today))
    .sort((a, b) => b.at.localeCompare(a.at))
  const won = pick(PS.ACCEPTED)
  const lost = pick(LOST_STATUSES)
  const postponed = pick(PS.POSTPONED)
  return {
    won: won.slice(0, limit), lost: lost.slice(0, limit), postponed: postponed.slice(0, limit),
    counts: { won: won.length, lost: lost.length, postponed: postponed.length },
  }
}

/** A confirmed request's value: its final price, else the AM's price; null when unpriced. */
export const valueOf = (r) => r.finalPrice ?? r.amPrice ?? null

const lostReasonOf = (r) => [...(r.statusHistory ?? [])].reverse().find((e) => e.lostReason)?.lostReason ?? r.lostReason ?? null
const LOST_LABELS = Object.fromEntries(LOST_REASONS.map((x) => [x.id, x.label]))

/** Count by a key, largest first: [{ key, label, count }]. */
function countBy(items, keyOf, labelOf = (k) => k) {
  const m = new Map()
  for (const it of items) {
    const k = keyOf(it)
    if (k === null || k === undefined) continue
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()].map(([key, count]) => ({ key, label: labelOf(key), count }))
    .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)))
}

// ---------------------------------------------------------------------------
// Scorecards
// ---------------------------------------------------------------------------

/**
 * Business Development: their own requests.
 * Headline: submitted · won · win rate · won value (where priced). Extra: average days from ready to sent.
 * Breakdowns: by brand; top lost reasons.
 */
export function bdScorecard(requests, period, today) {
  const f = funnel(requests, period, today)
  const wonRows = requests.filter((r) => measuresOf(r, period, today).won)
  const priced = wonRows.filter((r) => valueOf(r) !== null)
  const lostRows = requests.filter((r) => measuresOf(r, period, today).lost)
  const inScope = requests.filter((r) => measuresOf(r, period, today).sent)
  return {
    funnel: f,
    headline: [
      { id: 'received', label: 'Requests submitted', value: f.received },
      { id: 'won', label: 'Confirmed', value: f.won },
      { id: 'winRate', label: 'Confirmation rate', value: winRate(f).text },
      { id: 'wonValue', label: 'Confirmed value', value: priced.reduce((s, r) => s + valueOf(r), 0), money: true, priced: priced.length,
        note: `${priced.length} of ${wonRows.length} confirmed requests have a price` },
    ],
    extra: { label: 'Average days from ready to sent', value: daysText(averageDays(inScope,
      (r) => firstAt(r, PS.READY_FOR_BD), (r) => firstAt(r, PS.SHARED_WITH_CLIENT))) },
    breakdowns: [
      { id: 'brand', title: 'By brand', rows: countBy(requests.filter((r) => measuresOf(r, period, today).received), (r) => r.brand) },
      { id: 'lost', title: 'Top lost reasons', rows: countBy(lostRows, lostReasonOf, (k) => LOST_LABELS[k] ?? k).slice(0, 5) },
    ],
  }
}

/**
 * Changes after a proposal was ready, in the period: "Internal change" (BD asked for changes, or the AM
 * took it back, before the client saw it) and "Client revision" (after sharing). Counted separately.
 */
export function changeCounts(requests, period, today) {
  let internal = 0
  let client = 0
  for (const r of requests) {
    const h = r.statusHistory ?? []
    h.forEach((e, i) => {
      if (!inPeriod(cairoDay(e.changedAt), period, today)) return
      const prev = h[i - 1]?.status
      if (e.status === PS.REVISION_REQUESTED) {
        if (prev === PS.READY_FOR_BD) internal += 1
        else client += 1
      } else if (e.status === PS.IN_PROGRESS && prev === PS.READY_FOR_BD) internal += 1
    })
  }
  return { internal, client }
}

/** On time: first Ready for BD on or before the proposal deadline (requests that have both). */
export function onTimeRate(requests) {
  const rows = requests.filter((r) => r.requiredBy && firstAt(r, PS.READY_FOR_BD))
  return rate(rows.filter((r) => cairoDay(firstAt(r, PS.READY_FOR_BD)) <= r.requiredBy).length, rows.length)
}

/** Average AM turnaround (submitted -> ready, minus time waiting on BD); imported rows without dates left out. */
export function turnaround(requests) {
  const values = requests.map(amTurnaroundDays).filter((v) => v !== null)
  return { value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, basedOn: values.length }
}

/**
 * Account Manager: the requests assigned to them.
 * Headline: received · prepared · average turnaround · on-time rate.
 * Breakdowns: "Outcome of your proposals"; versions per request.
 */
export function amScorecard(requests, period, today) {
  const f = funnel(requests, period, today)
  const prepared = requests.filter((r) => measuresOf(r, period, today).prepared)
  const changes = changeCounts(requests, period, today)
  return {
    funnel: f,
    headline: [
      { id: 'received', label: 'Received', value: f.received },
      { id: 'prepared', label: 'Prepared', value: f.prepared },
      { id: 'turnaround', label: 'Average turnaround', value: daysText(turnaround(prepared)) },
      { id: 'onTime', label: 'On time', value: onTimeRate(prepared).text },
    ],
    extra: null,
    breakdowns: [
      { id: 'outcome', title: 'Outcome of your proposals', rows: [
        { key: 'won', label: 'Confirmed', count: f.won }, { key: 'lost', label: 'Lost', count: f.lost },
        { key: 'postponed', label: 'Postponed', count: f.postponed }, { key: 'open', label: 'In progress', count: f.inProgress },
      ] },
      { id: 'changes', title: 'Changes after ready', rows: [
        { key: 'internal', label: 'Internal changes (before the client saw it)', count: changes.internal },
        { key: 'client', label: 'Client revisions', count: changes.client },
      ] },
    ],
  }
}

/**
 * The company (management): headline received · sent · won · win rate.
 * Breakdowns (management only): lost split (Rejected vs Cancelled); what open requests wait on (reasons).
 */
export function companyScorecard(requests, period, today, { reasonLabel = (team, code) => code } = {}) {
  const f = funnel(requests, period, today)
  const lostRows = requests.filter((r) => measuresOf(r, period, today).lost)
  const waiting = requests.filter((r) => isOpenNow(r) && r.waiting?.team)
  return {
    funnel: f,
    headline: [
      { id: 'received', label: 'Received', value: f.received },
      { id: 'sent', label: 'Sent to clients', value: f.sent },
      { id: 'won', label: 'Confirmed', value: f.won },
      { id: 'winRate', label: 'Confirmation rate', value: winRate(f).text },
    ],
    extra: null,
    breakdowns: [
      { id: 'lostSplit', title: 'Lost: rejected or cancelled', rows: [
        { key: 'rejected', label: 'Rejected by the client', count: lostRows.filter((r) => firstAt(r, PS.REJECTED)).length },
        { key: 'cancelled', label: 'Cancelled', count: lostRows.filter((r) => !firstAt(r, PS.REJECTED)).length },
      ] },
      { id: 'waiting', title: 'Waiting-on reasons (open requests)',
        rows: countBy(waiting, (r) => `${r.waiting.team}:${r.waiting.reason}`, (k) => reasonLabel(...k.split(':'))).slice(0, 6) },
    ],
  }
}

/**
 * Management tables (never mixed, never ranked: alphabetical).
 * people = [{ id, name, as: 'bd' | 'am', active }]
 */
export function bdTable(requests, people, period, today) {
  return people.filter((p) => p.as === 'bd').map((p) => {
    const f = funnel(requests.filter((r) => r.bdOwner === p.id), period, today)
    return { ...p, requests: f.received, sent: f.sent, won: f.won, lost: f.lost, winRate: winRate(f).text }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

export function amTable(requests, people, period, today) {
  return people.filter((p) => p.as === 'am').map((p) => {
    const mine = requests.filter((r) => r.assignedAM === p.id)
    const f = funnel(mine, period, today)
    const prepared = mine.filter((r) => measuresOf(r, period, today).prepared)
    const changes = changeCounts(mine, period, today)
    return { ...p, received: f.received, prepared: f.prepared, turnaround: daysText(turnaround(prepared)),
      onTime: onTimeRate(prepared).text, changes: `${changes.internal} internal · ${changes.client} client` }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

/** CSV (management): one file with both tables, one after the other. */
export function scorecardCsv(bdRows, amRows, periodLabel) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const line = (cells) => cells.map(cell).join(',')
  return [
    line([`Period: ${periodLabel}`]),
    line(['Business Development', 'Active', 'Requests', 'Sent', 'Confirmed', 'Lost', 'Confirmation rate']),
    ...bdRows.map((r) => line([r.name, r.active ? 'yes' : 'Former team member', r.requests, r.sent, r.won, r.lost, r.winRate])),
    '',
    line(['Account Managers', 'Active', 'Received', 'Prepared', 'Average turnaround', 'On time', 'Changes']),
    ...amRows.map((r) => line([r.name, r.active ? 'yes' : 'Former team member', r.received, r.prepared, r.turnaround, r.onTime, r.changes])),
  ].join('\r\n')
}

// ---------------------------------------------------------------------------
// Executive Overview (Doaa, Tony): one screen, the same definitions as Analytics
// ---------------------------------------------------------------------------

const lastYear = (iso) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`

/** Sum of confirmed value in a period (and how many were priced). */
export function confirmedValue(requests, period, today) {
  const won = requests.filter((r) => measuresOf(r, period, today).won)
  const priced = won.filter((r) => valueOf(r) !== null)
  return { value: priced.reduce((s, r) => s + valueOf(r), 0), priced: priced.length, count: won.length }
}

/**
 * -> { month, year (each { value, priced, count, lastYear | null }), pipeline: { value, count },
 *      byBrand: [{ brand, rate }], topClients: [{ clientId, value, count }], lostReasons: [{ key, label, count }] }
 * "vs last year" is null when last year has no confirmed requests (no data to compare with).
 */
export function executiveOverview(requests, today) {
  const withLastYear = (period) => {
    const now = confirmedValue(requests, period, today)
    const before = confirmedValue(requests, period, lastYear(today))
    return { ...now, lastYear: before.count ? before : null }
  }
  const pending = requests.filter((r) => [PS.SHARED_WITH_CLIENT, PS.POSTPONED].includes(r.status))
  const year = requests.filter((r) => measuresOf(r, 'year', today).won)
  const byClient = new Map()
  for (const r of year) {
    const c = byClient.get(r.clientId) ?? { clientId: r.clientId, clientName: r.clientName ?? null, value: 0, count: 0, priced: 0 }
    c.value += valueOf(r) ?? 0
    c.count += 1
    if (valueOf(r) !== null) c.priced += 1
    byClient.set(r.clientId, c)
  }
  const brands = [...new Set(requests.map((r) => r.brand))].sort()
  return {
    month: withLastYear('month'),
    year: withLastYear('year'),
    pipeline: { value: pending.reduce((s, r) => s + (r.amPrice ?? 0), 0), count: pending.length,
      priced: pending.filter((r) => r.amPrice !== null && r.amPrice !== undefined).length },
    byBrand: brands.map((brand) => ({ brand, rate: winRate(funnel(requests.filter((r) => r.brand === brand), 'year', today)) })),
    topClients: [...byClient.values()].sort((a, b) => b.value - a.value || b.count - a.count).slice(0, 5),
    lostReasons: countBy(requests.filter((r) => measuresOf(r, 'year', today).lost), lostReasonOf, (k) => LOST_LABELS[k] ?? k).slice(0, 3),
  }
}

/**
 * Value numbers for the period: confirmed (final price, else the proposal price), sent and lost (the
 * proposal price). -> [{ id, label, value, priced, count }] ("based on priced of count with a price").
 */
export function valueCards(requests, period, today) {
  const sum = (rows, price) => {
    const priced = rows.filter((r) => price(r) !== null && price(r) !== undefined)
    return { value: priced.reduce((s, r) => s + price(r), 0), priced: priced.length, count: rows.length }
  }
  const where = (key) => requests.filter((r) => measuresOf(r, period, today)[key])
  return [
    { id: 'confirmedValue', label: 'Confirmed value', ...sum(where('won'), valueOf) },
    { id: 'sentValue', label: 'Sent value', ...sum(where('sent'), (r) => r.amPrice ?? null) },
    { id: 'lostValue', label: 'Lost value', ...sum(where('lost'), (r) => r.amPrice ?? null) },
  ]
}

/** Every lost reason in the period, largest first: [{ key, label, count }] (Lost = rejected or cancelled). */
export function lostReasons(requests, period, today) {
  return countBy(requests.filter((r) => measuresOf(r, period, today).lost), lostReasonOf, (k) => LOST_LABELS[k] ?? k)
}

const PREVIOUS_LABEL = { month: 'last month', quarter: 'last quarter', year: 'last year' }

/** The same point in the previous period ("2026-10-27", month -> "2026-09-27"; 31 Mar -> 28/29 Feb); null for All time. */
export function previousToday(period, today) {
  const back = { month: 1, quarter: 3, year: 12 }[period]
  if (!back) return null
  const [y, m, d] = today.split('-').map(Number)
  const index = y * 12 + (m - 1) - back
  const py = Math.floor(index / 12)
  const pm = (index % 12) + 1
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate()
  return `${py}-${String(pm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

/**
 * The funnel's change against the same days of the previous period ("↑ 3 vs last month").
 * { label, received, prepared, sent, won, lost, postponed } as differences, or null when there is
 * nothing to compare with (All time, or no requests at all in the previous period).
 */
export function funnelChange(requests, period, today) {
  const before = previousToday(period, today)
  if (!before) return null
  const prev = funnel(requests, period, before)
  if (!prev.received && !prev.won && !prev.lost && !prev.sent) return null
  const now = funnel(requests, period, today)
  const keys = ['received', 'prepared', 'sent', 'won', 'lost', 'postponed']
  return { label: `vs ${PREVIOUS_LABEL[period]}`, ...Object.fromEntries(keys.map((k) => [k, now[k] - prev[k]])) }
}
