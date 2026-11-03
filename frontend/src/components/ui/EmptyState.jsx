import Icon from './Icon.jsx'

export default function EmptyState({ icon = 'info', title, children, meta }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">
        <Icon name={icon} size={22} />
      </div>
      <h2 className="empty-state__title">{title}</h2>
      {children && <p className="empty-state__text">{children}</p>}
      {meta && <div className="empty-state__meta">{meta}</div>}
    </div>
  )
}
