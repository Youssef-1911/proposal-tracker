/**
 * ============================================================================
 *  DEMO DATA: FICTIONAL CLIENTS AND NUMBERS, REAL TEAM NAMES.
 * ============================================================================
 *  Clients, contacts, amounts, events and tasks are invented for demonstration
 *  and do not represent real business. Team members are the real commercial
 *  team so the role-based views can be reviewed realistically.
 *
 *  All dates are generated relative to "today" when the app loads, so the demo
 *  always contains items due today, overdue items and upcoming events.
 *
 *  This is the ONE dataset every page reads from (via src/demo/hooks.js).
 * ============================================================================
 */

import { BRAND } from '../domain/brands.js'
import { ROLE } from '../domain/roles.js'
import { defaultPrivileges } from '../domain/access.js'
import { resolveAssignedAM } from '../domain/routing.js'
import { OPPORTUNITY_STAGE as STAGE, PROPOSAL_STATUS as PS } from '../domain/status.js'
import { toISODate } from '../lib/format.js'

// ---------- Date helpers (relative to load time) ----------

function dateIn(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return toISODate(d)
}

/** "YYYY-MM": for events where only the month is known so far. */
function monthIn(days) {
  return dateIn(days).slice(0, 7)
}

function timestampDaysAgo(days, hour = 10, minute = 0) {
  const d = new Date()
  d.setDate(d.getDate() - Math.floor(days))
  d.setHours(hour, minute, 0, 0)
  // Never produce a timestamp in the future for "today" events.
  return (d > new Date() ? new Date(Date.now() - 15 * 60000) : d).toISOString()
}

// ---------- Users (real team) ----------

const BRINGS_IN_CLIENTS = ['u-noha', 'u-doaa']

const USERS = [
  { id: 'u-noha', name: 'Noha El Kenawy', initials: 'NK', avatarTone: 1, jobTitle: 'Commercial Head',
    email: 'noha@eventflow.example', roles: [ROLE.COMMERCIAL_HEAD], brand: null },
  { id: 'u-mariam-elkhayat', name: 'Mariam El Khayat', initials: 'MK', avatarTone: 2, jobTitle: 'Senior Account Manager',
    email: 'mariam.elkhayat@eventflow.example', roles: [ROLE.BUSINESS_DEVELOPMENT, ROLE.ACCOUNT_MANAGER], brand: BRAND.GRASSHOPPERS },
  { id: 'u-mariam-dimitri', name: 'Mariam Dimitri', initials: 'MD', avatarTone: 3, jobTitle: 'Account Manager',
    email: 'mariam.dimitri@eventflow.example', roles: [ROLE.ACCOUNT_MANAGER], brand: BRAND.TEAM_UP },
  { id: 'u-abdelrahman', name: 'Abdelrahman Shams', initials: 'AB', avatarTone: 4, jobTitle: 'Business Development Executive',
    email: 'abdelrahman@eventflow.example', roles: [ROLE.BUSINESS_DEVELOPMENT], brand: null },
  { id: 'u-sherine', name: 'Sherine El Tabakh', initials: 'ST', avatarTone: 5, jobTitle: 'Business Development Executive',
    email: 'sherine@eventflow.example', roles: [ROLE.BUSINESS_DEVELOPMENT], brand: null },
  { id: 'u-ahmed', name: 'Ahmed Seif', initials: 'AS', avatarTone: 6, jobTitle: 'Business Development Executive',
    email: 'ahmed@eventflow.example', roles: [ROLE.BUSINESS_DEVELOPMENT], brand: null },
  { id: 'u-doaa', name: 'Doaa', initials: 'DO', avatarTone: 1, jobTitle: 'Managing Director',
    email: 'doaa@eventflow.example', roles: [ROLE.EXECUTIVE], brand: null },
  { id: 'u-tony', name: 'Tony', initials: 'TO', avatarTone: 2, jobTitle: 'Business Unit Director',
    email: 'tony@eventflow.example', roles: [ROLE.EXECUTIVE], brand: null },
].map((u) => ({
  ...u,
  active: true,
  // Noha and Doaa bring in clients themselves (own clients and requests, no BD role).
  privileges: { ...defaultPrivileges(u.roles), ...(BRINGS_IN_CLIENTS.includes(u.id) ? { bringsInClients: true } : {}) },
}))

