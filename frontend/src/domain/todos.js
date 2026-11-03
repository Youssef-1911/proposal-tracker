/**
 * Personal to-dos: every person keeps their own (private: only the owner ever sees them, the server
 * enforces it). Text, an optional due date and an optional link to a client, a request or an event.
 * Ticked ones show under "Done today" for the rest of that day, then only behind "Show completed"
 * (the last 30 days). Deleting hides a to-do (soft delete). No notifications; not in Analytics or /screen.
 * Same rules as backend/app/domain/todos.py.
 */

export const TODO_TEXT_MAX = 300
export const TODO_LINK_KINDS = ['client', 'request', 'event']
export const COMPLETED_DAYS = 30

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v

/** { text, dueOn?, linkKind?, linkId? } -> { errors, values } (trimmed; empty optional fields become null). */
export function validateTodo(input = {}) {
  const errors = {}
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (!text) errors.text = 'Write the to-do.'
  else if (text.length > TODO_TEXT_MAX) errors.text = `At most ${TODO_TEXT_MAX} characters.`
  const dueOn = input.dueOn || null
  if (dueOn !== null && !isDate(dueOn)) errors.dueOn = 'Enter a valid date.'
  const linkKind = input.linkKind || null
  const linkId = input.linkId || null
  if ((linkKind === null) !== (linkId === null) || (linkKind !== null && !TODO_LINK_KINDS.includes(linkKind))) {
    errors.link = 'Choose a client, request or event.'
  }
  return { errors, values: { text, dueOn, linkKind, linkId } }
}

export const isTodoOverdue = (t, today) => !t.doneAt && Boolean(t.dueOn) && t.dueOn < today
export const isTodoDueToday = (t, today) => !t.doneAt && t.dueOn === today

/** Open first: overdue, then by due date, then without a date (newest first). */
function openOrder(a, b) {
  if (a.dueOn && b.dueOn) return a.dueOn.localeCompare(b.dueOn) || String(b.createdAt).localeCompare(String(a.createdAt))
  if (a.dueOn || b.dueOn) return a.dueOn ? -1 : 1
  return String(b.createdAt).localeCompare(String(a.createdAt))
}

/**
 * todos (the owner's, not deleted) -> { open, doneToday, completed } with completed = done in the last
 * 30 days before today. doneDay(t) gives the Cairo day it was ticked.
 */
export function todoGroups(todos, today, doneDay) {
  const open = todos.filter((t) => !t.doneAt).sort(openOrder)
  const done = todos.filter((t) => t.doneAt).sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)))
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - COMPLETED_DAYS * 86400000).toISOString().slice(0, 10)
  return {
    open,
    doneToday: done.filter((t) => doneDay(t) === today),
    completed: done.filter((t) => doneDay(t) < today && doneDay(t) >= since),
  }
}

export const todosDueToday = (todos, today) => todos.filter((t) => isTodoDueToday(t, today)).length

/** On a client, request or event page: "1 to-do: Call before Thursday" (open ones linked to it), or null. */
export function linkedTodosLine(todos, kind, id) {
  const mine = todos.filter((t) => !t.doneAt && t.linkKind === kind && t.linkId === id).sort(openOrder)
  if (!mine.length) return null
  return `${mine.length} ${mine.length === 1 ? 'to-do' : 'to-dos'}: ${mine[0].text}`
}
