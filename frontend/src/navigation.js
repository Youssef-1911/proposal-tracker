import { ROLE } from './domain/roles.js'
import { MENUS } from './domain/access.js'

/**
 * Single source of truth for the sidebar, page titles and role-aware descriptions.
 * The sidebar is flat: main pages only, each with an icon; sections of a page are tabs inside it
 * (in the URL). describe(ctx) receives { role, brandName } and returns the page's one-line purpose.
 * page names the entry of pageAccess() (domain/access.js; in API mode /api/me "pages") that shows the
 * item and opens its page. Which pages a role has (and in which order) is MENUS in domain/access.js,
 * the same list the server uses to refuse everything else.
 */

const CH = ROLE.COMMERCIAL_HEAD
const AM = ROLE.ACCOUNT_MANAGER
const BD = ROLE.BUSINESS_DEVELOPMENT
const EX = ROLE.EXECUTIVE

export const NAV_SECTIONS = [
  {
    id: 'main',
    label: null,
    items: [
      {
        key: 'home', path: '/', label: 'My Work', icon: 'check', page: 'home', countsNew: true,
        describe: ({ role }) =>
          [ROLE.MARKETING, ROLE.OPERATIONS, ROLE.HR].includes(role) ? 'What is new and what needs you.'
          : 'What is new, what is your turn, and what you are waiting for.',
      },
      {
        key: 'queue', path: '/queue', label: 'My queue', icon: 'clipboard', page: 'queue',
        describe: () => 'Every proposal assigned to you, by stage.',
      },
      {
        key: 'proposals', path: '/proposals', label: 'Proposals', icon: 'document', page: 'proposals',
        describe: ({ role, brandName }) =>
          role === EX ? 'Where each proposal is right now (to read).'
          : role === CH ? 'Every proposal across both brands, until the client confirms.'
          : role === AM ? `Every ${brandName} proposal, until the client confirms.`
          : 'Your proposals and where each one stands, until the client confirms.',
      },
      {
        key: 'events', path: '/events', label: 'Events', icon: 'calendar', page: 'events',
        describe: ({ role }) =>
          role === ROLE.HR ? 'Initially confirmed, confirmed and done events.'
          : 'After the client agrees: initially confirmed, confirmed, done, postponed or cancelled.',
      },
      {
        key: 'clients', path: '/clients', label: 'Clients', icon: 'building', page: 'clients',
        describe: ({ role }) =>
          role === BD ? 'Schools, companies and agencies, including the ones you own.'
          : 'Schools, companies and agencies for both brands.',
      },
      {
        key: 'dashboard', path: '/dashboard', label: 'Dashboard', icon: 'dashboard', page: 'dashboard',
        describe: ({ role, brandName }) =>
          role === EX ? 'The company at a glance: value, pipeline, events and what is stuck.'
          : role === CH ? 'Proposals, deadlines and events across both brands, at a glance.'
          : role === AM ? `Your ${brandName} workload at a glance, and your numbers.`
          : 'Your requests at a glance, and your numbers.',
      },
      {
        key: 'analytics', path: '/analytics', label: 'Analytics', icon: 'chart', page: 'analytics',
        describe: () => 'Proposals, events, BD and AM numbers and lost reasons, by period and brand.',
      },
      {
        key: 'staffing', path: '/staffing', label: 'Staffing', icon: 'users', page: 'staffing',
        describe: () => 'Facilitators for confirmed events: needed, assigned and missing.',
      },
      {
        key: 'facilitators', path: '/facilitators', label: 'Facilitators', icon: 'clipboard', page: 'facilitators',
        describe: () => 'Everyone we book for events: events attended, ratings and notes.',
      },
      {
        key: 'admin', path: '/team', label: 'Admin', icon: 'settings', page: 'team',
        describe: () => 'Accounts, roles, routing, lists and occasions.',
      },
      {
        key: 'screen', path: '/screen', label: 'Office screen', icon: 'dashboard', page: 'screen',
        describe: () => 'This week, proposals in preparation and the latest confirmations, for the office TV.',
      },
    ],
  },
]

/** Pages that are not in the menu but still have their own address (titles and descriptions). */
const OTHER_PAGES = [
  {
    key: 'settings', path: '/settings', label: 'Settings', icon: 'settings', page: 'settings',
    describe: () => 'Who receives each brand’s requests, plus the lists and occasions.',
  },
  { key: 'opportunities', path: '/opportunities', label: 'Opportunities', icon: 'target', page: 'opportunities', describe: () => 'Opportunities by stage.' },
  { key: 'tasks', path: '/tasks', label: 'Tasks', icon: 'check', page: 'tasks', describe: () => 'Calls, meetings and follow-ups.' },
]

/** Old addresses that still work (bookmarks, earlier links) and where they now lead. */
export const REDIRECTS = {
  '/my-work': '/',
  '/operations': '/events?tab=week',
  '/admin': '/team',
  '/dashboard/funnel': '/analytics?tab=proposals',
  '/dashboard/events': '/analytics?tab=events',
  '/dashboard/team': '/analytics?tab=bd',
  '/events/week': '/events?tab=week',
  '/events/upcoming': '/events?tab=confirmed',
  '/events/initial': '/events?tab=initial',
  '/events/pipeline': '/events?tab=pipeline',
  '/events/calendar': '/events?tab=calendar',
  '/events/done': '/events?tab=done',
  '/events/postponed-cancelled': '/events?tab=off',
}

export const ALL_NAV_ITEMS = [...NAV_SECTIONS.flatMap((s) => s.items), ...OTHER_PAGES]

/** Exact match, or the section a sub-page belongs to (e.g. /proposals/PR-2026-0007 -> Proposals). */
export function findNavItem(pathname) {
  return (
    ALL_NAV_ITEMS.find((item) => item.path === pathname) ??
    ALL_NAV_ITEMS.find((item) => item.path !== '/' && pathname.startsWith(`${item.path}/`))
  )
}

/** pages = { home, proposals, ... } for this person in this role (useCurrentUser().pages). */
export function canAccess(entry, pages) {
  return !entry?.page || pages?.[entry.page] === true
}

const MENU_LABELS = {}

/** The label of a page for this role. */
export const labelFor = (item, role) => MENU_LABELS[role]?.[item.path] ?? item.label

const KEYS = Object.fromEntries(NAV_SECTIONS[0].items.map((i) => [i.key, i]))

/** The page a role starts on: the first page of its menu. */
export const firstPageFor = (role) => KEYS[(MENUS[role] ?? ['home'])[0]]?.path ?? '/'

/** The flat menu this person sees in this role (main pages only, in the role's order). */
export function visibleSections(pages, role) {
  const order = MENUS[role] ?? ['home']
  const items = order.map((k) => KEYS[k]).filter((i) => i && canAccess(i, pages))
    .map((i) => ({ ...i, label: labelFor(i, role) }))
  return items.length ? [{ id: 'main', label: null, items }] : []
}

