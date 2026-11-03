import { useState } from 'react'
import SidePanel from '../ui/SidePanel.jsx'
import ConfirmDialog from '../ui/ConfirmDialog.jsx'
import { Field, FormAlert, MoreDetails, PanelButtons, successText, usePanelForm } from './formParts.jsx'
import { useClientActions } from '../../data/hooks.js'
import { validateContactFields } from '../../domain/crm.js'

const FORM_ID = 'contact-form'

/** Add a contact person (contact = null) or edit one; an existing contact can be archived (with a confirmation). */
export default function ContactForm({ client, contact = null, onClose, onSaved, onReload }) {
  const editing = Boolean(contact)
  const actions = useClientActions(client)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const firstContact = client.contacts.length === 0
  const form = usePanelForm({
    name: contact?.name ?? '', title: contact?.title ?? '', phone: contact?.phone ?? '',
    email: contact?.email ?? '', notes: contact?.notes ?? '', isPrimary: contact?.isPrimary ?? firstContact,
  })
  const { values, set, errors, failure, busy, submit, fieldProps } = form

  const onSubmit = (e) => {
    e.preventDefault()
    const { errors: local } = validateContactFields(values)
    const all = { name: values.name, title: values.title, phone: values.phone, email: values.email, notes: values.notes }
    const fields = editing ? form.changedFields(all) : all
    // "Main contact" can only be given to someone; it moves away when another contact becomes the main one.
    if (values.isPrimary && !contact?.isPrimary) fields.isPrimary = true
    submit(local, () => (editing ? actions.updateContact(contact, fields) : actions.addContact(fields)),
      (result) => onSaved(result, successText(result)))
  }

  const archive = () => submit({}, () => actions.archiveContact(contact), (result) => {
    setConfirmArchive(false)
    onSaved(result, successText(result))
  })

  return (
    <SidePanel
      open
      title={editing ? 'Edit contact' : 'Add contact'}
      subtitle={client.name}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          {editing && (
            <button type="button" className="btn btn--link-danger side-panel__aside" onClick={() => setConfirmArchive(true)} disabled={busy}>
              Archive contact
            </button>
          )}
          <PanelButtons formId={FORM_ID} busy={busy} onCancel={onClose} submitLabel={editing ? 'Save changes' : 'Add contact'} />
        </>
      )}
    >
      <form id={FORM_ID} className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={confirmArchive ? null : failure} onReload={onReload} />
        <Field id="ct-name" label="Name" required error={errors.name}>
          <input type="text" autoComplete="name" maxLength={200} {...fieldProps('ct-name', 'name')} value={values.name} onChange={set('name')} />
        </Field>
        <Field id="ct-title" label="Job title" error={errors.title}>
          <input type="text" maxLength={200} {...fieldProps('ct-title', 'title')} value={values.title} onChange={set('title')} />
        </Field>
        <Field id="ct-phone" label="Phone" error={errors.phone}>
          <input type="tel" autoComplete="tel" {...fieldProps('ct-phone', 'phone')} value={values.phone} onChange={set('phone')} />
        </Field>
        <Field id="ct-email" label="Email" error={errors.email}>
          <input type="email" autoComplete="email" {...fieldProps('ct-email', 'email')} value={values.email} onChange={set('email')} />
        </Field>
        {contact?.isPrimary ? (
          <p className="muted">This is the main contact. Make another contact the main one to change it.</p>
        ) : (
          <label className="form-check">
            <input type="checkbox" checked={values.isPrimary} onChange={set('isPrimary')} />
            <span>Main contact for {client.name}</span>
          </label>
        )}
        <MoreDetails open={Boolean(errors.notes || values.notes)}>
          <Field id="ct-notes" label="Notes" error={errors.notes}>
            <textarea rows={3} maxLength={1000} {...fieldProps('ct-notes', 'notes')} value={values.notes} onChange={set('notes')} />
          </Field>
        </MoreDetails>
      </form>

      <ConfirmDialog
        open={confirmArchive}
        title={`Archive ${contact?.name}?`}
        confirmLabel="Archive contact"
        tone="danger"
        busy={busy}
        onConfirm={archive}
        onCancel={() => setConfirmArchive(false)}
      >
        <p>The contact is hidden from {client.name}. Their history is kept.</p>
        {confirmArchive && failure && <p className="form-field__error" role="alert">{failure.error}</p>}
      </ConfirmDialog>
    </SidePanel>
  )
}