const MK = 'u-mariam-elkhayat'
const AB = 'u-abdelrahman'
const ST = 'u-sherine'
const AS = 'u-ahmed'

// ---------- Clients (fictional) ----------

const G = BRAND.GRASSHOPPERS
const T = BRAND.TEAM_UP

const CLIENTS = [
  { id: 'c-01', name: 'Crescent Valley International School', type: 'school', brands: [G], city: 'New Cairo',
    contact: { name: 'Rania Fouad', title: 'Activities Coordinator', phone: '+20 100 555 0101', email: 'r.fouad@crescentvalley.example' }, owner: MK },
  { id: 'c-02', name: 'Lotusfield Language School', type: 'school', brands: [G], city: 'Giza',
    contact: { name: 'Hany Saber', title: 'Deputy Principal', phone: '+20 100 555 0102', email: 'h.saber@lotusfield.example' }, owner: ST },
  { id: 'c-03', name: 'Heliopolis Horizon Academy', type: 'school', brands: [G], city: 'Cairo',
    contact: { name: 'Dina Lotfy', title: 'Head of Student Life', phone: '+20 100 555 0103', email: 'd.lotfy@horizonacademy.example' }, owner: AB },
  { id: 'c-04', name: 'Sunstone British School', type: 'school', brands: [G], city: 'Sheikh Zayed',
    contact: { name: 'Karim Nabil', title: 'Primary Years Lead', phone: '+20 100 555 0104', email: 'k.nabil@sunstone.example' }, owner: MK },
  { id: 'c-05', name: 'Delta Lighthouse School', type: 'school', brands: [G], city: 'Alexandria',
    contact: { name: 'Mona Adel', title: 'Trips Officer', phone: '+20 100 555 0105', email: 'm.adel@deltalighthouse.example' }, owner: AS },
  { id: 'c-06', name: 'Oakpalm American School', type: 'school', brands: [G], city: '6th of October',
    contact: { name: 'Youssef Kamal', title: 'Elementary Principal', phone: '+20 100 555 0106', email: 'y.kamal@oakpalm.example' }, owner: ST },
  { id: 'c-07', name: 'Papyrus Fintech', type: 'corporate', brands: [T], city: 'Cairo',
    contact: { name: 'Salma Hegazy', title: 'People & Culture Manager', phone: '+20 100 555 0107', email: 's.hegazy@papyrusfintech.example' }, owner: AB },
  { id: 'c-08', name: 'Harbor Line Logistics', type: 'corporate', brands: [T], city: 'Alexandria',
    contact: { name: 'Tarek Mansour', title: 'HR Director', phone: '+20 100 555 0108', email: 't.mansour@harborline.example' }, owner: AS },
  { id: 'c-09', name: 'Medora Pharma', type: 'corporate', brands: [T, G], city: '6th of October',
    contact: { name: 'Nourhan Zaki', title: 'Employee Engagement Lead', phone: '+20 100 555 0109', email: 'n.zaki@medorapharma.example' }, owner: ST },
  { id: 'c-10', name: 'Obelisk Telecom', type: 'corporate', brands: [T], city: 'New Cairo',
    contact: { name: 'Omar Ragab', title: 'HR Business Partner', phone: '+20 100 555 0110', email: 'o.ragab@obelisktelecom.example' }, owner: AB },
  { id: 'c-11', name: 'BrightWave Events Agency', type: 'agency', brands: [T, G], city: 'Cairo',
    contact: { name: 'Laila Hamdy', title: 'Account Director', phone: '+20 100 555 0111', email: 'l.hamdy@brightwave.example' }, owner: AS },
  { id: 'c-12', name: 'Riverbend Community Club', type: 'other', brands: [G, T], city: 'Giza',
    contact: { name: 'Sameh Wahba', title: 'Events Committee Chair', phone: '+20 100 555 0112', email: 's.wahba@riverbend.example' }, owner: MK },
]

// ---------- Opportunities ----------

