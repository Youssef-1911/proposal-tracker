import { getStatus, subLabelFor } from '../../domain/status.js'

/**
 * The one status pill a row shows, written for the viewer (domain/waiting.js viewerPill):
 * Your turn (blue) · Waiting on <name> (grey) · Overdue (red) · Won (green) · Lost (red, muted).
 * The detailed stage is on hover.
 */
export default function StatusPill({ pill, request }) {
  const detail = request ? [getStatus('proposal', request.status).label, subLabelFor(request.status, request.version)]
    .filter(Boolean).join(' · ') : undefined
  return <span className={`status-pill status-pill--${pill.kind}`} title={detail}>{pill.label}</span>
}

/** "2 questions" · "Details changed" */
export function RowMarkers({ markers }) {
  if (!markers?.length) return null
  return (
    <span className="row-markers">
      {markers.map((m) => <span key={m} className="row-marker">{m}</span>)}
    </span>
  )
}
