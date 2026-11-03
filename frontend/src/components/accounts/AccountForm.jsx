import SidePanel from '../ui/SidePanel.jsx'
import { Field, FormAlert, MoreDetails, PanelButtons, successText, usePanelForm } from '../crm/formParts.jsx'
import { useAccountActions, useConfig, useCreateAccount, useCurrentUser, useTeam } from '../../data/hooks.js'
import { BRANDS } from '../../domain/brands.js'
import { PRIVILEGES, PRIVILEGE, defaultPrivileges, privilegesOf } from '../../domain/access.js'
import { checkAccountUpdate, validateAccountFields } from '../../domain/accounts.js'
import { ROLE, ROLE_CONFIG, ROLE_IDS } from '../../domain/roles.js'

const FORM_ID = 'account-form'

/**
 * New account (account = null) or Edit. Essentials first: full name, work email, job title,
 * role(s) and, for an Account Manager, the brand. Privileges sit under "Access"; choosing roles
 * turns on those roles' usual switches, which can then be changed. The server checks everything
 * again (unique email, the safeguards, who may do this).
 */
export default function AccountForm({ account = null, onClose, onSaved, onReload }) {
  const editing = Boolean(account)
  const { user: me } = useCurrentUser()
  const { data: config } = useConfig()
  const users = useTeam().data
  const creator = useCreateAccount()
  const actions = useAccountActions(account)
  const isSelf = editing && account.id === me.id

  const form = usePanelForm({
    name: account?.name ?? '', email: account?.email ?? '', jobTitle: account?.jobTitle ?? '',
    roles: account?.roles ?? [], brand: account?.brand ?? '',
    privileges: account ? privilegesOf(account) : defaultPrivileges([]),
  })
  const { values, set, setValues, errors, setErrors, failure, busy, submit, fieldProps } = form
  const isAM = values.roles.includes(ROLE.ACCOUNT_MANAGER)

  const toggleRole = (role) => (e) => {
    setValues((prev) => {
      const roles = e.target.checked ? [...prev.roles, role] : prev.roles.filter((r) => r !== role)
      return { ...prev, roles, privileges: defaultPrivileges(roles) } // each role's usual switches
    })
    setErrors((prev) => ({ ...prev, roles: undefined, privileges: undefined }))
  }
  const togglePrivilege = (id) => (e) => {
    setValues((prev) => ({ ...prev, privileges: { ...prev.privileges, [id]: e.target.checked } }))
    setErrors((prev) => ({ ...prev, privileges: undefined }))
  }

  const onSubmit = (e) => {
    e.preventDefault()
    const fields = { name: values.name, email: values.email, jobTitle: values.jobTitle, roles: values.roles,
      brand: isAM ? values.brand : null, privileges: values.privileges }
    const checked = validateAccountFields(fields, { users, id: account?.id ?? null })
    const local = { ...checked.errors }
    if (editing && !Object.keys(local).length) {
      Object.assign(local, checkAccountUpdate(account, checked.values,
        { actorId: me.id, users, routing: config.routing }).errors)
    }
    submit(local, () => (editing ? actions.update(form.changedFields(fields)) : creator.create(fields)),
      (result) => onSaved(result, successText(result)))
  }

  return (
    <SidePanel
      open
      title={editing ? 'Edit account' : 'New account'}
      subtitle={editing ? account.name : 'They can use IEE as soon as it is saved.'}
      onClose={onClose}
      busy={busy}
      footer={<PanelButtons formId={FORM_ID} busy={busy} onCancel={onClose} submitLabel={editing ? 'Save changes' : 'Create account'} />}
    >
      <form id={FORM_ID} className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={failure} onReload={onReload} />

        <Field id="af-name" label="Full name" required error={errors.name}>
          <input type="text" autoComplete="name" maxLength={200} {...fieldProps('af-name', 'name')}
            value={values.name} onChange={set('name')} />
        </Field>
        <Field id="af-email" label="Work email" required error={errors.email}>
          <input type="email" autoComplete="email" maxLength={254} {...fieldProps('af-email', 'email')}
            value={values.email} onChange={set('email')} />
        </Field>
        <Field id="af-title" label="Job title" error={errors.jobTitle}>
          <input type="text" maxLength={200} {...fieldProps('af-title', 'jobTitle')} value={values.jobTitle} onChange={set('jobTitle')} />
        </Field>

        <fieldset className="form-field" aria-describedby={errors.roles ? 'af-roles-error' : undefined}>
          <legend className="form-field__label">Roles <span aria-hidden="true">*</span></legend>
          <div className="check-list">
            {ROLE_IDS.map((r) => (
              <label key={r} className="form-check">
                <input type="checkbox" checked={values.roles.includes(r)} onChange={toggleRole(r)} />
                <span>{ROLE_CONFIG[r].label}<span className="form-field__hint">{ROLE_CONFIG[r].description}</span></span>
              </label>
            ))}
          </div>
          {errors.roles && <span className="form-field__error" id="af-roles-error" role="alert">{errors.roles}</span>}
        </fieldset>

        {isAM && (
          <Field id="af-brand" label="Brand" required error={errors.brand} hint="The brand this Account Manager works for.">
            <select {...fieldProps('af-brand', 'brand')} value={values.brand} onChange={set('brand')}>
              <option value="">Choose…</option>
              {BRANDS.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        )}

        <MoreDetails label="Access" open={Boolean(errors.privileges)}>
          <p className="form-field__hint">Each role turns on its usual switches; change them if needed. Switches only widen what
            a person sees; they never allow work outside the role.</p>
          <div className="check-list">
            {PRIVILEGES.map((p) => (isSelf && p.id === PRIVILEGE.MANAGE_ACCOUNTS && values.privileges[p.id] ? (
              <p key={p.id} className="muted">{p.label}: on. You cannot remove your own.</p>
            ) : (
              <label key={p.id} className="form-check">
                <input type="checkbox" checked={values.privileges[p.id]} onChange={togglePrivilege(p.id)} />
                <span>{p.label}<span className="form-field__hint">{p.description}</span></span>
              </label>
            )))}
          </div>
          {errors.privileges && <span className="form-field__error" role="alert">{errors.privileges}</span>}
        </MoreDetails>
      </form>
    </SidePanel>
  )
}
