import SidePanel from '../ui/SidePanel.jsx'
import { Field, FormAlert, PanelButtons, successText, usePanelForm } from '../crm/formParts.jsx'
import { useLookups, useTeam } from '../../data/hooks.js'
import { getBrand } from '../../domain/brands.js'
import { routingChoices, validateRouting } from '../../domain/accounts.js'

const FORM_ID = 'routing-form'

/**
 * Choose which Account Manager receives a brand's NEW requests (active Account Managers of
 * that brand only). Existing requests keep their Account Manager.
 */
export default function RoutingForm({ item, routing, onSave, onClose, onSaved, onReload }) {
  const brand = getBrand(item.brand)
  const { usersById } = useLookups()
  const users = useTeam().data
  const choices = routingChoices(item.brand, users)
  const form = usePanelForm({ amUserId: item.amUserId ?? '' })
  const { values, set, errors, failure, busy, submit, fieldProps } = form

  const onSubmit = (e) => {
    e.preventDefault()
    const { errors: local } = validateRouting(item.brand, values.amUserId, { users, routing })
    const mapped = local.amId ? { amUserId: local.amId } : local
    submit(mapped, () => onSave(item.brand, values.amUserId, item.rowVersion), (result) => onSaved(result, successText(result)))
  }

  return (
    <SidePanel
      open
      title={`${brand.name} routing`}
      subtitle={`Now: ${usersById[item.amUserId]?.name ?? 'nobody'}`}
      onClose={onClose}
      busy={busy}
      footer={<PanelButtons formId={FORM_ID} busy={busy} onCancel={onClose} submitLabel="Save routing" />}
    >
      <form id={FORM_ID} className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={failure} onReload={onReload} />
        <Field id="rf-am" label="New requests go to" required error={errors.amUserId ?? errors.amId}
          hint="Existing requests keep their Account Manager.">
          <select {...fieldProps('rf-am', 'amUserId')} value={values.amUserId} onChange={set('amUserId')}>
            {choices.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
      </form>
    </SidePanel>
  )
}