const OPPORTUNITIES = [
  { id: 'OPP-0001', clientId: 'c-10', brand: T, service: 'team_building', owner: AB, stage: STAGE.NEW_LEAD,
    estimatedValue: 180000, participants: 120, eventDate: dateIn(75),
    nextAction: 'Intro meeting with HR', nextActionDate: dateIn(2) },
  { id: 'OPP-0002', clientId: 'c-05', brand: G, service: 'school_trip', owner: AS, stage: STAGE.CONTACTED,
    estimatedValue: 95000, participants: 80, eventDate: dateIn(60),
    nextAction: 'Send brochure and sample itinerary', nextActionDate: dateIn(0) },
  { id: 'OPP-0003', clientId: 'c-01', brand: G, service: 'summer_camp', owner: MK, stage: STAGE.REQUIREMENTS_GATHERED,
    estimatedValue: 420000, participants: 150, eventDate: monthIn(240),
    nextAction: 'Finalise and submit proposal request', nextActionDate: dateIn(1) },
  { id: 'OPP-0004', clientId: 'c-08', brand: T, service: 'family_day', owner: AS, stage: STAGE.REQUIREMENTS_GATHERED,
    estimatedValue: 260000, participants: 300, eventDate: dateIn(45),
    nextAction: 'Confirm venue preference with HR', nextActionDate: dateIn(-1) },
  { id: 'OPP-0005', clientId: 'c-04', brand: G, service: 'sleepover', owner: MK, stage: STAGE.PROPOSAL_REQUESTED,
    estimatedValue: 85000, participants: 60, eventDate: dateIn(35),
    nextAction: 'Wait for proposal, then book client call', nextActionDate: dateIn(4) },
  { id: 'OPP-0006', clientId: 'c-07', brand: T, service: 'corporate_event', owner: AB, stage: STAGE.PROPOSAL_REQUESTED,
    estimatedValue: 550000, participants: 400, eventDate: dateIn(50),
    nextAction: 'Check proposal progress with AM', nextActionDate: dateIn(3) },
  { id: 'OPP-0007', clientId: 'c-02', brand: G, service: 'school_trip', owner: ST, stage: STAGE.PROPOSAL_REQUESTED,
    estimatedValue: 120000, participants: 110, eventDate: dateIn(28),
    nextAction: 'Confirm bus count with school', nextActionDate: dateIn(1) },
  { id: 'OPP-0008', clientId: 'c-09', brand: T, service: 'team_building', owner: ST, stage: STAGE.PROPOSAL_REQUESTED,
    estimatedValue: 210000, participants: 90, eventDate: dateIn(40),
    nextAction: 'Share proposal once ready', nextActionDate: dateIn(2) },
  { id: 'OPP-0009', clientId: 'c-03', brand: G, service: 'explorers_league', owner: AB, stage: STAGE.PROPOSAL_REQUESTED,
    estimatedValue: 160000, participants: 70, eventDate: dateIn(55),
    nextAction: 'Send headcount per grade to AM', nextActionDate: dateIn(-3) },
  { id: 'OPP-0010', clientId: 'c-11', brand: T, service: 'event_activation', owner: AS, stage: STAGE.PROPOSAL_REQUESTED,
    estimatedValue: 340000, participants: 500, eventDate: dateIn(30),
    nextAction: 'Get brand guidelines from agency', nextActionDate: dateIn(0) },
  { id: 'OPP-0011', clientId: 'c-01', brand: G, service: 'school_trip', owner: MK, stage: STAGE.PROPOSAL_REQUESTED,
    estimatedValue: 135000, participants: 120, eventDate: dateIn(21),
    nextAction: 'Share proposal with school', nextActionDate: dateIn(0) },
  { id: 'OPP-0012', clientId: 'c-10', brand: T, service: 'family_day', owner: AB, stage: STAGE.PROPOSAL_REQUESTED,
    estimatedValue: 300000, participants: 350, eventDate: dateIn(65),
    nextAction: 'Share proposal with HR', nextActionDate: dateIn(1) },
  { id: 'OPP-0013', clientId: 'c-06', brand: G, service: 'kids_activity', owner: ST, stage: STAGE.NEGOTIATION,
    estimatedValue: 70000, participants: 90, eventDate: dateIn(18),
    nextAction: 'Feedback call with principal', nextActionDate: dateIn(0) },
  { id: 'OPP-0014', clientId: 'c-12', brand: T, service: 'family_day', owner: MK, stage: STAGE.NEGOTIATION,
    estimatedValue: 190000, participants: 250, eventDate: dateIn(33),
    nextAction: 'Follow up on proposal feedback', nextActionDate: dateIn(2) },
  { id: 'OPP-0015', clientId: 'c-08', brand: T, service: 'team_building', owner: AS, stage: STAGE.NEGOTIATION,
    estimatedValue: 230000, participants: 100, eventDate: dateIn(26),
    nextAction: 'Send revised activity list', nextActionDate: dateIn(0) },
  { id: 'OPP-0016', clientId: 'c-05', brand: G, service: 'summer_camp', owner: AS, stage: STAGE.WON,
    estimatedValue: 380000, participants: 140, eventDate: monthIn(210),
    nextAction: 'Hand over to Operations', nextActionDate: dateIn(5) },
  { id: 'OPP-0017', clientId: 'c-09', brand: G, service: 'kids_activity', owner: ST, stage: STAGE.WON,
    estimatedValue: 65000, participants: 60, eventDate: dateIn(12),
    nextAction: 'Hand over to Operations', nextActionDate: dateIn(1) },
  { id: 'OPP-0018', clientId: 'c-07', brand: T, service: 'team_building', owner: AB, stage: STAGE.LOST,
    estimatedValue: 175000, participants: 80, eventDate: dateIn(20),
    nextAction: null, nextActionDate: null, lostReason: 'competitor' },
]

