import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import Icon from '../components/ui/Icon.jsx'
import PageLayout from '../components/layout/PageLayout.jsx'
import Card from '../components/ui/Card.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Badge from '../components/ui/Badge.jsx'
import RequestOverview from '../components/proposal/RequestOverview.jsx'
import RequestRequirements from '../components/proposal/RequestRequirements.jsx'
import ProposalVersions from '../components/proposal/ProposalVersions.jsx'
import ProposalFiles from '../components/proposal/ProposalFiles.jsx'
import ActivityTimeline from '../components/proposal/ActivityTimeline.jsx'
import LinkedOpportunity from '../components/proposal/LinkedOpportunity.jsx'
import ActionsPanel from '../components/proposal/ActionsPanel.jsx'
import { useCurrentUser, useLookups, useMarkRead, useProposalRequest } from '../data/hooks.js'
import { WaitingBar, WaitingOnPanel, waitingPermissions } from '../components/proposal/WaitingOn.jsx'
import { Conversation, DetailsBanner, OpenCards, ProgressSteps, UpdateDetailsPanel } from '../components/proposal/RequestFlow.jsx'
import SidePanel from '../components/ui/SidePanel.jsx'
import { CorrectStatusPanel } from '../components/proposal/DataFixes.jsx'
import { canCorrectStatus } from '../domain/corrections.js'
import { canUpdateDetails } from '../domain/conversation.js'
import { ROLE } from '../domain/roles.js'
import { PROPOSAL_STATUS as PS } from '../domain/status.js'
import Toast, { useRouteToast } from '../components/ui/Toast.jsx'
import { API_MODE } from '../data/source.js'
import { canViewRequest } from '../domain/proposals.js'
import { getBrand, serviceLabel } from '../domain/brands.js'
import { SkeletonRequest } from '../components/ui/Skeleton.jsx'
import { LinkedTodos } from '../components/Todos.jsx'

function NotAvailable({ id }) {
  // Same message whether the id doesn't exist or is someone else's draft, so drafts don't leak.
  return (
    <PageLayout title="Proposal">
      <Card>
        <EmptyState
          icon="document"
          title="Proposal not available"
          meta={<Link to="/" className="btn">Back to dashboard</Link>}
        >
          No request &ldquo;{id}&rdquo; is available to you. It may not exist, or it may be a draft
          that only its creator can see.
        </EmptyState>
      </Card>
    </PageLayout>
  )
}

