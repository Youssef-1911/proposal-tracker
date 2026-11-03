import { getBrand, serviceLabel } from '../domain/brands.js'
import { optionLabel } from '../domain/lists.js'
import { formatEventDate, formatNumber, formatWhenFull } from './format.js'

/**
 * The event sheet: one printable page for the team on the day (IEE header, brand, client, event,
 * date(s), venue, participants, brief, quick tags, requirements, facilitators for HR / Operations,
 * the contact the viewer may see, notes for the team). It never carries a price, for anyone.
 * The browser turns it into the PDF ("Save as PDF" in the print dialog); no library is needed.
 */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v)

/** ev: GET /api/events/{id}; showFacilitators: HR and Operations. -> a complete HTML document. */
export function eventSheetHtml(ev, { lists, showFacilitators = false, now = new Date() } = {}) {
  const brand = getBrand(ev.brand)
  const date = ev.eventDate ? formatEventDate(ev.eventDate, ev.eventEndDate, ev.eventDatePrecision) : '—'
  const tags = (ev.briefTags ?? []).map((c) => optionLabel(lists, 'briefTags', c))
  const contact = ev.contact ? [ev.contact.name, ev.contact.phone, ev.contact.email].filter(Boolean).join(' · ') : null
  const facilitators = showFacilitators ? (ev.staffing?.facilitators ?? []).map((f) => [f.name, f.phone].filter(Boolean).join(' · ')) : null
  const row = (label, value) => `<tr><th>${esc(label)}</th><td>${esc(dash(value))}</td></tr>`
  const block = (title, text) => `<h2>${esc(title)}</h2><p class="pre">${esc(dash(text))}</p>`
  const title = `Event sheet — ${ev.clientName ?? ev.id}${ev.eventDate ? ` — ${date}` : ''}`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.45 system-ui, 'Segoe UI', Arial, sans-serif; color: #101828; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #101828; padding-bottom: 6pt; margin-bottom: 12pt; }
  header strong { font-size: 18pt; letter-spacing: 0.04em; }
  header span { color: #475467; font-size: 9pt; }
  h1 { font-size: 16pt; margin: 0 0 2pt; }
  .sub { color: #475467; margin: 0 0 12pt; }
  .brand { display: inline-block; border-left: 4pt solid ${brand?.id === 'grasshoppers' ? '#3d8b1f' : '#6d4bc4'}; padding-left: 6pt; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 10pt; }
  th, td { text-align: left; vertical-align: top; padding: 4pt 6pt; border-bottom: 1px solid #e4e7ec; }
  th { width: 32%; color: #475467; font-weight: 600; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.05em; color: #475467; margin: 12pt 0 4pt; }
  .pre { white-space: pre-wrap; margin: 0; }
  ul { margin: 0; padding-left: 14pt; }
  footer { margin-top: 18pt; color: #667085; font-size: 8pt; }
</style></head>
<body>
  <header><strong>IEE</strong><span>Event sheet · ${esc(ev.id)}</span></header>
  <h1>${esc(ev.clientName ?? '—')}</h1>
  <p class="sub">${esc(ev.eventName ?? '')}${ev.eventName ? ' · ' : ''}<span class="brand">${esc(brand?.name ?? '—')}</span></p>
  <table>
    ${row('Date(s)', date)}
    ${row('Service', serviceLabel(ev.brand, ev.service))}
    ${row('Venue', ev.venue)}
    ${row('Participants', ev.participants ? formatNumber(ev.participants) : null)}
    ${contact ? row('Client contact', contact) : ''}
  </table>
  ${block('Brief', ev.brief)}
  <h2>Quick tags</h2><p>${esc(tags.length ? tags.join(' · ') : '—')}</p>
  ${block('Requirements', ev.specificRequirements)}
  ${facilitators ? `<h2>Facilitators assigned</h2>${facilitators.length ? `<ul>${facilitators.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p>No one assigned yet.</p>'}` : ''}
  ${block('Notes for the team', ev.teamNotes)}
  <footer>Printed ${esc(formatWhenFull(now))}</footer>
</body></html>`
}

/** Opens the print dialog for the sheet (choose "Save as PDF"); the file name follows the page title. */
export function downloadEventSheet(ev, options) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;inset-inline-end:0;inset-block-end:0;width:0;height:0;border:0;'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  doc.open()
  doc.write(eventSheetHtml(ev, options))
  doc.close()
  // Chrome names the saved PDF after the page's title: the sheet's own, for the moment of printing.
  const before = document.title
  document.title = doc.title
  const done = () => { document.title = before; setTimeout(() => frame.remove(), 1000) }
  frame.contentWindow.addEventListener('afterprint', done)
  setTimeout(() => { frame.contentWindow.focus(); frame.contentWindow.print() }, 50)
}
