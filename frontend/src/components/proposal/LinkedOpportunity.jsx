import { Link } from 'react-router-dom'
import Card from '../ui/Card.jsx'
import StatusBadge from '../ui/StatusBadge.jsx'
import { Person } from '../dashboard/cells.jsx'
import { serviceLabel } from '../../domain/brands.js'
import { formatCurrency, formatEventDate } from '../../lib/format.js'
import { clientLink, opportunityLink } from '../../lib/links.js'

export default function LinkedOpportunity({ opportunity, client, usersById }) {
  return (
    <Card title="Linked opportunity">
      {!opportunity ? (
        <p className="muted">This request is not linked to an opportunity.</p>
      ) : (
        <dl className="field-list field-list--1">
          <div className="field">
            <dt>Opportunity</dt>
            <dd>
              <Link to={opportunityLink(opportunity.id)}>{opportunity.id}</Link>
              <span className="field__hint">
                {client ? <Link to={clientLink(client.id)}>{client.name}</Link> : null} · {serviceLabel(opportunity.brand, opportunity.service)}
              </span>
            </dd>
          </div>
          <div className="field">
            <dt>Stage</dt>
            <dd><StatusBadge kind="opportunity" status={opportunity.stage} /></dd>
          </div>
          <div className="field">
            <dt>Estimated value</dt>
            <dd>
              {formatCurrency(opportunity.estimatedValue)}
              <span className="field__hint">Sales estimate, not the AM price</span>
            </dd>
          </div>
          <div className="field">
            <dt>Owner</dt>
            <dd><Person user={usersById[opportunity.owner]} /></dd>
          </div>
          <div className="field">
            <dt>Event</dt>
            <dd>{formatEventDate(opportunity.eventDate, opportunity.eventEndDate)}</dd>
          </div>
        </dl>
      )}
    </Card>
  )
}
