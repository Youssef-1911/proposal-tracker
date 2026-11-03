import { useEffect, useState } from 'react'
import { prefersReducedMotion } from '../../lib/motion.js'

// Numbers that already counted up during this visit (a page load): they don't count again.
const counted = new Set()
const DURATION = 700

/**
 * A dashboard number that counts up from 0 the first time it appears in a visit. Non-numbers
 * ("EGP 1.2M", "3 of 5") and reduced motion show the value straight away.
 */
export default function CountUp({ value, id }) {
  const target = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : null
  const key = id ?? null
  const animate = target !== null && target > 0 && key !== null && !counted.has(key) && !prefersReducedMotion()
  const [shown, setShown] = useState(animate ? 0 : target)
  useEffect(() => {
    if (target === null) return undefined
    if (!animate) { setShown(target); return undefined }
    counted.add(key)
    let frame
    const start = performance.now()
    const tick = (t) => {
      const p = Math.min(1, (t - start) / DURATION)
      setShown(Math.round(target * (1 - (1 - p) ** 3)))
      if (p < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame); setShown(target) }
  }, [target])
  if (target === null) return value
  return <span className="tabular">{shown}</span>
}
