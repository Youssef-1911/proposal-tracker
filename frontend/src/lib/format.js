import { CURRENCY, WEEK_STARTS_ON, WORKING_DAYS } from '../config.js'

const numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

// ---------- Numbers & money ----------

/** "EGP 125,000". No decimals. Returns an em dash for missing values. */
export function formatCurrency(value) {
  if (value === null || value === undefined) return '—'
  return `${CURRENCY} ${numberFmt.format(Math.round(value))}`
}

/** A money total that may have no prices behind it: "Prices not entered yet", never "EGP 0". */
export const NO_PRICES = 'Prices not entered yet'
export function formatTotal(value, priced) {
  return priced ? formatCurrency(value) : NO_PRICES
}

/** "EGP 125K", "EGP 1.2M" for tight spaces and chart axes. */
export function formatCurrencyCompact(value) {
  if (value === null || value === undefined) return '—'
  return `${CURRENCY} ${compactFmt.format(value)}`
}

export function formatNumber(value) {
  return numberFmt.format(value)
}

// ---------- Dates ----------

/** Accepts a Date or an ISO string. "YYYY-MM-DD" is read as a local calendar date (no UTC shift). */
export function toDate(value) {
  if (value instanceof Date) return value
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(value)
}

/**
 * Times are always shown in the business time zone (Africa/Cairo), whatever the computer's
 * own zone. Calendar dates ("YYYY-MM-DD": deadlines, event dates) are shown as they are.
 */
export const DISPLAY_TIME_ZONE = 'Africa/Cairo'

const cairoParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long',
})
const WEEKDAY_INDEX = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 }

/** { year, month (1-12), day, hour, minute, weekday (0 = Sunday) } in Cairo time (calendar dates as given). */
export function displayParts(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number)
    return { year, month, day, hour: 0, minute: 0, weekday: new Date(year, month - 1, day).getDay() }
  }
  const parts = Object.fromEntries(cairoParts.formatToParts(toDate(value)).map((p) => [p.type, p.value]))
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), weekday: WEEKDAY_INDEX[parts.weekday],
  }
}

/**
 * Local calendar date as "YYYY-MM-DD". Used by the domain rules for date arithmetic on
 * calendar dates (not for display), so it stays in the computer's own calendar.
 */
export function toISODate(date) {
  const d = toDate(date)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Fixed three-letter months so dates always read "20 Oct 2026" (some locales print "Sept").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "20 Oct 2026" */
export function formatDate(value) {
  if (!value) return '—'
  const p = displayParts(value)
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}`
}

/** Event dates may be a full date ("2027-03-14" -> "14 Mar 2027") or month-only ("2027-03" -> "Mar 2027"). */
/**
 * "20 Oct 2026", "Mar 2026" (month only), "5–7 Mar 2026" / "28 Feb – 2 Mar 2026" (with an end date),
 * "Date not set yet" (precision 'unset'), or "—" when there is nothing.
 */
export function formatEventDate(value, end = null, precision = null) {
  if (precision === 'unset') return 'Date not set yet'
  if (!value) return '—'
  if (typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)) {
    const [y, m] = value.split('-').map(Number)
    return `${MONTHS[m - 1]} ${y}`
  }
  const parts = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').map(Number) : null)
  const a = parts(value)
  const b = parts(end)
  if (a && b && end !== value) {
    const [y1, m1, d1] = a
    const [y2, m2, d2] = b
    if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${MONTHS[m1 - 1]} ${y1}`
    if (y1 === y2) return `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]} ${y1}`
    return `${formatDate(value)} – ${formatDate(end)}`
  }
  return formatDate(value)
}

/** "20 Oct" */
export function formatShortDate(value) {
  const p = displayParts(value)
  return `${p.day} ${MONTHS[p.month - 1]}`
}

/** "Tuesday, 20 Oct 2026" */
export function formatLongDate(value) {
  const p = displayParts(value)
  return `${WEEKDAYS[p.weekday]}, ${p.day} ${MONTHS[p.month - 1]} ${p.year}`
}

/** "Oct" */
export function formatMonth(value) {
  return MONTHS[displayParts(value).month - 1]
}

/** "14:30" (Cairo time) */
export function formatTime(value) {
  const p = displayParts(value)
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

/** "20 Oct 2026, 14:30" */
export function formatDateTime(value) {
  return `${formatDate(value)}, ${formatTime(value)}`
}

export function formatRelativeTime(value, now = new Date()) {
  const minutes = Math.round((now - toDate(value)) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

/** Whole calendar days from today to the date (negative = in the past). */
export function daysFromToday(value, now = new Date()) {
  const a = toDate(toISODate(now))
  const b = toDate(toISODate(value))
  return Math.round((b - a) / 86400000)
}

// ---------- Week (Egypt: Sunday–Thursday) ----------

/** Start of the week (Sunday, 00:00) containing the date. */
export function startOfWeek(value) {
  const d = toDate(value)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diff = (start.getDay() - WEEK_STARTS_ON + 7) % 7
  start.setDate(start.getDate() - diff)
  return start
}

export function isWorkingDay(value) {
  return WORKING_DAYS.includes(toDate(value).getDay())
}

export function greetingFor(date) {
  const h = displayParts(date).hour
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const cairoDayKey = (value) => {
  const p = displayParts(value)
  return Date.UTC(p.year, p.month - 1, p.day) / 86400000
}

/**
 * When something happened, for lists and threads: "Just now" · "5 min ago" · "2 h ago" (today) ·
 * "Yesterday" · "Mon" (this past week) · "20 Oct" · "20 Oct 2025" (another year). Cairo calendar days.
 * Deadlines and event dates are not times: they stay dates (formatDate).
 */
export function formatWhen(value, now = new Date()) {
  if (!value) return '—'
  const at = toDate(value)
  const minutes = Math.floor((now - at) / 60000)
  if (minutes < 1) return 'Just now'
  const days = cairoDayKey(now) - cairoDayKey(at)
  if (days <= 0) return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`
  if (days === 1) return 'Yesterday'
  if (days < 7) return SHORT_WEEKDAYS[displayParts(at).weekday]
  const p = displayParts(at)
  return p.year === displayParts(now).year ? `${p.day} ${MONTHS[p.month - 1]}` : formatDate(at)
}

/** The full time for hover and tap: "Tuesday, 20 Oct 2026, 14:30 (Cairo)". */
export function formatWhenFull(value) {
  if (!value) return ''
  return `${formatLongDate(value)}, ${formatTime(value)} (Cairo)`
}