// ---------- Proposal requests ----------

const AM_STATUSES = new Set([PS.IN_PROGRESS, PS.AWAITING_BD_INFO, PS.READY_FOR_BD])

const STATUS_PATHS = {
  [PS.DRAFT]: [PS.DRAFT],
  [PS.SUBMITTED]: [PS.DRAFT, PS.SUBMITTED],
  [PS.IN_PROGRESS]: [PS.DRAFT, PS.SUBMITTED, PS.IN_PROGRESS],
  [PS.AWAITING_BD_INFO]: [PS.DRAFT, PS.SUBMITTED, PS.IN_PROGRESS, PS.AWAITING_BD_INFO],
  [PS.READY_FOR_BD]: [PS.DRAFT, PS.SUBMITTED, PS.IN_PROGRESS, PS.READY_FOR_BD],
  [PS.SHARED_WITH_CLIENT]: [PS.DRAFT, PS.SUBMITTED, PS.IN_PROGRESS, PS.READY_FOR_BD, PS.SHARED_WITH_CLIENT],
  [PS.REVISION_REQUESTED]: [PS.DRAFT, PS.SUBMITTED, PS.IN_PROGRESS, PS.READY_FOR_BD, PS.SHARED_WITH_CLIENT, PS.REVISION_REQUESTED],
  [PS.ACCEPTED]: [PS.DRAFT, PS.SUBMITTED, PS.IN_PROGRESS, PS.READY_FOR_BD, PS.SHARED_WITH_CLIENT, PS.ACCEPTED],
  [PS.REJECTED]: [PS.DRAFT, PS.SUBMITTED, PS.IN_PROGRESS, PS.READY_FOR_BD, PS.SHARED_WITH_CLIENT, PS.REJECTED],
  [PS.CANCELLED]: [PS.DRAFT, PS.SUBMITTED, PS.CANCELLED],
}

/**
 * created/last: days ago of the first and latest status change.
 * requiredIn: days from today the proposal is needed by (negative = overdue).
 */
