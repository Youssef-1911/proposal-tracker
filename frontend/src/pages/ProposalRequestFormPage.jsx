import { useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import PageLayout from '../components/layout/PageLayout.jsx'
import Card from '../components/ui/Card.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import SegmentedControl from '../components/ui/SegmentedControl.jsx'
import StatusBadge from '../components/ui/StatusBadge.jsx'
import { Person } from '../components/dashboard/cells.jsx'
import ClientPicker from '../components/crm/ClientPicker.jsx'
import { useConfig, useCurrentUser, useLists, useLookups, useOccasions, useProposalRequest, useRequestForm } from '../data/hooks.js'
import { visibleOptions } from '../domain/lists.js'
import { API_MODE } from '../data/source.js'
import { BRANDS, getBrand, serviceLabel } from '../domain/brands.js'
import { ROLE } from '../domain/roles.js'
import { getStatus } from '../domain/status.js'
import { isActiveOpportunity, todayISO } from '../domain/metrics.js'
import { resolveAssignedAM } from '../domain/routing.js'
import { EVENT_DATE_PRECISION, EVENT_NAME_MAX, canEditDraft, findPossibleDuplicates, requestFields } from '../domain/workflow.js'
import { formatCurrency } from '../lib/format.js'
import { prefillFrom } from '../domain/radar.js'
import { editDraftLink, proposalLink } from '../lib/links.js'

const EMPTY = {
  clientId: '', eventName: '', brand: '', service: '', opportunityId: '', eventDatePrecision: EVENT_DATE_PRECISION.DAY,
  eventDate: '', eventEndDate: '', requiredBy: '', briefTags: [], participants: '', requirementsSummary: '', specificRequirements: '',
  occasionId: '', fromRadar: false,
}

/**
 * A new request started from a client or an opportunity (?client=… / ?opportunity=…), or from a previous
 * request ("Create request from previous" on the radar: ?from=PR-…&radar=1, dates left empty): only
 * choices the form offers this person anyway are taken; anything else starts empty.
 */
function prefill(search, clients, opportunities, requests = []) {
  const params = new URLSearchParams(search)
  const previous = requests.find((r) => r.id === params.get('from'))
  if (previous && clients.some((c) => c.id === previous.clientId)) {
    const f = prefillFrom(previous)
    return { ...EMPTY, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Array.isArray(v) ? v : v === null || v === undefined ? '' : String(v)])),
      fromRadar: params.get('radar') === '1' }
  }
  const opp = opportunities.find((o) => o.id === params.get('opportunity') && isActiveOpportunity(o))
  const clientId = opp?.clientId ?? params.get('client')
  if (!clients.some((c) => c.id === clientId)) return EMPTY
  if (!opp) return { ...EMPTY, clientId }
  return { ...EMPTY, clientId, brand: opp.brand, service: opp.service, opportunityId: opp.id, eventName: opp.eventName ?? '' }
}

/** Form values are always strings for the inputs; the workflow normalises them. */
function toFormValues(request) {
  const f = { ...requestFields(request), occasionId: request.occasionId ?? null }
  return Object.fromEntries(Object.entries({ ...EMPTY, ...f })
    .map(([k, v]) => [k, Array.isArray(v) ? v : v === null || v === undefined ? '' : String(v)]))
}

function Field({ id, label, required, hint, error, children }) {
  return (
    <div className="form-field">
      <label className="form-field__label" htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {children}
      {hint && <span className="form-field__hint" id={`${id}-hint`}>{hint}</span>}
      {error && <span className="form-field__error" id={`${id}-error`} role="alert">{error}</span>}
    </div>
  )
}

function Blocked({ title, children }) {
  return (
    <PageLayout title="New proposal">
      <Card>
        <EmptyState icon="lock" title={title} meta={<Link to="/" className="btn">Back to dashboard</Link>}>
          {children}
        </EmptyState>
      </Card>
    </PageLayout>
  )
}

