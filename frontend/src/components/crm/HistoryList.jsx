import { Link } from 'react-router-dom'
import StatusBadge from '../ui/StatusBadge.jsx'
import { BRANDS, getBrand, serviceLabel } from '../../domain/brands.js'
import { CLIENT_TYPES } from '../../domain/catalog.js'
import { roleLabel } from '../../domain/roles.js'
import { lostReasonLabel } from '../../domain/status.js'
import { formatCurrency, formatDate, formatEventDate, formatNumber } from '../../lib/format.js'
import RelTime from '../ui/RelTime.jsx'
import { opportunityLink, proposalLink } from '../../lib/links.js'

/** Field names in history entries, in words. */
const FIELD_LABELS = {
  name: 'Name', type: 'Type', brands: 'Brands', city: 'City', notes: 'Notes',
  title: 'Job title', phone: 'Phone', email: 'Email', primary: 'Main contact',
  brand: 'Brand', service: 'Service', estimatedValue: 'Estimated value', participants: 'Participants',
  eventDatePrecision: 'Event date precision', eventDate: 'Event date', nextAction: 'Next action',
  nextActionDate: 'Next action date',
}

function show(field, value) {
  if (value === null || value === undefined || value === '') return '—'
  switch (field) {
    case 'type': return CLIENT_TYPES[value]?.label ?? value
    case 'brands': return value.map((b) => getBrand(b)?.name ?? b).join(' · ')
    case 'brand': return getBrand(value)?.name ?? value
    case 'service': return BRANDS.flatMap((b) => b.services).find((s) => s.id === value)?.label ?? value
    case 'estimatedValue': return formatCurrency(value)
    case 'participants': return formatNumber(value)
    case 'eventDate': return formatEventDate(value)
    case 'nextActionDate': return formatDate(value)
    case 'eventDatePrecision': return value === 'month' ? 'Month only' : 'Exact date'
    case 'primary': return value ? 'Yes' : 'No'
    default: return String(value)
  }
}

/** "City: Maadi → Smouha" for each changed field. */
function Changes({ changes }) {
  if (!changes || !Object.keys(changes).length) return null
  return (
    <ul className="history-changes">
      {Object.entries(changes).map(([field, { from, to }]) => (
        <li key={field}>
          {FIELD_LABELS[field] ?? field}: <span className="muted">{show(field, from)}</span> → {show(field, to)}
        </li>
      ))}
    </ul>
  )
}

function Who({ entry, usersById }) {
  const user = usersById[entry.changedBy]
  return (
    <div className="muted">
      {user?.name ?? entry.changedBy} ({roleLabel(entry.role, user)}) · <RelTime value={entry.changedAt} />
    </div>
  )
}

const nameOf = (usersById, id) => usersById[id]?.name ?? id

function clientEventText(h, usersById) {
  const d = h.details ?? {}
  switch (h.event) {
    case 'created': return `Client added, owned by ${nameOf(usersById, d.owner)}`
    case 'updated': return 'Details changed'
    case 'archived': return h.reason?.startsWith('Merged into') ? `Client archived: ${h.reason}` : 'Client archived'
    case 'owner_transferred': {
      const moved = [`${d.opportunities?.length ?? 0} open opportunit${d.opportunities?.length === 1 ? 'y' : 'ies'}`]
      if (d.moveRequests) moved.push(`${d.requests?.length ?? 0} open request${d.requests?.length === 1 ? '' : 's'}`)
      return `Owner transferred from ${nameOf(usersById, d.from)} to ${nameOf(usersById, d.to)} (with ${moved.join(' and ')})`
    }
    case 'contact_added': return `Contact added: ${d.name}${d.primary ? ' (main contact)' : ''}`
    case 'contact_updated': return `Contact changed: ${d.name}`
    case 'contact_archived': return `Contact archived: ${d.name}`
    case 'opportunity_added': return 'Opportunity added'
    case 'clients_merged': {
      const from = (d.mergedFrom ?? []).map((c) => c.name).join(', ')
      const n = d.requests?.length ?? 0
      return `Merged in: ${from} (${n} request${n === 1 ? '' : 's'} moved here)`
    }
    default: return h.event
  }
}

/** A client's history, newest first: who, when and what changed. limit shows only the latest few. */
export function ClientHistoryList({ items, usersById, limit = null, empty = 'No changes recorded yet.' }) {
  const shown = limit ? items.slice(0, limit) : items
  if (!shown.length) return <p className="muted">{empty}</p>
  return (
    <ol className="history-list">
      {shown.map((h) => (
        <li key={h.id}>
          <div>
            {clientEventText(h, usersById)}
            {h.event === 'opportunity_added' && h.details?.opportunityId && (
              <> · <Link to={opportunityLink(h.details.opportunityId)}>{h.details.opportunityId}</Link></>
            )}
          </div>
          <Who entry={h} usersById={usersById} />
          {h.event === 'updated' && <Changes changes={h.details} />}
          {h.event === 'contact_updated' && <Changes changes={h.details?.changes} />}
          {h.reason && <blockquote className="timeline__note">{h.reason}</blockquote>}
        </li>
      ))}
    </ol>
  )
}

/** Why an opportunity's stage changed (history reason codes), in words. */
const REASONS = {
  created: 'Created',
  seed: 'Demo data',
  proposal_requested: 'Proposal requested',
  proposal_shared: 'Proposal shared with the client',
  proposal_accepted: 'Proposal confirmed (Mark confirmed)',
  proposal_rejected: 'Proposal lost (Mark lost)',
  reopened_after_acceptance: 'Reopened: a proposal was accepted',
  reopened: 'Reopened',
  manual_change: 'Changed by hand',
}

/** An opportunity's history, newest first: stage changes (with reasons) and detail edits. */
export function OpportunityHistoryList({ items, usersById, limit = null, empty = 'No changes recorded yet.' }) {
  const shown = limit ? items.slice(0, limit) : items
  if (!shown.length) return <p className="muted">{empty}</p>
  return (
    <ol className="history-list">
      {shown.map((h) => (
        <li key={h.id}>
          {h.reasonCode === 'details_updated' ? (
            <div>Details changed</div>
          ) : (
            <div>
              {h.fromStage ? <StatusBadge kind="opportunity" status={h.fromStage} /> : <span className="muted">New</span>}
              {' → '}
              <StatusBadge kind="opportunity" status={h.toStage} />
              <span className="muted"> · {REASONS[h.reasonCode] ?? h.reasonCode ?? 'Stage change'}</span>
            </div>
          )}
          <Who entry={h} usersById={usersById} />
          {h.sourceRequestId && <div className="muted">From <Link to={proposalLink(h.sourceRequestId)}>{h.sourceRequestId}</Link></div>}
          {h.reasonCode === 'details_updated' && <Changes changes={h.details} />}
          {h.lostReason && <div>Lost reason: {lostReasonLabel(h.lostReason)}</div>}
          {h.note && h.note !== h.lostReason && <blockquote className="timeline__note">{h.note}</blockquote>}
        </li>
      ))}
    </ol>
  )
}

/** "Grasshoppers · School trip" */
export function brandService(o) {
  return `${getBrand(o.brand)?.name} · ${serviceLabel(o.brand, o.service)}`
}