const REQUEST_DEFS = [
  { opp: 'OPP-0016', status: PS.REJECTED, created: 55, last: 42, requiredIn: -48, amPrice: 410000, lostReason: 'price',
    summary: 'Residential 7-day summer camp, 140 students, Red Sea location.', note: 'Client found the residential concept over budget.' },
  { opp: 'OPP-0016', status: PS.ACCEPTED, created: 40, last: 15, requiredIn: -33, amPrice: 372000,
    path: [PS.DRAFT, PS.SUBMITTED, PS.IN_PROGRESS, PS.READY_FOR_BD, PS.SHARED_WITH_CLIENT, PS.REVISION_REQUESTED, PS.IN_PROGRESS, PS.READY_FOR_BD, PS.SHARED_WITH_CLIENT, PS.ACCEPTED],
    summary: 'Day-camp format summer programme, 140 students, 10 days, transport included.', note: 'Signed off by school board.' },
  { opp: 'OPP-0018', status: PS.REJECTED, created: 30, last: 12, requiredIn: -24, amPrice: 168000, lostReason: 'competitor',
    summary: 'Half-day outdoor team building for 80 staff, Sokhna resort.', note: 'Client chose a lower-cost provider.' },
  { opp: 'OPP-0014', status: PS.CANCELLED, created: 25, last: 20, requiredIn: -18,
    summary: 'Spring family gathering for club members.', note: 'Duplicate: client merged two events into one family day.' },
  { opp: 'OPP-0017', status: PS.ACCEPTED, created: 22, last: 8, requiredIn: -15, amPrice: 64000,
    summary: 'Kids corner and activities for the Medora family day, 60 children aged 4–12.', note: 'Deposit confirmed by client.' },
  { opp: 'OPP-0015', status: PS.REVISION_REQUESTED, created: 20, last: 2, requiredIn: 3, amPrice: 236000,
    summary: 'Full-day team building for 100 staff with lunch, Alexandria.', note: 'Client wants a half-day option and a lower per-head price.' },
  { opp: 'OPP-0013', status: PS.SHARED_WITH_CLIENT, created: 16, last: 5, requiredIn: -8, amPrice: 68000,
    summary: 'On-campus activity day for KG and Grade 1, 90 children.' },
  { opp: 'OPP-0006', status: PS.CANCELLED, created: 12, last: 9, requiredIn: -4,
    summary: 'Annual gala dinner with entertainment, 400 guests.', note: 'Client moved the event date; replaced by a new request.' },
  { opp: 'OPP-0014', status: PS.SHARED_WITH_CLIENT, created: 11, last: 3, requiredIn: -4, amPrice: 182000,
    summary: 'Family day for 250 club members with kids zone, food stalls and stage show.' },
  { opp: 'OPP-0012', status: PS.READY_FOR_BD, created: 10, last: 0, requiredIn: 2, amPrice: 285000,
    // Includes a pause for BD information so turnaround can exclude waiting-on-BD time.
    path: [PS.DRAFT, PS.SUBMITTED, PS.IN_PROGRESS, PS.AWAITING_BD_INFO, PS.IN_PROGRESS, PS.READY_FOR_BD],
    stepNotes: { 3: 'Need confirmed venue capacity and catering preference.' },
    summary: 'Employee family day, 350 attendees, outdoor venue in New Cairo.',
    specific: 'Shaded seating for 350. Separate kids zone with supervisors. Vegetarian food options.' },
  { opp: 'OPP-0011', status: PS.READY_FOR_BD, created: 9, last: 1, requiredIn: 1, amPrice: 128000,
    summary: 'Grade 6 day trip to Alexandria, 120 students, 3 buses, museum and beach visit.',
    specific: 'Halal lunch boxes for all students. Two wheelchair-accessible seats. Back at school by 15:30.' },
  { opp: 'OPP-0009', status: PS.AWAITING_BD_INFO, created: 8, last: 3, requiredIn: 1,
    summary: 'Explorers League season for Grades 4–6, 70 students, 6 sessions.', note: 'Need confirmed headcount per grade and preferred dates.' },
  { opp: 'OPP-0010', status: PS.AWAITING_BD_INFO, created: 7, last: 2, requiredIn: -1,
    summary: 'Mall brand activation for agency client, 2 weekends, ~500 visitors per day.', note: 'Please confirm brand guidelines and activation footprint.' },
  { opp: 'OPP-0007', status: PS.IN_PROGRESS, created: 6, last: 4, requiredIn: 2,
    summary: 'Grade 5 science trip, 110 students, 2 locations in Giza.' },
  { opp: 'OPP-0008', status: PS.IN_PROGRESS, created: 5, last: 3, requiredIn: 0, fileUploaded: true,
    summary: 'Leadership team building for 90 managers, half day, indoor venue.' },
  { opp: 'OPP-0005', status: PS.SUBMITTED, created: 3, last: 2, requiredIn: 4,
    summary: 'Year 3 overnight school sleepover, 60 students, campfire and stargazing.' },
  { opp: 'OPP-0006', status: PS.SUBMITTED, created: 2, last: 1, requiredIn: 3, createdBy: 'u-noha',
    summary: 'Annual gala dinner with entertainment, 400 guests, new date.' },
  { opp: 'OPP-0003', status: PS.DRAFT, created: 1, last: 1, requiredIn: 6,
    summary: 'Summer day camp for 150 students aged 8–12, 5 days, transport from school.' },
  { opp: 'OPP-0004', status: PS.DRAFT, created: 0, last: 0, requiredIn: 5,
    summary: 'Family day for 300 employees and families, Alexandria.' },
]

