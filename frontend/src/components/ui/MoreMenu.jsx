import { useCallback, useRef, useState } from 'react'
import useDismiss from '../../lib/useDismiss.js'

/** "⋯ More" for rare actions (Transfer owner, Archive, ...). items: [{ label, onSelect, tone }]. Hidden when empty. */
export default function MoreMenu({ items, label = 'More' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  if (!items.length) return null
  return (
    <div className="popover-anchor" ref={ref}>
      <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">⋯</span> {label}
      </button>
      {open && (
        <div className="popover more-menu" role="menu">
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem"
              className={`more-menu__item${item.tone === 'danger' ? ' more-menu__item--danger' : ''}`}
              onClick={() => { setOpen(false); item.onSelect() }}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
