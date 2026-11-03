import { useCallback, useRef, useState } from 'react'
import Icon from '../ui/Icon.jsx'
import useDismiss from '../../lib/useDismiss.js'

/**
 * Global search box. NOT IMPLEMENTED YET: submitting explains that instead of
 * pretending to return results.
 */
export default function HeaderSearch() {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState(null)
  const ref = useRef(null)
  const close = useCallback(() => setSubmitted(null), [])
  useDismiss(ref, submitted !== null, close)

  function onSubmit(e) {
    e.preventDefault()
    setSubmitted(query.trim())
  }

  return (
    <form
      className="search popover-anchor"
      role="search"
      onSubmit={onSubmit}
      ref={ref}
      title="Search is not yet implemented"
    >
      <Icon name="search" size={16} className="search__icon" />
      <input
        className="search__input"
        type="search"
        placeholder="Search (not yet implemented)"
        aria-label="Search clients, opportunities and proposals (not yet implemented)"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setSubmitted(null)
        }}
      />
      {submitted !== null && (
        <div className="popover popover--start" role="status">
          <div className="popover__section">
            <div className="popover__title">Search is not yet implemented</div>
            <p className="popover__text">
              Searching clients, opportunities and proposal requests will be added in a later phase.
            </p>
          </div>
        </div>
      )}
    </form>
  )
}
