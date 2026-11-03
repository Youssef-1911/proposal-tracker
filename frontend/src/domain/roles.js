import { getBrand } from './brands.js'

export const ROLE = {
  COMMERCIAL_HEAD: 'commercial_head',
  ACCOUNT_MANAGER: 'account_manager',
  BUSINESS_DEVELOPMENT: 'business_development',
  EXECUTIVE: 'executive',
  MARKETING: 'marketing',
  OPERATIONS: 'operations',
  HR: 'hr', // facilitators for events: staffing, the facilitator list, ratings (sees confirmed events only)
  OFFICE_SCREEN: 'office_screen', // a read-only account for the office TV: the office screen and nothing else
}

/** In the order account screens list them. */
export const ROLE_IDS = [
  ROLE.BUSINESS_DEVELOPMENT, ROLE.ACCOUNT_MANAGER, ROLE.COMMERCIAL_HEAD, ROLE.EXECUTIVE, ROLE.MARKETING, ROLE.OPERATIONS,
  ROLE.HR, ROLE.OFFICE_SCREEN,
]

export const ROLE_CONFIG = {
  [ROLE.COMMERCIAL_HEAD]: {
    label: 'Commercial Head',
    description: 'Oversees both brands and both teams.',
  },
  [ROLE.ACCOUNT_MANAGER]: {
    label: 'Account Manager',
    description: 'Prepares proposals and owns pricing for one brand.',
  },
  [ROLE.BUSINESS_DEVELOPMENT]: {
    label: 'Business Development',
    description: 'Acquires clients, requests and shares proposals, negotiates, follows up.',
  },
  [ROLE.EXECUTIVE]: {
    label: 'Executive',
    description: 'Sees everything across both brands; changes nothing.',
  },
  [ROLE.MARKETING]: {
    label: 'Marketing',
    description: 'Nothing waits on Marketing yet.',
  },
  [ROLE.OPERATIONS]: {
    label: 'Operations',
    description: 'Nothing waits on Operations yet.',
  },
  [ROLE.HR]: {
    label: 'HR',
    description: 'Staffs confirmed events with facilitators and keeps the facilitator list and ratings.',
  },
  [ROLE.OFFICE_SCREEN]: {
    label: 'Office screen',
    description: 'A read-only account for the office TV: it sees the office screen and nothing else.',
  },
}

/** "Account Manager — Grasshoppers" for AMs, plain role label otherwise. */
export function roleLabel(role, user) {
  const base = ROLE_CONFIG[role]?.label ?? role
  if (role === ROLE.ACCOUNT_MANAGER && user?.brand) {
    return `${base} — ${getBrand(user.brand)?.name ?? user.brand}`
  }
  return base
}
