import { useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import PageLayout from '../components/layout/PageLayout.jsx'
import Card from '../components/ui/Card.jsx'
import DataTable from '../components/ui/DataTable.jsx'
import Icon from '../components/ui/Icon.jsx'
import SegmentedControl from '../components/ui/SegmentedControl.jsx'
import StatusBadge from '../components/ui/StatusBadge.jsx'
import Avatar from '../components/ui/Avatar.jsx'
import Toast, { useRouteToast } from '../components/ui/Toast.jsx'
import OpportunityForm from '../components/crm/OpportunityForm.jsx'
import { brandService } from '../components/crm/HistoryList.jsx'
import { ClientEvent, Person } from '../components/dashboard/cells.jsx'
import { usePageDescription } from './PlaceholderPage.jsx'
import { useCurrentUser, useLookups, useOpportunities, useUsers } from '../data/hooks.js'
import { findNavItem } from '../navigation.js'
import { BRANDS } from '../domain/brands.js'
import { ROLE } from '../domain/roles.js'
import { statusList } from '../domain/status.js'
import { isActiveOpportunity } from '../domain/metrics.js'
import { formatCurrency, formatEventDate } from '../lib/format.js'
import { opportunityLink } from '../lib/links.js'

/**
 * Opportunities: a board by stage with count and estimated value per stage, or a table. Filters
 * (brand, owner) live in the URL; dashboard links may also pass stage and active. The one main
 * action is "New opportunity" (Business Development for their clients, or the Commercial Head).
 */
export default function OpportunitiesPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { createClients } = useCurrentUser()
  const { usersById, clientsById } = useLookups()
  const users = useUsers().data
  const { data: all, isLoading, error } = useOpportunities()
  const subtitle = usePageDescription(findNavItem('/opportunities'))
  const [creating, setCreating] = useState(false)
  const toast = useRouteToast()

  const id = params.get('id')
  if (id) return <Navigate to={opportunityLink(id)} replace />

  const view = params.get('view') === 'table' ? 'table' : 'board'
  const brand = params.get('brand') ?? ''
  const owner = params.get('owner') ?? ''
  const stagesFromLink = (params.get('stage') ?? '').split(',').filter(Boolean)
  const activeOnly = params.get('active') === 'true'
  const update = (key, value) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }
  const clearLinkFilters = () => {
    const next = new URLSearchParams(params)
    next.delete('stage')
    next.delete('active')
    setParams(next, { replace: true })
  }

  const stages = statusList('opportunity').filter((s) => !stagesFromLink.length || stagesFromLink.includes(s.id))
  const opportunities = (all ?? []).filter((o) =>
    (!brand || o.brand === brand) && (!owner || o.owner === owner)
    && (!stagesFromLink.length || stagesFromLink.includes(o.stage)) && (!activeOnly || isActiveOpportunity(o)))
  const shownStages = activeOnly ? stages.filter((s) => !s.closed) : stages
  const bds = users.filter((u) => u.roles.includes(ROLE.BUSINESS_DEVELOPMENT))
  const total = opportunities.reduce((sum, o) => sum + (o.estimatedValue ?? 0), 0)

  // Business Development (for their own clients) and the Commercial Head add opportunities.
  const newButton = createClients.allowed && (
    <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
      <Icon name="plus" size={16} strokeWidth={2.25} /> New opportunity
    </button>
  )

  return (
    <PageLayout title="Opportunities" subtitle={subtitle} actions={newButton || null}>
      <Card flush>
        <div className="page-toolbar">
          <div className="form-field">
            <span className="form-field__label">View</span>
            <SegmentedControl label="View" value={view} onChange={(v) => update('view', v === 'table' ? 'table' : '')}
              options={[{ value: 'board', label: 'Board' }, { value: 'table', label: 'Table' }]} />
          </div>
          <label className="form-field">
            <span className="form-field__label">Brand</span>
            <select value={brand} onChange={(e) => update('brand', e.target.value)}>
              <option value="">Both brands</option>
              {BRANDS.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label className="form-field">
            <span className="form-field__label">Owner</span>
            <select value={owner} onChange={(e) => update('owner', e.target.value)}>
              <option value="">Anyone</option>
              {bds.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          {(stagesFromLink.length > 0 || activeOnly) && (
            <button type="button" className="filter-chip" onClick={clearLinkFilters}>
              {activeOnly ? 'Open opportunities only' : `Stage: ${stages.map((s) => s.label).join(', ')}`}
              <Icon name="x" size={12} strokeWidth={2.25} />
            </button>
          )}
        </div>
        <div className="result-count" role="status" aria-busy={isLoading}>
          {error ? error.message : isLoading && !all
            ? 'Loading…'
            : `${opportunities.length} ${opportunities.length === 1 ? 'opportunity' : 'opportunities'} · ${opportunities.some((o) => o.estimatedValue) ? `${formatCurrency(total)} estimated (not revenue)` : 'no estimates entered yet'}`}
        </div>
      </Card>

      {all && view === 'board' && (
        <div className="board" aria-label="Opportunities by stage">
          {shownStages.map((stage) => {
            const items = opportunities.filter((o) => o.stage === stage.id)
            const value = items.reduce((sum, o) => sum + (o.estimatedValue ?? 0), 0)
            return (
              <section key={stage.id} className="board__column" aria-label={stage.label}>
                <div className="board__head">
                  <span className="board__title"><StatusBadge kind="opportunity" status={stage.id} /></span>
                  <span className="board__meta tabular">{items.length} · {formatCurrency(value)}</span>
                </div>
                {items.length === 0 && <p className="board__empty">None</p>}
                {items.map((o) => (
                  <Link key={o.id} to={opportunityLink(o.id)} className="board__card"
                    aria-label={`${clientsById[o.clientId]?.name ?? o.clientId}, ${brandService(o)}, ${usersById[o.owner]?.name ?? ''}`}>
                    <strong><ClientEvent name={clientsById[o.clientId]?.name ?? o.clientId} eventName={o.eventName} /></strong>
                    <span className="board__card-row">
                      <span className="tabular">{formatCurrency(o.estimatedValue)}</span>
                      <Avatar initials={usersById[o.owner]?.initials} tone={usersById[o.owner]?.avatarTone} size="sm"
                        title={usersById[o.owner]?.name} />
                    </span>
                    <span className="muted">{o.eventDate ? formatEventDate(o.eventDate, o.eventEndDate) : '—'}</span>
                  </Link>
                ))}
              </section>
            )
          })}
        </div>
      )}

      {all && view === 'table' && (
        <Card flush>
          <DataTable
            caption="Opportunities"
            rows={opportunities}
            rowKey={(o) => o.id}
            rowHref={(o) => opportunityLink(o.id)}
            emptyMessage="No opportunities match these filters."
            columns={[
              {
                key: 'client', header: 'Client',
                render: (o) => (
                  <span className="stack">
                    <span><Link to={opportunityLink(o.id)}><ClientEvent name={clientsById[o.clientId]?.name ?? o.clientId} eventName={o.eventName} /></Link> <span className="id-chip">{o.id}</span></span>
                    <span className="muted">{brandService(o)}</span>
                  </span>
                ),
              },
              { key: 'stage', header: 'Stage', nowrap: true, render: (o) => <StatusBadge kind="opportunity" status={o.stage} /> },
              { key: 'value', header: 'Est. value', align: 'end', nowrap: true, render: (o) => <span className="tabular">{formatCurrency(o.estimatedValue)}</span> },
              { key: 'event', header: 'Event', nowrap: true, render: (o) => formatEventDate(o.eventDate, o.eventEndDate) },
              { key: 'owner', header: 'Owner', nowrap: true, render: (o) => <Person user={usersById[o.owner]} /> },
            ]}
          />
        </Card>
      )}

      {creating && (
        <OpportunityForm
          onClose={() => setCreating(false)}
          onSaved={(result, text) => navigate(opportunityLink(result.opportunity.id), { state: { toast: text } })}
        />
      )}
      <Toast message={toast.message} />
    </PageLayout>
  )
}
