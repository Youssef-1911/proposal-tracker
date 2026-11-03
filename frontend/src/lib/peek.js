import { useCallback } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'

/**
 * Quick peek: a list row opens a side panel instead of a new page. It lives in the URL (?peek=PR-…
 * for a proposal, ?peek=event:PR-… for an event) so it can be shared; the list underneath keeps its
 * scroll and filters. Opening adds a history entry, so Back closes it too.
 */
export const peekToken = (kind, id) => (kind === 'event' ? `event:${id}` : id)

export function parsePeek(token) {
  if (!token) return null
  return token.startsWith('event:') ? { kind: 'event', id: token.slice(6) } : { kind: 'proposal', id: token }
}

/** Plain clicks peek; Ctrl / Cmd / Shift / middle clicks keep the link's own behaviour (new tab). */
export const isPlainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey

export function usePeek() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const peek = parsePeek(params.get('peek'))
  const open = useCallback((token) => {
    const next = new URLSearchParams(location.search)
    next.set('peek', token)
    navigate({ pathname: location.pathname, search: `?${next}` }, { state: { peekFrom: true } })
  }, [navigate, location.pathname, location.search])
  const close = useCallback(() => {
    if (location.state?.peekFrom) { navigate(-1); return }
    const next = new URLSearchParams(location.search)
    next.delete('peek')
    const search = next.toString()
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true })
  }, [navigate, location.pathname, location.search, location.state])
  return { peek, open, close }
}

/** onClick for a Link to a request or event: peek on a plain click, follow the link otherwise. */
export function usePeekLink() {
  const { open } = usePeek()
  return useCallback((token) => (e) => {
    if (!isPlainClick(e)) return
    e.preventDefault()
    open(token)
  }, [open])
}
