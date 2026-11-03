/**
 * Grey placeholders shaped like the content while it loads (instead of blank areas or spinners).
 * Screen readers hear one "Loading…"; the shapes are hidden from them. No shimmer when the system
 * asks for reduced motion (styles).
 */
const Bar = ({ w = '100%', h = 12 }) => <span className="skeleton__bar" style={{ inlineSize: w, blockSize: h }} />

/** A list or table: one line per row. */
export function SkeletonList({ rows = 6, columns = 4 }) {
  const widths = ['38%', '22%', '16%', '12%', '10%', '14%']
  return (
    <div className="skeleton" role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton__row" aria-hidden="true">
          {Array.from({ length: columns }, (__, j) => <Bar key={j} w={widths[j % widths.length]} />)}
        </div>
      ))}
    </div>
  )
}

/** A row of number cards (dashboard). */
export function SkeletonCards({ count = 3 }) {
  return (
    <div className="skeleton skeleton--cards" role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton__card" aria-hidden="true"><Bar w="45%" /><Bar w="30%" h={26} /><Bar w="60%" /></div>
      ))}
    </div>
  )
}

/** One request or event page: a status bar, the progress steps, then two columns of cards. */
export function SkeletonRequest() {
  return (
    <div className="skeleton" role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true">
        <div className="skeleton__card"><Bar w="55%" h={14} /></div>
        <div className="skeleton__steps">{Array.from({ length: 5 }, (_, i) => <Bar key={i} h={8} />)}</div>
        <div className="skeleton__columns">
          <div className="skeleton__card">{['30%', '70%', '60%', '80%', '50%', '65%'].map((w, i) => <Bar key={i} w={w} />)}</div>
          <div className="skeleton__card">{['40%', '90%', '75%'].map((w, i) => <Bar key={i} w={w} />)}</div>
        </div>
      </div>
    </div>
  )
}
