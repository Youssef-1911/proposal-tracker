import { useState } from 'react'
import { Link } from 'react-router-dom'
import Card from '../ui/Card.jsx'
import SidePanel from '../ui/SidePanel.jsx'
import { Field, FormAlert, PanelButtons, usePanelForm } from '../crm/formParts.jsx'
import { useEventStaffing, useFacilitators, useLists } from '../../data/hooks.js'
import { BRANDS } from '../../domain/brands.js'
import { visibleOptions } from '../../domain/lists.js'
import { possibleDuplicates, validateRating } from '../../domain/staffing.js'

const rating = (f) => (f.average === null || f.average === undefined ? 'no ratings yet'
  : `★ ${f.average.toFixed(1)} from ${f.ratingCount}`)

/** Name, phone (required), reference, skills, brands, notes: the short form, alone or while assigning. */
function FacilitatorFields({ form, prefix }) {
  const lists = useLists().data
  const { values, set, errors, fieldProps } = form
  const toggle = (key, code) => set(key)(values[key].includes(code) ? values[key].filter((c) => c !== code) : [...values[key], code])
  return (
    <>
      <Field id={`${prefix}-name`} label="Name" required error={errors.name}>
        <input maxLength={120} {...fieldProps(`${prefix}-name`, 'name')} value={values.name} onChange={set('name')} />
      </Field>
      <Field id={`${prefix}-phone`} label="Phone" required error={errors.phone}>
        <input inputMode="tel" maxLength={40} {...fieldProps(`${prefix}-phone`, 'phone')} value={values.phone} onChange={set('phone')} />
      </Field>
      <Field id={`${prefix}-ref`} label="National ID or other reference (optional)">
        <input maxLength={60} value={values.reference} onChange={set('reference')} />
      </Field>
      <fieldset className="form-field reason-picker"><legend className="form-field__label">Skills</legend>
        <div className="reason-picker__options">
          {visibleOptions(lists, 'facilitatorSkills').map((o) => (
            <label key={o.code} className={`chip-toggle${values.skills.includes(o.code) ? ' is-on' : ''}`}>
              <input type="checkbox" checked={values.skills.includes(o.code)} onChange={() => toggle('skills', o.code)} />{o.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="form-field reason-picker"><legend className="form-field__label">Brands</legend>
        <div className="reason-picker__options">
          {BRANDS.map((b) => (
            <label key={b.id} className={`chip-toggle${values.brands.includes(b.id) ? ' is-on' : ''}`}>
              <input type="checkbox" checked={values.brands.includes(b.id)} onChange={() => toggle('brands', b.id)} />{b.name}
            </label>
          ))}
        </div>
      </fieldset>
      <Field id={`${prefix}-notes`} label="Notes (optional)"><textarea rows={2} maxLength={2000} value={values.notes} onChange={set('notes')} /></Field>
    </>
  )
}

const EMPTY = { name: '', phone: '', reference: '', skills: [], brands: [], notes: '', confirmDuplicate: false }

/** "+ Add facilitator" from the list. A possible duplicate (same phone, same name) asks before saving. */
export function AddFacilitatorPanel({ onClose }) {
  const { create } = useFacilitators()
  const form = usePanelForm(EMPTY)
  const { values, set, failure, busy, submit } = form
  const dup = failure?.code === 'possible_duplicate'
  const onSubmit = (e) => {
    e.preventDefault()
    const local = {}
    if (!values.name.trim()) local.name = 'Enter the name.'
    if (!values.phone.trim()) local.phone = 'Enter the phone number.'
    submit(local, () => create(values), () => onClose())
  }
  return (
    <SidePanel open title="Add facilitator" onClose={onClose} busy={busy}
      footer={<PanelButtons formId="add-fac" busy={busy} onCancel={onClose} submitLabel={dup ? 'Add anyway' : 'Add'} />}>
      <form id="add-fac" className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={failure} />
        {dup && <label className="form-check"><input type="checkbox" checked={values.confirmDuplicate} onChange={set('confirmDuplicate')} /><span>It is a different person</span></label>}
        <FacilitatorFields form={form} prefix="af" />
      </form>
    </SidePanel>
  )
}

/**
 * "Assign facilitators" on an event (HR, Noha): type a name; matching facilitators show with their rating and
 * events attended (and whether they are booked that day). None matching: "+ Add '<name>' as a new facilitator"
 * (saved permanently and assigned in one step). A same-day booking is a warning, never a block.
 */
function AssignPanel({ event, onClose, onDone }) {
  const list = useFacilitators()
  const staffing = useEventStaffing(event)
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [note, setNote] = useState(null)
  const form = usePanelForm({ ...EMPTY })
  const { values, failure, busy, submit } = form
  const taken = new Set((event.staffing?.facilitators ?? []).map((f) => f.id))
  const all = (list.data?.items ?? []).filter((f) => f.status === 'active' && !taken.has(f.id))
  const needle = q.trim().toLowerCase()
  const matches = needle ? all.filter((f) => f.name.toLowerCase().includes(needle)) : all.slice(0, 8)
  const dupIds = adding ? possibleDuplicates(values, list.data?.items ?? []) : []
  const dupes = (list.data?.items ?? []).filter((f) => dupIds.includes(f.id))
  const pick = async (f) => {
    const result = await staffing.assign(f.id)
    setNote(result.ok ? [result.message, ...(result.warnings ?? []).map((w) => w.message)].join(' ') : result.error)
    if (result.ok) onDone()
  }
  const startAdd = () => { form.set('name')(q.trim()); setAdding(true) }
  const onSubmit = (e) => {
    e.preventDefault()
    const local = {}
    if (!values.name.trim()) local.name = 'Enter the name.'
    if (!values.phone.trim()) local.phone = 'Enter the phone number.'
    submit(local, () => staffing.addAndAssign({ ...values, confirmDuplicate: values.confirmDuplicate || dupes.length > 0 && values.confirmDuplicate }),
      (result) => { setNote([result.message, ...(result.warnings ?? []).map((w) => w.message)].join(' ')); setAdding(false); onDone() })
  }
  return (
    <SidePanel open title="Assign facilitators" subtitle={`${event.clientName ?? event.id} · ${event.staffing?.missing ?? 0} missing`} onClose={onClose} busy={busy}
      footer={adding ? <PanelButtons formId="assign-new" busy={busy} onCancel={() => setAdding(false)} submitLabel="Add and assign" /> : null}>
      {note && <p className="muted" role="status">{note}</p>}
      {!adding ? (
        <>
          <input type="search" aria-label="Find a facilitator" placeholder="Type a name" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="short-list short-list--actions">
            {matches.map((f) => (
              <li key={f.id}>
                <span className="stack"><Link to={`/facilitators/${f.id}`}>{f.name}</Link>
                  <span className="muted">{f.eventsAttended} events · {rating(f)}</span></span>
                <button type="button" className="btn btn--sm" onClick={() => pick(f)}>Assign</button>
              </li>
            ))}
          </ul>
          {needle && !all.some((f) => f.name.toLowerCase() === needle) && (
            <button type="button" className="btn" onClick={startAdd}>+ Add &lsquo;{q.trim()}&rsquo; as a new facilitator</button>
          )}
        </>
      ) : (
        <form id="assign-new" className="stack-form" onSubmit={onSubmit} noValidate>
          <FormAlert failure={failure} />
          {dupes.map((f) => (
            <p key={f.id} className="details-banner">
              {f.name} — already in the list, {f.eventsAttended} events{f.average ? `, ★${f.average.toFixed(1)}` : ''}.{' '}
              <button type="button" className="link-btn" onClick={() => { setAdding(false); pick(f) }}>Use this person</button>
            </p>
          ))}
          {(dupes.length > 0 || failure?.code === 'possible_duplicate') && (
            <label className="form-check"><input type="checkbox" checked={values.confirmDuplicate} onChange={form.set('confirmDuplicate')} /><span>It is a different person</span></label>
          )}
          <FacilitatorFields form={form} prefix="an" />
        </form>
      )}
    </SidePanel>
  )
}

/** Rate one facilitator on a done event: stars, attended yes / no, feedback (editable for 7 days). */
function RatePanel({ event, facilitator, onClose, onDone }) {
  const staffing = useEventStaffing(event)
  const form = usePanelForm({ attended: '', stars: '', feedback: '' })
  const { values, set, errors, failure, busy, submit } = form
  const onSubmit = (e) => {
    e.preventDefault()
    const input = { ...values, attended: values.attended === '' ? null : values.attended === 'yes' }
    submit(validateRating(input).errors, () => staffing.rate(facilitator.id, input), () => { onDone(); onClose() })
  }
  return (
    <SidePanel open title={`Rate ${facilitator.name}`} subtitle={event.clientName ?? event.id} onClose={onClose} busy={busy}
      footer={<PanelButtons formId="rate-fac" busy={busy} onCancel={onClose} submitLabel="Save rating" />}>
      <form id="rate-fac" className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={failure} />
        <Field id="rf-att" label="Attended" required error={errors.attended}>
          <select value={values.attended} onChange={set('attended')}><option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option></select>
        </Field>
        {values.attended === 'yes' && (
          <Field id="rf-stars" label="Stars" required error={errors.stars}>
            <select value={values.stars} onChange={set('stars')}><option value="">Choose…</option>
              {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{'★'.repeat(n)} ({n})</option>)}</select>
          </Field>
        )}
        <Field id="rf-fb" label="Feedback (optional)" error={errors.feedback}>
          <textarea rows={3} maxLength={1000} value={values.feedback} onChange={set('feedback')} />
        </Field>
      </form>
    </SidePanel>
  )
}

/**
 * The event page's staffing: "N needed · M assigned · K missing", the suggestion from the ratio (labelled, not
 * saved until confirmed), the assigned list (Operations and Noha see it too), assigning (HR, Noha) and rating.
 */
export function EventStaffingCard({ event, onChanged }) {
  const st = event.staffing
  const staffing = useEventStaffing(event)
  const [panel, setPanel] = useState(null) // 'assign' | { rate: facilitator }
  const [value, setValue] = useState(st?.needed ?? '')
  const [note, setNote] = useState(null)
  if (!st) return null
  const save = async (v) => {
    const result = await staffing.setNeeded(v === '' ? null : Number(v))
    setNote(result.ok ? 'Saved. HR is told.' : Object.values(result.errors ?? {})[0] ?? result.error)
    if (result.ok) onChanged?.()
  }
  return (
    <Card id="staffing" title="Facilitators" subtitle={st.needed === null ? 'Number needed not set yet'
      : `${st.needed} needed · ${st.assigned} assigned · ${st.missing} missing`}
      actions={st.canAssign ? <button type="button" className="btn btn--sm" onClick={() => setPanel('assign')}>Assign facilitators</button> : null}>
      {st.canSetNeeded && (
        <div className="inline-form">
          <label htmlFor="fac-needed">Facilitators needed</label>
          <input id="fac-needed" inputMode="numeric" size={4} value={value} onChange={(e) => setValue(e.target.value)} />
          <button type="button" className="btn btn--sm" onClick={() => save(value)}>Save</button>
          {st.needed === null && st.suggestion && (
            <span className="muted">Suggestion from the ratio: {st.suggestion}{' '}
              <button type="button" className="link-btn" onClick={() => { setValue(String(st.suggestion)); save(String(st.suggestion)) }}>Use it</button></span>
          )}
          {note && <span className="muted" role="status">{note}</span>}
        </div>
      )}
      {st.facilitators.length === 0 ? <p className="muted">No one assigned yet.</p> : (
        <ul className="short-list short-list--actions">
          {st.facilitators.map((f) => (
            <li key={f.id}>
              <span className="stack"><Link to={`/facilitators/${f.id}`}>{f.name}</Link>
                {f.ratings?.length > 0 && <span className="muted">{f.ratings.map((r) => `${r.attended ? `★${r.stars}` : 'did not attend'} (${r.rater})`).join(' · ')}</span>}</span>
              <span className="next-step__buttons">
                {st.canRate && <button type="button" className="btn btn--sm" onClick={() => setPanel({ rate: f })}>Rate</button>}
                {st.canAssign && <button type="button" className="link-btn" onClick={async () => { await staffing.remove(f.id); onChanged?.() }}>Remove</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {panel === 'assign' && <AssignPanel event={event} onClose={() => setPanel(null)} onDone={() => onChanged?.()} />}
      {panel?.rate && <RatePanel event={event} facilitator={panel.rate} onClose={() => setPanel(null)} onDone={() => onChanged?.()} />}
    </Card>
  )
}

/** "Edit details" on the profile (HR, Noha). */
export function EditFacilitatorPanel({ facilitator, update, onClose }) {
  const form = usePanelForm({ name: facilitator.name, phone: facilitator.phone, reference: facilitator.reference ?? '',
    skills: facilitator.skills, brands: facilitator.brands, notes: '' })
  const { values, failure, busy, submit } = form
  const onSubmit = (e) => {
    e.preventDefault()
    const { notes, ...details } = values
    submit({}, () => update(details), () => onClose())
  }
  return (
    <SidePanel open title="Edit details" subtitle={facilitator.name} onClose={onClose} busy={busy}
      footer={<PanelButtons formId="edit-fac" busy={busy} onCancel={onClose} submitLabel="Save" />}>
      <form id="edit-fac" className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={failure} />
        <FacilitatorFields form={form} prefix="ef" />
      </form>
    </SidePanel>
  )
}
