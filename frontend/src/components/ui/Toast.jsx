import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import Icon from './Icon.jsx'

/** One short success message that disappears after a few seconds. */
export function useToast(ms = 4000) {
  const [message, setMessage] = useState(null)
  useEffect(() => {
    if (!message) return undefined
    const t = setTimeout(() => setMessage(null), ms)
    return () => clearTimeout(t)
  }, [message, ms])
  const show = useCallback((text) => setMessage(text), [])
  return { message, show }
}

/**
 * useToast, plus a message handed over by navigate(path, { state: { toast } }) (e.g. "Client
 * added" after opening the new client). It is shown once, then cleared from the history entry.
 */
export function useRouteToast(ms = 4000) {
  const toast = useToast(ms)
  const location = useLocation()
  const navigate = useNavigate()
  const handed = location.state?.toast
  const { show } = toast
  useEffect(() => {
    if (!handed) return
    show(handed)
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null })
  }, [handed, show, navigate, location.pathname, location.search])
  return toast
}

export default function Toast({ message }) {
  if (!message) return null
  return (
    <div className="toast" role="status">
      <Icon name="checkmark" size={16} strokeWidth={2.25} />
      <span>{message}</span>
    </div>
  )
}
