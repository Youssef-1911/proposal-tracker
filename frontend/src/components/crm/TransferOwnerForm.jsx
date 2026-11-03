import { useState } from 'react'
import SidePanel from '../ui/SidePanel.jsx'
import ConfirmDialog from '../ui/ConfirmDialog.jsx'
import { Field, FormAlert, PanelButtons, successText, usePanelForm } from './formParts.jsx'
import { useClientActions, useLookups, useUsers } from '../../data/hooks.js'
import { validateTransfer } from '../../domain/crm.js'
import { ROLE } from '../../domain/roles.js'

const FORM_ID = 'transfer-form'
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/**
 * Commercial Head only: give the client to another Business Development owner, with a reason.
 * Its open opportunities always move. "Also move N open requests" (ticked by default) moves the
 * open proposal requests too; closed requests and drafts never move. A confirmation follows.
 */
export default function TransferOwnerForm({ client, onClose, onSaved, onReload }) {
  const actions = useClientActions(client)
  const { usersById } = useLookups()
  const users = useUsers().data
  const [confirming, setConfirming] = useState(false)
  const form = usePanelForm({ toOwner: '', reason: '', moveRequests: true })
  const { values, set, errors, setErrors, failure, busy, submit, fieldProps } = form
  const bds = users.filter((u) => u.roles.includes(ROLE.BUSINESS_DEVELOPMENT) && u.id !== client.owner)
  const preview = client.transferPreview ?? { openOpportunityCount: 0, openRequestCount: 0 }
  const newOwner = usersById[values.toOwner]
  const from = usersById[client.owner]?.name ?? client.owner

  const onSubmit = (e) => {
    e.preventDefault()
    const { errors: local } = validateTransfer(client, values, usersById)
    if (Object.keys(local).length) setErrors(local)
    else setConfirming(true)
  }

  const send = () => submit({}, () => actions.transfer({
    toOwner: values.toOwner, reason: values.reason, moveRequests: preview.openRequestCount > 0 && values.moveRequests,
  }), (result) => {
    setConfirming(false)
    onSaved(result, successText(result))
  })

  const moving = [
    plural(preview.openOpportunityCount, 'open opportunity', 'open opportunities'),
    ...(values.moveRequests && preview.openRequestCount ? [plural(preview.openRequestCount, 'open request', 'open requests')] : []),
  ]

  return (
    <SidePanel
      open
      title="Transfer owner"
      subtitle={`${client.name} · now owned by ${from}`}
      onClose={onClose}
      busy={busy}
      footer={<PanelButtons formId={FORM_ID} busy={busy} onCancel={onClose} submitLabel="Transfer" />}
    >
      <form id={FORM_ID} className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={confirming ? null : failure} onReload={onReload} />
        <Field id="tf-owner" label="New owner" required error={errors.toOwner}>
          <select {...fieldProps('tf-owner', 'toOwner')} value={values.toOwner} onChange={set('toOwner')}>
            <option value="">Choose…</option>
            {bds.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        <Field id="tf-reason" label="Reason" required error={errors.reason} hint="Saved in the client's history.">
          <textarea rows={3} maxLength={500} {...fieldProps('tf-reason', 'reason')} value={values.reason} onChange={set('reason')} />
        </Field>
        {preview.openRequestCount > 0 ? (
          <label className="form-check">
            <input type="checkbox" checked={values.moveRequests} onChange={set('moveRequests')} />
            <span>
              Also move {plural(preview.openRequestCount, 'open request', 'open requests')} to {newOwner?.name ?? 'the new owner'}
              <span className="form-field__hint">Closed requests and drafts stay with their current owner.</span>
            </span>
          </label>
        ) : (
          <p className="muted">No open requests to move. Closed requests and drafts stay with their current owner.</p>
        )}
      </form>

      <ConfirmDialog
        open={confirming}
        title={`Transfer ${client.name} to ${newOwner?.name}?`}
        confirmLabel="Transfer"
        busy={busy}
        onConfirm={send}
        onCancel={() => setConfirming(false)}
      >
        <p>The client and {moving.join(' and ')} move from {from} to {newOwner?.name}.</p>
        {confirming && failure && <p className="form-field__error" role="alert">{failure.error}</p>}
      </ConfirmDialog>
    </SidePanel>
  )
}
