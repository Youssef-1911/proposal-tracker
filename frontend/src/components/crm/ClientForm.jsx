import { useMemo } from 'react'
import { useLists } from '../../data/hooks.js'
import { visibleOptions } from '../../domain/lists.js'
import SidePanel from '../ui/SidePanel.jsx'
import { Field, FormAlert, MoreDetails, PanelButtons, successText, usePanelForm } from './formParts.jsx'
import { useClientActions, useCreateClient, useCurrentUser, useLookups, useUsers } from '../../data/hooks.js'
import { BRANDS } from '../../domain/brands.js'
import { CLIENT_TYPES } from '../../domain/catalog.js'
import { findPossibleDuplicateClients, newClientOwner, validateClientFields, validateContactFields } from '../../domain/crm.js'
import { ROLE } from '../../domain/roles.js'

const FORM_ID = 'client-form'
const CONTACT_FIELDS = ['name', 'title', 'phone', 'email']

/**
 * New client (client = null) or Edit details. Essentials first (name, type, brands; the owner
 * when the Commercial Head creates one); city, notes and the first contact under "More details".
 * A possible duplicate is a warning only. onSaved(result) gets the server's { client, message }.
 */
export default function ClientForm({ client = null, onClose, onSaved, onReload }) {
  const cities = visibleOptions(useLists().data, 'cities')
  const editing = Boolean(client)
  const { user, activeRole } = useCurrentUser()
  const { usersById, clientsById } = useLookups()
  const users = useUsers().data
  const creator = useCreateClient()
  const actions = useClientActions(client)
  const chooseOwner = !editing && activeRole === ROLE.COMMERCIAL_HEAD
  const bds = users.filter((u) => u.roles.includes(ROLE.BUSINESS_DEVELOPMENT))

  const form = usePanelForm({
    name: client?.name ?? '', type: client?.type ?? '', brands: client?.brands ?? [],
    city: client?.city ?? '', notes: client?.notes ?? '', owner: '',
    contactName: '', contactTitle: '', contactPhone: '', contactEmail: '',
  })
  const { values, set, setValues, errors, failure, busy, submit, fieldProps } = form

  const duplicates = useMemo(() => findPossibleDuplicateClients(
    { name: values.name, contacts: [{ phone: values.contactPhone, email: values.contactEmail }] },
    Object.values(clientsById), client?.id ?? null,
  ), [values.name, values.contactPhone, values.contactEmail, clientsById, client?.id])

  const toggleBrand = (id) => (e) => {
    setValues((prev) => ({ ...prev, brands: e.target.checked ? [...prev.brands, id] : prev.brands.filter((b) => b !== id) }))
    form.setErrors((prev) => ({ ...prev, brands: undefined }))
  }

  const onSubmit = (e) => {
    e.preventDefault()
    const fields = { name: values.name, type: values.type, brands: values.brands, city: values.city, notes: values.notes }
    const local = { ...validateClientFields(fields).errors }
    const contact = Object.fromEntries(CONTACT_FIELDS.map((f) => [f, values[`contact${f[0].toUpperCase()}${f.slice(1)}`]]))
    const hasContact = !editing && CONTACT_FIELDS.some((f) => contact[f].trim())
    if (hasContact) {
      for (const [k, v] of Object.entries(validateContactFields(contact).errors)) local[`contact.${k}`] = v
    }
    if (chooseOwner) {
      const owner = newClientOwner({ userId: user.id, activeRole }, values.owner, usersById)
      if (owner.errors) Object.assign(local, owner.errors)
    }
    const body = {
      ...fields,
      ...(chooseOwner ? { owner: values.owner } : {}),
      ...(hasContact ? { contact } : {}),
    }
    submit(local, () => (editing ? actions.update(form.changedFields(fields)) : creator.create(body)),
      (result) => onSaved(result, successText(result)))
  }

  const contactField = (f) => `contact${f[0].toUpperCase()}${f.slice(1)}`

  return (
    <SidePanel
      open
      title={editing ? 'Edit client' : 'New client'}
      subtitle={editing ? client.name : chooseOwner ? null : 'You will be the relationship owner.'}
      onClose={onClose}
      busy={busy}
      footer={<PanelButtons formId={FORM_ID} busy={busy} onCancel={onClose} submitLabel={editing ? 'Save changes' : 'Add client'} />}
    >
      <form id={FORM_ID} className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={failure} onReload={onReload} />

        <Field id="cf-name" label="Client name" required error={errors.name}>
          <input type="text" autoComplete="organization" maxLength={200} {...fieldProps('cf-name', 'name')}
            value={values.name} onChange={set('name')} />
        </Field>
        {duplicates.length > 0 && (
          <p className="data-notice" role="status">
            Possible duplicate: {duplicates.map((d) => d.name).join(', ')}. You can still save.
          </p>
        )}

        <Field id="cf-type" label="Type" required error={errors.type}>
          <select {...fieldProps('cf-type', 'type')} value={values.type} onChange={set('type')}>
            <option value="">Choose…</option>
            {Object.entries(CLIENT_TYPES).map(([id, t]) => <option key={id} value={id}>{t.label}</option>)}
          </select>
        </Field>

        <fieldset className="form-field" aria-describedby={errors.brands ? 'cf-brands-error' : undefined}>
          <legend className="form-field__label">Brands <span aria-hidden="true">*</span></legend>
          <div className="check-row">
            {BRANDS.map((b) => (
              <label key={b.id}>
                <input type="checkbox" checked={values.brands.includes(b.id)} onChange={toggleBrand(b.id)} />
                {b.name}
              </label>
            ))}
          </div>
          {errors.brands && <span className="form-field__error" id="cf-brands-error" role="alert">{errors.brands}</span>}
        </fieldset>

        {chooseOwner && (
          <Field id="cf-owner" label="Relationship owner" required error={errors.owner}>
            <select {...fieldProps('cf-owner', 'owner')} value={values.owner} onChange={set('owner')}>
              <option value="">Choose…</option>
              {bds.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        )}

        <MoreDetails open={Boolean(errors.city || errors.notes || CONTACT_FIELDS.some((f) => errors[`contact.${f}`]))}>
          <Field id="cf-city" label="City" error={errors.city}>
            <select {...fieldProps('cf-city', 'city')} value={values.city} onChange={set('city')}>
              <option value="">—</option>
              {/* A city typed before the list existed stays selectable as it was. */}
              {values.city && !cities.some((c) => c.code === values.city) && <option value={values.city}>{values.city}</option>}
              {cities.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </Field>
          <Field id="cf-notes" label="Notes" error={errors.notes}>
            <textarea rows={3} maxLength={2000} {...fieldProps('cf-notes', 'notes')} value={values.notes} onChange={set('notes')} />
          </Field>
          {!editing && (
            <>
              <p className="form-field__label">Main contact</p>
              {[
                ['name', 'Name', 'text', 'name'],
                ['title', 'Job title', 'text', 'organization-title'],
                ['phone', 'Phone', 'tel', 'tel'],
                ['email', 'Email', 'email', 'email'],
              ].map(([f, label, type, auto]) => (
                <Field key={f} id={`cf-contact-${f}`} label={label} error={errors[`contact.${f}`]}>
                  <input type={type} autoComplete={auto} {...fieldProps(`cf-contact-${f}`, `contact.${f}`)}
                    value={values[contactField(f)]} onChange={set(contactField(f))} />
                </Field>
              ))}
            </>
          )}
        </MoreDetails>
      </form>
    </SidePanel>
  )
}
