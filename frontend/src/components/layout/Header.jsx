import Badge from '../ui/Badge.jsx'
import Icon from '../ui/Icon.jsx'
import DemoUserSwitcher from './DemoUserSwitcher.jsx'
import NotificationsMenu from './NotificationsMenu.jsx'
import RoleToggle from './RoleToggle.jsx'
import { CommandButton } from './CommandBox.jsx'
import { API_MODE } from '../../data/source.js'
import { useCurrentUser } from '../../data/hooks.js'

/**
 * Top bar: menu button (small screens), the page name (small screens only; the page
 * itself shows the title on wider screens), which data is shown (the in-memory demo, or the
 * server's real or demo database), and the
 * development identity switcher. "Search  Ctrl K" opens the command box (CommandBox.jsx).
 */
export default function Header({ title, onOpenNav }) {
  const { dataKind } = useCurrentUser()
  return (
    <header className="header">
      <button type="button" className="icon-btn header__menu-btn" onClick={onOpenNav} aria-label="Open navigation">
        <Icon name="menu" size={20} />
      </button>

      <div className="header__title-group">
        <div className="header__title">{title}</div>
        {!API_MODE && (
          <span title="Everything shown is fictional sample data. It resets when the page reloads.">
            <Badge tone="warning" icon="info">Demo data</Badge>
          </span>
        )}
        {API_MODE && dataKind === 'demo' && (
          <span title="The server is using the demo database (fictional sample data for presentations).">
            <Badge tone="warning" icon="info">Demo data</Badge>
          </span>
        )}
        {API_MODE && dataKind === 'real' && <span className="header__data-label">Real data</span>}
        {API_MODE && dataKind === 'test' && (
          <span title="Your own copy of the real data for testing; it is kept between starts. The real data is not changed.">
            <Badge tone="info" icon="info">Test copy</Badge>
          </span>
        )}
        {API_MODE && dataKind === 'presentation' && (
          <span title="A copy of the real data made for this presentation; the real data is not changed.">
            <Badge tone="info" icon="info">Presentation copy</Badge>
          </span>
        )}
      </div>

      <div className="header__actions">
        <CommandButton />
        <NotificationsMenu />
        <RoleToggle />
        <DemoUserSwitcher />
      </div>
    </header>
  )
}
