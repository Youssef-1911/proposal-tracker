import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import PageLayout from '../components/layout/PageLayout.jsx'
import Card from '../components/ui/Card.jsx'
import { SkeletonRequest } from '../components/ui/Skeleton.jsx'
import DataTable from '../components/ui/DataTable.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import MoreMenu from '../components/ui/MoreMenu.jsx'
import { useFacilitator, useLists } from '../data/hooks.js'
import { getBrand } from '../domain/brands.js'
import { optionLabel } from '../domain/lists.js'
import { formatEventDate, formatShortDate } from '../lib/format.js'
import RelTime from '../components/ui/RelTime.jsx'
import { stars } from './FacilitatorsPage.jsx'
import { EditFacilitatorPanel } from '../components/staffing/Staffing.jsx'

/**
 * One facilitator: details, then on one page (nothing collapsed): upcoming assignments · events history ·
 * feedback · rating over time (3+ ratings) · notes (HR only, with their history). HR and Noha can edit,
 * mark inactive / active and add notes.
 */
export default function FacilitatorPage() {
  const { id } = useParams()
  const f = useFacilitator(id)
  const lists = useLists().data
  const [note, setNote] = useState('')
  const [message, setMessage] = useState(null)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const p = f.data
  if (f.error) {
    return <PageLayout title="Facilitator"><Card><EmptyState icon="lock" title="Not available">{f.error.message}</EmptyState></Card></PageLayout>
  }
  if (!p) return <PageLayout title="Facilitator"><SkeletonRequest /></PageLayout>
  const copy = async () => {
    try { await navigator.clipboard.writeText(p.phone); setCopied(true) } catch { setCopied(false) }
  }
  const toggle = async () => {
    const result = await f.update({ status: p.status === 'active' ? 'inactive' : 'active' })
    setMessage(result.ok ? result.message : result.error)
  }
  const addNote = async (e) => {
    e.preventDefault()
    const result = await f.addNote(note)
    setMessage(result.ok ? result.message : Object.values(result.errors ?? {})[0] ?? result.error)
    if (result.ok) setNote('')
  }
  const rated = (p.history ?? []).filter((h) => h.ratings?.some((r) => r.attended && r.stars))
  const reliability = p.assignedDone ? `attended ${p.eventsAttended} of ${p.assignedDone} assigned` : 'no events yet'
  const eventCols = [
    { key: 'date', header: 'Date', nowrap: true, render: (e) => (e.eventDate ? formatEventDate(e.eventDate, e.eventEndDate) : '—') },
    { key: 'client', header: 'Client', render: (e) => e.clientName ?? '—' },
    { key: 'event', header: 'Event', render: (e) => e.eventName ?? '—' },
    { key: 'brand', header: 'Brand', nowrap: true, render: (e) => getBrand(e.brand)?.name ?? '—' },
  ]
  return (
    <PageLayout title={p.name}
      subtitle={[p.status === 'active' ? 'Active' : 'Inactive', p.brands.map((b) => getBrand(b)?.name).join(' · ')].filter(Boolean).join(' · ')}
      actions={p.canManage ? <MoreMenu items={[{ label: 'Edit details', onSelect: () => setEditing(true) },
        { label: p.status === 'active' ? 'Mark inactive' : 'Mark active', onSelect: toggle }]} /> : null}>
      {editing && <EditFacilitatorPanel facilitator={p} update={f.update} onClose={() => setEditing(false)} />}
      <nav className="breadcrumb" aria-label="Breadcrumb"><Link to="/facilitators">Facilitators</Link><span aria-hidden="true">/</span><span aria-current="page">{p.name}</span></nav>
      {message && <p className="muted" role="status">{message}</p>}
      <Card>
        <dl className="field-list">
          <div className="field"><dt>Phone</dt><dd>{p.phone} <button type="button" className="link-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></dd></div>
          <div className="field"><dt>Skills</dt><dd>{p.skills.length ? p.skills.map((s) => optionLabel(lists, 'facilitatorSkills', s)).join(', ') : '—'}</dd></div>
          <div className="field"><dt>Events attended</dt><dd className="tabular">{p.eventsAttended}</dd></div>
          {'average' in p && <div className="field"><dt>Rating</dt><dd>{stars(p)}</dd></div>}
          <div className="field"><dt>First · last event</dt><dd>{p.firstEvent ? formatShortDate(p.firstEvent) : '—'} · {p.lastEvent ? formatShortDate(p.lastEvent) : '—'}</dd></div>
          <div className="field"><dt>Reliability</dt><dd>{reliability}</dd></div>
          {p.reference && <div className="field"><dt>Reference</dt><dd>{p.reference}</dd></div>}
        </dl>
      </Card>
      <Card flush title={`Upcoming assignments (${p.upcoming.length})`}>
        <DataTable caption="Upcoming" rows={p.upcoming} rowKey={(e) => e.requestId} rowHref={(e) => `/events/${encodeURIComponent(e.requestId)}`}
          columns={eventCols} emptyMessage="Nothing booked." />
      </Card>
      <Card flush title={`Events history (${p.history.length})`}>
        <DataTable caption="Events history" rows={p.history} rowKey={(e) => e.requestId} rowHref={(e) => `/events/${encodeURIComponent(e.requestId)}`}
          emptyMessage="No events yet."
          columns={[...eventCols, ...('average' in p ? [{
            key: 'rating', header: 'Rating · attended · by',
            render: (e) => (e.ratings?.length ? e.ratings.map((r) => `${r.attended ? `★${r.stars}` : 'did not attend'} · ${r.rater}`).join('; ') : '—'),
          }] : [])]} />
      </Card>
      {p.feedback && (
        <Card title="Feedback">
          {p.feedback.length === 0 ? <p className="muted">No written feedback yet.</p> : (
            <ul className="short-list">
              {p.feedback.map((fb, i) => (
                <li key={i}><span className="stack"><span>&ldquo;{fb.feedback}&rdquo;</span>
                  <span className="muted">★{fb.stars ?? '—'} · {fb.eventName ?? fb.requestId} · {fb.rater} · <RelTime value={fb.at} /></span></span></li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {rated.length >= 3 && (
        <Card title="Rating over time">
          <div className="mini-bars" role="img" aria-label={rated.map((e) => `${e.eventName ?? e.requestId}: ${avg(e.ratings)}`).join('; ')}>
            {[...rated].reverse().map((e) => (
              <div key={e.requestId} className="mini-bars__month" title={`${e.eventName ?? e.requestId}: ★${avg(e.ratings)}`}>
                <div className="mini-bars__pair"><span className="mini-bars__bar mini-bars__bar--won" style={{ height: `${(avg(e.ratings) / 5) * 100}%` }} /></div>
                <span className="mini-bars__label">{e.eventDate ? formatShortDate(e.eventDate) : '—'}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      {p.notes && (
        <Card title="Notes" subtitle="HR only · every note is kept">
          {p.canManage && (
            <form className="inline-form" onSubmit={addNote}>
              <textarea rows={2} aria-label="Add a note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
              <button type="submit" className="btn btn--sm">Add note</button>
            </form>
          )}
          {p.notes.length === 0 ? <p className="muted">No notes.</p> : (
            <ul className="short-list">{p.notes.map((n, i) => <li key={i}><span>{n.body}</span><span className="muted">{n.author} · <RelTime value={n.at} /></span></li>)}</ul>
          )}
        </Card>
      )}
    </PageLayout>
  )
}

const avg = (ratings) => {
  const s = ratings.filter((r) => r.attended && r.stars)
  return s.length ? Math.round((s.reduce((t, r) => t + r.stars, 0) / s.length) * 10) / 10 : 0
}
