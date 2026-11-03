import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import PageLayout from '../components/layout/PageLayout.jsx'
import Card from '../components/ui/Card.jsx'
import { SkeletonRequest } from '../components/ui/Skeleton.jsx'
import DataTable from '../components/ui/DataTable.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import MoreMenu from '../components/ui/MoreMenu.jsx'
import StatusBadge from '../components/ui/StatusBadge.jsx'
import Tabs from '../components/ui/Tabs.jsx'
import Toast, { useRouteToast } from '../components/ui/Toast.jsx'
import { DueDate, Person } from '../components/dashboard/cells.jsx'
import OpportunityForm from '../components/crm/OpportunityForm.jsx'
import StageForm from '../components/crm/StageForm.jsx'
import { OpportunityHistoryList, brandService } from '../components/crm/HistoryList.jsx'
import { useAllRequests, useCurrentUser, useLookups, useOpportunity } from '../data/hooks.js'
import { API_MODE } from '../data/source.js'
import { lostReasonLabel, OPPORTUNITY_STAGE } from '../domain/status.js'
import { isActiveOpportunity, isDeadlinePending } from '../domain/metrics.js'
import { formatCurrency, formatDate, formatEventDate, formatNumber } from '../lib/format.js'
import { clientLink, newRequestLink, proposalLink } from '../lib/links.js'

const TAB_IDS = ['overview', 'requests', 'history']

function Field({ label, children }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{children || children === 0 ? children : <span className="muted">—</span>}</dd>
    </div>
  )
}

/**
 * Opportunity detail, laid out like the client profile: a header (client, brand · service,
 * stage, owner) and three tabs — Overview · Requests · History. The one main action is Move
 * stage; Edit details and Mark lost sit under "More". Won is never offered by hand (only an
 * accepted proposal sets it). Only actions this viewer may take are shown (server `permissions`).
 */
