import { useLocation, useNavigate } from 'react-router-dom'
import Tabs from '../ui/Tabs.jsx'

/** Admin (one menu item): Team & Users · Settings. */
export default function AdminTabs() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  return (
    <Tabs label="Admin" value={pathname.startsWith('/settings') ? 'settings' : 'team'}
      onChange={(id) => navigate(id === 'settings' ? '/settings' : '/team')}
      tabs={[{ id: 'team', label: 'Team & Users' }, { id: 'settings', label: 'Settings' }]} />
  )
}
