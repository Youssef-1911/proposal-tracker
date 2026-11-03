import Icon from './Icon.jsx'

/** A small, quiet note, e.g. "Adding and editing clients comes next." Not a button. */
export default function CalmNote({ children }) {
  return (
    <p className="calm-note" role="note">
      <Icon name="info" size={14} />
      <span>{children}</span>
    </p>
  )
}
