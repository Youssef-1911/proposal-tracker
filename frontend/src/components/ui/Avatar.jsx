/** tone: 1–6 picks a distinct tint so people with similar initials stay distinguishable. */
export default function Avatar({ initials, size = 'md', tone = 1, title }) {
  return (
    <span
      className={`avatar avatar--${size} avatar--t${tone}`}
      title={title}
      aria-hidden={title ? undefined : 'true'}
    >
      {initials}
    </span>
  )
}
