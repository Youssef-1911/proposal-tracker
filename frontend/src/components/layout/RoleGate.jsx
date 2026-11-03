import Card from '../ui/Card.jsx'
import EmptyState from '../ui/EmptyState.jsx'
import PageLayout from './PageLayout.jsx'
import { useCurrentUser } from '../../data/hooks.js'
import { canAccess, findNavItem } from '../../navigation.js'

/**
 * Shows a page (and its sub-pages) only when this person's access includes it: their role
 * and privileges (in API mode the server's /api/me "pages"). The server refuses the data too.
 */
export default function RoleGate({ path, children }) {
  const { pages } = useCurrentUser()
  const item = findNavItem(path)
  if (canAccess(item, pages)) return children
  return (
    <PageLayout title={item.label}>
      <Card>
        <EmptyState icon="lock" title="Not available to you">
          {item.label} is not part of your access. Someone with &ldquo;Manage accounts&rdquo; can change this.
        </EmptyState>
      </Card>
    </PageLayout>
  )
}
