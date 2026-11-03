import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import Card from './ui/Card.jsx'
import MoreMenu from './ui/MoreMenu.jsx'
import { ClientSource, EventSource, RequestSource } from './layout/CommandBox.jsx'
import { useCurrentUser, useTodos } from '../data/hooks.js'
import { commandMatches } from '../domain/command.js'
import { cairoTodayISO } from '../domain/events.js'
import { TODO_TEXT_MAX, isTodoOverdue, linkedTodosLine, todoGroups, validateTodo } from '../domain/todos.js'
import { formatShortDate } from '../lib/format.js'

const LINK_KIND = { cl: 'client', req: 'request', ev: 'event' }
const PICKED = 8
const doneDay = (t) => cairoTodayISO(new Date(t.doneAt))
export const todoLink = (t) => (t.linkKind === 'client' ? `/clients/${encodeURIComponent(t.linkId)}`
  : t.linkKind === 'event' ? `/events/${encodeURIComponent(t.linkId)}` : `/proposals/${encodeURIComponent(t.linkId)}`)

/**
 * "My to-dos" on My Work (every person, every role). One-line quick add: text, an optional due date and
 * an optional link (search). Tick to complete ("Done today" until the day ends; "Show completed": the last
 * 30 days). Edit and delete from "More". Private: the server only ever returns my own.
 */
export function MyTodos() {
  const todos = useTodos()
  const [showCompleted, setShowCompleted] = useState(false)
  const [editing, setEditing] = useState(null)
  const [message, setMessage] = useState(null)
  if (!todos.available) return null
  const today = cairoTodayISO()
  const { open, doneToday, completed } = todoGroups(todos.items, today, doneDay)
  const run = async (promise) => {
    const result = await promise
    setMessage(result.ok ? null : result.error)
    return result
  }
  const row = (t) => (editing === t.id ? (
    <li key={t.id} className="todo todo--editing">
      <TodoForm initial={t} submitLabel="Save" onCancel={() => setEditing(null)}
        onSubmit={async (values) => { const r = await todos.update(t.id, values); if (r.ok) setEditing(null); return r }} />
    </li>
  ) : (
    <li key={t.id} className={`todo${t.doneAt ? ' is-done' : ''}`}>
      <input type="checkbox" checked={Boolean(t.doneAt)} aria-label={t.doneAt ? `Mark "${t.text}" not done` : `Mark "${t.text}" done`}
        onChange={() => run(todos.setDone(t.id, !t.doneAt))} />
      <span className="todo__text">{t.text}</span>
      {t.linkKind && (t.linkLabel
        ? <Link className="todo__link" to={todoLink(t)}>{t.linkLabel}</Link>
        : <span className="todo__link muted">No longer available</span>)}
      {t.dueOn && (
        <span className={`todo__due tabular${isTodoOverdue(t, today) ? ' text-danger' : ''}`}>
          {isTodoOverdue(t, today) ? `Overdue · ${formatShortDate(t.dueOn)}` : t.dueOn === today ? 'Today' : formatShortDate(t.dueOn)}
        </span>
      )}
      <MoreMenu items={[
        ...(!t.doneAt ? [{ label: 'Edit', onSelect: () => setEditing(t.id) }] : []),
        { label: 'Delete', tone: 'danger', onSelect: () => run(todos.remove(t.id)) },
      ]} />
    </li>
  ))
  return (
    <Card id="todos" title={`My to-dos (${open.length})`} subtitle="Only you see these"
      actions={completed.length > 0 ? (
        <button type="button" className="link-btn" onClick={() => setShowCompleted((v) => !v)}>
          {showCompleted ? 'Hide completed' : `Show completed (${completed.length})`}
        </button>
      ) : null}>
      <TodoForm submitLabel="Add" onSubmit={(values) => todos.add(values)} quick />
      {message && <p className="form-field__error" role="alert">{message}</p>}
      {open.length > 0 && <ul className="todo-list">{open.map(row)}</ul>}
      {doneToday.length > 0 && (
        <section aria-label="Done today">
          <h3 className="table-group-title">Done today <span className="muted tabular">{doneToday.length}</span></h3>
          <ul className="todo-list">{doneToday.map(row)}</ul>
        </section>
      )}
      {showCompleted && completed.length > 0 && (
        <section aria-label="Completed">
          <h3 className="table-group-title">Completed · last 30 days <span className="muted tabular">{completed.length}</span></h3>
          <ul className="todo-list">{completed.map(row)}</ul>
        </section>
      )}
    </Card>
  )
}

