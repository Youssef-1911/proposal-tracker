import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import PageLayout from '../components/layout/PageLayout.jsx'
import Card from '../components/ui/Card.jsx'
import DataTable from '../components/ui/DataTable.jsx'
import { usePageDescription } from './PlaceholderPage.jsx'
import { useFacilitators, useListActions, useLists } from '../data/hooks.js'
import { findNavItem } from '../navigation.js'
import { BRANDS } from '../domain/brands.js'
import { optionLabel, visibleOptions } from '../domain/lists.js'
import { formatShortDate } from '../lib/format.js'
import { AddFacilitatorPanel } from '../components/staffing/Staffing.jsx'

const SORTS = [
  { id: 'attended', label: 'Most attended' },
  { id: 'rated', label: 'Best rated' },
  { id: 'recent', label: 'Recent' },
]

/** "★ 4.5 from 6 ratings" (or "No ratings yet"). */
export const stars = (f) => (f.average === null || f.average === undefined ? 'No ratings yet'
  : `★ ${f.average.toFixed(1)} from ${f.ratingCount} rating${f.ratingCount === 1 ? '' : 's'}`)

/**
 * Facilitators (HR): everyone we book for events. They never log in; archived, never deleted.
 * Sort by most attended (default), best rated, or recent; search by name or skill; filters in one row.
 */
export default function FacilitatorsPage() {
  const subtitle = usePageDescription(findNavItem('/facilitators'))
  const { data, error } = useFacilitators()
  const lists = useLists().data
  const [sort, setSort] = useState('attended')
  const [q, setQ] = useState('')
  const [brand, setBrand] = useState('')
  const [skill, setSkill] = useState('')
  const [status, setStatus] = useState('active')
  const [good, setGood] = useState(false)
  const [regular, setRegular] = useState(false)
  const [params] = useSearchParams()
  const [adding, setAdding] = useState(() => params.get('add') === '1') // Ctrl+K "Add facilitator"
  const items = data?.items ?? []
  const skillLabel = (c) => optionLabel(lists, 'facilitatorSkills', c)
  const needle = q.trim().toLowerCase()
  const rows = items
    .filter((f) => !needle || f.name.toLowerCase().includes(needle) || f.skills.some((s) => skillLabel(s).toLowerCase().includes(needle)))
    .filter((f) => (!brand || f.brands.includes(brand)) && (!skill || f.skills.includes(skill)) && (!status || f.status === status))
    .filter((f) => (!good || (f.average ?? 0) >= 4) && (!regular || f.eventsAttended >= 5))
    .sort((a, b) => (sort === 'rated' ? (b.average ?? 0) - (a.average ?? 0)
      : sort === 'recent' ? String(b.lastEvent ?? '').localeCompare(String(a.lastEvent ?? '')) : b.eventsAttended - a.eventsAttended)
      || a.name.localeCompare(b.name))

  return (
    <PageLayout title="Facilitators" subtitle={subtitle}
      actions={data?.canManage ? <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>+ Add facilitator</button> : null}>
      <div className="page-toolbar">
        <label className="form-field"><span className="form-field__label">Search</span>
          <input type="search" placeholder="Name or skill" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <label className="form-field"><span className="form-field__label">Brand</span>
          <select value={brand} onChange={(e) => setBrand(e.target.value)}><option value="">Both</option>
            {BRANDS.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label className="form-field"><span className="form-field__label">Skill</span>
          <select value={skill} onChange={(e) => setSkill(e.target.value)}><option value="">Any</option>
            {visibleOptions(lists, 'facilitatorSkills').map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}</select></label>
        <label className="form-field"><span className="form-field__label">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any</option>
            <option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        <label className="form-field"><span className="form-field__label">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>{SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        {data?.seeRatings && <label className="form-check"><input type="checkbox" checked={good} onChange={(e) => setGood(e.target.checked)} /><span>4★ and up</span></label>}
        <label className="form-check"><input type="checkbox" checked={regular} onChange={(e) => setRegular(e.target.checked)} /><span>5+ events</span></label>
      </div>
      {error && <p className="form-error" role="alert">{error.message}</p>}
      <Card flush>
        <DataTable caption="Facilitators" rows={rows} rowKey={(f) => f.id} rowHref={(f) => `/facilitators/${f.id}`}
          emptyMessage={items.length ? 'No one matches.' : 'No facilitators yet.'}
          columns={[
            { key: 'name', header: 'Name', render: (f) => <Link to={`/facilitators/${f.id}`}>{f.name}</Link> },
            { key: 'events', header: 'Events attended', align: 'end', render: (f) => <span className="tabular">{f.eventsAttended}</span> },
            ...(data?.seeRatings ? [{ key: 'rating', header: 'Rating', nowrap: true, render: (f) => stars(f) }] : []),
            { key: 'last', header: 'Last event', nowrap: true, render: (f) => (f.lastEvent ? formatShortDate(f.lastEvent) : '—') },
            { key: 'skills', header: 'Skills', render: (f) => (f.skills.length ? f.skills.map(skillLabel).join(', ') : '—') },
            { key: 'status', header: 'Status', nowrap: true, render: (f) => (f.status === 'active' ? 'Active' : <span className="muted">Inactive</span>) },
          ]} />
      </Card>
      {data?.canManage && <Skills />}
      {adding && <AddFacilitatorPanel onClose={() => setAdding(false)} />}
    </PageLayout>
  )
}

/** The skills list (HR and Noha): add a skill; names are kept for every facilitator who has one. */
function Skills() {
  const lists = useLists().data
  const { change } = useListActions()
  const [label, setLabel] = useState('')
  const [message, setMessage] = useState(null)
  const add = async (e) => {
    e.preventDefault()
    const result = await change('facilitatorSkills', { action: 'add', label })
    setMessage(result.ok ? 'Skill added.' : Object.values(result.errors ?? {})[0] ?? result.error)
    if (result.ok) setLabel('')
  }
  return (
    <Card title="Skills" subtitle={visibleOptions(lists, 'facilitatorSkills').map((o) => o.label).join(' · ')}>
      <form className="inline-form" onSubmit={add}>
        <input aria-label="New skill" placeholder="New skill" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit" className="btn btn--sm">Add skill</button>
        {message && <span className="muted" role="status">{message}</span>}
      </form>
    </Card>
  )
}
