import { BRAND } from './brands.js'

/**
 * Which Account Manager receives proposal requests for each brand.
 * In API mode the routing lives in the database (changed in Settings by anyone with
 * "Manage accounts") and the server assigns the AM. This table is the starting routing:
 * the demo store, the seed and the contract world use it.
 */
export const BRAND_AM_ROUTING = {
  [BRAND.GRASSHOPPERS]: 'u-mariam-elkhayat',
  [BRAND.TEAM_UP]: 'u-mariam-dimitri',
}

export function resolveAssignedAM(brandId, routing = BRAND_AM_ROUTING) {
  const amId = (routing ?? BRAND_AM_ROUTING)[brandId]
  if (!amId) throw new Error(`No Account Manager routing configured for brand "${brandId}"`)
  return amId
}