function roleOf(userId) {
  return USERS.find((u) => u.id === userId).roles[0]
}

/**
 * Status history entries: { status, changedBy, role, changedAt, note, version, amPrice? }.
 * - role: the role the person acted in (Mariam El Khayat acts as AM on AM steps).
 * - version: proposal version at that moment; +1 when work restarts after a revision request.
 * - amPrice: only on Ready for BD entries. Only the LATEST Ready entry has a known price;
 *   earlier ones are null ("not recorded") because the demo never captured them.
 */
function buildHistory(def, path, { bdOwner, assignedAM, createdBy }) {
  const lastReadyIndex = path.lastIndexOf(PS.READY_FOR_BD)
  let version = 1
  return path.map((status, i) => {
    if (status === PS.IN_PROGRESS && path[i - 1] === PS.REVISION_REQUESTED) version += 1
    const t = path.length === 1 ? def.created : def.created - ((def.created - def.last) * i) / (path.length - 1)
    // Creation and submission are done by whoever created the request (may be the Commercial Head).
    const actor = AM_STATUSES.has(status) ? assignedAM
      : (status === PS.DRAFT || status === PS.SUBMITTED) && i <= 1 ? createdBy
      : bdOwner
    const role = AM_STATUSES.has(status) ? ROLE.ACCOUNT_MANAGER
      : actor === bdOwner ? ROLE.BUSINESS_DEVELOPMENT
      : roleOf(actor)
    const entry = {
      status,
      changedBy: actor,
      role,
      changedAt: timestampDaysAgo(t, 9 + ((i * 3) % 8), (i * 17) % 60),
      note: i === path.length - 1 ? def.note ?? null : def.stepNotes?.[i] ?? null,
      version,
    }
    if (status === PS.READY_FOR_BD) entry.amPrice = i === lastReadyIndex ? def.amPrice ?? null : null
    if (status === PS.REJECTED && def.lostReason) entry.lostReason = def.lostReason
    // Created/submitted by someone else (the Commercial Head) on behalf of the BD owner.
    if (actor !== bdOwner && !AM_STATUSES.has(status)) entry.onBehalfOf = bdOwner
    return entry
  })
}

/**
 * Demo proposal files: one per version that reached Ready for BD (uploaded by the AM at that
 * moment), plus the current version's file when def.fileUploaded (uploaded, not yet marked ready).
 * Only the metadata exists in the demo; the backend seed stores small placeholder PDFs.
 */
export function demoProposalFiles(statusHistory, { assignedAM, fileUploaded = false }) {
  const file = (version, uploadedAt) => ({
    version, fileType: 'pdf', originalName: `Proposal v${version}.pdf`, uploadedBy: assignedAM, uploadedAt,
  })
  const files = statusHistory.filter((e) => e.status === PS.READY_FOR_BD).map((e) => file(e.version, e.changedAt))
  const last = statusHistory.at(-1)
  if (fileUploaded && !files.some((f) => f.version === last.version)) files.push(file(last.version, last.changedAt))
  return files
}

function buildProposalRequests() {
  const year = new Date().getFullYear()
  return REQUEST_DEFS.map((def, index) => {
    const opp = OPPORTUNITIES.find((o) => o.id === def.opp)
    const assignedAM = resolveAssignedAM(opp.brand)
    const bdOwner = CLIENTS.find((c) => c.id === opp.clientId).owner // relationship owner
    const createdBy = def.createdBy ?? bdOwner
    const path = def.path ?? STATUS_PATHS[def.status]
    const statusHistory = buildHistory(def, path, { bdOwner, assignedAM, createdBy })
    const submitted = statusHistory.find((h) => h.status === PS.SUBMITTED)
    return {
      id: `PR-${year}-${String(index + 1).padStart(4, '0')}`,
      opportunityId: opp.id,
      clientId: opp.clientId,
      brand: opp.brand,
      service: opp.service,
      bdOwner,
      createdBy,
      assignedAM,
      status: def.status,
      submittedAt: submitted?.changedAt ?? null,
      submittedBy: submitted?.changedBy ?? null, // who actually submitted (see history onBehalfOf)
      lastUpdated: statusHistory.at(-1).changedAt,
      requiredBy: dateIn(def.requiredIn),
      eventDate: opp.eventDate, // "YYYY-MM-DD", or "YYYY-MM" when only the month is known
      eventDatePrecision: /^\d{4}-\d{2}$/.test(opp.eventDate) ? 'month' : 'day',
      participants: opp.participants,
      requirementsSummary: def.summary, // the brief
      specificRequirements: def.specific ?? null,
      amPrice: def.amPrice ?? null, // current price (latest Ready for BD); history keeps earlier ones
      version: statusHistory.at(-1).version,
      priceChange: null, // reserved for a later phase
      statusHistory,
      files: demoProposalFiles(statusHistory, { assignedAM, fileUploaded: def.fileUploaded }),
    }
  })
}

