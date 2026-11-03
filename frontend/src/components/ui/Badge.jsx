import Icon from './Icon.jsx'

/** tone: neutral | info | success | warning | danger | accent */
export default function Badge({ tone = 'neutral', icon, children }) {
  return (
    <span className={`badge${tone === 'neutral' ? '' : ` badge--${tone}`}`}>
      {icon && <Icon name={icon} size={12} strokeWidth={2} />}
      {children}
    </span>
  )
}
