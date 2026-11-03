import { useEffect, useRef, useState } from 'react'

/** Tracks an element's rendered width so SVG charts can size themselves responsively. */
export default function useElementWidth(initial = 600) {
  const ref = useRef(null)
  const [width, setWidth] = useState(initial)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}
