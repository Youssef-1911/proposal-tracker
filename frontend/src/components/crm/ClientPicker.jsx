import { useId, useMemo, useState } from 'react'
import { CLIENT_TYPES } from '../../domain/catalog.js'
import { canOwnClients } from '../../domain/access.js'
import { didYouMean, searchClients } from '../../domain/crm.js'

/**
 * The Client field of the request and opportunity forms: type to search the clients this person
 * may use; the last option adds a new client ("+ Add '<name>' as a new client"), which opens a short
 * section below. The client is created only when the form is saved, together with it (one
 * transaction on the server).
 *
 * value: the chosen client id ('' when none) · newClient: null, or the new client's fields.
 * canAdd: only people who bring in clients (or the Head) may add one here.
 * allClients: every client (for "Did you mean …?", also for clients someone else owns).
 */
export default function ClientPicker({
  id, clients, allClients = clients, value, onChoose, newClient, onNewClient, canAdd, isHead, usersById, brandName,
  errors = {}, describedBy,
}) {
  const listId = useId()
  const chosen = clients.find((c) => c.id === value) ?? null
  const [text, setText] = useState(chosen?.name ?? newClient?.name ?? '')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const matches = useMemo(() => {
    const byId = Object.fromEntries(clients.map((c) => [c.id, c]))
    return searchClients(text, clients).map((cid) => byId[cid])
  }, [text, clients])
  const typed = text.trim()
  const exact = matches.some((c) => c.name.toLowerCase() === typed.toLowerCase())
  const options = [
    ...matches.map((c) => ({ kind: 'client', client: c })),
    ...(canAdd && typed && !exact ? [{ kind: 'new' }] : []),
  ]

  function choose(option) {
    setOpen(false)
    if (option.kind === 'client') {
      setText(option.client.name)
      onNewClient(null)
      onChoose(option.client.id)
    } else {
      onChoose('')
      onNewClient({ name: typed, type: '', contactName: '', contactPhone: '', owner: '' })
    }
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, options.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && open && options[active]) { e.preventDefault(); choose(options[active]) }
    else if (e.key === 'Escape') setOpen(false)
  }

  const similarId = newClient ? didYouMean(newClient.name, allClients) : null
  const similar = similarId ? allClients.find((c) => c.id === similarId) : null
  const usable = similar && clients.some((c) => c.id === similar.id)
  const owners = isHead ? Object.values(usersById).filter(canOwnClients) : []
  const setNew = (field) => (e) => onNewClient({ ...newClient, [field]: e.target.value })

  return (
    <div className="client-picker">
      <input
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        placeholder="Type a client name…"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        aria-invalid={Boolean(errors.clientId) || undefined}
        aria-describedby={describedBy}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setOpen(true)
          setActive(0)
          if (value) onChoose('')
          if (newClient) onNewClient(null)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {open && options.length > 0 && (
        <ul className="client-picker__list" role="listbox" id={listId}>
          {options.map((o, i) => (
            <li
              key={o.kind === 'client' ? o.client.id : 'new'}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`client-picker__option${i === active ? ' is-active' : ''}${o.kind === 'new' ? ' client-picker__option--new' : ''}`}
              onMouseDown={(e) => e.preventDefault()} // keep focus in the box until the choice is made
              onClick={() => choose(o)}
              onMouseEnter={() => setActive(i)}
            >
              {o.kind === 'client'
                ? <>{o.client.name} <span className="muted">· {CLIENT_TYPES[o.client.type]?.label ?? '—'}</span></>
                : <>+ Add &lsquo;{typed}&rsquo; as a new client</>}
            </li>
          ))}
        </ul>
      )}

      {newClient && (
        <div className="client-picker__new" role="group" aria-label="New client">
          {similar && (
            <p className="client-picker__similar" role="note">
              Did you mean <strong>{similar.name}</strong>?{' '}
              {usable ? (
                <button type="button" className="link-btn" onClick={() => choose({ kind: 'client', client: similar })}>
                  Use {similar.name}
                </button>
              ) : (
                <>It already exists, owned by {usersById[similar.owner]?.name ?? 'someone else'}. You can still add a new one.</>
              )}
            </p>
          )}
          <div className="form-grid">
            <div className="form-field">
              <label className="form-field__label" htmlFor={`${id}-new-name`}>Client name<span aria-hidden="true"> *</span></label>
              <input id={`${id}-new-name`} value={newClient.name} onChange={setNew('name')} maxLength={120} />
              {errors['newClient.name'] && <span className="form-field__error" role="alert">{errors['newClient.name']}</span>}
            </div>
            <div className="form-field">
              <label className="form-field__label" htmlFor={`${id}-new-type`}>Type<span aria-hidden="true"> *</span></label>
              <select id={`${id}-new-type`} value={newClient.type} onChange={setNew('type')}>
                <option value="">Choose a type…</option>
                {Object.entries(CLIENT_TYPES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
              </select>
              {errors['newClient.type'] && <span className="form-field__error" role="alert">{errors['newClient.type']}</span>}
            </div>
            {isHead && (
              <div className="form-field">
                <label className="form-field__label" htmlFor={`${id}-new-owner`}>Relationship owner<span aria-hidden="true"> *</span></label>
                <select id={`${id}-new-owner`} value={newClient.owner} onChange={setNew('owner')}>
                  <option value="">Choose the owner…</option>
                  {owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                {errors['newClient.owner'] && <span className="form-field__error" role="alert">{errors['newClient.owner']}</span>}
              </div>
            )}
            <div className="form-field">
              <label className="form-field__label" htmlFor={`${id}-new-contact`}>Contact name (optional)</label>
              <input id={`${id}-new-contact`} value={newClient.contactName} onChange={setNew('contactName')} />
              {errors['newClient.contact.name'] && <span className="form-field__error" role="alert">{errors['newClient.contact.name']}</span>}
            </div>
            <div className="form-field">
              <label className="form-field__label" htmlFor={`${id}-new-phone`}>Phone (optional)</label>
              <input id={`${id}-new-phone`} type="tel" value={newClient.contactPhone} onChange={setNew('contactPhone')} />
              {errors['newClient.contact.phone'] && <span className="form-field__error" role="alert">{errors['newClient.contact.phone']}</span>}
            </div>
          </div>
          <span className="form-field__hint">
            Added when you save{brandName ? `, for ${brandName}` : ''}. {isHead ? '' : 'You will be its relationship owner.'}
          </span>
        </div>
      )}
    </div>
  )
}
