import { useState } from 'react'
import { useCurrentUser, useLookups, useReminders } from '../../data/hooks.js'
import { canRemind, remindTarget } from '../../domain/reminders.js'
import { formatDateTime } from '../../lib/format.js'

/**
 * "Remind <name>": one notification to the person this request waits on, listing everything waiting on
 * them. Shown only to people who may send it; once sent, it says when the next one is possible (24 hours).
 */
export default function RemindButton({ request, compact = false }) {
  const { user, activeRole } = useCurrentUser()
  const { usersById } = useLookups()
  const { available, nextAt, remind } = useReminders()
  const [state, setState] = useState(null) // { busy } | { text }
  if (!available || !canRemind(request, { userId: user.id, activeRole }, usersById).allowed) return null
  const target = remindTarget(request)
  const name = usersById[target]?.name?.split(' ')[0] ?? 'them'
  if (state?.text) return <span className="muted remind-note">{state.text}</span>
  if (nextAt[target]) {
    return <span className="muted remind-note">Reminded · next possible {formatDateTime(nextAt[target])}</span>
  }
  const send = async (e) => {
    e.stopPropagation()
    setState({ busy: true })
    const result = await remind(request.id)
    setState({ text: result.ok ? result.message : result.error })
  }
  return (
    <button type="button" className={`btn ${compact ? 'btn--sm' : ''}`} disabled={state?.busy} aria-busy={state?.busy} onClick={send}>
      Remind {name}
    </button>
  )
}
