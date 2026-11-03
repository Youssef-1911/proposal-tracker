import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import AdminTabs from '../components/accounts/AdminTabs.jsx'
import PageLayout from '../components/layout/PageLayout.jsx'
import RoleGate from '../components/layout/RoleGate.jsx'
import Badge from '../components/ui/Badge.jsx'
import Card from '../components/ui/Card.jsx'
import DataTable from '../components/ui/DataTable.jsx'
import Icon from '../components/ui/Icon.jsx'
import SegmentedControl from '../components/ui/SegmentedControl.jsx'
import Toast, { useRouteToast } from '../components/ui/Toast.jsx'
import Avatar from '../components/ui/Avatar.jsx'
import AccountForm from '../components/accounts/AccountForm.jsx'
import { usePageDescription } from './PlaceholderPage.jsx'
import { useCreateAccount, useTeam } from '../data/hooks.js'
import { findNavItem } from '../navigation.js'
import { getBrand } from '../domain/brands.js'
import { PRIVILEGES, privilegesOf } from '../domain/access.js'
import { ROLE, roleLabel } from '../domain/roles.js'

const personLink = (id) => `/team/${encodeURIComponent(id)}`

/**
 * Team & Users (people with "Manage accounts"): everyone, active or deactivated. The one main
 * action is "New account"; each person opens their own page (edit, deactivate, history).
 */
function Team() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const everyone = useTeam().data
  const creator = useCreateAccount()
  const subtitle = usePageDescription(findNavItem('/team'))
  const toast = useRouteToast()
  const [creating, setCreating] = useState(false)
  const show = params.get('show') === 'deactivated' ? 'deactivated' : 'active'
  const setShow = (v) => {
    const next = new URLSearchParams(params)
    if (v === 'deactivated') next.set('show', v)
    else next.delete('show')
    setParams(next, { replace: true })
  }
  const active = everyone.filter((u) => u.active !== false)
  const deactivated = everyone.filter((u) => u.active === false)
  const rows = [...(show === 'active' ? active : deactivated)].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <PageLayout
      title="Team & Users"
      subtitle={subtitle}
      actions={creator.available ? (
        <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} strokeWidth={2.25} /> New account
        </button>
      ) : null}
    >
      <AdminTabs />
      <Card flush>
        <div className="page-toolbar">
          <div className="form-field">
            <span className="form-field__label">Show</span>
            <SegmentedControl label="Which accounts" value={show} onChange={setShow} options={[
              { value: 'active', label: `Active (${active.length})` },
              { value: 'deactivated', label: `Deactivated (${deactivated.length})` },
            ]} />
          </div>
        </div>
        <DataTable
          caption="Accounts"
          rows={rows}
          rowKey={(u) => u.id}
          rowHref={(u) => personLink(u.id)}
          emptyMessage={show === 'active' ? 'No active accounts.' : 'Nobody is deactivated.'}
          columns={[
            {
              key: 'name', header: 'Person',
              render: (u) => (
                <span className="person">
                  <Avatar initials={u.initials} tone={u.avatarTone} size="sm" />
                  <span className="stack">
                    <span><Link to={personLink(u.id)}>{u.name}</Link> <span className="id-chip">{u.id}</span></span>
                    <span className="muted">{u.jobTitle ?? '—'}</span>
                  </span>
                </span>
              ),
            },
            { key: 'roles', header: 'Roles', nowrap: true, render: (u) => u.roles.map((r) => roleLabel(r)).join(' · ') },
            {
              key: 'brand', header: 'Brand', nowrap: true,
              render: (u) => (u.roles.includes(ROLE.ACCOUNT_MANAGER) && u.brand ? getBrand(u.brand)?.name : <span className="muted">—</span>),
            },
            {
              key: 'access', header: 'Access', nowrap: true,
              render: (u) => {
                const on = PRIVILEGES.filter((p) => privilegesOf(u)[p.id]).map((p) => p.label)
                return on.length ? on.join(' · ') : <span className="muted">Role only</span>
              },
            },
            {
              key: 'status', header: 'Status', nowrap: true,
              render: (u) => (u.active === false ? <Badge tone="neutral">Deactivated</Badge> : <Badge tone="success">Active</Badge>),
            },
          ]}
        />
      </Card>

      {creating && (
        <AccountForm
          onClose={() => setCreating(false)}
          onSaved={(result, text) => navigate(personLink(result.user.id), { state: { toast: text } })}
        />
      )}
      <Toast message={toast.message} />
    </PageLayout>
  )
}

export default function TeamPage() {
  return <RoleGate path="/team"><Team /></RoleGate>
}
