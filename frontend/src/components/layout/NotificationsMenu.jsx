import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from '../ui/Icon.jsx'
import useDismiss from '../../lib/useDismiss.js'
import { useNotifications } from '../../data/hooks.js'
import { formatWhen, formatWhenFull } from '../../lib/format.js'

/**
 * The bell: unread count (at most "9+"), the latest 20 newest first; opening one marks it read and goes
 * to it; "Mark all as read". In-app only: no email, pop-ups or sounds. Hidden where the server has none (demo).
 */
export default function NotificationsMenu() {
  const { available, items, unread, read, readAll } = useNotifications()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const navigate = useNavigate()
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  if (!available) return null

  const go = async (n) => {
    setOpen(false)
    if (!n.readAt) await read(n.id)
    if (n.link) navigate(n.link)
  }
  return (
    <div className="popover-anchor" ref={ref}>
      <button type="button" className="icon-btn bell" aria-haspopup="dialog" aria-expanded={open}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" size={20} />
        {unread > 0 && <span className="bell__count" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="popover bell__panel" role="dialog" aria-label="Notifications">
          <div className="bell__head">
            <span className="popover__title">Notifications</span>
            {unread > 0 && <button type="button" className="link-btn" onClick={() => readAll()}>Mark all as read</button>}
          </div>
          {items.length === 0 ? <p className="popover__text">Nothing new.</p> : (
            <ul className="bell__list">
              {items.map((n) => (
                <li key={n.id}>
                  <button type="button" className={`bell__item${n.readAt ? '' : ' is-unread'}`} onClick={() => go(n)}>
                    <span className="bell__title">{n.title}</span>
                    {n.body && <span className="bell__body">{n.body.split('\n').slice(0, 3).join(' · ')}</span>}
                    <span className="bell__time" title={formatWhenFull(n.createdAt)}>{formatWhen(n.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