// ---------- Tasks ----------

const TASK_DEFS = [
  { owner: AS, type: 'call', title: 'Send brochure and sample itinerary', opp: 'OPP-0002', due: 0 },
  { owner: AS, type: 'follow_up', title: 'Confirm venue preference with HR', opp: 'OPP-0004', due: -1 },
  { owner: MK, type: 'call', title: 'Clarify transport needs for Grade 6 trip', opp: 'OPP-0011', due: 0 },
  { owner: MK, type: 'reminder', title: 'Price the Sunstone sleepover proposal', opp: 'OPP-0005', due: 1 },
  { owner: 'u-mariam-dimitri', type: 'reminder', title: 'Finish leadership team-building proposal', opp: 'OPP-0008', due: 0 },
  { owner: 'u-mariam-dimitri', type: 'follow_up', title: 'Chase venue quote for activation', opp: 'OPP-0010', due: -2 },
  { owner: ST, type: 'call', title: 'Feedback call with Oakpalm principal', opp: 'OPP-0013', due: 0 },
  { owner: ST, type: 'follow_up', title: 'Send bus count to Account Manager', opp: 'OPP-0007', due: 2 },
  { owner: AB, type: 'meeting', title: 'Intro meeting with Obelisk Telecom HR', opp: 'OPP-0001', due: 2 },
  { owner: AB, type: 'follow_up', title: 'Send headcount per grade to Account Manager', opp: 'OPP-0009', due: -3 },
  { owner: AS, type: 'follow_up', title: 'Send revised activity list to Harbor Line', opp: 'OPP-0015', due: 0 },
  { owner: 'u-noha', type: 'meeting', title: 'Weekly pipeline review with BD team', due: 0 },
  { owner: 'u-noha', type: 'reminder', title: 'Review Q1 pricing guidelines with AMs', due: 3 },
  { owner: AS, type: 'call', title: 'Thank-you call after summer camp confirmation', opp: 'OPP-0016', due: -4, done: true },
  { owner: ST, type: 'follow_up', title: 'Collect deposit confirmation from Medora', opp: 'OPP-0017', due: -1, done: true },
]

function buildTasks(proposalRequests) {
  return TASK_DEFS.map((def, i) => {
    const opp = def.opp ? OPPORTUNITIES.find((o) => o.id === def.opp) : null
    // Link to the latest proposal request for that opportunity, if any.
    const request = opp ? proposalRequests.filter((r) => r.opportunityId === opp.id).at(-1) : null
    return {
      id: `t-${String(i + 1).padStart(2, '0')}`,
      title: def.title,
      type: def.type,
      owner: def.owner,
      related: {
        clientId: opp?.clientId ?? null,
        opportunityId: opp?.id ?? null,
        proposalRequestId: request?.id ?? null,
      },
      dueDate: dateIn(def.due),
      done: def.done ?? false,
    }
  })
}

/** Builds a fresh copy of the full demo dataset. Called once per page load. */
export function createDemoData() {
  const proposalRequests = buildProposalRequests()
  return {
    users: USERS.map((u) => ({ ...u, roles: [...u.roles], privileges: { ...u.privileges } })),
    clients: CLIENTS.map((c) => ({ ...c, contact: { ...c.contact } })),
    opportunities: OPPORTUNITIES.map((o) => ({ ...o })),
    proposalRequests,
    tasks: buildTasks(proposalRequests),
  }
}

export const DEFAULT_DEMO_USER_ID = 'u-noha'