/** Detail page for one proposal request (/proposals/:id), with the actions this viewer may take. */
export default function ProposalDetailPage() {
  const { id } = useParams()
  const flash = useLocation().state?.flash // success message from the request form
  const { user, activeRole } = useCurrentUser()
  const { data: request, isLoading, error, notFound } = useProposalRequest(id)
  const { clientsById, usersById, opportunitiesById } = useLookups()
  const [waitingOpen, setWaitingOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [correctOpen, setCorrectOpen] = useState(false)
  // When this person last opened it (captured once, so what was new stays highlighted for this visit).
  const [lastReadAt, setLastReadAt] = useState(undefined)
  const markRead = useMarkRead(id)
  useEffect(() => {
    if (!request || lastReadAt !== undefined) return
    setLastReadAt(request.lastReadAt ?? null)
    markRead() // opening the request clears "New for you" for this person
  }, [request, lastReadAt, markRead])
  const toast = useRouteToast()

  if (!request && isLoading) {
    return <PageLayout title={id}><SkeletonRequest /></PageLayout>
  }
  if (error && !request) {
    return (
      <PageLayout title="Proposal">
        <Card>
          <EmptyState icon="alert" title="Could not load the request">{error.message}</EmptyState>
        </Card>
      </PageLayout>
    )
  }
  if (notFound || !request || !canViewRequest(request, user.id)) return <NotAvailable id={id} />

  const client = clientsById[request.clientId]
  // API mode: the linked opportunity comes with the request.
  const opportunity = request.opportunity ?? (request.opportunityId ? opportunitiesById[request.opportunityId] : null)
  const viewer = { userId: user.id, activeRole }
  const waiting = waitingPermissions(request, viewer, usersById)
  const details = request.conversationPermissions?.updateDetails ?? canUpdateDetails(request, viewer, usersById)
  // The AM while preparing: "Upload proposal" and "Set waiting on" are visible buttons, not in "More".
  const preparing = activeRole === ROLE.ACCOUNT_MANAGER && request.assignedAM === user.id
    && [PS.SUBMITTED, PS.IN_PROGRESS, PS.REVISION_REQUESTED].includes(request.status)
  const uploadAllowed = request.upload?.allowed ?? false
  const openUpload = () => {
    const input = document.getElementById('proposal-upload')
    input?.scrollIntoView?.({ block: 'center' })
    input?.click()
  }

  return (
    <PageLayout
      title={request.id}
      subtitle={request.eventName
        ? `${client?.name ?? request.clientName ?? 'Unknown client'} · ${request.eventName}`
        : `${client?.name ?? request.clientName ?? 'Unknown client'} · ${getBrand(request.brand)?.name} · ${serviceLabel(request.brand, request.service)}`}
      actions={(
        <span className="page-tags">
          {request.status === PS.ACCEPTED && <Link to={`/events/${encodeURIComponent(request.id)}`} className="btn">Open the event</Link>}
          {request.imported && <Badge tone="neutral">Imported</Badge>}
          {request.needsReview && <Badge tone="info">Needs review</Badge>}
        </span>
      )}
    >
      {flash && (
        <div className="action-feedback action-feedback--success" role="status">
          <Icon name="checkmark" size={16} strokeWidth={2.25} />
          <span>
            {flash}
            {!API_MODE && <span className="action-feedback__note">Demo: kept in memory only; resets when you reload.</span>}
          </span>
        </div>
      )}
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/proposals">Proposals</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{request.id}</span>
      </nav>
      <LinkedTodos kind="request" id={request.id} />

      {request.status === PS.ACCEPTED && (
        <p className="details-banner">This proposal is now an event. <Link to={`/events/${encodeURIComponent(request.id)}`}>Open the event page</Link></p>
      )}
      {/* Who it is waiting on, impossible to miss: directly under the title, with Change and Remind. */}
      <WaitingBar request={request} onChange={() => setWaitingOpen(true)} canChange={waiting.set.allowed || waiting.clear.allowed} />
      {/* The progress bar; then two columns, nothing folded away. */}
      <ProgressSteps request={request} />
      <p className="full-history-link">
        <button type="button" className="link-btn" onClick={() => setHistoryOpen(true)}>Full history</button>
      </p>
      <DetailsBanner key={`banner:${user.id}:${activeRole}`} request={request} />
      <div className="request-columns">
        <div className="request-columns__left">
          <RequestOverview request={request} client={client} usersById={usersById} />
          <RequestRequirements request={request} />
          <ProposalFiles request={request} usersById={usersById} />
          <ProposalVersions request={request} usersById={usersById} />
          <LinkedOpportunity opportunity={opportunity} client={client} usersById={usersById} />
        </div>
        <div className="request-columns__right">
          {/* Remount per viewer so one person's form or success message never shows for another. */}
          <ActionsPanel key={`${user.id}:${activeRole}`} request={request} extras={[
            ...(preparing && uploadAllowed ? [{ label: 'Upload proposal', onSelect: openUpload, visible: true }] : []),
            ...(preparing && waiting.set.allowed ? [{ label: 'Set waiting on', onSelect: () => setWaitingOpen(true), visible: true }] : []),
            ...(details.allowed ? [{ label: 'Update details', onSelect: () => setDetailsOpen(true) }] : []),
            ...((request.correctStatus ?? canCorrectStatus(request, viewer, usersById)).allowed
              ? [{ label: 'Correct status (data fix)', onSelect: () => setCorrectOpen(true) }] : []),
          ]} />
          <OpenCards key={`cards:${user.id}:${activeRole}`} request={request} lastReadAt={lastReadAt} />
          <Conversation key={`thread:${user.id}:${activeRole}`} request={request} lastReadAt={lastReadAt} />
        </div>
      </div>
      {correctOpen && (
        <CorrectStatusPanel request={request} onClose={() => setCorrectOpen(false)}
          onSaved={(_r, text) => { setCorrectOpen(false); toast.show(text) }} />
      )}
      {historyOpen && (
        <SidePanel open title="Full history" subtitle={request.id} onClose={() => setHistoryOpen(false)}>
          <ActivityTimeline request={request} usersById={usersById} />
        </SidePanel>
      )}
      {detailsOpen && (
        <UpdateDetailsPanel request={request} onClose={() => setDetailsOpen(false)}
          onSaved={(_r, text) => { setDetailsOpen(false); toast.show(text) }} />
      )}
      {waitingOpen && (
        <WaitingOnPanel request={request} onClose={() => setWaitingOpen(false)}
          onSaved={(_r, text) => { setWaitingOpen(false); toast.show(text) }} />
      )}
      <Toast message={toast.message} />
    </PageLayout>
  )
}