/** The one-line form: text · due date (optional) · link (optional) · Add / Save. */
function TodoForm({ initial = null, submitLabel, onSubmit, onCancel, quick = false }) {
  const [text, setText] = useState(initial?.text ?? '')
  const [dueOn, setDueOn] = useState(initial?.dueOn ?? '')
  const [link, setLink] = useState(initial?.linkKind ? { kind: initial.linkKind, id: initial.linkId, label: initial.linkLabel ?? initial.linkId } : null)
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    const input = { text, dueOn: dueOn || null, linkKind: link?.kind ?? null, linkId: link?.id ?? null }
    const local = validateTodo(input)
    if (Object.keys(local.errors).length) { setErrors(local.errors); return }
    setBusy(true)
    const result = await onSubmit(local.values)
    setBusy(false)
    if (!result.ok) { setErrors(result.errors && Object.keys(result.errors).length ? result.errors : { text: result.error }); return }
    setErrors({})
    if (quick) { setText(''); setDueOn(''); setLink(null) }
  }
  const error = errors.text ?? errors.dueOn ?? errors.link
  return (
    <form className="todo-form" onSubmit={submit} noValidate>
      <input className="todo-form__text" value={text} maxLength={TODO_TEXT_MAX} onChange={(e) => setText(e.target.value)}
        placeholder={quick ? 'Add a to-do…' : undefined} aria-label="To-do" aria-invalid={Boolean(errors.text)} />
      <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} aria-label="Due date (optional)" aria-invalid={Boolean(errors.dueOn)} />
      <LinkPicker value={link} onChange={setLink} />
      <button type="submit" className="btn btn--sm" disabled={busy}>{submitLabel}</button>
      {onCancel && <button type="button" className="link-btn" onClick={onCancel}>Cancel</button>}
      {error && <span className="form-field__error todo-form__error" role="alert">{error}</span>}
    </form>
  )
}

/** "Link…": search the clients, requests and events this person can open (the server filters each list). */
function LinkPicker({ value, onChange }) {
  const { pages } = useCurrentUser()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [found, setFound] = useState({})
  const report = useCallback((key, items) => setFound((f) => (f[key] === items ? f : { ...f, [key]: items })), [])
  const term = q.trim()
  if (value) {
    return (
      <span className="todo-form__linked">
        <span className="todo__link">{value.label}</span>
        <button type="button" className="link-btn" onClick={() => onChange(null)} aria-label="Remove the link">×</button>
      </span>
    )
  }
  if (!open) return <button type="button" className="link-btn" onClick={() => setOpen(true)}>Link…</button>
  const results = term ? [
    ...(found.requests ?? []), ...commandMatches(found.events ?? [], term), ...(found.clients ?? []),
  ].slice(0, PICKED) : []
  const pick = (item) => {
    const [prefix, ...rest] = item.id.split(':')
    onChange({ kind: LINK_KIND[prefix], id: rest.join(':'), label: item.label || rest.join(':') })
    setOpen(false)
    setQ('')
  }
  return (
    <span className="todo-picker popover-anchor">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Client, request or event"
        aria-label="Link to a client, request or event" onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }} />
      {results.length > 0 && (
        <ul className="popover todo-picker__list" role="listbox">
          {results.map((item) => (
            <li key={item.id} role="option" aria-selected="false">
              <button type="button" className="todo-picker__item" onClick={() => pick(item)}>
                <span>{item.label}</span> <span className="muted">{LINK_KIND[item.id.split(':')[0]]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {term && pages?.proposals && <RequestSource q={term} report={report} />}
      {term && pages?.events && <EventSource report={report} />}
      {term && pages?.clients && <ClientSource q={term} report={report} />}
    </span>
  )
}

/** On a client, request or event page: "1 to-do: Call before Thursday" (only the owner's, only when there is one). */
export function LinkedTodos({ kind, id }) {
  const todos = useTodos()
  const line = todos.available ? linkedTodosLine(todos.items, kind, id) : null
  if (!line) return null
  return <p className="todo-line"><Link to="/#todos">{line}</Link></p>
}
