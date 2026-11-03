import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import AppShell from './components/layout/AppShell.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import MyWorkPage from './pages/MyWorkPage.jsx'
import PlaceholderPage from './pages/PlaceholderPage.jsx'
import NotFoundPage from './pages/NotFoundPage.jsx'
import ProposalDetailPage from './pages/ProposalDetailPage.jsx'
import ProposalRequestFormPage from './pages/ProposalRequestFormPage.jsx'
import ProposalTrackerPage from './pages/ProposalTrackerPage.jsx'
import ClientsPage from './pages/ClientsPage.jsx'
import ClientDetailPage from './pages/ClientDetailPage.jsx'
import OpportunitiesPage from './pages/OpportunitiesPage.jsx'
import OpportunityDetailPage from './pages/OpportunityDetailPage.jsx'
import TeamPage from './pages/TeamPage.jsx'
import PersonPage from './pages/PersonPage.jsx'
import RoleGate from './components/layout/RoleGate.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import AnalyticsPage from './pages/AnalyticsPage.jsx'
import TasksPage from './pages/TasksPage.jsx'
import EventsPage from './pages/EventsPage.jsx'
import EventPage from './pages/EventPage.jsx'
import QueueBoardPage from './pages/QueueBoardPage.jsx'
import StaffingPage from './pages/StaffingPage.jsx'
import FacilitatorsPage from './pages/FacilitatorsPage.jsx'
import FacilitatorPage from './pages/FacilitatorPage.jsx'
import ScreenPage from './pages/ScreenPage.jsx'
import { ALL_NAV_ITEMS, REDIRECTS, firstPageFor } from './navigation.js'
import { useEffect } from 'react'
import { useCurrentUser } from './data/hooks.js'

let landed = false

/** "/" is My Work; a role whose first page is another one (Operations) lands there when the app opens. */
function HomeRoute() {
  const { activeRole, pages } = useCurrentUser()
  const first = firstPageFor(activeRole)
  const go = (!landed || !pages?.home) && first !== '/'
  useEffect(() => { landed = true }, [])
  if (go) return <Navigate to={first} replace />
  return <MyWorkPage />
}

/** /proposals?id=PR-… opens the detail page; any other parameters are tracker filters. */
function ProposalsRoute() {
  const [params] = useSearchParams()
  const id = params.get('id')
  if (id) return <Navigate to={`/proposals/${encodeURIComponent(id)}`} replace />
  return <ProposalTrackerPage />
}

const BUILT = new Set(['/', '/queue', '/dashboard', '/proposals', '/events', '/clients', '/opportunities', '/team', '/settings', '/tasks',
  '/staffing', '/facilitators', '/screen', '/analytics'])

export default function App() {
  return (
    <Routes>
      {/* The office screen: full screen, no menu (the office TV). */}
      <Route path="/screen" element={<ScreenPage />} />
      <Route element={<AppShell />}>
        <Route index element={<HomeRoute />} />
        <Route path="/dashboard" element={<RoleGate path="/dashboard"><DashboardPage /></RoleGate>} />
        <Route path="/proposals" element={<RoleGate path="/proposals"><ProposalsRoute /></RoleGate>} />
        <Route path="/proposals/new" element={<RoleGate path="/proposals"><ProposalRequestFormPage key="new" /></RoleGate>} />
        <Route path="/proposals/:id/edit" element={<RoleGate path="/proposals"><ProposalRequestFormPage key="edit" /></RoleGate>} />
        <Route path="/proposals/:id" element={<RoleGate path="/proposals"><ProposalDetailPage /></RoleGate>} />
        <Route path="/staffing" element={<RoleGate path="/staffing"><StaffingPage /></RoleGate>} />
        <Route path="/facilitators" element={<RoleGate path="/facilitators"><FacilitatorsPage /></RoleGate>} />
        <Route path="/facilitators/:id" element={<FacilitatorPage />} />
        <Route path="/queue" element={<RoleGate path="/queue"><QueueBoardPage /></RoleGate>} />
        <Route path="/events" element={<RoleGate path="/events"><EventsPage /></RoleGate>} />
        <Route path="/events/:id" element={<RoleGate path="/events"><EventPage /></RoleGate>} />
        <Route path="/clients" element={<RoleGate path="/clients"><ClientsPage /></RoleGate>} />
        <Route path="/clients/:id" element={<RoleGate path="/clients"><ClientDetailPage /></RoleGate>} />
        <Route path="/opportunities" element={<RoleGate path="/opportunities"><OpportunitiesPage /></RoleGate>} />
        <Route path="/opportunities/:id" element={<RoleGate path="/opportunities"><OpportunityDetailPage /></RoleGate>} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/team/:id" element={<RoleGate path="/team"><PersonPage /></RoleGate>} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/analytics" element={<RoleGate path="/analytics"><AnalyticsPage /></RoleGate>} />
        <Route path="/tasks" element={<RoleGate path="/tasks"><TasksPage /></RoleGate>} />
        {ALL_NAV_ITEMS.filter((item) => !BUILT.has(item.path)).map((item) => (
          <Route key={item.path} path={item.path} element={<PlaceholderPage item={item} />} />
        ))}
        {Object.entries(REDIRECTS).map(([from, to]) => (
          <Route key={from} path={from} element={<Navigate to={to} replace />} />
        ))}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
