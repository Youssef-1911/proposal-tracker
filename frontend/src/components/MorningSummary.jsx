import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useCurrentUser } from '../data/hooks.js'
import { cairoHour, greeting, morningFacts } from '../domain/morning.js'

const read = (key) => { try { return window.localStorage.getItem(key) === '1' } catch { return false } }
const write = (key, on) => { try { window.localStorage.setItem(key, on ? '1' : '0') } catch { /* not remembered */ } }

/**
 * "Good morning Ahmed — 3 new items, 2 due today, and Sodic has been waiting 90 days." Each fact links to
 * its list; collapsing it is remembered per person (this browser).
 */
export default function MorningSummary({ counts }) {
  const { user, activeRole } = useCurrentUser()
  const key = `iee.summary.collapsed.${user.id}`
  const [collapsed, setCollapsed] = useState(() => read(key))
  const facts = morningFacts(counts, activeRole)
  const toggle = () => { setCollapsed((c) => { write(key, !c); return !c }) }
  const hello = greeting(user.name.split(' ')[0], cairoHour())
  return (
    <section className={`morning${collapsed ? ' is-collapsed' : ''}`} aria-label="Your summary">
      <p className="morning__text">
        <strong>{hello}</strong>
        {!collapsed && (facts.length ? <> — {facts.map((f, i) => (
          <span key={f.key}>
            {i > 0 && (i === facts.length - 1 ? ', and ' : ', ')}
            <Link to={f.to}>{i === 0 ? f.text.charAt(0).toUpperCase() + f.text.slice(1) : f.text}</Link>
          </span>
        ))}.</> : <> — You&apos;re all caught up.</>)}
      </p>
      <button type="button" className="link-btn morning__toggle" onClick={toggle} aria-expanded={!collapsed}>
        {collapsed ? 'Show' : 'Hide'}
      </button>
    </section>
  )
}
