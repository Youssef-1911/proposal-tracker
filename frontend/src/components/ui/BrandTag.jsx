import { getBrand } from '../../domain/brands.js'

/** The brand, always written, with its colour as a small dot (colour is never the only signal). */
export default function BrandTag({ brand, muted = false }) {
  const b = getBrand(brand)
  if (!b) return <span className="muted">—</span>
  return <span className={`brand-tag brand--${b.id}${muted ? ' brand-tag--muted' : ''}`}>{b.name}</span>
}

/** Class names for a row or card with its brand's thin left edge. */
export const brandEdge = (brand) => (getBrand(brand) ? `brand-edge brand--${brand}` : '')
