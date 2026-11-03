import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { fromPreviousLink } from '../components/RadarSection.jsx'
import { LinkedTodos } from '../components/Todos.jsx'
import PageLayout from '../components/layout/PageLayout.jsx'
import Badge from '../components/ui/Badge.jsx'
import Card from '../components/ui/Card.jsx'
import { SkeletonRequest } from '../components/ui/Skeleton.jsx'
import ConfirmDialog from '../components/ui/ConfirmDialog.jsx'
import DataTable from '../components/ui/DataTable.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import MoreMenu from '../components/ui/MoreMenu.jsx'
import StatusBadge from '../components/ui/StatusBadge.jsx'
import Tabs from '../components/ui/Tabs.jsx'
import Toast, { useRouteToast } from '../components/ui/Toast.jsx'
import { Person } from '../components/dashboard/cells.jsx'
import ClientForm from '../components/crm/ClientForm.jsx'
import ContactForm from '../components/crm/ContactForm.jsx'
import OpportunityForm from '../components/crm/OpportunityForm.jsx'
import TransferOwnerForm from '../components/crm/TransferOwnerForm.jsx'
import { ClientHistoryList, brandService } from '../components/crm/HistoryList.jsx'
import { successText } from '../components/crm/formParts.jsx'
import { useAllRequests, useClient, useClientActions, useClientHistory, useLists, useLookups, useOpportunities, useRadar } from '../data/hooks.js'
import { optionLabel } from '../domain/lists.js'
import { getBrand, serviceLabel } from '../domain/brands.js'
import { CLIENT_TYPES } from '../domain/catalog.js'
import { isActiveOpportunity } from '../domain/metrics.js'
import { EVENT_TIMING_LABELS, cairoTodayISO, clientEvents } from '../domain/events.js'
import { formatCurrency, formatEventDate } from '../lib/format.js'
import { opportunityLink, proposalLink } from '../lib/links.js'

const TAB_IDS = ['overview', 'contacts', 'events', 'history']
const NONE = { allowed: false, reason: null }

/**
 * Client profile: a header (name, type, brands, owner) and four tabs — Overview · Contacts ·
 * Events (one row per request) · History. The one main action is Edit; Transfer owner (Commercial Head) and
 * Archive sit under "More". Only actions this viewer may take are shown (from the server's
 * `permissions`); otherwise one calm line says whose client it is.
 */
