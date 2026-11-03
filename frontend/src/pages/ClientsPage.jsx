import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import PageLayout from '../components/layout/PageLayout.jsx'
import Card from '../components/ui/Card.jsx'
import DataTable from '../components/ui/DataTable.jsx'
import Icon from '../components/ui/Icon.jsx'
import SegmentedControl from '../components/ui/SegmentedControl.jsx'
import Toast, { useRouteToast } from '../components/ui/Toast.jsx'
import { Person } from '../components/dashboard/cells.jsx'
import ClientForm from '../components/crm/ClientForm.jsx'
import { usePageDescription } from './PlaceholderPage.jsx'
import { useClients, useCurrentUser, useLookups, useUsers } from '../data/hooks.js'
import { findNavItem } from '../navigation.js'
import { BRANDS, getBrand } from '../domain/brands.js'
import { CLIENT_TYPES } from '../domain/catalog.js'
import { ROLE } from '../domain/roles.js'
import { clientLink } from '../lib/links.js'
import Tabs from '../components/ui/Tabs.jsx'
import RadarSection from '../components/RadarSection.jsx'
import useTab from '../lib/useTab.js'

/**
 * Clients: search and filters in the URL; BD can switch between their own and all clients.
 * The one main action is "New client" (BD, who becomes the owner, or the Commercial Head).
 * Archived clients are not listed.
 */
export default function ClientsPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { user, activeRole, createClients } = useCurrentUser()
  const { usersById } = useLookups()
  const users = useUsers().data
  const subtitle = usePageDescription(findNavItem('/clients'))
  const [creating, setCreating] = useState(false)
  const toast = useRouteToast() // e.g. after archiving a client
  const isBD = activeRole === ROLE.BUSINESS_DEVELOPMENT
  // "Likely to book soon": BD (their clients), Noha and the Executives (all, by BD owner).
  const radarRole = [ROLE.BUSINESS_DEVELOPMENT, ROLE.COMMERCIAL_HEAD, ROLE.EXECUTIVE].includes(activeRole)
  const [tab, setTab] = useTab(radarRole ? ['all', 'radar'] : ['all'], 'all')

  const view = isBD && params.get('view') !== 'all' ? 'mine' : 'all'
  const filters = {
    q: params.get('q') ?? '',
    type: params.get('type') ?? '',
    brand: params.get('brand') ?? '',
    owner: view === 'mine' ? user.id : params.get('owner') ?? '',
  }
  const filtered = Boolean(filters.q || filters.type || filters.brand || (view === 'all' && filters.owner))
  const { data: clients, isLoading, error } = useClients(filters)
  const set = (key) => (e) => {
    const next = new URLSearchParams(params)
    if (e.target.value) next.set(key, e.target.value)
    else next.delete(key)
    setParams(next, { replace: true })
  }
  const setView = (v) => {
    const next = new URLSearchParams(params)
    if (v === 'all') next.set('view', 'all')
    else { next.delete('view'); next.delete('owner') }
    setParams(next, { replace: true })
  }
  const bds = users.filter((u) => u.roles.includes(ROLE.BUSINESS_DEVELOPMENT))
  const newClientButton = createClients.allowed && (
    <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
      <Icon name="plus" size={16} strokeWidth={2.25} /> New client
    </button>
  )

  return (
    <PageLayout title="Clients" subtitle={subtitle} actions={newClientButton || null}>
      {radarRole && (
        <Tabs label="Clients" value={tab} onChange={setTab}
          tabs={[{ id: 'all', label: 'Clients' }, { id: 'radar', label: 'Likely to book soon' }]} />
      )}
      {tab === 'radar' ? <RadarSection /> : (
      <Card flush>
        <div className="page-toolbar">
          {isBD && (
            <div className="form-field">
              <span className="form-field__label">Show</span>
              <SegmentedControl label="Which clients" value={view} onChange={setView}
                options={[{ value: 'mine', label: 'My clients' }, { value: 'all', label: 'All clients' }]} />
            </div>
          )}
          <label className="form-field form-field--grow">
            <span className="form-field__label">Search</span>
            <input type="search" placeholder="Client name" value={filters.q} onChange={set('q')} />
          </label>
          <label className="form-field">
            <span className="form-field__label">Type</span>
            <select value={filters.type} onChange={set('type')}>
              <option value="">Any type</option>
              {Object.entries(CLIENT_TYPES).map(([id, t]) => <option key={id} value={id}>{t.label}</option>)}
            </select>
          </label>
          <label className="form-field">
            <span className="form-field__label">Brand</span>
            <select value={filters.brand} onChange={set('brand')}>
              <option value="">Both brands</option>
              {BRANDS.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          {view === 'all' && (
            <label className="form-field">
              <span className="form-field__label">Relationship owner</span>
              <select value={filters.owner} onChange={set('owner')}>
                <option value="">Anyone</option>
                {bds.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="result-count" role="status" aria-busy={isLoading}>
          {error ? error.message : isLoading && !clients ? 'Loading…' : `${clients.length} ${clients.length === 1 ? 'client' : 'clients'}`}
        </div>
        {clients && clients.length === 0 && !filtered && !isLoading ? (
          <div className="empty-line card-pad">
            <span>{view === 'mine' ? 'You have no clients yet.' : 'No clients yet.'}</span>
            {newClientButton}
          </div>
        ) : clients && (
          <DataTable
            caption="Clients"
            rows={clients}
            rowKey={(c) => c.id}
            rowHref={(c) => clientLink(c.id)}
            emptyMessage="No clients match these filters."
            columns={[
              {
                key: 'name', header: 'Client',
                render: (c) => (
                  <span className="stack">
                    <span><Link to={clientLink(c.id)}>{c.name}</Link> <span className="id-chip">{c.id}</span></span>
                    <span className="muted">{CLIENT_TYPES[c.type]?.label}{c.city ? ` · ${c.city}` : ''}</span>
                  </span>
                ),
              },
              { key: 'brands', header: 'Brands', render: (c) => c.brands.map((b) => getBrand(b)?.name).join(' · ') },
              { key: 'owner', header: 'Relationship owner', nowrap: true, render: (c) => <Person user={usersById[c.owner]} /> },
              {
                key: 'contact', header: 'Main contact',
                render: (c) => (c.contact?.name
                  ? <span className="stack"><span>{c.contact.name}</span><span className="muted">{c.contact.title}</span></span>
                  : <span className="muted">—</span>),
              },
            ]}
          />
        )}
      </Card>
      )}

      {creating && (
        <ClientForm
          onClose={() => setCreating(false)}
          onSaved={(result, text) => navigate(clientLink(result.client.id), { state: { toast: text } })}
        />
      )}
      <Toast message={toast.message} />
    </PageLayout>
  )
}
