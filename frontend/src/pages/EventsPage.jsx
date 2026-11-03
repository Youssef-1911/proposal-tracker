import { Link, useSearchParams } from 'react-router-dom'
import PageLayout from '../components/layout/PageLayout.jsx'
import Card from '../components/ui/Card.jsx'
import DataTable from '../components/ui/DataTable.jsx'
import SegmentedControl from '../components/ui/SegmentedControl.jsx'
import StatusPill from '../components/ui/StatusPill.jsx'
import { usePageDescription } from './PlaceholderPage.jsx'
import { useCurrentUser, useEvents, useLists } from '../data/hooks.js'
import { findNavItem } from '../navigation.js'
import Tabs from '../components/ui/Tabs.jsx'
import useTab from '../lib/useTab.js'
import { ROLE } from '../domain/roles.js'
import { BRANDS, getBrand } from '../domain/brands.js'
import {
  EVENT_PERIODS, EVENT_STATUS, calendarEvents, calendarMonth, EVENT_TIMING, OPS_DONE_LIMIT, PRELIMINARY, cairoTodayISO, eventPill, operationsSections,
  pipelineStage,
} from '../domain/events.js'
import { optionLabel } from '../domain/lists.js'
import { formatEventDate, formatNumber } from '../lib/format.js'
import { useState } from 'react'
import { PastRecordPanel, usePastRecordAllowed } from '../components/proposal/DataFixes.jsx'
import BrandTag, { brandEdge } from '../components/ui/BrandTag.jsx'
import { SkeletonList } from '../components/ui/Skeleton.jsx'
import { peekToken, usePeekLink } from '../lib/peek.js'

const EVENT_TABS = [
  { id: 'week', label: 'This week' },
  { id: 'confirmed', label: 'Upcoming' },
  { id: 'initial', label: 'Initially confirmed' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'done', label: 'Done' },
  { id: 'off', label: 'Postponed / Cancelled' },
  { id: 'pipeline', label: 'Coming up (proposals)' },
]
const TABS_FOR = {
  [ROLE.OPERATIONS]: ['week', 'confirmed', 'initial', 'calendar', 'done', 'off', 'pipeline'],
  [ROLE.HR]: ['confirmed', 'initial', 'calendar', 'done'], // HR: initially confirmed, confirmed and done only
}
const DEFAULT_TABS = ['week', 'confirmed', 'initial', 'calendar', 'done', 'off']

/**
 * Events: only what the client agreed to. Tabs (counts on each; in the URL): This week · Upcoming (confirmed) ·
 * Initially confirmed · Calendar · Done (the last 20, then View all) · Postponed / Cancelled; Operations also
 * "Coming up (proposals)" (awareness only: no price, files or conversation). Filters in one row: brand · period.
 */
