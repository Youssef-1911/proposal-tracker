/**
 * The dropdown lists, in one place. Values are stored as CODES; labels are what people see.
 * People with "Manage accounts" edit them in Settings: add, rename, hide (never delete, so a code
 * that was used keeps its label). The backend (app/domain/lists.py) has the same defaults and
 * rules, checked by the contract file.
 *
 * lists = { listId: [{ code, label, hidden }] } — the defaults with Settings' changes applied.
 */

const o = (code, label) => ({ code, label, hidden: false })

export const LIST_DEFS = [
  { id: 'whatsMissing', label: "What's missing (Awaiting BD information)", multi: true },
  { id: 'whatShouldChange', label: 'What should change (Revision requested)', multi: true },
  { id: 'postponeWhy', label: 'Why postponed', multi: false },
  { id: 'cities', label: 'Client city', multi: false },
  { id: 'briefTags', label: 'Brief quick tags', multi: true },
  { id: 'waitingClient', label: 'Waiting on the client: reasons', multi: false },
  { id: 'waitingMarketing', label: 'Waiting on Marketing: reasons', multi: false },
  { id: 'waitingOperations', label: 'Waiting on Operations: reasons', multi: false },
  { id: 'waitingInternal', label: 'Waiting on BD, AM or management: reasons', multi: false },
  { id: 'questionAbout', label: 'Questions: about', multi: false },
  { id: 'eventCancelReasons', label: 'Event cancelled: why', multi: false },
  { id: 'facilitatorSkills', label: 'Facilitators: skills', multi: true },
]
export const LIST_IDS = LIST_DEFS.map((d) => d.id)
export const OTHER = 'other'
export const LIST_MAX_VISIBLE = 12
export const LIST_LABEL_MAX = 60

export const DEFAULT_LISTS = {
  whatsMissing: [o('budget', 'Budget'), o('participants', 'Participants'), o('event_date', 'Event date'), o('venue', 'Venue'),
    o('transport', 'Transport'), o('catering', 'Catering'), o('activities', 'Activities'), o(OTHER, 'Other')],
  whatShouldChange: [o('price', 'Price'), o('activities', 'Activities'), o('date', 'Date'), o('participants', 'Participants'),
    o('venue', 'Venue'), o('transport', 'Transport'), o('design', 'Design'), o(OTHER, 'Other')],
  postponeWhy: [o('budget_not_approved', 'Budget not approved'), o('date_not_confirmed', 'Date not confirmed'),
    o('internal_changes', "Client's internal changes"), o('seasonal', 'Seasonal / Ramadan'), o(OTHER, 'Other')],
  cities: [o('cairo', 'Cairo'), o('giza', 'Giza'), o('new_cairo', 'New Cairo'), o('sheikh_zayed', 'Sheikh Zayed / 6th of October'),
    o('alexandria', 'Alexandria'), o('north_coast', 'North Coast'), o('ain_sokhna', 'Ain Sokhna'), o('hurghada', 'Hurghada / El Gouna'),
    o('sharm', 'Sharm El Sheikh'), o(OTHER, 'Other')],
  briefTags: [o('transport', 'Transport'), o('catering', 'Catering'), o('venue', 'Venue'), o('overnight', 'Overnight'),
    o('outdoor', 'Outdoor'), o('indoor', 'Indoor')],
  waitingClient: [o('awaiting_reply', 'Awaiting reply'), o('budget_approval', 'Budget approval'), o('final_numbers', 'Final numbers'),
    o('event_date', 'Event date'), o(OTHER, 'Other')],
  waitingMarketing: [o('design', 'Design / creative'), o('presentation', 'Presentation formatting'), o(OTHER, 'Other')],
  waitingOperations: [o('venue_availability', 'Venue availability'), o('supplier_prices', 'Supplier prices'),
    o('transport', 'Transport'), o('staff', 'Staff'), o(OTHER, 'Other')],
  waitingInternal: [o('information_missing', 'Information missing'), o('approval_needed', 'Approval needed'), o(OTHER, 'Other')],
  questionAbout: [o('price', 'Price'), o('activities', 'Activities'), o('date', 'Date'), o('participants', 'Participants'),
    o('venue', 'Venue'), o('transport', 'Transport'), o('design', 'Design'), o(OTHER, 'Other')],
  eventCancelReasons: [o('client_cancelled', 'Client cancelled'), o('budget', 'Budget'), o('date_clash', 'Date clash'), o(OTHER, 'Other')],
  facilitatorSkills: [o('games', 'Games'), o('sports', 'Sports'), o('kids', 'Kids'), o('team_building', 'Team building'),
    o('mc', 'MC'), o('first_aid', 'First aid')],
}

