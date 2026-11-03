import { useEffect, useState } from 'react'
import { prefersReducedMotion } from '../../lib/motion.js'

const EVENT = 'iee:celebrate'
const SHOW_MS = 2600

/** "<Client> is confirmed 🎉" for a moment, after a proposal is marked Confirmed or Initially confirmed. */
export function celebrate(clientName, { initial = false } = {}) {
  const who = clientName || 'The client'
  const text = initial ? `${who} is initially confirmed 🎉` : `${who} is confirmed 🎉`
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { text, at: Date.now() } }))
}

/**
 * Mounted once in the app frame. A short burst (under 1.5 s) around the message; with reduced motion
 * only the message shows. No sound.
 */
export default function Celebration() {
  const [shown, setShown] = useState(null)
  useEffect(() => {
    const on = (e) => setShown({ ...e.detail, still: prefersReducedMotion() })
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [])
  useEffect(() => {
    if (!shown) return undefined
    const t = setTimeout(() => setShown(null), SHOW_MS)
    return () => clearTimeout(t)
  }, [shown])
  if (!shown) return null
  return (
    <div className={`celebrate${shown.still ? ' celebrate--still' : ''}`} role="status" key={shown.at}>
      {!shown.still && (
        <span className="celebrate__burst" aria-hidden="true">
          {Array.from({ length: 12 }, (_, i) => <i key={i} style={{ '--i': i }} />)}
        </span>
      )}
      <span className="celebrate__text">{shown.text}</span>
    </div>
  )
}
