import { useCurrentUser } from '../../data/hooks.js'
import { ROLE, roleLabel } from '../../domain/roles.js'

const SHORT = { [ROLE.BUSINESS_DEVELOPMENT]: 'BD' }

/**
 * For people with more than one role (Mariam El Khayat: BD and Account Manager): an obvious switch in
 * the header, "BD | Account Manager", the active one highlighted. New, unread and the bell are per role.
 */
export default function RoleToggle() {
  const { user, activeRole, hasMultipleRoles, switchRole } = useCurrentUser()
  if (!hasMultipleRoles) return null
  return (
    <div className="role-toggle" role="radiogroup" aria-label={`${user.name} is working as`}>
      {user.roles.map((r) => (
        <button key={r} type="button" role="radio" aria-checked={r === activeRole}
          className={`role-toggle__option${r === activeRole ? ' is-active' : ''}`} onClick={() => r !== activeRole && switchRole(r)}>
          {SHORT[r] ?? roleLabel(r, user)}
        </button>
      ))}
    </div>
  )
}

/** "Working as Account Manager": a coloured label on every page for people with more than one role. */
export function WorkingAs() {
  const { user, activeRole, hasMultipleRoles } = useCurrentUser()
  if (!hasMultipleRoles) return null
  return <p className={`working-as working-as--${activeRole}`}>Working as {roleLabel(activeRole, user)}</p>
}
