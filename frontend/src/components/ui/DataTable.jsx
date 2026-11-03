import { useNavigate } from 'react-router-dom'
import { brandEdge } from './BrandTag.jsx'
import { isPlainClick, usePeek } from '../../lib/peek.js'

/**
 * Compact table. Scrolls horizontally inside its card on narrow screens.
 * columns: [{ key, header, render(row), align: 'start'|'end', nowrap }]
 * rowHref(row): optional; makes the whole row open that link (keyboard: Enter).
 * rowPeek(row): optional peek token (lib/peek.js); a plain click or Enter opens the quick peek instead,
 *   Ctrl / Cmd-click still opens rowHref.
 * rowBrand(row): optional brand id; the row gets the brand's thin left edge.
 */
const INTERACTIVE = 'a, button, input, select, textarea, time'

export default function DataTable({ columns, rows, rowKey, rowHref, rowPeek, rowBrand, rowClassName, emptyMessage = 'Nothing to show.', caption }) {
  const navigate = useNavigate()
  const { open } = usePeek()

  if (!rows.length) {
    return <p className="data-table__empty">{emptyMessage}</p>
  }

  return (
    <div className="data-table__scroll">
      <table className="data-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.align === 'end' ? 'is-end' : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = rowHref?.(row)
            const peek = rowPeek?.(row)
            const linked = Boolean(href || peek)
            // A link or button inside the row handles its own click/Enter; opening the row as well
            // would add the page to the history twice (Back would then seem to do nothing).
            const openRow = (e, viaKey) => {
              if (e.target.closest(INTERACTIVE)) return
              if (peek && (viaKey || isPlainClick(e))) open(peek)
              else if (href) navigate(href)
            }
            return (
              <tr
                key={rowKey(row)}
                className={[linked && 'is-link', rowBrand && brandEdge(rowBrand(row)), rowClassName?.(row)].filter(Boolean).join(' ') || undefined}
                tabIndex={linked ? 0 : undefined}
                onClick={linked ? (e) => openRow(e, false) : undefined}
                onKeyDown={linked ? (e) => e.key === 'Enter' && openRow(e, true) : undefined}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={[c.align === 'end' && 'is-end', c.nowrap && 'is-nowrap'].filter(Boolean).join(' ') || undefined}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