/**
 * The defaults with Settings' changes applied. rows: [{ listId, code, label, hidden, position }] —
 * a row for a default code renames or hides it; a row for a new code adds it (before "Other").
 */
export function effectiveLists(rows = []) {
  const out = Object.fromEntries(LIST_IDS.map((id) => [id, DEFAULT_LISTS[id].map((x) => ({ ...x }))]))
  const sorted = [...rows].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.code).localeCompare(String(b.code)))
  for (const r of sorted) {
    const list = out[r.listId]
    if (!list) continue
    const found = list.find((x) => x.code === r.code)
    if (found) {
      found.label = r.label
      found.hidden = Boolean(r.hidden)
    } else {
      const other = list.findIndex((x) => x.code === OTHER)
      list.splice(other === -1 ? list.length : other, 0, { code: r.code, label: r.label, hidden: Boolean(r.hidden) })
    }
  }
  return out
}

export const visibleOptions = (lists, listId) => (lists?.[listId] ?? DEFAULT_LISTS[listId] ?? []).filter((x) => !x.hidden)

/** A stored code's label (hidden or not); an unknown code shows as itself. */
export function optionLabel(lists, listId, code) {
  if (code === null || code === undefined || code === '') return null
  return (lists?.[listId] ?? DEFAULT_LISTS[listId] ?? []).find((x) => x.code === code)?.label ?? String(code)
}

/** Codes chosen in a form: each must be a visible option; multi lists take several. -> error text | null */
export function checkCodes(lists, listId, codes, { multi = true } = {}) {
  if (!Array.isArray(codes)) return 'Choose from the list.'
  const valid = new Set(visibleOptions(lists, listId).map((x) => x.code))
  if (codes.some((c) => !valid.has(c)) || new Set(codes).size !== codes.length) return 'Choose from the list.'
  if (!multi && codes.length > 1) return 'Choose one.'
  return null
}

const codeFrom = (label) => label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)

/**
 * A change in Settings. input = { action: 'add' | 'rename' | 'hide' | 'show', code, label }.
 * -> { errors, row } where row = { listId, code, label, hidden } to store. Nothing is ever deleted.
 */
export function validateListChange(lists, listId, input = {}) {
  const list = lists?.[listId]
  if (!list) return { errors: { listId: 'Unknown list.' }, row: null }
  const label = typeof input.label === 'string' ? input.label.trim().replace(/\s+/g, ' ') : ''
  const existing = list.find((x) => x.code === input.code)
  const sameLabel = (x) => x.label.toLowerCase() === label.toLowerCase()
  if (input.action === 'add') {
    if (!label) return { errors: { label: 'Enter the option.' }, row: null }
    if (label.length > LIST_LABEL_MAX) return { errors: { label: `Use at most ${LIST_LABEL_MAX} characters.` }, row: null }
    const code = codeFrom(label)
    if (!code) return { errors: { label: 'Use letters or numbers.' }, row: null }
    if (list.some((x) => x.code === code || sameLabel(x))) return { errors: { label: 'This option already exists.' }, row: null }
    if (list.filter((x) => !x.hidden).length >= LIST_MAX_VISIBLE) {
      return { errors: { label: `Keep at most ${LIST_MAX_VISIBLE} options; hide one first.` }, row: null }
    }
    return { errors: {}, row: { listId, code, label, hidden: false } }
  }
  if (!existing) return { errors: { code: 'Choose an option from the list.' }, row: null }
  if (input.action === 'rename') {
    if (!label) return { errors: { label: 'Enter the new name.' }, row: null }
    if (label.length > LIST_LABEL_MAX) return { errors: { label: `Use at most ${LIST_LABEL_MAX} characters.` }, row: null }
    if (list.some((x) => x.code !== existing.code && sameLabel(x))) return { errors: { label: 'Another option has this name.' }, row: null }
    return { errors: {}, row: { listId, code: existing.code, label, hidden: existing.hidden } }
  }
  if (input.action === 'hide' || input.action === 'show') {
    const hidden = input.action === 'hide'
    if (hidden && existing.code === OTHER) return { errors: { code: '"Other" always stays available.' }, row: null }
    if (!hidden && list.filter((x) => !x.hidden).length >= LIST_MAX_VISIBLE) {
      return { errors: { code: `Keep at most ${LIST_MAX_VISIBLE} options; hide one first.` }, row: null }
    }
    return { errors: {}, row: { listId, code: existing.code, label: existing.label, hidden } }
  }
  return { errors: { action: 'Choose add, rename, hide or show.' }, row: null }
}
