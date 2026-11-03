/**
 * The morning summary at the top of My Work: one or two plain sentences built from the data (no AI).
 * At most 3 facts, in this priority, for the person's role:
 *   new items · overdue · due today · to-dos due today · longest waiting item on me · questions waiting for
 *   my answer · events this week (Operations, HR) · stuck for 3+ days (Noha, Executives)
 * Each fact links to its list. Nothing to report: "You're all caught up."
 */

import { ROLE } from './roles.js'

export const MAX_FACTS = 3

/** "Good morning" (before 12) · "Good afternoon" (before 17) · "Good evening", by the Cairo hour. */
export function greeting(firstName, cairoHour) {
  const part = cairoHour < 12 ? 'Good morning' : cairoHour < 17 ? 'Good afternoon' : 'Good evening'
  return firstName ? `${part} ${firstName}` : part
}

export function cairoHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Cairo' }).format(now)) % 24
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/**
 * counts = { newItems, overdue, dueToday, todosDueToday, longestWait: { name, days, to } | null, questions,
 * eventsThisWeek, stuck } -> [{ key, text, to }] (at most 3, in priority order, only for this role).
 */
export function morningFacts(counts, role) {
  const ops = [ROLE.OPERATIONS, ROLE.HR].includes(role)
  const stuckRole = [ROLE.COMMERCIAL_HEAD, ROLE.EXECUTIVE].includes(role)
  const all = [
    counts.newItems > 0 && { key: 'new', text: plural(counts.newItems, 'new item', 'new items'), to: '/#new' },
    counts.overdue > 0 && { key: 'overdue', text: `${counts.overdue} overdue`, to: '/proposals?deadline=overdue' },
    counts.dueToday > 0 && { key: 'today', text: `${counts.dueToday} due today`, to: '/#your-turn' },
    counts.todosDueToday > 0 && { key: 'todos', text: plural(counts.todosDueToday, 'to-do', 'to-dos') + ' due today', to: '/#todos' },
    counts.longestWait && counts.longestWait.days >= 1 && {
      key: 'longest', text: `${counts.longestWait.name} has been waiting ${plural(counts.longestWait.days, 'day', 'days')}`,
      to: counts.longestWait.to,
    },
    counts.questions > 0 && { key: 'questions', text: plural(counts.questions, 'question waits', 'questions wait') + ' for your answer', to: '/#your-turn' },
    ops && counts.eventsThisWeek > 0 && { key: 'events', text: plural(counts.eventsThisWeek, 'event', 'events') + ' this week', to: '/events?tab=week' },
    stuckRole && counts.stuck > 0 && { key: 'stuck', text: plural(counts.stuck, 'request has', 'requests have') + ' been stuck for 3+ days', to: '/#waiting' },
  ].filter(Boolean)
  return all.slice(0, MAX_FACTS)
}

/** "3 new items, 2 due today, and Sodic has been waiting 90 days." (or "You're all caught up.") */
export function factsSentence(facts) {
  if (!facts.length) return "You're all caught up."
  const texts = facts.map((f) => f.text)
  const body = texts.length === 1 ? texts[0] : `${texts.slice(0, -1).join(', ')}, and ${texts[texts.length - 1]}`
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`
}
