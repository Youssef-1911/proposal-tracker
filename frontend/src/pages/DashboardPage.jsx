import { AmHome, BdHome, HeadHome, WaitingOnYouHome } from './dashboards/FocusedHome.jsx'
import ExecutiveOverview from './dashboards/ExecutiveOverview.jsx'
import { usePageDescription } from './PlaceholderPage.jsx'
import { findNavItem } from '../navigation.js'
import { useCurrentUser } from '../data/hooks.js'
import { ROLE } from '../domain/roles.js'
import PageLayout from '../components/layout/PageLayout.jsx'
import Tabs from '../components/ui/Tabs.jsx'
import useTab from '../lib/useTab.js'
import { Analytics } from './AnalyticsPage.jsx'

/**
 * Each Home: the funnel strip, Needs Attention (at most 5 rows) and at most 3 cards. Workload, team
 * tables and breakdowns live in Analytics. Marketing and Operations see what is waiting on them.
 */
const DASHBOARDS = {
  [ROLE.COMMERCIAL_HEAD]: HeadHome,
  [ROLE.ACCOUNT_MANAGER]: AmHome,
  [ROLE.BUSINESS_DEVELOPMENT]: BdHome,
  [ROLE.EXECUTIVE]: ExecutiveOverview, // one screen of company numbers, no operational lists
  [ROLE.MARKETING]: WaitingOnYouHome,
  [ROLE.OPERATIONS]: WaitingOnYouHome,
}

/** Shows the Home for the ACTIVE role (Mariam El Khayat switches between BD and AM). */
export default function DashboardPage() {
  const { activeRole, user } = useCurrentUser()
  const subtitle = usePageDescription(findNavItem('/dashboard'))
  const Dashboard = DASHBOARDS[activeRole] ?? WaitingOnYouHome
  const mine = [ROLE.BUSINESS_DEVELOPMENT, ROLE.ACCOUNT_MANAGER].includes(activeRole)
  const [tab, setTab] = useTab(['overview', 'numbers'])
  // BD and Account Managers: "Overview" (a quick personal overview) · "My numbers" (their own scorecard).
  if (mine && tab === 'numbers') {
    return (
      <PageLayout title="Dashboard" subtitle={subtitle}>
        <DashboardTabs value={tab} onChange={setTab} />
        <Analytics key={`${user.id}:${activeRole}`} mine />
      </PageLayout>
    )
  }
  // key: remount on viewer change so per-page UI state never leaks between people/roles.
  return (
    <>
      {mine && <div className="page page--tabs-only"><DashboardTabs value={tab} onChange={setTab} /></div>}
      <Dashboard key={`${user.id}:${activeRole}`} subtitle={subtitle} />
    </>
  )
}

function DashboardTabs({ value, onChange }) {
  return <Tabs label="Dashboard" value={value} onChange={onChange} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'numbers', label: 'My numbers' }]} />
}
