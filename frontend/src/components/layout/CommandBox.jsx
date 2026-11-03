import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from '../ui/Icon.jsx'
import BrandTag from '../ui/BrandTag.jsx'
import { usePastRecordAllowed } from '../proposal/DataFixes.jsx'
import { useClients, useCurrentUser, useEvents, useFacilitators, useTeam, useTracker, useUsers } from '../../data/hooks.js'
import { parseTrackerParams } from '../../domain/tracker.js'
import { commandMatches } from '../../domain/command.js'
import { visibleSections } from '../../navigation.js'
import { formatEventDate } from '../../lib/format.js'
import { clientLink, newRequestLink, proposalLink } from '../../lib/links.js'
import { peekToken } from '../../lib/peek.js'

const OPEN_EVENT = 'iee:command'
const PER_GROUP = 5
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform ?? '')

/** "Search  Ctrl K" in the header, for people who don't use shortcuts. */
export function CommandButton() {
  return (
    <button type="button" className="command-btn" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
      aria-keyshortcuts={isMac() ? 'Meta+K' : 'Control+K'}>
      <Icon name="search" size={16} />
      <span className="command-btn__label">Search</span>
      <kbd>{isMac() ? '⌘ K' : 'Ctrl K'}</kbd>
    </button>
  )
}

/**
 * Ctrl+K (Cmd+K on a Mac) from anywhere: clients, requests (ID, client or event name), events, people and
 * pages this person may see, and the quick actions they may take. Every list comes from the server
 * already filtered to what this person may see; nothing is loaded until the box opens. Arrows + Enter.
 */
export default function CommandBox() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(OPEN_EVENT, onOpen) }
  }, [])
  return open ? <Box onClose={() => setOpen(false)} /> : null
}

function Box({ onClose }) {
  const ref = useRef(null)
  const inputRef = useRef(null)
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [found, setFound] = useState({})
  const { pages, activeRole, createRequests } = useCurrentUser()
  const pastAllowed = usePastRecordAllowed()
  const report = useCallback((key, items) => setFound((f) => (f[key] === items ? f : { ...f, [key]: items })), [])

  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    inputRef.current?.focus()
    return () => dialog?.close()
  }, [])
  useEffect(() => setActive(0), [q])

  const term = q.trim()
  const groups = useMemo(() => {
    const pageItems = visibleSections(pages, activeRole).flatMap((s) => s.items)
      .map((i) => ({ id: `page:${i.key}`, label: i.label, hint: 'Page', to: i.path }))
    const actions = [
      createRequests?.allowed && { id: 'new', label: 'New request', hint: 'Action', to: newRequestLink() },
      pastAllowed && { id: 'past', label: 'Add past record', hint: 'Action', to: '/proposals?past=1' },
      found.canAddFacilitator && { id: 'fac', label: 'Add facilitator', hint: 'Action', to: '/facilitators?add=1' },
    ].filter(Boolean)
    const pick = (items) => commandMatches(items ?? [], term).slice(0, PER_GROUP)
    return [
      { title: 'Actions', items: pick(actions) },
      { title: 'Requests', items: term ? (found.requests ?? []).slice(0, PER_GROUP) : [] },
      { title: 'Events', items: term ? pick(found.events) : [] },
      { title: 'Clients', items: term ? (found.clients ?? []).slice(0, PER_GROUP) : [] },
      { title: 'People', items: term ? pick(found.people) : [] },
      { title: 'Pages', items: pick(pageItems) },
    ].filter((g) => g.items.length)
  }, [pages, activeRole, createRequests, pastAllowed, found, term])
  const flat = groups.flatMap((g) => g.items)

  const go = (item) => {
    if (!item) return
    onClose()
    navigate(item.to)
  }
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    if (e.key === 'Enter') { e.preventDefault(); go(flat[active]) }
  }
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  let index = -1
  return (
    <dialog ref={ref} className="command" aria-label="Search and quick actions"
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onClick={(e) => { if (e.target === ref.current) onClose() }}>
      <div className="command__inner">
        <div className="command__field">
          <Icon name="search" size={18} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Search clients, requests, events, people or pages" aria-label="Search"
            role="combobox" aria-expanded="true" aria-controls="command-list"
            aria-activedescendant={flat[active] ? `cmd-${flat[active].id}` : undefined} />
          <kbd>Esc</kbd>
        </div>
        <div id="command-list" className="command__list" role="listbox">
          {groups.map((g) => (
            <div key={g.title} role="group" aria-label={g.title}>
              <div className="command__group">{g.title}</div>
              {g.items.map((item) => {
                index += 1
                const i = index
                return (
                  <div key={item.id} id={`cmd-${item.id}`} role="option" aria-selected={i === active}
                    className={`command__item${i === active ? ' is-active' : ''}`}
                    onMouseMove={() => setActive(i)} onClick={() => go(item)}>
                    <span className="command__label">{item.label}</span>
                    {item.brand && <BrandTag brand={item.brand} muted />}
                    <span className="command__hint">{item.hint}</span>
                  </div>
                )
              })}
            </div>
          ))}
          {term && flat.length === 0 && <p className="command__empty">Nothing found for “{term}”.</p>}
        </div>
      </div>
      {/* Each source loads only what this person may open; the server filters every list. */}
      {term && pages?.proposals && <RequestSource q={term} report={report} />}
      {term && pages?.events && <EventSource report={report} />}
      {term && pages?.clients && <ClientSource q={term} report={report} />}
      {term && pages?.team && <PeopleSource report={report} />}
      {pages?.facilitators && <FacilitatorSource report={report} />}
    </dialog>
  )
}

