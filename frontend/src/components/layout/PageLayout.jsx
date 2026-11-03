import { useLocation, useNavigate } from 'react-router-dom'
import Icon from '../ui/Icon.jsx'
import { WorkingAs } from './RoleToggle.jsx'

/**
 * Where Back goes when there is no earlier page in this tab (a link opened directly):
 * one level up, e.g. /clients/CL-0001 -> /clients, /proposals/PR-1/edit -> /proposals/PR-1, /clients -> /.
 */
export function parentPath(pathname) {
  const parts = pathname.split('/').filter(Boolean)
  return parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : '/'
}

/** Back to the previous page in the app; one level up when the page was opened directly. Not on Home. */
function BackButton() {
  const navigate = useNavigate()
  const location = useLocation()
  if (location.pathname === '/') return null
  // React Router gives the first page of a tab the key "default": there is nothing in the app to go back to.
  const hasHistory = location.key !== 'default'
  return (
    <button
      type="button"
      className="back-button"
      onClick={() => (hasHistory ? navigate(-1) : navigate(parentPath(location.pathname)))}
    >
      <Icon name="arrowLeft" size={16} strokeWidth={2} />
      Back
    </button>
  )
}

/** Standard page frame used by every screen: Back, title, optional subtitle and actions, then content. */
export default function PageLayout({ title, subtitle, actions, children }) {
  return (
    <div className="page">
      <BackButton />
      <WorkingAs />
      <div className="page-header">
        <div>
          <h1 className="page-header__title">{title}</h1>
          {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="page-header__actions">{actions}</div>}
      </div>
      <div className="page__content">{children}</div>
    </div>
  )
}
