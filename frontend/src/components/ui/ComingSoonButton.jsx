import { useCallback, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import useDismiss from '../../lib/useDismiss.js'

/**
 * A real-looking call to action whose workflow isn't built yet. Clicking it
 * explains that instead of pretending something happened.
 */
export default function ComingSoonButton({ icon = 'plus', label, message, variant = 'primary' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)

  return (
    <div className="popover-anchor" ref={ref}>
      <button
        type="button"
        className={`btn${variant === 'primary' ? ' btn--primary' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={icon} size={16} strokeWidth={2} />
        {label}
      </button>
      {open && (
        <div className="popover" role="status" style={{ inlineSize: 280 }}>
          <div className="popover__section">
            <div className="popover__title">Coming in the next phase</div>
            <p className="popover__text">{message}</p>
          </div>
        </div>
      )}
    </div>
  )
}
