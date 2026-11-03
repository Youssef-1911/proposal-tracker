import { useState } from 'react'
import { Link } from 'react-router-dom'
import AdminTabs from '../components/accounts/AdminTabs.jsx'
import PageLayout from '../components/layout/PageLayout.jsx'
import RoleGate from '../components/layout/RoleGate.jsx'
import Card from '../components/ui/Card.jsx'
import Toast, { useToast } from '../components/ui/Toast.jsx'
import RoutingForm from '../components/accounts/RoutingForm.jsx'
import ListsEditor from '../components/accounts/ListsEditor.jsx'
import OccasionsEditor from '../components/accounts/OccasionsEditor.jsx'
import StatusBadge from '../components/ui/StatusBadge.jsx'
import { Person } from '../components/dashboard/cells.jsx'
import { usePageDescription } from './PlaceholderPage.jsx'
import { useConfig, useLookups, useRouting } from '../data/hooks.js'
import { getBrand } from '../domain/brands.js'
import { roleLabel } from '../domain/roles.js'
import RelTime from '../components/ui/RelTime.jsx'
import { findNavItem } from '../navigation.js'

/**
 * Settings (people with "Manage accounts"). Routing is editable: which Account Manager receives
 * each brand's new requests (every change is kept). The rest is the business configuration, read-only.
 */
function Settings() {
  const { data: config } = useConfig()
  const { usersById } = useLookups()
  const routing = useRouting()
  const toast = useToast()
  const [changing, setChanging] = useState(null) // a routing item
  const items = routing.data?.items ?? []
  const current = Object.fromEntries(items.map((i) => [i.brand, i.amUserId]))
  const history = routing.data?.history ?? []
  const subtitle = usePageDescription(findNavItem('/settings'))
  const stages = [...config.proposalStages].sort((a, b) => a.order - b.order)
  const statusesByStage = (stageId) => config.proposalStatuses.filter((s) => s.stage === stageId)

  return (
    <PageLayout title="Settings" subtitle={subtitle}>
      <AdminTabs />
      <div className="dash-grid">
        <div className="span-6">
          <Card title="Brands & services">
            <ul className="settings-list">
              {config.brands.map((b) => (
                <li key={b.id}>
                  <strong>{b.name}:</strong>
                  <span>{b.services.map((s) => s.label).join(' · ')}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="span-6">
          <Card title="Proposal routing" subtitle="Each brand's new requests go to one Account Manager">
            <ul className="settings-list">
              {items.map((item) => {
                const others = item.choices.filter((id) => id !== item.amUserId)
                return (
                  <li key={item.brand} className="routing-row">
                    <strong>{getBrand(item.brand)?.name}</strong>
                    <span aria-hidden="true">→</span>
                    <Person user={usersById[item.amUserId]} />
                    {routing.available && (others.length > 0 ? (
                      <button type="button" className="btn-link" onClick={() => setChanging(item)}
                        aria-label={`Change ${getBrand(item.brand)?.name} routing`}>Change</button>
                    ) : (
                      <span className="muted">To change this, first add another {getBrand(item.brand)?.name} Account Manager in{' '}
                        <Link to="/team">Team &amp; Users</Link>.</span>
                    ))}
                  </li>
                )
              })}
            </ul>
            {history.length > 0 && (
              <ol className="history-list routing-history">
                {history.slice(0, 5).map((h) => (
                  <li key={h.id}>
                    <div>{getBrand(h.brand)?.name}: {usersById[h.fromUser]?.name ?? 'nobody'} → {usersById[h.toUser]?.name ?? h.toUser}</div>
                    <div className="muted">
                      {usersById[h.changedBy]?.name ?? h.changedBy} ({roleLabel(h.role, usersById[h.changedBy])}) · <RelTime value={h.changedAt} />
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
        <div className="span-6">
          <Card title="Proposal stages and statuses" subtitle="The stage is what people see; the detailed status drives the workflow">
            <ul className="settings-list">
              {stages.map((st) => (
                <li key={st.id}>
                  <strong>{st.label}:</strong>
                  <span>
                    {statusesByStage(st.id).map((s) => `${s.label}${s.subLabel ? ` ("${s.subLabel.replace(' (v{nextVersion})', '')}")` : ''}`).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="span-6">
          <Card title="Opportunity stages">
            <ul className="settings-list">
              {config.opportunityStages.map((s) => (
                <li key={s.id}><StatusBadge kind="opportunity" status={s.id} /></li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="span-6">
          <Card title="Lost reasons" subtitle="Chosen when a proposal is marked lost">
            <ul className="settings-list">
              {config.lostReasons.map((r) => <li key={r.id}>{r.label}</li>)}
            </ul>
          </Card>
        </div>
        <div className="span-6">
          <Card title="Proposal files and sharing">
            <ul className="settings-list">
              <li><strong>File types:</strong> {config.proposalFiles.types.map((t) => `${t.label} (${t.extension})`).join(' · ')}</li>
              <li><strong>Maximum size:</strong> {Math.round(config.proposalFiles.maxBytes / (1024 * 1024))} MB</li>
              <li><strong>Shared via:</strong> {config.shareChannels.map((c) => c.label).join(' · ')}</li>
              <li><strong>Time zone:</strong> {config.businessTimezone} · <strong>Currency:</strong> {config.currency}</li>
            </ul>
          </Card>
        </div>
        <div className="span-12">
          <ListsEditor onMessage={toast.show} />
        </div>
      </div>
      <OccasionsEditor />
      {changing && (
        <RoutingForm item={changing} routing={current} onSave={routing.set} onReload={routing.reload}
          onClose={() => setChanging(null)}
          onSaved={(_result, text) => { setChanging(null); toast.show(text) }} />
      )}
      <Toast message={toast.message} />
    </PageLayout>
  )
}

export default function SettingsPage() {
  return <RoleGate path="/settings"><Settings /></RoleGate>
}
