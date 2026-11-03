import SidePanel from '../ui/SidePanel.jsx'
import SegmentedControl from '../ui/SegmentedControl.jsx'
import { useState } from 'react'
import ClientPicker from './ClientPicker.jsx'
import { Field, FormAlert, MoreDetails, PanelButtons, successText, usePanelForm } from './formParts.jsx'
import { useCreateOpportunity, useCurrentUser, useLookups, useOpportunityActions } from '../../data/hooks.js'
import { BRANDS, getBrand } from '../../domain/brands.js'
import { canEditClient, validateOpportunityFields } from '../../domain/crm.js'
import { todayISO } from '../../domain/metrics.js'

const FORM_ID = 'opportunity-form'
const OPTIONAL = ['participants', 'eventDate', 'eventEndDate', 'nextAction', 'nextActionDate']

const asText = (v) => (v === null || v === undefined ? '' : String(v))

/**
 * New opportunity (opportunity = null) or Edit details. From a client profile the client is
 * fixed (clientId); from the Opportunities page it is chosen among the clients this person may
 * add opportunities for. Essentials: brand, service, estimated value; dates and the next action
 * under "More details". The owner is always the client's relationship owner (set by the server).
 */
export default function OpportunityForm({ opportunity = null, clientId = null, onClose, onSaved, onReload }) {
  const editing = Boolean(opportunity)
  const { user, activeRole, createClients } = useCurrentUser()
  const [newClient, setNewClient] = useState(null) // "+ Add '<name>' as a new client": created with the opportunity
  const { usersById, clientsById } = useLookups()
  const creator = useCreateOpportunity()
  const actions = useOpportunityActions(opportunity)
  const fixedClient = clientsById[opportunity?.clientId ?? clientId] ?? null
  const viewer = { userId: user.id, activeRole }
  const choices = fixedClient ? [] : Object.values(clientsById)
    .filter((c) => !c.archivedAt && canEditClient(c, viewer, usersById).allowed)
    .sort((a, b) => a.name.localeCompare(b.name))

  const singleBrand = (c) => (c?.brands.length === 1 ? c.brands[0] : '')
  const form = usePanelForm({
    clientId: fixedClient?.id ?? '',
    brand: opportunity?.brand ?? singleBrand(fixedClient),
    service: opportunity?.service ?? '',
    estimatedValue: asText(opportunity?.estimatedValue),
    participants: asText(opportunity?.participants),
    eventDatePrecision: opportunity?.eventDatePrecision ?? 'day',
    eventDate: asText(opportunity?.eventDate),
    eventEndDate: asText(opportunity?.eventEndDate),
    eventName: asText(opportunity?.eventName),
    nextAction: asText(opportunity?.nextAction),
    nextActionDate: asText(opportunity?.nextActionDate),
  })
  const { values, set, setValues, errors, failure, busy, submit, fieldProps } = form
  const client = fixedClient ?? clientsById[values.clientId] ?? null
  const brand = getBrand(values.brand)
  const today = todayISO()

  const pickClient = (id) => {
    const next = clientsById[id]
    setValues((prev) => ({ ...prev, clientId: id, brand: singleBrand(next) || prev.brand, service: next ? '' : prev.service }))
  }
  const pickBrand = (e) => setValues((prev) => ({ ...prev, brand: e.target.value, service: '' }))
  const pickPrecision = (v) => setValues((prev) => (prev.eventDatePrecision === v ? prev
    : { ...prev, eventDatePrecision: v, eventDate: '', eventEndDate: '' }))

  const onSubmit = (e) => {
    e.preventDefault()
    const { errors: local, values: clean } = validateOpportunityFields(values, { today, current: opportunity })
    if (!editing && !values.clientId && !newClient) local.clientId = 'Choose a client.'
    const fields = {
      brand: clean.brand, service: clean.service, estimatedValue: clean.estimatedValue, participants: clean.participants,
      eventName: clean.eventName, eventDatePrecision: clean.eventDatePrecision, eventDate: clean.eventDate,
      eventEndDate: clean.eventEndDate, nextAction: clean.nextAction, nextActionDate: clean.nextActionDate,
    }
    const created = newClient ? { newClient } : { clientId: values.clientId }
    submit(local, () => (editing ? actions.update(form.changedFields(fields)) : creator.create({ ...created, ...fields })),
      (result) => onSaved(result, successText(result)))
  }

  return (
    <SidePanel
      open
      title={editing ? 'Edit details' : 'New opportunity'}
      subtitle={editing ? `${client?.name ?? opportunity.clientId} · ${opportunity.id}` : fixedClient?.name}
      onClose={onClose}
      busy={busy}
      footer={<PanelButtons formId={FORM_ID} busy={busy} onCancel={onClose} submitLabel={editing ? 'Save changes' : 'Add opportunity'} />}
    >
      <form id={FORM_ID} className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={failure} onReload={onReload} />

        {!fixedClient && (
          <Field id="of-client" label="Client" required error={errors.clientId}
            hint="Type to search the clients you may add opportunities for.">
            <ClientPicker
              id="of-client"
              clients={choices}
              allClients={Object.values(clientsById).filter((c) => !c.archivedAt)}
              value={values.clientId}
              onChoose={pickClient}
              newClient={newClient}
              onNewClient={setNewClient}
              canAdd={createClients.allowed}
              isHead={activeRole === 'commercial_head'}
              usersById={usersById}
              brandName={brand?.name}
              errors={errors}
            />
          </Field>
        )}

        <Field id="of-event-name" label="Event name (optional)" error={errors.eventName}>
          <input type="text" maxLength={80} placeholder="e.g. Summer team day" {...fieldProps('of-event-name', 'eventName')}
            value={values.eventName} onChange={set('eventName')} />
        </Field>

        <Field id="of-brand" label="Brand" required error={errors.brand}>
          <select {...fieldProps('of-brand', 'brand')} value={values.brand} onChange={pickBrand}>
            <option value="">Choose…</option>
            {BRANDS.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>

        <Field id="of-service" label="Service" required error={errors.service}
          hint={brand ? null : 'Choose the brand first.'}>
          <select {...fieldProps('of-service', 'service')} value={values.service} onChange={set('service')} disabled={!brand}>
            <option value="">Choose…</option>
            {brand?.services.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </Field>

        <Field id="of-value" label="Estimated value (EGP)" error={errors.estimatedValue} hint="A sales estimate in whole pounds, not revenue.">
          <input type="number" inputMode="numeric" min="0" step="1" {...fieldProps('of-value', 'estimatedValue')}
            value={values.estimatedValue} onChange={set('estimatedValue')} />
        </Field>

        <MoreDetails open={OPTIONAL.some((f) => errors[f])}>
          <Field id="of-participants" label="Expected participants" error={errors.participants}>
            <input type="number" inputMode="numeric" min="1" step="1" {...fieldProps('of-participants', 'participants')}
              value={values.participants} onChange={set('participants')} />
          </Field>
          <Field id="of-event" label="Event date" error={errors.eventDate}
            hint={values.eventDatePrecision === 'month' ? 'Month and year only.' : null}>
            <SegmentedControl label="Event date precision" value={values.eventDatePrecision} onChange={pickPrecision}
              options={[{ value: 'day', label: 'Exact date' }, { value: 'month', label: 'Month only' }]} />
            {values.eventDatePrecision === 'month' ? (
              <input type="month" min={today.slice(0, 7)} {...fieldProps('of-event', 'eventDate')} value={values.eventDate} onChange={set('eventDate')} />
            ) : (
              <input type="date" min={today} {...fieldProps('of-event', 'eventDate')} value={values.eventDate} onChange={set('eventDate')} />
            )}
          </Field>
          {values.eventDatePrecision === 'day' && (
            <Field id="of-event-end" label="End date (optional)" error={errors.eventEndDate} hint="Only for events over more than one day.">
              <input type="date" min={values.eventDate || today} {...fieldProps('of-event-end', 'eventEndDate')}
                value={values.eventEndDate} onChange={set('eventEndDate')} />
            </Field>
          )}
          <Field id="of-next" label="Next action" error={errors.nextAction}>
            <input type="text" maxLength={300} placeholder="e.g. Call to confirm the date" {...fieldProps('of-next', 'nextAction')}
              value={values.nextAction} onChange={set('nextAction')} />
          </Field>
          <Field id="of-next-date" label="Next action date" error={errors.nextActionDate}>
            <input type="date" min={today} {...fieldProps('of-next-date', 'nextActionDate')} value={values.nextActionDate} onChange={set('nextActionDate')} />
          </Field>
        </MoreDetails>
      </form>
    </SidePanel>
  )
}
