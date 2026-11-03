import { useSearchParams } from 'react-router-dom'
import Badge from '../components/ui/Badge.jsx'
import Icon from '../components/ui/Icon.jsx'
import Card from '../components/ui/Card.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import PageLayout from '../components/layout/PageLayout.jsx'
import { useCurrentUser } from '../data/hooks.js'
import { canAccess } from '../navigation.js'

/** Role-aware one-line description for a nav item. */
export function usePageDescription(item) {
  const { activeRole, brand } = useCurrentUser()
  return item.describe({ role: activeRole, brandName: brand?.name ?? '' })
}

/** Shows the URL filters a link passed in, so links can be checked before the list pages exist. */
function ReceivedFilters() {
  const [params] = useSearchParams()
  const entries = [...params.entries()]
  if (!entries.length) return null
  return (
    <div className="store-check" role="status">
      <Icon name="sliders" size={16} />
      <span>
        <strong>Filters received from link:</strong>{' '}
        {entries.map(([k, v]) => `${k} = ${v}`).join(' · ')}
        <span className="store-check__note"> (not applied yet; this page is still a placeholder)</span>
      </span>
    </div>
  )
}

/** Consistent stand-in for screens that are planned but not built yet. */
export default function PlaceholderPage({ item, children }) {
  const { pages } = useCurrentUser()
  const description = usePageDescription(item)

  if (!canAccess(item, pages)) {
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

  return (
    <PageLayout title={item.label} subtitle={description}>
      {children}
      <ReceivedFilters />
      {/* Filters arrive from dashboard links; the real list page will apply them in a later phase. */}
      <Card>
        <EmptyState icon={item.icon} title="Coming in a later phase" meta={<Badge>Not built yet</Badge>}>
          This screen hasn&apos;t been built yet. It will use the shared demo data until it is
          connected to the backend.
        </EmptyState>
      </Card>
    </PageLayout>
  )
}
