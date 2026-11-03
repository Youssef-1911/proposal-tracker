export const BRAND = {
  GRASSHOPPERS: 'grasshoppers',
  TEAM_UP: 'teamup',
}

export const BRANDS = [
  {
    id: BRAND.GRASSHOPPERS,
    name: 'Grasshoppers',
    tagline: 'School trips, camps and kids activities',
    services: [
      { id: 'school_trip', label: 'School trip' },
      { id: 'summer_camp', label: 'Summer camp' },
      { id: 'explorers_league', label: 'Explorers League' },
      { id: 'sleepover', label: 'Sleepover' },
      { id: 'kids_activity', label: 'Kids activity' },
      { id: 'activation', label: 'Activation' },
      { id: 'family_day', label: 'Family day' },
    ],
  },
  {
    id: BRAND.TEAM_UP,
    name: 'Team Up',
    tagline: 'Team building, family days and corporate events',
    services: [
      { id: 'team_building', label: 'Team building' },
      { id: 'family_day', label: 'Family day' },
      { id: 'event_activation', label: 'Event activation' },
      { id: 'corporate_event', label: 'Corporate event' },
    ],
  },
]

export function getBrand(brandId) {
  return BRANDS.find((b) => b.id === brandId)
}

export function serviceLabel(brandId, serviceId) {
  return getBrand(brandId)?.services.find((s) => s.id === serviceId)?.label ?? serviceId
}