/**
 * New Proposal Request (/proposals/new) and Edit draft (/proposals/:id/edit).
 * All rules (validation, ownership, routing, submission) come from domain/workflow.js;
 * this page only collects input and calls the store's single save path.
 */
export default function ProposalRequestFormPage() {
  const { id: draftId } = useParams()
  const form = useRequestForm()
  const { data: draft, isLoading: draftLoading, reload: reloadDraft } = useProposalRequest(draftId)

  // ---- access ----
  if (!form.access.allowed) {
    return <Blocked title="You can't create proposal requests">{form.access.reason}</Blocked>
  }
  if ((draftId && draftLoading && !draft) || form.isLoading) {
    return <PageLayout title={draftId ? `Edit draft ${draftId}` : 'New proposal'}><Card><p className="muted" role="status">Loading…</p></Card></PageLayout>
  }
  // API mode: the server says whether this viewer may edit the draft (canEditDraft); demo mode: the rules.
  const editable = draft && (draft.canEditDraft ?? canEditDraft(draft, form.viewer, form.usersById))
  if (draftId && !editable) {
    return (
      <Blocked title="Draft not available to edit">
        &ldquo;{draftId}&rdquo; can't be edited by you. Only a draft's creator can edit it, and only while it is still a
        draft. {draft && <Link to={proposalLink(draft.id)}>Open the request</Link>}
      </Blocked>
    )
  }
  return <RequestForm key={draftId ?? 'new'} draftId={draftId} draft={draft} form={form} reloadDraft={reloadDraft} />
}

