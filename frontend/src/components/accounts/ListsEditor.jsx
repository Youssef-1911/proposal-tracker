import { useState } from 'react'
import Card from '../ui/Card.jsx'
import { useListActions, useLists } from '../../data/hooks.js'
import { LIST_DEFS, LIST_LABEL_MAX, OTHER } from '../../domain/lists.js'

/**
 * Settings → Dropdown lists ("Manage accounts"): pick a list, then add, rename, hide or show its
 * options. Nothing is ever deleted, so codes already used keep their names.
 */
export default function ListsEditor({ onMessage }) {
  const { data: lists } = useLists()
  const actions = useListActions()
  const [listId, setListId] = useState(LIST_DEFS[0].id)
  const [adding, setAdding] = useState('')
  const [renaming, setRenaming] = useState(null) // { code, label }
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const options = lists?.[listId] ?? []

  async function run(input) {
    setBusy(true)
    setError(null)
    const result = await actions.change(listId, input)
    setBusy(false)
    if (result.ok) {
      setAdding('')
      setRenaming(null)
      onMessage(result.message)
    } else setError(Object.values(result.errors ?? {})[0] ?? result.error)
  }

  return (
    <Card title="Dropdown lists" subtitle="Add, rename or hide options. Nothing is deleted, so past choices keep their names.">
      <div className="lists-editor">
        <label className="form-field">
          <span className="form-field__label">List</span>
          <select value={listId} onChange={(e) => { setListId(e.target.value); setRenaming(null); setError(null) }}>
            {LIST_DEFS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </label>
        <ul className="settings-list lists-editor__options">
          {options.map((o) => (
            <li key={o.code} className={o.hidden ? 'is-hidden' : undefined}>
              {renaming?.code === o.code ? (
                <form className="lists-editor__row" onSubmit={(e) => { e.preventDefault(); run({ action: 'rename', code: o.code, label: renaming.label }) }}>
                  <input value={renaming.label} maxLength={LIST_LABEL_MAX} aria-label={`New name for ${o.label}`}
                    onChange={(e) => setRenaming({ ...renaming, label: e.target.value })} />
                  <button type="submit" className="btn btn--sm" disabled={busy}>Save</button>
                  <button type="button" className="link-btn" onClick={() => setRenaming(null)}>Cancel</button>
                </form>
              ) : (
                <span className="lists-editor__row">
                  <span>{o.label}{o.hidden && <span className="muted"> · hidden</span>}</span>
                  {actions.available && (
                    <span className="lists-editor__actions">
                      <button type="button" className="link-btn" onClick={() => setRenaming({ code: o.code, label: o.label })}>Rename</button>
                      {o.code !== OTHER && (
                        <button type="button" className="link-btn" disabled={busy}
                          onClick={() => run({ action: o.hidden ? 'show' : 'hide', code: o.code })}>
                          {o.hidden ? 'Show' : 'Hide'}
                        </button>
                      )}
                    </span>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
        {actions.available ? (
          <form className="lists-editor__row" onSubmit={(e) => { e.preventDefault(); run({ action: 'add', label: adding }) }}>
            <input value={adding} maxLength={LIST_LABEL_MAX} placeholder="New option" aria-label="New option"
              onChange={(e) => setAdding(e.target.value)} />
            <button type="submit" className="btn btn--sm" disabled={busy || !adding.trim()}>Add</button>
          </form>
        ) : <p className="muted">Editing the lists needs the server (demo data shows the defaults).</p>}
        {error && <p className="form-field__error" role="alert">{error}</p>}
      </div>
    </Card>
  )
}