export default function EventsPage() {
  const [params, setParams] = useSearchParams()
  const { activeRole } = useCurrentUser()
  const tabs = EVENT_TABS.filter((t) => (TABS_FOR[activeRole] ?? DEFAULT_TABS).includes(t.id))
  const [section, setSection] = useTab(tabs.map((t) => t.id))
  const { data, isLoading, error } = useEvents()
  const lists = useLists().data
  const nav = findNavItem('/events')
  const subtitle = usePageDescription(nav)
  const today = data?.today ?? cairoTodayISO()

  const brand = params.get('brand') ?? ''
  const period = EVENT_PERIODS.some((p) => p.id === params.get('period')) ? params.get('period') : 'all'
  const all = params.get('all') === '1'
  const update = (key, value, fallback) => {
    const next = new URLSearchParams(params)
    if (value && value !== fallback) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const [pastOpen, setPastOpen] = useState(() => params.get('past') === '1')
  const pastAllowed = usePastRecordAllowed()
  const sections = operationsSections(data?.items ?? [], data?.pipeline ?? [], { brand, period }, today)
  const fresh = new Set(data?.newIds ?? [])
  const rows = section === 'done' ? (all ? sections.doneAll : sections.done) : sections[section] ?? []
  const counts = { ...Object.fromEntries(tabs.map((t) => [t.id, sections[t.id]?.length])), done: sections.doneTotal, calendar: undefined }
  const label = tabs.find((t) => t.id === section)?.label ?? 'Events'

  return (
    <PageLayout title="Events" subtitle={subtitle}
      actions={pastAllowed ? <button type="button" className="btn" onClick={() => setPastOpen(true)}>+ Add past record</button> : null}>
      {pastOpen && <PastRecordPanel onClose={() => setPastOpen(false)} />}
      <Tabs label="Events" value={section} onChange={setSection}
        tabs={tabs.map((t) => ({ ...t, count: data ? counts[t.id] : undefined }))} />
      <div className="page-toolbar ops-toolbar">
        <label className="form-field">
          <span className="form-field__label">Brand</span>
          <select value={brand} onChange={(e) => update('brand', e.target.value, '')}>
            <option value="">Both brands</option>
            {BRANDS.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        {section !== 'calendar' && (
          <label className="form-field">
            <span className="form-field__label">Period</span>
            <select value={period} onChange={(e) => update('period', e.target.value, 'all')}>
              {EVENT_PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
        )}
      </div>
      {error && <p className="quiet-line" role="status">{error.message}</p>}
      {isLoading && !data && !error && <SkeletonList />}
      {data && section === 'calendar' && (
        <EventCalendar events={calendarEvents(data.items ?? [], { brand }, today)} today={today}
          mode={params.get('cal') === 'week' ? 'week' : 'month'} anchor={params.get('at') ?? today}
          onMode={(m) => update('cal', m, 'month')} onAnchor={(d) => update('at', d, today)} />
      )}
      {data && section !== 'calendar' && (
        <Card flush
          subtitle={section === 'initial' ? <span className="preliminary">{PRELIMINARY}</span> : undefined}
          actions={section === 'done' && sections.doneTotal > OPS_DONE_LIMIT ? (
            <button type="button" className="link-btn" onClick={() => update('all', all ? '' : '1', '')}>
              {all ? `Show the last ${OPS_DONE_LIMIT}` : `View all (${sections.doneTotal})`}
            </button>
          ) : null}>
          <DataTable caption={label} rows={rows} rowKey={(e) => e.request.id}
            rowHref={section === 'pipeline' ? undefined : (e) => `/events/${encodeURIComponent(e.request.id)}`}
            rowPeek={section === 'pipeline' ? undefined : (e) => peekToken('event', e.request.id)}
            rowBrand={(e) => e.request.brand}
            columns={columnsFor(section, { lists, fresh })} emptyMessage="Nothing here." />
        </Card>
      )}
    </PageLayout>
  )
}

const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v)

/** Six columns at most: date(s) with the status pill · client · event name · participants · brand · venue (stage, reason). */
function columnsFor(section, { lists, fresh }) {
  const date = {
    key: 'date', header: 'Date', nowrap: true,
    render: ({ request: r, timing, status }) => (
      <span className="stack">
        <span>{r.eventDate ? formatEventDate(r.eventDate, r.eventEndDate, r.eventDatePrecision) : '—'}</span>
        {section !== 'pipeline' && <StatusPill pill={eventPill(timing, status)} />}
      </span>
    ),
  }
  const last = section === 'pipeline'
    ? { key: 'stage', header: 'Stage', nowrap: true, render: ({ request: r }) => pipelineStage(r.status) }
    : section === 'off'
      ? {
        key: 'reason', header: 'Reason',
        render: ({ request: r, timing }) => {
          const why = timing === EVENT_TIMING.CANCELLED ? optionLabel(lists, 'eventCancelReasons', r.eventCancelReason)
            : optionLabel(lists, 'postponeWhy', r.eventPostponeReason)
          const note = timing === EVENT_TIMING.CANCELLED ? r.eventCancelNote : r.eventPostponeNote
          return dash([why, note].filter(Boolean).join(' — '))
        },
      }
      : { key: 'venue', header: 'Venue', render: ({ request: r }) => (r.venue ? <span className="cell-truncate" title={r.venue}>{r.venue}</span> : '—') }
  return [
    date,
    {
      key: 'client', header: 'Client',
      render: ({ request: r }) => (
        <span>{fresh.has(r.id) && <span className="new-dot" aria-label="New" />}{dash(r.clientName)}</span>
      ),
    },
    { key: 'event', header: 'Event name', render: ({ request: r }) => (r.eventName ? <span className="cell-truncate" title={r.eventName}>{r.eventName}</span> : '—') },
    { key: 'people', header: 'Participants', align: 'end', nowrap: true, render: ({ request: r }) => <span className="tabular">{r.participants ? formatNumber(r.participants) : '—'}</span> },
    { key: 'brand', header: 'Brand', nowrap: true, render: ({ request: r }) => <BrandTag brand={r.brand} /> },
    last,
  ]
}

// ---------------------------------------------------------------------------
// Calendar: month or week; confirmed solid, initially confirmed outlined; busy days (2+) marked
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const iso = (d) => d.toISOString().slice(0, 10)
const utc = (s) => new Date(`${s}T00:00:00Z`)
const plus = (s, n) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d) }

