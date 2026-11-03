import { useRef, useState } from 'react'
import Badge from '../ui/Badge.jsx'
import Card from '../ui/Card.jsx'
import { useProposalFileUpload } from '../../data/hooks.js'
import RelTime from '../ui/RelTime.jsx'

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * Proposal files (API mode): the files this viewer may see, each downloadable, and, for the
 * assigned AM while the request is with the AM, a simple picker to upload the file for the
 * version being prepared. Who may upload, for which version, and what is accepted all come
 * from the server (request.upload and its error messages).
 * Minimal on purpose: the combined upload + price + Mark ready panel is Phase 4B.
 */
export default function ProposalFiles({ request, usersById }) {
  const { available, upload, download, reload } = useProposalFileUpload(request)
  const [file, setFile] = useState(null)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState(null) // { ok, message | error, stale }
  const inputRef = useRef(null)
  const pendingRef = useRef(false)
  if (!available) return null

  const target = request.upload
  const files = request.files ?? []

  async function send(e) {
    e.preventDefault()
    if (!file || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    try {
      const res = await upload(file)
      setResult(res)
      if (res.ok) {
        setFile(null)
        if (inputRef.current) inputRef.current.value = ''
      }
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  async function get(f) {
    try {
      await download(f)
    } catch (err) {
      setResult({ ok: false, error: err.message })
    }
  }

  return (
    <Card title="Proposal files" subtitle="PDF or PowerPoint, one per version">
      {files.length === 0 ? (
        <p className="muted">No proposal file has been uploaded yet.</p>
      ) : (
        <ul className="file-list">
          {files.map((f) => (
            <li key={f.id} className="file-list__item">
              <span className="file-list__main">
                <strong>v{f.version}</strong> {f.originalName}
                <span className="muted">
                  {' '}· {formatSize(f.sizeBytes)} · {usersById[f.uploadedBy]?.name ?? f.uploadedBy} · <RelTime value={f.uploadedAt} />
                </span>
              </span>
              {f.current ? <Badge tone="info">Current</Badge> : <Badge tone="neutral">Replaced</Badge>}
              <button type="button" className="btn btn--sm" onClick={() => get(f)}>Download</button>
            </li>
          ))}
        </ul>
      )}

      {target?.allowed && (
        <form className="file-upload" onSubmit={send}>
          <label className="form-field">
            <span className="form-field__label">
              {target.replaces ? `Replace the file for version ${target.version}` : `Upload the file for version ${target.version}`}
            </span>
            <input ref={inputRef} id="proposal-upload" type="file" accept=".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null) }} disabled={pending} />
            <span className="form-field__hint">
              PDF or PowerPoint (.pptx), up to 25 MB.
              {target.startsWork && ' Uploading also moves the request to Preparing (In Progress).'}
            </span>
          </label>
          <button type="submit" className="btn btn--primary" disabled={!file || pending} aria-busy={pending}>
            {pending ? 'Uploading…' : 'Upload'}
          </button>
        </form>
      )}

      {result && (
        <div className={`action-feedback ${result.ok ? 'action-feedback--success' : 'form-error'}`} role={result.ok ? 'status' : 'alert'}>
          <span>
            {result.ok ? result.message : result.errors?.file ?? result.error}
          </span>
          {result.stale && (
            <button type="button" className="btn btn--sm" onClick={() => { setResult(null); reload() }}>Reload</button>
          )}
        </div>
      )}
    </Card>
  )
}
