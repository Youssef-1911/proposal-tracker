import { Link } from 'react-router-dom'
import Icon from '../ui/Icon.jsx'
import CountUp from '../ui/CountUp.jsx'

/**
 * delta: { text, direction: 'up' | 'down', good: boolean } (optional)
 * tone: 'default' | 'danger' | 'warning' (highlights something that needs attention)
 * to: optional link (e.g. a filtered placeholder page)
 */
export default function KpiCard({ label, value, icon, tone = 'default', delta, note, to }) {
  const body = (
    <>
      <div className="kpi-card__top">
        <span className="kpi-card__label">{label}</span>
        <span className={`kpi-card__icon${tone !== 'default' ? ` kpi-card__icon--${tone}` : ''}`}>
          <Icon name={icon} size={16} strokeWidth={2} />
        </span>
      </div>
      <div className="kpi-card__value"><CountUp value={value} id={label} /></div>
      {(delta || note) && (
        <div className="kpi-card__foot">
          {delta && (
            <span className={`delta delta--${delta.good ? 'good' : 'bad'}`}>
              <Icon name={delta.direction === 'up' ? 'arrowUp' : 'arrowDown'} size={12} strokeWidth={2.25} />
              {delta.text}
            </span>
          )}
          {note && <span>{note}</span>}
        </div>
      )}
    </>
  )

  return to ? (
    <Link to={to} className="card kpi-card kpi-card--link">
      {body}
    </Link>
  ) : (
    <div className="card kpi-card">{body}</div>
  )
}
