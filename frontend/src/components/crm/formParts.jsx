import { useCallback, useState } from 'react'

/** A labelled input with its hint and its own error underneath (errors sit next to the field). */
export function Field({ id, label, required, hint, error, children }) {
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

/** Optional fields, folded away until asked for. */
export function MoreDetails({ children, open = false, label = 'More details' }) {
  return (
    <details className="more-details" open={open || undefined}>
      <summary>{label}</summary>
      <div className="more-details__body">{children}</div>
    </details>
  )
}

/**
 * The one message above the fields, only when it is not about a single field: the server's
 * reason (403, 409) or a stale write, which offers Reload (what was typed stays in the form).
 */
export function FormAlert({ failure, onReload }) {
  if (!failure) return null
  const fieldOnly = !failure.stale && failure.status === 422 && Object.keys(failure.errors ?? {}).length > 0
  if (fieldOnly) return null
  return (
    <div className="form-error" role="alert">
      {failure.error}
      {failure.stale && onReload && (
        <button type="button" className="btn form-error__reload" onClick={onReload}>Reload</button>
      )}
    </div>
  )
}

/** Cancel + the panel's one main button (submits the form with this id). */
export function PanelButtons({ formId, busy, submitLabel, onCancel, tone = 'primary' }) {
  return (
    <>
      <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
      <button type="submit" form={formId} className={`btn btn--${tone}`} disabled={busy} aria-busy={busy}>
        {busy ? 'Saving…' : submitLabel}
      </button>
    </>
  )
}

/** Form state for a side panel: values, field errors, the server's failure, and a pending flag. */
export function usePanelForm(initialValues) {
  const [initial] = useState(initialValues) // what the panel opened with (see changedFields)
  const [values, setValues] = useState(initialValues)
  const [errors, setErrors] = useState({})
  const [failure, setFailure] = useState(null)
  const [busy, setBusy] = useState(false)

  const set = useCallback((field) => (e) => {
    const value = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e
    setValues((prev) => ({ ...prev, [field]: value }))
    setErrors((prev) => {
      if (!prev[field]) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })
  }, [])

  /** Local errors stop it before sending; otherwise send() and hand a success to onDone. */
  const submit = useCallback(async (localErrors, send, onDone) => {
    if (Object.keys(localErrors).length) {
      setErrors(localErrors)
      setFailure(null)
      return
    }
    setBusy(true)
    setFailure(null)
    const result = await send()
    setBusy(false)
    if (result.ok) onDone(result)
    else {
      setErrors(result.errors ?? {})
      setFailure(result)
    }
  }, [])

  /** aria wiring for an input named `name` (error and hint ids). */
  const fieldProps = (id, name) => ({
    id,
    'aria-invalid': Boolean(errors[name]) || undefined,
    'aria-describedby': errors[name] ? `${id}-error` : undefined,
  })

  /**
   * Only the fields this person changed since the panel opened, from `fields` (keyed like the
   * form). An edit sends just these, so a Reload-and-retry after a 409 never overwrites what
   * someone else changed in the other fields.
   */
  const changedFields = (fields) => Object.fromEntries(Object.entries(fields)
    .filter(([k]) => JSON.stringify(values[k]) !== JSON.stringify(initial[k])))

  return { values, setValues, set, errors, setErrors, failure, busy, submit, fieldProps, changedFields }
}

/** "Saved." plus any server warnings, as one short line. */
export function successText(result) {
  const warnings = (result.warnings ?? []).map((w) => w.message ?? w).filter(Boolean)
  return [result.message, ...warnings].filter(Boolean).join(' ')
}