function RequestForm({ draftId, draft, form, reloadDraft }) {
  const { routing } = useConfig().data
  const navigate = useNavigate()
  const location = useLocation()
  const { viewer, clients, opportunities, allRequests, usersById, save } = form
  const { createClients } = useCurrentUser()
  const { clientsById } = useLookups()
  const briefTags = visibleOptions(useLists().data, 'briefTags')
  const toggleTag = (code) => setValues((prev) => ({
    ...prev, briefTags: prev.briefTags.includes(code) ? prev.briefTags.filter((c) => c !== code) : [...prev.briefTags, code],
  }))
  const allClients = useMemo(() => Object.values(clientsById).filter((c) => !c.archivedAt), [clientsById])
  const isHead = viewer.activeRole === ROLE.COMMERCIAL_HEAD

  const [values, setValues] = useState(() => (draft ? toFormValues(draft) : prefill(location.search, clients, opportunities, allRequests)))
  const occasions = useOccasions().items
  const [errors, setErrors] = useState({})
  const [newClient, setNewClient] = useState(null) // "+ Add '<name>' as a new client": created with the request
  const [error, setError] = useState(null)
  const [stale, setStale] = useState(false) // 409: the draft changed elsewhere; typed values are kept
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false) // guards double clicks before React re-renders

  const client = clients.find((c) => c.id === values.clientId) ?? null
  const brand = values.brand ? getBrand(values.brand) : null
  const openOpps = useMemo(
    () => opportunities.filter((o) => o.clientId === values.clientId && o.brand === values.brand && isActiveOpportunity(o)),
    [opportunities, values.clientId, values.brand],
  )
  const duplicates = findPossibleDuplicates(values, allRequests, draftId ?? null)
  const am = brand ? usersById[resolveAssignedAM(brand.id, routing)] : null // the live routing (Settings)

  const set = (field) => (e) => {
    const value = e.target.value
    setValues((prev) => {
      const next = { ...prev, [field]: value }
      // Keep dependent choices consistent: service follows brand; opportunity follows client + brand.
      if (field === 'brand' && prev.brand !== value) { next.service = ''; next.opportunityId = '' }
      if (field === 'clientId' && prev.clientId !== value) next.opportunityId = ''
      if (field === 'eventDatePrecision' && prev.eventDatePrecision !== value) { next.eventDate = ''; next.eventEndDate = '' }
      return next
    })
    setErrors((prev) => ({ ...prev, [field]: undefined }))
  }

  async function run(submit) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    let result
    try {
      result = await save({ ...values, newClient }, { draftId: draftId ?? null, submit, rowVersion: draft?.rowVersion })
    } finally {
      busyRef.current = false
      setBusy(false)
    }
    if (!result.ok) {
      // Keep everything the user typed; show what to fix.
      setErrors(result.errors ?? {})
      setError(result.error)
      setStale(Boolean(result.stale))
      return
    }
    // Saved (demo store updated, or the server answered 2xx) before we get here.
    const flash = [result.message, ...(result.warnings ?? []).map((w) => w.message)].join(' ')
    if (submit) navigate(proposalLink(result.request.id), { state: { flash } })
    else navigate(editDraftLink(result.request.id), { replace: true, state: { flash } })
  }

  const flash = location.state?.flash
  const ownerUser = client ? usersById[client.owner]
    : newClient ? usersById[isHead ? newClient.owner : viewer.userId] ?? null : null
  const fieldProps = (name) => ({
    id: `f-${name}`,
    'aria-invalid': Boolean(errors[name]),
    'aria-describedby': [errors[name] && `f-${name}-error`, `f-${name}-hint`].filter(Boolean).join(' '),
  })

  return (
    <PageLayout
      title={draftId ? `Edit draft ${draftId}` : 'New proposal'}
      subtitle={draftId ? 'Only you can see this draft until it is submitted.' : 'Ask the Account Manager for a proposal. Save as a draft or submit now.'}
      actions={draftId ? <StatusBadge kind="proposal" status={draft.status} version={draft.version} /> : null}
    >
      {!API_MODE && (
        <div className="notice" role="note">
          <Icon name="info" size={16} strokeWidth={2} />
          <p>
            <strong>Demo:</strong> requests are kept in memory only and reset when the page is reloaded.
          </p>
        </div>
      )}

      {flash && (
        <div className="action-feedback action-feedback--success" role="status">
          <Icon name="checkmark" size={16} strokeWidth={2.25} />
          <span>{flash}</span>
        </div>
      )}

      <form className="request-form" onSubmit={(e) => { e.preventDefault(); run(true) }} noValidate>
        <div className="dash-grid detail-grid request-form__grid">
          <div className="span-8 detail-col">
            <Card title="Client & service">
              <div className="form-grid">
                <Field id="f-clientId" label="Client" required error={errors.clientId}
                  hint={isHead ? 'Type to search all clients.' : 'Type to search the clients you own.'}>
                  <ClientPicker
                    id="f-clientId"
                    clients={clients}
                    allClients={allClients}
                    value={values.clientId}
                    onChoose={(cid) => set('clientId')({ target: { value: cid } })}
                    newClient={newClient}
                    onNewClient={setNewClient}
                    canAdd={createClients.allowed}
                    isHead={isHead}
                    usersById={usersById}
                    brandName={brand?.name}
                    errors={errors}
                    describedBy={fieldProps('clientId')['aria-describedby']}
                  />
                </Field>

                <Field id="f-eventName" label="Event name (optional)" error={errors.eventName}
                  hint="Shown next to the client in lists.">
                  <input type="text" maxLength={EVENT_NAME_MAX} placeholder="e.g. Summer team day" {...fieldProps('eventName')}
                    value={values.eventName} onChange={set('eventName')} />
                </Field>
                {occasions.length > 0 && (
                  <Field id="f-occasion" label="Occasion (optional)" error={errors.occasionId} hint="Ramadan, Easter, Summer…: helps us call back next time.">
                    <select {...fieldProps('occasionId')} value={values.occasionId} onChange={set('occasionId')}>
                      <option value="">None</option>
                      {occasions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  </Field>
                )}

                <div className="form-field">
                  <span className="form-field__label">BD owner</span>
                  <div className="readonly-value">
                    {ownerUser ? <Person user={ownerUser} suffix="Client relationship owner" /> : <span className="muted">Set by the client</span>}
                  </div>
                  <span className="form-field__hint">
                    Always the client's relationship owner; not editable here.
                    {ownerUser && viewer.userId !== ownerUser.id && ` You are creating this on behalf of ${ownerUser.name}.`}
                  </span>
                </div>

                <Field id="f-brand" label="Brand" required error={errors.brand}>
                  <SegmentedControl
                    label="Brand"
                    options={BRANDS.map((b) => ({ value: b.id, label: b.name }))}
                    value={values.brand}
                    onChange={(v) => set('brand')({ target: { value: v } })}
                  />
                </Field>

                <Field id="f-service" label="Service" required error={errors.service}
                  hint={brand ? `${brand.name} services` : 'Choose a brand first.'}>
                  <select {...fieldProps('service')} value={values.service} onChange={set('service')} disabled={!brand}>
                    <option value="">Choose a service…</option>
                    {brand?.services.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </Field>

                <Field id="f-opportunityId" label="Linked opportunity (optional)" error={errors.opportunityId}
                  hint={client && brand ? `Open ${brand.name} opportunities for ${client.name}.` : 'Choose a client and brand to see opportunities.'}>
                  <select {...fieldProps('opportunityId')} value={values.opportunityId} onChange={set('opportunityId')}
                    disabled={!client || !brand}>
                    <option value="">None</option>
                    {openOpps.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.id} · {serviceLabel(o.brand, o.service)} · {getStatus('opportunity', o.stage).label} · est. {formatCurrency(o.estimatedValue)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </Card>

            <Card title="Event & proposal deadline" subtitle="The event date is when the event happens. The proposal deadline is when the AM must send the proposal to BD.">
              <div className="form-grid">
                <Field id="f-eventDate" label="Event date" error={errors.eventDate}
                  hint={values.eventDatePrecision === 'month' ? 'Month and year only; the exact day is not known yet.'
                    : values.eventDatePrecision === 'unset' ? 'The client has not chosen a date yet.' : 'The day the event starts.'}>
                  <SegmentedControl
                    label="Event date precision"
                    options={[{ value: 'day', label: 'Exact date' }, { value: 'month', label: 'Month only' }, { value: 'unset', label: 'Not set yet' }]}
                    value={values.eventDatePrecision}
                    onChange={(v) => set('eventDatePrecision')({ target: { value: v } })}
                  />
                  {values.eventDatePrecision === 'month' && (
                    <input type="month" placeholder="YYYY-MM" min={todayISO().slice(0, 7)} {...fieldProps('eventDate')}
                      value={values.eventDate} onChange={set('eventDate')} />
                  )}
                  {values.eventDatePrecision === 'day' && (
                    <input type="date" min={todayISO()} {...fieldProps('eventDate')} value={values.eventDate} onChange={set('eventDate')} />
                  )}
                </Field>

                {values.eventDatePrecision === 'day' && (
                  <Field id="f-eventEndDate" label="End date (optional)" error={errors.eventEndDate}
                    hint="Only for events over more than one day.">
                    <input type="date" min={values.eventDate || todayISO()} {...fieldProps('eventEndDate')}
                      value={values.eventEndDate} onChange={set('eventEndDate')} />
                  </Field>
                )}

                <Field id="f-requiredBy" label="Proposal deadline" error={errors.requiredBy}
                  hint="When the AM must send the proposal to BD. Today or later, and before the event.">
                  <input type="date" min={todayISO()} {...fieldProps('requiredBy')} value={values.requiredBy} onChange={set('requiredBy')} />
                </Field>

                <Field id="f-participants" label="Expected participants" error={errors.participants} hint="Whole number.">
                  <input type="number" inputMode="numeric" min="1" step="1" {...fieldProps('participants')}
                    value={values.participants} onChange={set('participants')} />
                </Field>
              </div>
            </Card>

            <Card title="Requirements">
              <div className="form-stack">
                <Field id="f-requirementsSummary" label="Event brief" error={errors.requirementsSummary}
                  hint="What the client wants: format, audience, location, duration.">
                  <textarea rows={4} {...fieldProps('requirementsSummary')} value={values.requirementsSummary}
                    onChange={set('requirementsSummary')} />
                </Field>
                <fieldset className="form-field reason-picker">
                  <legend className="form-field__label">Quick tags (optional)</legend>
                  <div className="reason-picker__options">
                    {briefTags.map((t) => (
                      <label key={t.code} className={`chip-toggle${values.briefTags.includes(t.code) ? ' is-on' : ''}`}>
                        <input type="checkbox" checked={values.briefTags.includes(t.code)} onChange={() => toggleTag(t.code)} />
                        {t.label}
                      </label>
                    ))}
                  </div>
                  {errors.briefTags && <span className="form-field__error" role="alert">{errors.briefTags}</span>}
                </fieldset>
                <Field id="f-specificRequirements" label="Specific requirements (optional)" error={errors.specificRequirements}
                  hint="Dietary needs, accessibility, timing constraints, etc.">
                  <textarea rows={3} {...fieldProps('specificRequirements')} value={values.specificRequirements}
                    onChange={set('specificRequirements')} />
                </Field>
              </div>
            </Card>
          </div>

          <div className="span-4 detail-col">
            <Card title="Routing">
              {brand && am ? (
                <div className="routing">
                  <p className="routing__line">
                    This request will go to <strong>{am.name}</strong> ({brand.name}).
                  </p>
                  <Person user={am} suffix={`Account Manager — ${brand.name}`} />
                  <span className="form-field__hint">Set automatically by brand; not editable.</span>
                </div>
              ) : (
                <p className="muted">Choose a brand to see which Account Manager will prepare the proposal.</p>
              )}
            </Card>

            {duplicates.length > 0 && (
              <div className="notice" role="note">
                <Icon name="alert" size={16} strokeWidth={2} />
                <div>
                  <strong>Possible duplicate.</strong> An open request already exists for this client, brand, service and
                  event date:{' '}
                  {duplicates.map((d, i) => (
                    <span key={d.id}>
                      {i > 0 && ', '}
                      <Link to={proposalLink(d.id)}>{d.id}</Link> ({getStatus('proposal', d.status).label})
                    </span>
                  ))}
                  . You can still continue.
                </div>
              </div>
            )}

            <Card title="Save or submit">
              <div className="form-stack">
                <p className="form-field__hint">
                  <strong>Save draft</strong> keeps it private to you; nothing is sent. Needs client, brand and service.
                  <br />
                  <strong>Submit request</strong> sends it to the Account Manager. Needs every field except the optional ones.
                </p>
                {error && (
                  <div className="form-error" role="alert">
                    {error}
                    {stale && (
                      <button type="button" className="btn btn--sm form-error__reload"
                        onClick={() => { setStale(false); setError(null); reloadDraft() }}>
                        Reload
                      </button>
                    )}
                  </div>
                )}
                <div className="form-buttons">
                  <button type="button" className="btn" disabled={busy} aria-busy={busy} onClick={() => run(false)}>
                    {busy ? 'Saving…' : draftId ? 'Save draft changes' : 'Save draft'}
                  </button>
                  <button type="submit" className="btn btn--primary" disabled={busy} aria-busy={busy}>
                    {busy ? 'Saving…' : 'Submit request'}
                  </button>
                </div>
                <Link to={draftId ? proposalLink(draftId) : '/'} className="link-btn form-cancel">
                  Cancel: discard unsaved changes
                </Link>
              </div>
            </Card>
          </div>
        </div>
      </form>
    </PageLayout>
  )
}
