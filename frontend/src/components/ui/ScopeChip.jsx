import Icon from './Icon.jsx'

const SCOPES = {
  personal: { label: 'My workspace', icon: 'user' },
  company: { label: 'Company-wide', icon: 'building' },
}

/**
 * Tells the employee whether they are looking at their own work or shared company data.
 * scope: 'personal' | 'company'. Optional label overrides the default text.
 * With onClick it becomes a toggle button (aria-pressed = selected), e.g. a scope switch.
 */
export default function ScopeChip({ scope, label, onClick, selected = false }) {
  const s = SCOPES[scope]
  if (!s) return null
  const content = (
    <>
      <Icon name={s.icon} size={13} strokeWidth={2} />
      {label ?? s.label}
    </>
  )
  if (onClick) {
    return (
      <button
        type="button"
        className={`scope-chip scope-chip--button scope-chip--${scope}${selected ? ' is-selected' : ''}`}
        aria-pressed={selected}
        onClick={onClick}
      >
        {content}
      </button>
    )
  }
  return <span className={`scope-chip scope-chip--${scope}`}>{content}</span>
}
