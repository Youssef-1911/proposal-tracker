import Card from '../ui/Card.jsx'
import { useLists } from '../../data/hooks.js'
import { optionLabel } from '../../domain/lists.js'
import { DueDate } from '../dashboard/cells.jsx'
import { isDeadlinePending, isDraft } from '../../domain/metrics.js'
import { formatEventDate, formatNumber } from '../../lib/format.js'

export default function RequestRequirements({ request }) {
  const pending = isDeadlinePending(request)
  const monthOnly = /^\d{4}-\d{2}$/.test(request.eventDate ?? '')
  const lists = useLists().data
  const tags = (request.briefTags ?? []).map((c) => optionLabel(lists, 'briefTags', c))
  return (
    <Card title="Event & requirements">
      <div className="requirements">
        <section>
          <h3 className="section-label">Brief</h3>
          <p className="prose">{request.requirementsSummary || <span className="muted">No brief provided.</span>}</p>
          {tags.length > 0 && <p className="muted">Tags: {tags.join(' · ')}</p>}
        </section>
        <section>
          <h3 className="section-label">Specific requirements</h3>
          <p className="prose">
            {request.specificRequirements || <span className="muted">None recorded.</span>}
          </p>
        </section>
        <dl className="field-list field-list--3">
          <div className="field">
            <dt>Participants</dt>
            <dd className="tabular">{request.participants ? formatNumber(request.participants) : '—'}</dd>
          </div>
          <div className="field">
            <dt>Expected event date</dt>
            <dd>
              {formatEventDate(request.eventDate, request.eventEndDate, request.eventDatePrecision)}
              {monthOnly && <span className="field__hint">Exact day not confirmed yet</span>}
            </dd>
          </div>
          <div className="field">
            <dt>Proposal deadline</dt>
            <dd>
              <DueDate date={request.requiredBy} active={pending} />
              <span className="field__hint">
                {pending
                  ? 'When the AM must send the proposal to BD'
                  : isDraft(request)
                    ? 'Applies once the request is submitted'
                    : 'The AM is no longer working on it, so this deadline is not tracked'}
              </span>
            </dd>
          </div>
        </dl>
      </div>
    </Card>
  )
}
