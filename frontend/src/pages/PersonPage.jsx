import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import PageLayout from '../components/layout/PageLayout.jsx'
import Badge from '../components/ui/Badge.jsx'
import Card from '../components/ui/Card.jsx'
import { SkeletonRequest } from '../components/ui/Skeleton.jsx'
import ConfirmDialog from '../components/ui/ConfirmDialog.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import MoreMenu from '../components/ui/MoreMenu.jsx'
import Tabs from '../components/ui/Tabs.jsx'
import Toast, { useRouteToast } from '../components/ui/Toast.jsx'
import AccountForm from '../components/accounts/AccountForm.jsx'
import { AccountHistoryList } from '../components/accounts/AccountHistoryList.jsx'
import { successText } from '../components/crm/formParts.jsx'
import { useAccount, useAccountActions, useLookups } from '../data/hooks.js'
import { getBrand } from '../domain/brands.js'
import { PRIVILEGES, privilegesOf } from '../domain/access.js'
import { ROLE, roleLabel } from '../domain/roles.js'
import { clientsLink } from '../lib/links.js'

const TAB_IDS = ['overview', 'history']
const NONE = { allowed: false, reason: null }
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/**
 * One person (Admin → Team & Users): who they are, their roles and access, what they own, and
 * every change to their account. Edit is the one main action; Deactivate / Reactivate sit
 * under "More". Accounts are never deleted.
 */
