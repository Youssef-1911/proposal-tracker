import { useEffect, useRef } from 'react'

/** Modal confirmation using the native <dialog> element (focus trap + Escape built in). */
export default function ConfirmDialog({ open, title, children, confirmLabel, tone = 'primary', busy = false, onConfirm, onCancel }) {
  const ref = useRef(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="confirm-dialog-title"
      onCancel={(e) => {
        e.preventDefault()
        onCancel()
      }}
    >
      <h2 id="confirm-dialog-title" className="confirm-dialog__title">{title}</h2>
      <div className="confirm-dialog__body">{children}</div>
      <div className="confirm-dialog__actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Go back</button>
        <button type="button" className={`btn btn--${tone}`} onClick={onConfirm} disabled={busy} aria-busy={busy} autoFocus>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
