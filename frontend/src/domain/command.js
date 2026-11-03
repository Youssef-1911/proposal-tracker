/**
 * The Ctrl+K box's local matching (pages, actions, events and people it already has; requests and
 * clients are searched by the server). Every word typed must appear in the label, hint or keywords,
 * ignoring case and accents; labels that start with the text come first. No text: everything, as is.
 */
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function commandMatches(items, text) {
  const words = fold(text).split(/\s+/).filter(Boolean)
  if (!words.length) return items
  const hits = items.filter((item) => {
    const hay = fold([item.label, item.hint, item.keywords].filter(Boolean).join(' '))
    return words.every((w) => hay.includes(w))
  })
  const starts = (item) => (fold(item.label).startsWith(words[0]) ? 0 : 1)
  return hits.map((item, i) => [item, i]).sort((a, b) => starts(a[0]) - starts(b[0]) || a[1] - b[1]).map(([item]) => item)
}
