import { useEffect, useRef } from 'react'
import Icon from './Icon.jsx'

/**
 * A form panel that slides in from the right (native <dialog>: focus stays inside, Escape closes).
 * Forms open here instead of on a new page. `footer` holds the panel's buttons.
 */
export default function SidePanel({ open, title, subtitle, onClose, children, footer, busy = false }) {
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
      className="side-panel"
      aria-labelledby="side-panel-title"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onClose()
      }}
    >
      {open && (
        <div className="side-panel__inner">
          <header className="side-panel__header">
            <div>
              <h2 id="side-panel-title" className="side-panel__title">{title}</h2>
              {subtitle && <p className="side-panel__subtitle">{subtitle}</p>}
            </div>
            <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close">
              <Icon name="x" size={18} />
            </button>
          </header>
          <div className="side-panel__body">{children}</div>
          {footer && <footer className="side-panel__footer">{footer}</footer>}
        </div>
      )}
    </dialog>
  )
}
