import { useState } from 'react'
import { formatWhen, formatWhenFull } from '../../lib/format.js'

/**
 * A moment shown relatively ("2 h ago", "Yesterday", "Mon"); the full date and time in Cairo on hover,
 * and on tap (touch screens have no hover): tapping switches between the two.
 */
export default function RelTime({ value, className }) {
  const [full, setFull] = useState(false)
  if (!value) return <span className="muted">—</span>
  const long = formatWhenFull(value)
  return (
    <time
      dateTime={typeof value === 'string' ? value : value.toISOString()}
      title={long}
      className={['rel-time', className].filter(Boolean).join(' ')}
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); setFull((f) => !f) }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setFull((f) => !f) } }}
    >
      {full ? long : formatWhen(value)}
    </time>
  )
}
