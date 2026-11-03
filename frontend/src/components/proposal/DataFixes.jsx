import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import SidePanel from '../ui/SidePanel.jsx'
import { Field, FormAlert, PanelButtons, usePanelForm } from '../crm/formParts.jsx'
import { useClients, useConfig, useCurrentUser, useDataFixes, useLookups, useUsers } from '../../data/hooks.js'
import { BRANDS, getBrand } from '../../domain/brands.js'
import { CLIENT_TYPES } from '../../domain/catalog.js'
import {
  CORRECTION_TARGETS, PAST_OUTCOMES, canAddPastRecord, plainStatus, validateCorrection, validatePastRecord,
} from '../../domain/corrections.js'
import { cairoTodayISO } from '../../domain/events.js'
import { ROLE } from '../../domain/roles.js'
import { resolveAssignedAM } from '../../domain/routing.js'
import { LOST_REASONS_FOR_FORMS } from '../../domain/status.js'
import { proposalLink } from '../../lib/links.js'

/**
 * "Correct status (data fix)": choose the right status in plain words, plus what that status needs.
 * It jumps straight there (outside the normal steps), is recorded as "Status corrected from X to Y",
 * and notifies no one.
 */
export function CorrectStatusPanel({ request, onClose, onSaved }) {
  const fixes = useDataFixes()
  const form = usePanelForm({
    target: '', followUpOn: '', eventDate: request.eventDatePrecision === 'day' ? request.eventDate ?? '' : '',
    eventEndDate: request.eventEndDate ?? '', finalPrice: request.finalPrice ?? '', finalParticipants: request.confirmedParticipants ?? '',
    lostReason: '', note: '',
  })
  const { values, set, errors, failure, busy, submit, fieldProps } = form
  const target = CORRECTION_TARGETS.find((t) => t.id === values.target)
  const onSubmit = (e) => {
    e.preventDefault()
    const { errors: local } = validateCorrection(values, request)
    submit(local, () => fixes.correctStatus(request, values), (result) => onSaved(result, result.message))
  }
  return (
    <SidePanel open title="Correct status (data fix)" subtitle={`${request.id} · now: ${plainStatus(request)}`} onClose={onClose} busy={busy}
      footer={<PanelButtons formId="correct-status" busy={busy} onCancel={onClose} submitLabel="Correct status" />}>
      <form id="correct-status" className="stack-form" onSubmit={onSubmit} noValidate>
        <p className="muted">For fixing data only: it jumps straight to the right status, is recorded in the history, and
          notifies no one. Use the normal steps to move new work forward.</p>
        <FormAlert failure={failure} />
        <Field id="cs-target" label="The right status" required error={errors.target}>
          <select {...fieldProps('cs-target', 'target')} value={values.target} onChange={set('target')}>
            <option value="">Choose…</option>
            {CORRECTION_TARGETS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </Field>
        {target?.id === 'postponed' && (
          <Field id="cs-follow" label="Follow-up date" required error={errors.followUpOn}>
            <input type="date" {...fieldProps('cs-follow', 'followUpOn')} value={values.followUpOn} onChange={set('followUpOn')} />
          </Field>
        )}
        {target?.status === 'accepted' && (
          <>
            <Field id="cs-date" label="Event date" required error={errors.eventDate}>
              <input type="date" {...fieldProps('cs-date', 'eventDate')} value={values.eventDate} onChange={set('eventDate')} />
            </Field>
            <Field id="cs-end" label="End date (optional)" error={errors.eventEndDate}>
              <input type="date" {...fieldProps('cs-end', 'eventEndDate')} value={values.eventEndDate} onChange={set('eventEndDate')} />
            </Field>
            {'finalPrice' in request && (
              <Field id="cs-price" label="Final price, EGP (optional)" error={errors.finalPrice}>
                <input inputMode="numeric" {...fieldProps('cs-price', 'finalPrice')} value={values.finalPrice} onChange={set('finalPrice')} />
              </Field>
            )}
            <Field id="cs-people" label="Participants (optional)" error={errors.finalParticipants}>
              <input inputMode="numeric" {...fieldProps('cs-people', 'finalParticipants')} value={values.finalParticipants} onChange={set('finalParticipants')} />
            </Field>
          </>
        )}
        {target?.id === 'lost' && (
          <Field id="cs-lost" label="Why it was lost" required error={errors.lostReason}>
            <select {...fieldProps('cs-lost', 'lostReason')} value={values.lostReason} onChange={set('lostReason')}>
              <option value="">Choose…</option>
              {LOST_REASONS_FOR_FORMS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </Field>
        )}
        <Field id="cs-note" label="Note (optional)" error={errors.note}>
          <textarea rows={2} maxLength={300} {...fieldProps('cs-note', 'note')} value={values.note} onChange={set('note')} />
        </Field>
      </form>
    </SidePanel>
  )
}

/** "+ Add past record": shown to Noha, Business Development and Account Managers. */
export function usePastRecordAllowed() {
  const { user, activeRole } = useCurrentUser()
  const { usersById } = useLookups()
  return canAddPastRecord({ userId: user.id, activeRole }, {}, { ...usersById, [user.id]: user }).allowed
}

/**
 * "Add past proposal or event": a record from before IEE. One form; the history is built from the dates
 * entered ("Added manually — before IEE"), nobody is notified, and it counts in all numbers.
 */
export function PastRecordPanel({ onClose }) {
  const navigate = useNavigate()
  const { user, activeRole } = useCurrentUser()
  const fixes = useDataFixes()
  const users = useUsers().data ?? []
  const clients = useClients().data ?? []
  const routing = useConfig().data?.routing
  const today = cairoTodayISO()
  const isAM = activeRole === ROLE.ACCOUNT_MANAGER
  const firstBrand = isAM && user.brand ? user.brand : ''
  const amFor = (brand) => { try { return brand ? resolveAssignedAM(brand, routing) : '' } catch { return '' } }
  const form = usePanelForm({
    clientId: '', newClientName: '', newClientType: '', eventName: '', brand: firstBrand, service: '',
    bdOwner: activeRole === ROLE.BUSINESS_DEVELOPMENT ? user.id : '', assignedAM: amFor(firstBrand),
    briefDate: '', sentDate: '', eventDate: '', eventEndDate: '', participants: '', outcome: '', amPrice: '', finalPrice: '',
    lostReason: '', notes: '', confirmDuplicate: false,
  })
  const { values, set, errors, failure, busy, submit, fieldProps } = form
  const [file, setFile] = useState(null)
  const [fileError, setFileError] = useState(null)
  const brand = getBrand(values.brand)
  const bds = users.filter((u) => u.active !== false && (u.roles.includes(ROLE.BUSINESS_DEVELOPMENT) || u.privileges?.bringsInClients))
  const ams = users.filter((u) => u.active !== false && u.roles.includes(ROLE.ACCOUNT_MANAGER))
  const mine = activeRole === ROLE.BUSINESS_DEVELOPMENT ? clients.filter((c) => c.owner === user.id) : clients
  const confirmed = ['confirmed', 'done'].includes(values.outcome)
  const duplicate = failure?.code === 'possible_duplicate'
  const setBrand = (e) => {
    set('brand')(e)
    set('service')('')
    set('assignedAM')(amFor(e.target.value))
  }

  const onSubmit = (e) => {
    e.preventDefault()
    const { errors: local } = validatePastRecord(values, { today })
    if (!values.clientId && !values.newClientName.trim()) local.clientId = 'Choose the client (or add a new one).'
    if (!values.clientId && values.newClientName.trim() && !values.newClientType) local.newClientType = 'Choose the client type.'
    const payload = {
      ...Object.fromEntries(Object.entries(values).filter(([k]) => !['newClientName', 'newClientType', 'clientId'].includes(k))),
      ...(values.clientId ? { clientId: values.clientId }
        : { newClient: { name: values.newClientName.trim(), type: values.newClientType, owner: values.bdOwner || null } }),
    }
    submit(local, () => fixes.addPastRecord(payload), async (result) => {
      const id = result.request.id
      if (file) {
        const sent = await fixes.uploadPastFile(id, file)
        if (!sent.ok) { setFileError(`${id} was added, but the file was not: ${sent.errors?.file ?? sent.error}`); return }
      }
      onClose()
      navigate(proposalLink(id), { state: { flash: result.message } })
    })
  }

  return (
    <SidePanel open title="Add past proposal or event" subtitle="A record from before IEE · nobody is notified" onClose={onClose} busy={busy}
      footer={<PanelButtons formId="past-record" busy={busy} onCancel={onClose} submitLabel={duplicate ? 'Add it anyway' : 'Add record'} />}>
      <form id="past-record" className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={failure} />
        {duplicate && (
          <label className="form-check">
            <input type="checkbox" checked={values.confirmDuplicate} onChange={set('confirmDuplicate')} />
            <span>It is a different record: add it anyway</span>
          </label>
        )}
        {fileError && <p className="form-error" role="alert">{fileError}</p>}
        <Field id="pr-client" label="Client" required error={errors.clientId}>
          <select {...fieldProps('pr-client', 'clientId')} value={values.clientId} onChange={set('clientId')}>
            <option value="">{values.newClientName ? 'New client (below)' : 'Choose…'}</option>
            {[...mine].sort((a, b) => a.name.localeCompare(b.name)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        {!values.clientId && (
          <div className="form-row">
            <Field id="pr-new" label="…or a new client" error={errors['newClient.name'] ?? errors['newClient.owner']}>
              <input maxLength={120} {...fieldProps('pr-new', 'newClientName')} value={values.newClientName} onChange={set('newClientName')} />
            </Field>
            {values.newClientName && (
              <Field id="pr-type" label="Type" required error={errors.newClientType ?? errors['newClient.type']}>
                <select {...fieldProps('pr-type', 'newClientType')} value={values.newClientType} onChange={set('newClientType')}>
                  <option value="">Choose…</option>
                  {Object.entries(CLIENT_TYPES).map(([id, t]) => <option key={id} value={id}>{t.label}</option>)}
                </select>
              </Field>
            )}
          </div>
        )}
        <Field id="pr-event" label="Event name (optional)" error={errors.eventName}>
          <input maxLength={120} {...fieldProps('pr-event', 'eventName')} value={values.eventName} onChange={set('eventName')} />
        </Field>
        <div className="form-row">
          <Field id="pr-brand" label="Brand" required error={errors.brand}>
            <select {...fieldProps('pr-brand', 'brand')} value={values.brand} onChange={setBrand}>
              <option value="">Choose…</option>
              {BRANDS.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field id="pr-service" label="Service" required error={errors.service}>
            <select {...fieldProps('pr-service', 'service')} value={values.service} onChange={set('service')} disabled={!brand}>
              <option value="">Choose…</option>
              {(brand?.services ?? []).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="form-row">
          <Field id="pr-bd" label="BD owner" required error={errors.bdOwner}>
            <select {...fieldProps('pr-bd', 'bdOwner')} value={values.bdOwner} onChange={set('bdOwner')}>
              <option value="">Choose…</option>
              {bds.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
          <Field id="pr-am" label="Account Manager" required hint="From the brand's routing; change it if needed" error={errors.assignedAM}>
            <select {...fieldProps('pr-am', 'assignedAM')} value={values.assignedAM} onChange={set('assignedAM')}>
              <option value="">Choose…</option>
              {ams.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="form-row">
          <Field id="pr-brief" label="Brief date" required error={errors.briefDate}>
            <input type="date" max={today} {...fieldProps('pr-brief', 'briefDate')} value={values.briefDate} onChange={set('briefDate')} />
          </Field>
          <Field id="pr-sent" label="Proposal sent (optional)" error={errors.sentDate}>
            <input type="date" max={today} {...fieldProps('pr-sent', 'sentDate')} value={values.sentDate} onChange={set('sentDate')} />
          </Field>
        </div>
        <div className="form-row">
          <Field id="pr-edate" label={confirmed ? 'Event date' : 'Event date (optional)'} required={confirmed} error={errors.eventDate}>
            <input type="date" {...fieldProps('pr-edate', 'eventDate')} value={values.eventDate} onChange={set('eventDate')} />
          </Field>
          <Field id="pr-eend" label="End date (optional)" error={errors.eventEndDate}>
            <input type="date" {...fieldProps('pr-eend', 'eventEndDate')} value={values.eventEndDate} onChange={set('eventEndDate')} />
          </Field>
        </div>
        <Field id="pr-outcome" label="What happened" required error={errors.outcome}>
          <select {...fieldProps('pr-outcome', 'outcome')} value={values.outcome} onChange={set('outcome')}>
            <option value="">Choose…</option>
            {PAST_OUTCOMES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </Field>
        {values.outcome === 'lost' && (
          <Field id="pr-lost" label="Why it was lost" required error={errors.lostReason}>
            <select {...fieldProps('pr-lost', 'lostReason')} value={values.lostReason} onChange={set('lostReason')}>
              <option value="">Choose…</option>
              {LOST_REASONS_FOR_FORMS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </Field>
        )}
        <div className="form-row">
          <Field id="pr-people" label="Participants (optional)" error={errors.participants}>
            <input inputMode="numeric" {...fieldProps('pr-people', 'participants')} value={values.participants} onChange={set('participants')} />
          </Field>
          <Field id="pr-price" label="Proposal price, EGP (optional)" error={errors.amPrice}>
            <input inputMode="numeric" {...fieldProps('pr-price', 'amPrice')} value={values.amPrice} onChange={set('amPrice')} />
          </Field>
          {confirmed && (
            <Field id="pr-final" label="Final price, EGP (optional)" error={errors.finalPrice}>
              <input inputMode="numeric" {...fieldProps('pr-final', 'finalPrice')} value={values.finalPrice} onChange={set('finalPrice')} />
            </Field>
          )}
        </div>
        <Field id="pr-notes" label="Notes (optional)" error={errors.notes}>
          <textarea rows={3} maxLength={1000} {...fieldProps('pr-notes', 'notes')} value={values.notes} onChange={set('notes')} />
        </Field>
        <Field id="pr-file" label="Proposal file (optional)" hint="PDF or PowerPoint, up to 25 MB">
          <input id="pr-file" type="file" accept=".pdf,.pptx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
      </form>
    </SidePanel>
  )
}
