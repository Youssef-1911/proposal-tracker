import { getBrand } from '../../domain/brands.js'
import { PRIVILEGES } from '../../domain/access.js'
import { roleLabel } from '../../domain/roles.js'
import RelTime from '../ui/RelTime.jsx'

const FIELD_LABELS = { name: 'Name', email: 'Work email', jobTitle: 'Job title', roles: 'Roles', brand: 'Brand' }
const PRIVILEGE_LABELS = Object.fromEntries(PRIVILEGES.map((p) => [`privileges.${p.id}`, p.label]))

function show(field, value) {
  if (value === null || value === undefined || value === '') return '—'
  if (field === 'roles') return value.map((r) => roleLabel(r)).join(' · ')
  if (field === 'brand') return getBrand(value)?.name ?? value
  if (field.startsWith('privileges.')) return value ? 'On' : 'Off'
  return String(value)
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

function eventText(h) {
  switch (h.event) {
    case 'created': return 'Account created'
    case 'updated': return 'Account changed'
    case 'deactivated': {
      const owned = h.details?.owned
      const still = owned && (owned.clients || owned.openRequests)
        ? ` while still owning ${plural(owned.clients, 'client', 'clients')} and ${plural(owned.openRequests, 'open request', 'open requests')}`
        : ''
      return `Deactivated${still}`
    }
    case 'reactivated': return 'Reactivated'
    default: return h.event
  }
}

/** An account's history, newest first: who, when, and what changed (old → new). */
export function AccountHistoryList({ items, usersById }) {
  if (!items.length) return <p className="muted">No changes recorded yet.</p>
  return (
    <ol className="history-list">
      {items.map((h) => {
        const by = usersById[h.changedBy]
        return (
          <li key={h.id}>
            <div>{eventText(h)}</div>
            <div className="muted">{by?.name ?? h.changedBy} ({roleLabel(h.role, by)}) · <RelTime value={h.changedAt} /></div>
            {h.event === 'updated' && h.details && (
              <ul className="history-changes">
                {Object.entries(h.details).map(([field, change]) => (
                  <li key={field}>
                    {FIELD_LABELS[field] ?? PRIVILEGE_LABELS[field] ?? field}:{' '}
                    <span className="muted">{show(field, change.from)}</span> → {show(field, change.to)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ol>
  )
}