export default function ClientDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { data: client, isLoading, error, notFound, reload } = useClient(id)
  const history = useClientHistory(client ? id : null)
  const { usersById } = useLookups()
  const opportunities = useOpportunities()
  const requests = useAllRequests() // only what this viewer may see (never someone else's draft)
  const actions = useClientActions(client)
  const toast = useRouteToast()
  const lists = useLists().data
  const radar = useRadar()
  const [panel, setPanel] = useState(null) // { kind: 'edit' | 'contact' | 'opportunity' | 'transfer', contact? }
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState(null)
  const [archiveBusy, setArchiveBusy] = useState(false)

  if (!client && isLoading) return <PageLayout title="Client"><SkeletonRequest /></PageLayout>
  if (notFound || error || !client) {
    return (
      <PageLayout title="Client">
        <Card>
          <EmptyState icon="building" title="Client not available" meta={<Link to="/clients" className="btn">Back to clients</Link>}>
            {error ? error.message : `No client "${id}" exists.`}
          </EmptyState>
        </Card>
      </PageLayout>
    )
  }

  const can = { edit: NONE, contacts: NONE, archive: NONE, addOpportunity: NONE, transfer: NONE, ...client.permissions }
  const asked = params.get('tab') === 'opportunities' ? 'events' : params.get('tab') // the tab's old name still works
  const tab = TAB_IDS.includes(asked) ? asked : 'overview'
  const setTab = (t) => {
    const next = new URLSearchParams(params)
    if (t === 'overview') next.delete('tab')
    else next.set('tab', t)
    setParams(next, { replace: true })
  }
  const opps = (opportunities.data ?? []).filter((o) => o.clientId === client.id)
  const openOpps = opps.filter(isActiveOpportunity)
  const events = clientEvents((requests.data ?? []).filter((r) => r.clientId === client.id), cairoTodayISO())
  const owner = usersById[client.owner]
  const primary = client.contacts.find((c) => c.isPrimary) ?? null
  const historyItems = history.data ?? []

  const close = () => setPanel(null)
  const saved = (_result, text) => {
    setPanel(null)
    toast.show(text)
  }
  const archive = async () => {
    setArchiveBusy(true)
    const result = await actions.archive()
    setArchiveBusy(false)
    if (result.ok) navigate('/clients', { state: { toast: successText(result) } })
    else setArchiveError(result.error)
  }

  const more = [
    ...(can.transfer.allowed ? [{ label: 'Transfer owner', onSelect: () => setPanel({ kind: 'transfer' }) }] : []),
    ...(can.archive.allowed ? [{ label: 'Archive client', tone: 'danger', onSelect: () => { setArchiveError(null); setArchiving(true) } }] : []),
  ]
  const headerActions = can.edit.allowed || more.length ? (
    <>
      <MoreMenu items={more} />
      {can.edit.allowed && <button type="button" className="btn btn--primary" onClick={() => setPanel({ kind: 'edit' })}>Edit</button>}
    </>
  ) : (
    <span className="muted">{client.archivedAt ? 'This client is archived.' : `Owned by ${owner?.name ?? client.owner}`}</span>
  )
  const addContact = can.contacts.allowed && (
    <button type="button" className="btn" onClick={() => setPanel({ kind: 'contact' })}>Add contact</button>
  )
  const addOpportunity = can.addOpportunity.allowed && (
    <button type="button" className="btn" onClick={() => setPanel({ kind: 'opportunity' })}>New opportunity</button>
  )
  const oppColumns = [
    {
      key: 'service', header: 'Opportunity',
      render: (o) => <span><Link to={opportunityLink(o.id)}>{brandService(o)}</Link> <span className="id-chip">{o.id}</span></span>,
    },
    { key: 'stage', header: 'Stage', nowrap: true, render: (o) => <StatusBadge kind="opportunity" status={o.stage} /> },
    { key: 'value', header: 'Est. value', align: 'end', nowrap: true, render: (o) => <span className="tabular">{formatCurrency(o.estimatedValue)}</span> },
    { key: 'event', header: 'Event', nowrap: true, render: (o) => (o.eventDate ? formatEventDate(o.eventDate, o.eventEndDate) : <span className="muted">—</span>) },
  ]

  return (
    <PageLayout title={client.name} subtitle={`${CLIENT_TYPES[client.type]?.label ?? client.type}${client.city ? ` · ${optionLabel(lists, 'cities', client.city)}` : ''}`}
      actions={headerActions}>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/clients">Clients</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{client.name}</span>
      </nav>
      <LinkedTodos kind="client" id={client.id} />
      {(radar.data?.items ?? []).filter((i) => i.clientId === client.id).map((i) => (
        <p key={i.signal} className="radar-line">Likely to book soon: {i.sentence}{' '}
          <Link to={fromPreviousLink(i)}>Create request from previous</Link></p>
      ))}
      <div className="profile-meta">
        <span>{client.brands.map((b) => getBrand(b)?.name).join(' · ')}</span>
        <Person user={owner} suffix="Relationship owner" />
        <span className="id-chip">{client.id}</span>
        {client.archivedAt && <Badge tone="neutral">Archived</Badge>}
      </div>

      <Tabs label="Client sections" value={tab} onChange={setTab} tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'contacts', label: 'Contacts', count: client.contacts.length },
        { id: 'events', label: 'Events', count: events.rows.length },
        { id: 'history', label: 'History' },
      ]} />

      {tab === 'overview' && (
        <div className="dash-grid detail-grid">
          <div className="span-8 detail-col">
            <Card title="Open opportunities" subtitle="Values are estimates" flush>
              {openOpps.length === 0 && !opportunities.isLoading ? (
                <div className="empty-line card-pad"><span>No open opportunities.</span>{addOpportunity}</div>
              ) : (
                <DataTable caption="Open opportunities" rows={openOpps} rowKey={(o) => o.id} rowHref={(o) => opportunityLink(o.id)}
                  emptyMessage="Loading…" columns={oppColumns} />
              )}
            </Card>
            <Card title="Latest updates">
              <ClientHistoryList items={historyItems} usersById={usersById} limit={3}
                empty={history.isLoading ? 'Loading…' : 'No changes recorded yet.'} />
              {historyItems.length > 3 && (
                <div className="card-actions"><button type="button" className="btn-link" onClick={() => setTab('history')}>See all history</button></div>
              )}
            </Card>
          </div>
          <div className="span-4 detail-col">
            <Card title="Main contact">
              {primary ? <ContactLines contact={primary} /> : (
                <div className="empty-line"><span>No main contact yet.</span>{addContact}</div>
              )}
            </Card>
            {client.notes && <Card title="Notes"><p className="prose">{client.notes}</p></Card>}
          </div>
        </div>
      )}

      {tab === 'contacts' && (
        <Card title="Contacts">
          {client.contacts.length === 0 ? (
            <div className="empty-line"><span>No contacts yet.</span>{addContact}</div>
          ) : (
            <>
              <ul className="contact-list">
                {client.contacts.map((c) => (
                  <li key={c.id}>
                    <ContactLines contact={c} />
                    {can.contacts.allowed && (
                      <button type="button" className="btn-link" onClick={() => setPanel({ kind: 'contact', contact: c })}
                        aria-label={`Edit ${c.name}`}>Edit</button>
                    )}
                  </li>
                ))}
              </ul>
              {addContact && <div className="card-actions">{addContact}</div>}
            </>
          )}
        </Card>
      )}

      {tab === 'events' && (
        <Card title="Events"
          subtitle={`Confirmed ${events.counts.won} · Lost ${events.counts.lost} · Open ${events.counts.open} · newest first`} flush>
          {events.rows.length === 0 && !requests.isLoading ? (
            <div className="empty-line card-pad"><span>No proposal requests for this client yet.</span>{addOpportunity}</div>
          ) : (
            <DataTable
              caption="Events"
              rows={events.rows}
              rowKey={(e) => e.request.id}
              rowHref={(e) => proposalLink(e.request.id)}
              emptyMessage="Loading…"
              columns={[
                {
                  key: 'name', header: 'Event name',
                  render: ({ request: r }) => <Link to={proposalLink(r.id)}>{r.eventName ?? serviceLabel(r.brand, r.service)}</Link>,
                },
                { key: 'service', header: 'Service', render: ({ request: r }) => serviceLabel(r.brand, r.service) },
                { key: 'brand', header: 'Brand', nowrap: true, render: ({ request: r }) => getBrand(r.brand)?.name ?? '—' },
                { key: 'date', header: 'Date', nowrap: true, render: ({ request: r }) => formatEventDate(r.eventDate, r.eventEndDate) },
                {
                  key: 'stage', header: 'Stage', nowrap: true,
                  render: ({ request: r, timing }) => (timing ? (
                    <span className="status-badge">
                      <Badge tone="success">Confirmed</Badge>
                      <span className="status-badge__sub">{EVENT_TIMING_LABELS[timing]}</span>
                    </span>
                  ) : <StatusBadge kind="proposal" status={r.status} version={r.version} />),
                },
              ]}
            />
          )}
        </Card>
      )}

      {tab === 'history' && (
        <Card title="History" subtitle="Every change, newest first">
          <ClientHistoryList items={historyItems} usersById={usersById} empty={history.isLoading ? 'Loading…' : 'No changes recorded yet.'} />
        </Card>
      )}

      {panel?.kind === 'edit' && <ClientForm client={client} onClose={close} onSaved={saved} onReload={reload} />}
      {panel?.kind === 'contact' && <ContactForm client={client} contact={panel.contact ?? null} onClose={close} onSaved={saved} onReload={reload} />}
      {panel?.kind === 'opportunity' && <OpportunityForm clientId={client.id} onClose={close} onSaved={saved} onReload={reload} />}
      {panel?.kind === 'transfer' && <TransferOwnerForm client={client} onClose={close} onSaved={saved} onReload={reload} />}

      <ConfirmDialog
        open={archiving}
        title={`Archive ${client.name}?`}
        confirmLabel="Archive client"
        tone="danger"
        busy={archiveBusy}
        onConfirm={archive}
        onCancel={() => setArchiving(false)}
      >
        <p>It disappears from lists and from the request form. Its history, opportunities and requests are kept.</p>
        {archiveError && <p className="form-field__error" role="alert">{archiveError}</p>}
      </ConfirmDialog>

      <Toast message={toast.message} />
    </PageLayout>
  )
}

function ContactLines({ contact }) {
  return (
    <div className="contact-list__lines">
      <strong>
        {contact.name} {contact.isPrimary && <Badge tone="info">Main contact</Badge>}
      </strong>
      {contact.title && <span className="muted">{contact.title}</span>}
      {contact.phone && <a href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`}>{contact.phone}</a>}
      {contact.email && <a href={`mailto:${contact.email}`}>{contact.email}</a>}
      {contact.notes && <span className="muted">{contact.notes}</span>}
    </div>
  )
}