function EventCalendar({ events, today, mode, anchor, onMode, onAnchor }) {
  const a = /^\d{4}-\d{2}-\d{2}$/.test(anchor) ? anchor : today
  const peekLink = usePeekLink()
  // Every day shown (a week may span two months), plus the month-only events of the anchor's month.
  const { byDay, monthOnly } = calendarMonth(events, a.slice(0, 7))
  let days
  let title
  if (mode === 'week') {
    const start = plus(a, -utc(a).getUTCDay())
    days = Array.from({ length: 7 }, (_, i) => plus(start, i))
    title = `${formatEventDate(days[0], days[6])}`
  } else {
    const first = `${a.slice(0, 7)}-01`
    const start = plus(first, -utc(first).getUTCDay())
    const count = Math.ceil((utc(first).getUTCDay() + new Date(Date.UTC(+a.slice(0, 4), +a.slice(5, 7), 0)).getUTCDate()) / 7) * 7
    days = Array.from({ length: count }, (_, i) => plus(start, i))
    title = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utc(first))
  }
  const step = (dir) => {
    if (mode === 'week') return onAnchor(plus(a, dir * 7))
    const d = utc(`${a.slice(0, 7)}-01`)
    d.setUTCMonth(d.getUTCMonth() + dir)
    return onAnchor(iso(d))
  }
  return (
    <Card flush title={title} actions={(
      <div className="next-step__buttons">
        <SegmentedControl label="Calendar range" value={mode} onChange={onMode}
          options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }]} />
        <button type="button" className="btn btn--sm" onClick={() => step(-1)} aria-label="Previous">‹</button>
        <button type="button" className="btn btn--sm" onClick={() => onAnchor(today)}>Today</button>
        <button type="button" className="btn btn--sm" onClick={() => step(1)} aria-label="Next">›</button>
      </div>
    )}>
      {monthOnly.length > 0 && (
        <div className="cal__strip" aria-label="Date not set this month">
          <span className="cal__strip-label">Date not set this month</span>
          {monthOnly.map((e) => (
            <Link key={e.request.id} to={`/events/${encodeURIComponent(e.request.id)}`} onClick={peekLink(peekToken('event', e.request.id))}
              className={`cal__event ${brandEdge(e.request.brand)}${e.status === EVENT_STATUS.INITIAL ? ' cal__event--initial' : ''}`}>
              {e.request.clientName ?? e.request.id}
            </Link>
          ))}
        </div>
      )}
      {days.every((d) => !(byDay[d]?.length)) && monthOnly.length === 0 && (
        <p className="quiet-line card-pad" role="status">No events with dates in this {mode === 'week' ? 'week' : 'month'}.</p>
      )}
      <div className={`cal cal--${mode}`} role="grid" aria-label={title}>
        {WEEKDAYS.map((w) => <div key={w} className="cal__weekday" role="columnheader">{w}</div>)}
        {days.map((d) => {
          const list = byDay[d] ?? []
          const outside = mode === 'month' && d.slice(0, 7) !== a.slice(0, 7)
          return (
            <div key={d} role="gridcell" className={['cal__day', outside && 'cal__day--outside', d === today && 'cal__day--today',
              list.length >= 2 && 'cal__day--busy'].filter(Boolean).join(' ')}>
              <span className="cal__date">
                {Number(d.slice(8))}
                {list.length >= 2 && <span className="cal__busy" title={`${list.length} events`}>{list.length}</span>}
              </span>
              {list.slice(0, mode === 'week' ? 8 : 3).map((e) => (
                <Link key={e.request.id} to={`/events/${encodeURIComponent(e.request.id)}`} onClick={peekLink(peekToken('event', e.request.id))}
                  className={`cal__event ${brandEdge(e.request.brand)}${e.status === EVENT_STATUS.INITIAL ? ' cal__event--initial' : ''}`}
                  title={[e.request.clientName, e.request.eventName, getBrand(e.request.brand)?.name,
                    e.status === EVENT_STATUS.INITIAL ? PRELIMINARY : null].filter(Boolean).join(' · ')}>
                  {e.request.clientName ?? e.request.id}
                </Link>
              ))}
              {list.length > (mode === 'week' ? 8 : 3) && <span className="cal__more">+{list.length - (mode === 'week' ? 8 : 3)} more</span>}
            </div>
          )
        })}
      </div>
      <p className="quiet-line card-pad">
        <span className="cal__event cal__key">Confirmed</span> <span className="cal__event cal__event--initial cal__key">Initially confirmed</span>
      </p>
    </Card>
  )
}
