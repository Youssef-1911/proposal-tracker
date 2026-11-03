import { useState } from 'react'
import { Link } from 'react-router-dom'
import Card from './ui/Card.jsx'
import MoreMenu from './ui/MoreMenu.jsx'
import { useCurrentUser, useRadar } from '../data/hooks.js'
import { ROLE } from '../domain/roles.js'

/** Where "Create request from previous" goes: the request form, prefilled from that request (dates left empty). */
export const fromPreviousLink = (item) => `/proposals/new?from=${encodeURIComponent(item.sourceRequestId)}&radar=1`

/**
 * "Likely to book soon", a tab on Clients: BD their own clients; Noha and Executives every client, grouped by
 * BD owner (everything shown; nothing to show says so). Each item: one plain sentence, "Create request from previous" and
 * "Not this time" (hidden until the next occurrence, with an optional reason).
 */
export default function RadarSection() {
  const { activeRole } = useCurrentUser()
  const radar = useRadar()
  const [dismissing, setDismissing] = useState(null) // the item being dismissed
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState(null)
  const items = radar.data?.items ?? []
  if (!radar.available) return null
  if (!radar.data) return <Card><p className="muted" role="status">{radar.error ? radar.error.message : 'Loading…'}</p></Card>
  if (!items.length) return <Card><p className="muted">No client looks likely to book soon right now.</p></Card>
  const grouped = [ROLE.COMMERCIAL_HEAD, ROLE.EXECUTIVE].includes(activeRole)
  const shown = items
  const groups = grouped
    ? [...new Set(shown.map((i) => i.bdOwnerName ?? '—'))].sort().map((name) => ({ name, items: shown.filter((i) => (i.bdOwnerName ?? '—') === name) }))
    : [{ name: null, items: shown }]
  const send = async () => {
    const result = await radar.dismiss(dismissing, reason.trim() || null)
    setMessage(result.ok ? result.message : result.error)
    setDismissing(null)
    setReason('')
  }
  return (
    <Card id="radar" title={`Likely to book soon (${items.length})`} subtitle="From past occasions and how often each client books">
      {message && <p className="muted" role="status">{message}</p>}
      {groups.map((g) => (
        <section key={g.name ?? 'all'} aria-label={g.name ?? 'Your clients'}>
          {g.name && <h3 className="table-group-title">{g.name} <span className="muted tabular">{g.items.length}</span></h3>}
          <ul className="radar-list">
            {g.items.map((i) => (
              <li key={`${i.clientId}:${i.signal}`} className="radar-item">
                <span className="radar-item__text">{i.sentence}{!grouped && i.bdOwnerName ? '' : ''}</span>
                {dismissing === i ? (
                  <span className="radar-item__dismiss">
                    <input aria-label="Why not this time (optional)" placeholder="Why? (optional)" maxLength={300} value={reason}
                      onChange={(e) => setReason(e.target.value)} />
                    <button type="button" className="btn btn--sm" onClick={send}>Hide until next time</button>
                    <button type="button" className="link-btn" onClick={() => setDismissing(null)}>Back</button>
                  </span>
                ) : (
                  <span className="radar-item__actions">
                    <Link className="btn btn--sm" to={fromPreviousLink(i)}>Create request from previous</Link>
                    <MoreMenu items={[{ label: 'Not this time', onSelect: () => setDismissing(i) }]} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Card>
  )
}
