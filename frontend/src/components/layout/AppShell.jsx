import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar.jsx'
import Header from './Header.jsx'
import { findNavItem } from '../../navigation.js'
import { APP_NAME } from '../../config.js'
import { useNewCount } from '../../data/hooks.js'
import PeekPanel from '../peek/PeekPanel.jsx'
import CommandBox from './CommandBox.jsx'
import Celebration from '../ui/Celebration.jsx'

/** Persistent frame for every screen: sidebar + header + routed page content. */
export default function AppShell() {
  const { pathname } = useLocation()
  const [navOpen, setNavOpen] = useState(false)
  const current = findNavItem(pathname)

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setNavOpen(false), [pathname])

  const newCount = useNewCount()
  useEffect(() => {
    const base = current ? `${current.label} · ${APP_NAME}` : APP_NAME
    document.title = newCount > 0 ? `(${newCount}) ${base}` : base // "(3) My Work · IEE"
  }, [current, newCount])

  return (
    <div className={`app-shell${navOpen ? ' is-nav-open' : ''}`}>
      <Sidebar onClose={() => setNavOpen(false)} />
      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />
      <div className="app-main">
        <Header title={current?.label ?? 'Page not found'} onOpenNav={() => setNavOpen(true)} />
        <main className="app-content">
          <Outlet />
        </main>
        <PeekPanel />
        <CommandBox />
        <Celebration />
      </div>
    </div>
  )
}
