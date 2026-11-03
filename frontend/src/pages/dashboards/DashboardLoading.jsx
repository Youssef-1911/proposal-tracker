import PageLayout from '../../components/layout/PageLayout.jsx'
import Card from '../../components/ui/Card.jsx'
import EmptyState from '../../components/ui/EmptyState.jsx'
import { SkeletonCards, SkeletonList } from '../../components/ui/Skeleton.jsx'

/** A page while its data loads (shaped placeholders), or when it could not be loaded. */
export default function DashboardLoading({ title = 'Dashboard', subtitle, error }) {
  return (
    <PageLayout title={title} subtitle={subtitle}>
      {error ? (
        <Card><EmptyState icon="alert" title="Could not load this page">{error.message}</EmptyState></Card>
      ) : (
        <>
          <SkeletonCards />
          <Card flush><SkeletonList /></Card>
        </>
      )}
    </PageLayout>
  )
}
