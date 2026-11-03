import { useSearchParams } from 'react-router-dom'

/** The active tab of a page, kept in the URL (?tab=…) so links keep working. -> [tab, setTab] */
export default function useTab(ids, fallback = ids[0]) {
  const [params, setParams] = useSearchParams()
  const tab = ids.includes(params.get('tab')) ? params.get('tab') : fallback
  const setTab = (id) => {
    const next = new URLSearchParams(params)
    if (id === fallback) next.delete('tab')
    else next.set('tab', id)
    next.delete('page')
    setParams(next, { replace: true })
  }
  return [tab, setTab]
}
