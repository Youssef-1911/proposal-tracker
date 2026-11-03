import Badge from '../ui/Badge.jsx'
import Card from '../ui/Card.jsx'
import { proposalVersions } from '../../domain/proposals.js'
import { CHANGE_KIND_LABELS, changeKind } from '../../domain/conversation.js'
import { formatCurrency } from '../../lib/format.js'
import RelTime from '../ui/RelTime.jsx'
import { API_MODE } from '../../data/source.js'

/** Current version/price and earlier versions, all from status history. Prices are never invented. */
export default function ProposalVersions({ request, usersById }) {
  const versions = proposalVersions(request)
  const hasPrice = request.amPrice !== null && request.amPrice !== undefined

  return (
    <Card title="Proposal" subtitle="Versions and AM prices (EGP) from the request history" flush>
      <div className="proposal-current">
        <div>
          <div className="proposal-current__label">Current version</div>
          <div className="proposal-current__value tabular">v{request.version}</div>
        </div>
        <div>
          <div className="proposal-current__label">AM price</div>
          <div className="proposal-current__value">
            {hasPrice ? formatCurrency(request.amPrice) : <span className="muted proposal-current__empty">No price yet</span>}
          </div>
        </div>
      </div>

      {versions.length === 0 ? (
        <p className="data-table__empty">
          No proposal has been prepared yet. A version and price appear here once the Account Manager
          marks the proposal Ready for BD.
        </p>
      ) : (
        <ul className="version-list">
          {versions.map((v) => (
            <li key={v.version} className="version-list__item">
              <span className="version-list__v tabular">v{v.version}</span>
              <span className="version-list__main">
                {v.isPending ? (
                  <span className="muted">In preparation · no price yet</span>
                ) : v.amPrice !== null ? (
                  <strong className="tabular">{formatCurrency(v.amPrice)}</strong>
                ) : (
                  <span className="muted">Price not recorded</span>
                )}
                {changeKind(request, v.version) && (
                  <span className="version-list__meta">{CHANGE_KIND_LABELS[changeKind(request, v.version)]}</span>
                )}
                {v.readyAt && (
                  <span className="version-list__meta">
                    Ready for BD <RelTime value={v.readyAt} /> · {usersById[v.readyBy]?.name ?? '—'}
                  </span>
                )}
              </span>
              {v.isCurrent && <Badge tone="info">Current</Badge>}
            </li>
          ))}
        </ul>
      )}
      {!API_MODE && <p className="card-note">Proposal files need the backend; the demo store has none to download.</p>}
    </Card>
  )
}
