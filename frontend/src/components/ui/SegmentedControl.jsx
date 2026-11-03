/** A compact toggle group. options: [{ value, label }]. stacked = one option per row. */
export default function SegmentedControl({ options, value, onChange, label, stacked = false }) {
  return (
    <div className={`segmented${stacked ? ' segmented--stacked' : ''}`} role="group" aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="segmented__option"
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
