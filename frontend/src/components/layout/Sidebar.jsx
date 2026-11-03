import { NavLink } from 'react-router-dom'
import Icon from '../ui/Icon.jsx'
import { APP_NAME } from '../../config.js'
import { visibleSections } from '../../navigation.js'
import { useCurrentUser, useEvents, useNewCount } from '../../data/hooks.js'
import { cairoTodayISO, eventSectionCounts } from '../../domain/events.js'

function SidebarLink({ item, newCount }) {
  return (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      title={item.label}
      className={({ isActive }) => `sidebar__link${isActive ? ' is-active' : ''}`}
    >
      <Icon name={item.icon} size={18} />
      <span className="sidebar__label">{item.label}</span>
      {item.countsNew && newCount > 0 && <span className="sidebar__count" aria-label={`${newCount} new`}>{newCount > 99 ? '99+' : newCount}</span>}
    </NavLink>
  )
}

function SubLink({ item, count }) {
  return (
    <NavLink to={item.path} end title={item.label}
      className={({ isActive }) => `sidebar__link sidebar__link--sub${isActive ? ' is-active' : ''}`}>
      <span className="sidebar__label">{item.label}</span>
      {count !== undefined && <span className="sidebar__subcount tabular" aria-label={`${count}`}>{count}</span>}
    </NavLink>
  )
}

/** A group (Dashboard, Events): its name, then its pages. */
function Group({ item, counts }) {
  return (
    <div className="sidebar__group">
      <div className="sidebar__group-label"><Icon name={item.icon} size={18} /><span className="sidebar__label">{item.label}</span></div>
      {item.children.map((c) => <SubLink key={c.path} item={c} count={c.count ? counts?.[c.section] : undefined} />)}
    </div>
  )
}

/** Events: each page with its count (loads the events once for the menu). */
function EventsGroup({ item }) {
  const { data } = useEvents()
  return <Group item={item} counts={data ? eventSectionCounts(data, data.today ?? cairoTodayISO()) : null} />
}

export default function Sidebar({ onClose }) {
  const { pages, activeRole } = useCurrentUser()
  const sections = visibleSections(pages, activeRole)
  const newCount = useNewCount()

  return (
    <aside className="sidebar" aria-label="Main navigation">
      <div className="sidebar__brand">
        <span className="sidebar__logo" aria-hidden="true">I</span>
        <div className="sidebar__brand-text">
          <span className="sidebar__brand-name">{APP_NAME}</span>
          <span className="sidebar__brand-tag">Sales &amp; Operations</span>
        </div>
        <button type="button" className="sidebar__close" onClick={onClose} aria-label="Close navigation">
          <Icon name="x" size={18} />
        </button>
      </div>

      <nav className="sidebar__nav">
        {sections.map((section) => (
          <div className="sidebar__section" key={section.id}>
            {section.label && <div className="sidebar__section-label">{section.label}</div>}
            {section.items.map((item) => (item.children?.length
              ? item.path === '/events' ? <EventsGroup key={item.path} item={item} /> : <Group key={item.path} item={item} />
              : <SidebarLink key={item.path} item={item} newCount={newCount} />))}
          </div>
        ))}
      </nav>
    </aside>
  )
}
