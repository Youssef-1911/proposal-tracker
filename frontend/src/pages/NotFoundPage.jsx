import { Link } from 'react-router-dom'
import Card from '../components/ui/Card.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import PageLayout from '../components/layout/PageLayout.jsx'

export default function NotFoundPage() {
  return (
    <PageLayout title="Page not found">
      <Card>
        <EmptyState
          icon="alert"
          title="This page doesn't exist"
          meta={<Link to="/" className="btn">Back to dashboard</Link>}
        >
          Check the address, or use the navigation to find what you need.
        </EmptyState>
      </Card>
    </PageLayout>
  )
}
