import Badge from './Badge.jsx'
import { PROPOSAL_STATUS, getStage, getStatus, stageOf, subLabelFor } from '../../domain/status.js'

/**
 * Label and colour come only from STATUS_CONFIG. kind: 'proposal' | 'opportunity'
 *
 * Proposals show the simple display STAGE as the main badge with the detailed sub-label
 * beside it (e.g. "With AM · Needs BD info"); the full detailed status is in the tooltip.
 * version: needed for "Revision (vN)". detailed: show the detailed status label instead
 * (used by the "Detailed status" filter/breakdown rows).
 */
export default function StatusBadge({ kind, status, version = 1, detailed = false, compact = false }) {
  const cfg = getStatus(kind, status)
  if (kind !== 'proposal' || detailed) {
    return (
      <span title={cfg.description}>
        <Badge tone={cfg.tone}>{cfg.label}</Badge>
      </span>
    )
  }

  const stage = getStage(stageOf(status))
  const subLabel = subLabelFor(status, version)
  return (
    <span className="status-badge" title={`${cfg.label}: ${cfg.description}`}>
      <Badge tone={stage.tone ?? cfg.tone}>{stage.label}</Badge>
      {!compact && subLabel && <span className="status-badge__sub">{subLabel}</span>}
      {status === PROPOSAL_STATUS.AWAITING_BD_INFO && <Badge tone="warning" icon="alert">Waiting on BD</Badge>}
    </span>
  )
}