export default function PersonPage() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const { data: person, isLoading, error, notFound, reload } = useAccount(id)
  const { usersById } = useLookups()
  const actions = useAccountActions(person)
  const toast = useRouteToast()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [moveTo, setMoveTo] = useState('') // who takes over an Account Manager's open requests

  if (!person && isLoading) return <PageLayout title="Person"><SkeletonRequest /></PageLayout>
  if (notFound || error || !person) {
    return (
      <PageLayout title="Person">
        <Card>
          <EmptyState icon="users" title="Account not available" meta={<Link to="/team" className="btn">Back to Team &amp; Users</Link>}>
            {error ? error.message : `No account "${id}" exists.`}
          </EmptyState>
        </Card>
      </PageLayout>
    )
  }

  const can = { edit: NONE, deactivate: NONE, reactivate: NONE, ...person.permissions }
  const tab = TAB_IDS.includes(params.get('tab')) ? params.get('tab') : 'overview'
  const setTab = (t) => {
    const next = new URLSearchParams(params)
    if (t === 'overview') next.delete('tab')
    else next.set('tab', t)
    setParams(next, { replace: true })
  }
  const privileges = privilegesOf(person)
  const owns = person.owns ?? { clients: 0, openRequests: 0 }
  const ownsSomething = owns.clients > 0 || owns.openRequests > 0
  const theirClients = clientsLink({ owner: person.id, view: 'all' })

  // An Account Manager's open requests move to another AM of the brand when they are deactivated.
  const move = person.deactivation ?? { count: 0, choices: [], blocked: null }
  const deactivate = async () => {
    if (move.count && !moveTo) {
      setConfirmError(`Choose who takes over ${person.name}'s ${plural(move.count, 'open request', 'open requests')}.`)
      return
    }
    setConfirmBusy(true)
    const result = await actions.deactivate(move.count ? moveTo : null)
    setConfirmBusy(false)
    if (result.ok) {
      setConfirming(false)
      toast.show(successText(result))
    } else setConfirmError(result.error)
  }
  // Reactivating loses nothing, so it needs no confirmation.
  const reactivate = async () => {
    const result = await actions.reactivate()
    toast.show(result.ok ? successText(result) : result.error)
  }

  const more = [
    ...(can.deactivate.allowed
      ? [{ label: 'Deactivate', tone: 'danger', onSelect: () => { setConfirmError(null); setMoveTo(''); setConfirming(true) } }] : []),
    ...(can.reactivate.allowed ? [{ label: 'Reactivate', onSelect: reactivate }] : []),
  ]
  // One calm line when deactivating is not possible (e.g. "Change routing for Team Up first.").
  const blocked = can.edit.allowed && person.active && !can.deactivate.allowed ? can.deactivate.reason : null

  return (
    <PageLayout
      title={person.name}
      subtitle={person.jobTitle ?? 'No job title'}
      actions={can.edit.allowed ? (
        <>
          <MoreMenu items={more} />
          <button type="button" className="btn btn--primary" onClick={() => setEditing(true)}>Edit</button>
        </>
      ) : null}
    >
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/team">Team &amp; Users</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{person.name}</span>
      </nav>
      <div className="profile-meta">
        <span>{person.roles.map((r) => roleLabel(r, person)).join(' · ')}</span>
        <a href={`mailto:${person.email}`}>{person.email}</a>
        {person.active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Deactivated</Badge>}
        <span className="id-chip">{person.id}</span>
      </div>
      {blocked && <p className="muted">{blocked}</p>}

      <Tabs label="Person sections" value={tab} onChange={setTab} tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'history', label: 'History', count: person.history?.length },
      ]} />

      {tab === 'overview' && (
        <div className="dash-grid detail-grid">
          <div className="span-8 detail-col">
            <Card title="Access" subtitle="What this person can see beyond their role">
              <ul className="access-list">
                {PRIVILEGES.map((p) => (
                  <li key={p.id}>
                    <span>{p.label}<span className="form-field__hint">{p.description}</span></span>
                    {privileges[p.id] ? <Badge tone="success">On</Badge> : <span className="muted">Off</span>}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          <div className="span-4 detail-col">
            <Card title="Details">
              <dl className="field-list field-list--1">
                <div className="field"><dt>Roles</dt><dd>{person.roles.map((r) => roleLabel(r)).join(' · ')}</dd></div>
                {person.roles.includes(ROLE.ACCOUNT_MANAGER) && (
                  <div className="field"><dt>Brand</dt><dd>{getBrand(person.brand)?.name ?? '—'}</dd></div>
                )}
                <div className="field"><dt>Owns</dt><dd>
                  {ownsSomething
                    ? <Link to={theirClients}>{plural(owns.clients, 'client', 'clients')} · {plural(owns.openRequests, 'open request', 'open requests')}</Link>
                    : <span className="muted">No clients or open requests</span>}
                </dd></div>
              </dl>
            </Card>
          </div>
        </div>
      )}

      {tab === 'history' && (
        <Card title="History" subtitle="Every change to this account, newest first">
          <AccountHistoryList items={person.history ?? []} usersById={usersById} />
        </Card>
      )}

      {editing && (
        <AccountForm account={person} onClose={() => setEditing(false)} onReload={reload}
          onSaved={(_result, text) => { setEditing(false); toast.show(text) }} />
      )}

      <ConfirmDialog
        open={confirming}
        title={`Deactivate ${person.name}?`}
        confirmLabel={move.count ? 'Move and deactivate' : ownsSomething ? 'Deactivate anyway' : 'Deactivate'}
        tone="danger"
        busy={confirmBusy}
        onConfirm={deactivate}
        onCancel={() => setConfirming(false)}
      >
        {ownsSomething ? (
          <p>
            {person.name} still owns {plural(owns.clients, 'client', 'clients')} and{' '}
            {plural(owns.openRequests, 'open request', 'open requests')}.{' '}
            <Link to={theirClients}>Transfer them first</Link>, or deactivate anyway: nothing is lost.
          </p>
        ) : (
          <p>They will no longer be able to use IEE. Everything they did stays in the history.</p>
        )}
        {move.count > 0 && (move.blocked ? <p className="form-field__error">{move.blocked}</p> : (
          <label className="form-field">
            <span className="form-field__label">
              Move {plural(move.count, 'open request', 'open requests')} to *
            </span>
            <select value={moveTo} onChange={(e) => { setMoveTo(e.target.value); setConfirmError(null) }}>
              <option value="">Choose an Account Manager…</option>
              {move.choices.map((uid) => <option key={uid} value={uid}>{usersById[uid]?.name ?? uid}</option>)}
            </select>
            <span className="form-field__hint">Each request records the change in its history.</span>
          </label>
        ))}
        {confirmError && <p className="form-field__error" role="alert">{confirmError}</p>}
      </ConfirmDialog>

      <Toast message={toast.message} />
    </PageLayout>
  )
}
