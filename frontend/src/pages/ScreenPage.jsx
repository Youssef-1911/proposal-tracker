import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCurrentUser, useScreen } from '../data/hooks.js'
import { BRANDS, getBrand } from '../domain/brands.js'
import { formatEventDate } from '../lib/format.js'

const THEME_KEY = 'iee.screen.theme'
const readTheme = () => { try { return window.localStorage.getItem(THEME_KEY) || 'light' } catch { return 'light' } }

const ago = (iso, now) => {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000))
  if (mins < 60) return `${mins} min ago`
  const h = Math.round(mins / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}
const time = (iso) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' }).format(new Date(iso))

/**
 * The office screen (TV mode, 1920×1080): this week's events · proposals in preparation · the latest
 * confirmations · this month. Large type, no scrolling, light or dark. Refreshes every 60 seconds; a new
 * confirmation is highlighted once (no movement when the system asks for reduced motion).
 * No prices, client contacts, drafts or conversations (the server sends none).
 */
export default function ScreenPage() {
  const { pages } = useCurrentUser()
  const { data, error } = useScreen()
  const [theme, setTheme] = useState(readTheme)
  const seen = useRef(null)
  const [fresh, setFresh] = useState(new Set())
  useEffect(() => {
    if (!data) return
    const ids = data.confirmations.map((c) => c.id)
    if (seen.current) {
      const added = ids.filter((id) => !seen.current.has(id))
      if (added.length) {
        setFresh(new Set(added))
        const t = setTimeout(() => setFresh(new Set()), 6000)
        seen.current = new Set(ids)
        return () => clearTimeout(t)
      }
    }
    seen.current = new Set(ids)
    return undefined
  }, [data])
  const flip = () => setTheme((t) => {
    const next = t === 'dark' ? 'light' : 'dark'
    try { window.localStorage.setItem(THEME_KEY, next) } catch { /* not remembered */ }
    return next
  })

  if (!pages?.screen) {
    return <div className="screen" data-theme={theme}><p className="screen__notice">The office screen is not part of your access. <Link to="/">Back</Link></p></div>
  }
  if (!data) return <div className="screen" data-theme={theme}><p className="screen__notice">{error ? error.message : 'Loading…'}</p></div>
  const now = Date.now()
  const m = data.month
  return (
    <div className="screen" data-theme={theme}>
      <header className="screen__head">
        <h1>IEE</h1>
        <span className="screen__updated">Updated {time(data.updatedAt)}</span>
        <button type="button" className="screen__theme" onClick={flip}>{theme === 'dark' ? 'Light' : 'Dark'}</button>
      </header>
      <main className="screen__grid">
        <section className="screen__area">
          <h2>This week</h2>
          {data.week.length === 0 ? <p className="screen__empty">No events this week.</p> : (
            <ul className="screen__list">
              {data.week.slice(0, 7).map((e, i) => (
                <li key={i} className={`screen__brand-edge brand--${e.brand}`}>
                  <span className="screen__date">{formatEventDate(e.date, e.endDate)}</span>
                  <span className="screen__main">{e.client ?? '—'}{e.eventName ? ` · ${e.eventName}` : ''}</span>
                  <span className="screen__brand">{getBrand(e.brand)?.name}{e.initial ? ' · preliminary' : ''}</span>
                </li>
              ))}
              {data.week.length > 7 && <li className="screen__more">+{data.week.length - 7} more</li>}
            </ul>
          )}
        </section>
        <section className="screen__area">
          <h2>In preparation now <span className="screen__count">{data.preparing.count}</span></h2>
          <p className="screen__brands">{BRANDS.map((b) => `${b.name} ${data.preparing.perBrand[b.id] ?? 0}`).join(' · ')}</p>
          <ul className="screen__list">
            {data.preparing.oldest.map((p, i) => (
              <li key={i}><span className="screen__main">{p.client ?? '—'}{p.eventName ? ` · ${p.eventName}` : ''}</span>
                <span className="screen__days">{p.days} {p.days === 1 ? 'day' : 'days'}</span></li>
            ))}
          </ul>
        </section>
        <section className="screen__area">
          <h2>Latest confirmations</h2>
          {data.confirmations.length === 0 ? <p className="screen__empty">None yet.</p> : (
            <ul className="screen__list">
              {data.confirmations.map((c) => (
                <li key={c.id} className={[c.brand && `screen__brand-edge brand--${c.brand}`, fresh.has(c.id) && 'is-fresh'].filter(Boolean).join(' ') || undefined}>
                  <span className="screen__main">{c.client ?? '—'} confirmed{fresh.has(c.id) ? ' 🎉' : ''}</span>
                  <span className="screen__brand">{[getBrand(c.brand)?.name, c.by, ago(c.at, now)].filter(Boolean).join(' · ')}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="screen__area screen__area--numbers">
          <h2>This month</h2>
          <p className="screen__big">{m.confirmed} <span>of {m.decided} confirmed</span></p>
          <p className="screen__big">{m.received} <span>requests received</span></p>
        </section>
      </main>
    </div>
  )
}
