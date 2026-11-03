/** True when the person asked the system for less motion: no animation anywhere then. */
export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return true // no window (tests, printing): nothing moves
  }
}
