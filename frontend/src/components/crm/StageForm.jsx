import { useState } from 'react'
import SidePanel from '../ui/SidePanel.jsx'
import ConfirmDialog from '../ui/ConfirmDialog.jsx'
import { Field, FormAlert, PanelButtons, successText, usePanelForm } from './formParts.jsx'
import { useOpportunityActions } from '../../data/hooks.js'
import { stageLabel, validateStageMove } from '../../domain/crm.js'
import { LOST_REASONS, LOST_REASON_OTHER, OPPORTUNITY_STAGE } from '../../domain/status.js'

const FORM_ID = 'stage-form'
const LOST = OPPORTUNITY_STAGE.LOST

/**
 * Move stage by hand (recorded as "Changed by hand"), or Mark lost (lost = true: the stage is
 * fixed to Lost, a reason from the list is required, and a confirmation follows). Won is never
 * offered: it is set only when a proposal is accepted. Reopening a Lost opportunity needs a note.
 */
export default function StageForm({ opportunity, targets, lost = false, onClose, onSaved, onReload }) {
  const actions = useOpportunityActions(opportunity)
  const [confirming, setConfirming] = useState(false)
  const form = usePanelForm({ stage: lost ? LOST : '', lostReason: '', note: '' })
  const { values, set, errors, setErrors, failure, busy, submit, fieldProps } = form
  const reopening = opportunity.stage === LOST
  const choices = targets.filter((s) => lost || s !== LOST) // Lost has its own action (Mark lost)
  const toLost = values.stage === LOST
  const noteRequired = reopening || (toLost && values.lostReason === LOST_REASON_OTHER)

  const send = () => submit({}, () => actions.move({
    stage: values.stage, ...(toLost ? { lostReason: values.lostReason } : {}), ...(values.note.trim() ? { note: values.note } : {}),
  }), (result) => {
    setConfirming(false)
    onSaved(result, successText(result))
  })

  const onSubmit = (e) => {
    e.preventDefault()
    const checked = validateStageMove(opportunity, values)
    if (!checked.ok) {
      setErrors(Object.keys(checked.errors).length ? checked.errors : { stage: checked.error })
      return
    }
    if (toLost) setConfirming(true) // the only stage change that asks first
    else send()
  }

  return (
    <SidePanel
      open
      title={lost ? 'Mark lost' : 'Move stage'}
      subtitle={`${opportunity.id} · now ${stageLabel(opportunity.stage)}`}
      onClose={onClose}
      busy={busy}
      footer={<PanelButtons formId={FORM_ID} busy={busy} onCancel={onClose} tone={lost ? 'danger' : 'primary'}
        submitLabel={lost ? 'Mark lost' : 'Move'} />}
    >
      <form id={FORM_ID} className="stack-form" onSubmit={onSubmit} noValidate>
        <FormAlert failure={confirming ? null : failure} onReload={onReload} />

        {!lost && (
          <Field id="sf-stage" label="New stage" required error={errors.stage}
            hint="Confirmed is set only when a proposal is confirmed. To record a loss, use Mark lost.">
            <select {...fieldProps('sf-stage', 'stage')} value={values.stage} onChange={set('stage')}>
              <option value="">Choose…</option>
              {choices.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
            </select>
          </Field>
        )}

        {toLost && (
          <Field id="sf-reason" label="Why was it lost?" required error={errors.lostReason ?? (lost ? errors.stage : null)}>
            <select {...fieldProps('sf-reason', 'lostReason')} value={values.lostReason} onChange={set('lostReason')}>
              <option value="">Choose…</option>
              {LOST_REASONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </Field>
        )}

        <Field id="sf-note" label={reopening ? 'Why is it reopened?' : 'Note'} required={noteRequired} error={errors.note}>
          <textarea rows={3} maxLength={1000} {...fieldProps('sf-note', 'note')} value={values.note} onChange={set('note')} />
        </Field>
      </form>

      <ConfirmDialog
        open={confirming}
        title={`Mark ${opportunity.id} as lost?`}
        confirmLabel="Mark lost"
        tone="danger"
        busy={busy}
        onConfirm={send}
        onCancel={() => setConfirming(false)}
      >
        <p>Reason: {LOST_REASONS.find((r) => r.id === values.lostReason)?.label}. It can be reopened later with a note.</p>
        {confirming && failure && <p className="form-field__error" role="alert">{failure.error}</p>}
      </ConfirmDialog>
    </SidePanel>
  )
}
