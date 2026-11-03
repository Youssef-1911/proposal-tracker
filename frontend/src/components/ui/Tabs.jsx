/** Up to four tabs. tabs: [{ id, label, count }]. */
export default function Tabs({ tabs, value, onChange, label }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id}
          className={`tabs__tab${value === t.id ? ' is-active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <span className="tracker-tab__count tabular">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}