export function RequestSource({ q, report }) {
  const { user, activeRole, scopes } = useCurrentUser()
  const users = useUsers().data
  const scope = scopes?.includes('company') ? 'company' : scopes?.[0]
  const parsed = parseTrackerParams(new URLSearchParams(scope ? { scope } : {}), { userId: user.id, activeRole }, users)
  const state = { ...parsed, filters: { ...parsed.filters, q } }
  const { data } = useTracker(state, { page: 1, pageSize: 20 })
  useEffect(() => {
    if (!data) return
    report('requests', data.rows.map((row) => ({
      id: `req:${row.request.id}`, label: [row.clientName, row.request.eventName].filter(Boolean).join(' · '),
      hint: row.request.id, brand: row.request.brand,
      to: row.opensEditor ? row.href : `${proposalLink(row.request.id)}`,
    })))
  }, [data, report])
  return null
}

export function EventSource({ report }) {
  const { data } = useEvents()
  useEffect(() => {
    if (!data) return
    report('events', (data.items ?? []).map((e) => ({
      id: `ev:${e.id}`, label: [e.clientName, e.eventName].filter(Boolean).join(' · '),
      hint: e.eventDate ? formatEventDate(e.eventDate, e.eventEndDate, e.eventDatePrecision) : e.id,
      keywords: e.id, brand: e.brand, to: `/events?peek=${encodeURIComponent(peekToken('event', e.id))}`,
    })))
  }, [data, report])
  return null
}

export function ClientSource({ q, report }) {
  const { data } = useClients({ q })
  useEffect(() => {
    if (!data) return
    report('clients', data.map((c) => ({ id: `cl:${c.id}`, label: c.name, hint: 'Client', to: clientLink(c.id) })))
  }, [data, report])
  return null
}

function PeopleSource({ report }) {
  const { data } = useTeam()
  useEffect(() => {
    if (!data) return
    report('people', data.filter((u) => u.active !== false)
      .map((u) => ({ id: `u:${u.id}`, label: u.name, hint: u.jobTitle ?? 'Person', keywords: u.email, to: `/team/${u.id}` })))
  }, [data, report])
  return null
}

function FacilitatorSource({ report }) {
  const { data } = useFacilitators()
  useEffect(() => { report('canAddFacilitator', Boolean(data?.canManage)) }, [data, report])
  return null
}