export default function OpportunityDetailPage() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const { data: opp, isLoading, error, notFound, reload } = useOpportunity(id)
  const { usersById, clientsById } = useLookups()
  const { createRequests } = useCurrentUser()
  const requests = useAllRequests() // only what this viewer may see
  const toast = useRouteToast()
  const [panel, setPanel] = useState(null) // 'move' | 'lost' | 'edit'

  if (!opp && isLoading) return <PageLayout title={id}><SkeletonRequest /></PageLayout>
  if (notFound || error || !opp) {
    return (
      <PageLayout title="Opportunity">
        <Card>
          <EmptyState icon="target" title="Opportunity not available" meta={<Link to="/opportunities" className="btn">Back to opportunities</Link>}>
            {error ? error.message : `No opportunity "${id}" exists.`}
          </EmptyState>
        </Card>
      </PageLayout>
    )
  }

  const client = clientsById[opp.clientId]
  const owner = usersById[opp.owner]
  const linked = (requests.data ?? []).filter((r) => r.opportunityId === opp.id)
  const history = [...(opp.history ?? [])].reverse() // newest first
  const canEdit = Boolean(opp.permissions?.edit?.allowed)
  const targets = canEdit ? opp.permissions.moveTargets ?? [] : []
  const canMove = targets.some((s) => s !== OPPORTUNITY_STAGE.LOST)
  const canMarkLost = targets.includes(OPPORTUNITY_STAGE.LOST)
  const tab = TAB_IDS.includes(params.get('tab')) ? params.get('tab') : 'overview'
  const setTab = (t) => {
    const next = new URLSearchParams(params)
    if (t === 'overview') next.delete('tab')
    else next.set('tab', t)
    setParams(next, { replace: true })
  }

  const more = [
    ...(canEdit ? [{ label: 'Edit details', onSelect: () => setPanel('edit') }] : []),
    ...(canMarkLost ? [{ label: 'Mark lost', tone: 'danger', onSelect: () => setPanel('lost') }] : []),
  ]
  let calm = null
  if (!canEdit) calm = `Owned by ${owner?.name ?? opp.owner}`
  else if (opp.stage === OPPORTUNITY_STAGE.WON) calm = 'Confirmed is final.'
  const headerActions = (
    <>
      {calm && <span className="muted">{calm}</span>}
      <MoreMenu items={more} />
      {canMove && <button type="button" className="btn btn--primary" onClick={() => setPanel('move')}>Move stage</button>}
    </>
  )
  const close = () => setPanel(null)
  const saved = (_result, text) => {
    setPanel(null)
    toast.show(text)
  }
  const newRequest = createRequests.allowed && isActiveOpportunity(opp) && (
    <Link to={newRequestLink({ opportunity: opp.id })} className="btn">New proposal request</Link>
  )

  return (
    <PageLayout title={client?.name ?? opp.clientId} subtitle={brandService(opp)} actions={headerActions}>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/opportunities">Opportunities</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{opp.id}</span>
      </nav>
      <div className="profile-meta">
        <StatusBadge kind="opportunity" status={opp.stage} />
        <span className="tabular">{formatCurrency(opp.estimatedValue)} <span className="muted">estimated</span></span>
        <Person user={owner} suffix="Owner" />
        <span className="id-chip">{opp.id}</span>
      </div>

      <Tabs label="Opportunity sections" value={tab} onChange={setTab} tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'requests', label: 'Requests', count: linked.length },
        { id: 'history', label: 'History' },
      ]} />

      {tab === 'overview' && (
        <div className="dash-grid detail-grid">
          <div className="span-8 detail-col">
            <Card title="Details">
              <dl className="field-list">
                <Field label="Client">{client ? <Link to={clientLink(client.id)}>{client.name}</Link> : opp.clientId}</Field>
                <Field label="Brand · Service">{brandService(opp)}</Field>
                <Field label="Estimated value">{formatCurrency(opp.estimatedValue)} <span className="field__hint">A sales estimate, not revenue</span></Field>
                <Field label="Participants">{opp.participants ? formatNumber(opp.participants) : null}</Field>
                <Field label="Event">{opp.eventDate ? formatEventDate(opp.eventDate, opp.eventEndDate) : null}</Field>
                {opp.lostReason && <Field label="Lost reason">{lostReasonLabel(opp.lostReason)}</Field>}
              </dl>
            </Card>
            <Card title="Latest updates">
              <OpportunityHistoryList items={history} usersById={usersById} limit={3}
                empty={API_MODE ? 'No changes recorded yet.' : 'History is stored by the backend; the demo store has none.'} />
              {history.length > 3 && (
                <div className="card-actions"><button type="button" className="btn-link" onClick={() => setTab('history')}>See all history</button></div>
              )}
            </Card>
          </div>
          <div className="span-4 detail-col">
            <Card title="Next action">
              {opp.nextAction ? (
                <p>{opp.nextAction}{opp.nextActionDate && <span className="field__hint">{formatDate(opp.nextActionDate)}</span>}</p>
              ) : (
                <div className="empty-line">
                  <span>No next action set.</span>
                  {canEdit && <button type="button" className="btn" onClick={() => setPanel('edit')}>Add next action</button>}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {tab === 'requests' && (
        <Card title="Proposal requests" subtitle="Requests you can see for this opportunity" flush>
          {linked.length === 0 && !requests.isLoading ? (
            <div className="empty-line card-pad"><span>No proposal requests for this opportunity.</span>{newRequest}</div>
          ) : (
            <>
              <DataTable
                caption="Proposal requests"
                rows={linked}
                rowKey={(r) => r.id}
                rowHref={(r) => proposalLink(r.id)}
                emptyMessage="Loading…"
                columns={[
                  { key: 'id', header: 'Request', nowrap: true, render: (r) => <Link to={proposalLink(r.id)}>{r.id}</Link> },
                  { key: 'status', header: 'Status', render: (r) => <StatusBadge kind="proposal" status={r.status} version={r.version} /> },
                  { key: 'price', header: 'AM price', align: 'end', nowrap: true, render: (r) => <span className="tabular">{formatCurrency(r.amPrice)}</span> },
                  { key: 'due', header: 'Proposal deadline', nowrap: true, render: (r) => <DueDate date={r.requiredBy} active={isDeadlinePending(r)} /> },
                ]}
              />
              {newRequest && <div className="card-actions card-pad">{newRequest}</div>}
            </>
          )}
        </Card>
      )}

      {tab === 'history' && (
        <Card title="History" subtitle="Stage changes and edits, newest first">
          <OpportunityHistoryList items={history} usersById={usersById}
            empty={API_MODE ? 'No changes recorded yet.' : 'History is stored by the backend; the demo store has none.'} />
        </Card>
      )}

      {panel === 'edit' && <OpportunityForm opportunity={opp} onClose={close} onSaved={saved} onReload={reload} />}
      {panel === 'move' && <StageForm opportunity={opp} targets={targets} onClose={close} onSaved={saved} onReload={reload} />}
      {panel === 'lost' && <StageForm opportunity={opp} targets={targets} lost onClose={close} onSaved={saved} onReload={reload} />}

      <Toast message={toast.message} />
    </PageLayout>
  )
}
