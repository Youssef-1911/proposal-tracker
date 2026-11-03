// My Work sections (one rule, no duplicates, stuck inside Waiting on others) and personal to-dos. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { myWorkSection, stuckDays, waitingOnOthers } from '../src/domain/myWork.js'
import { isTodoOverdue, linkedTodosLine, todoGroups, todosDueToday, validateTodo } from '../src/domain/todos.js'

const S = JSON.parse(readFileSync(new URL('../../contracts/proposal-scenarios.json', import.meta.url), 'utf8'))
const NOW = new Date(S.now)
const REQUESTS = S.world.requests

test('3: the sections match the shared contract; each request sits in one section at most', () => {
  for (const c of S.myWorkCases) {
    const sections = Object.fromEntries(REQUESTS.map((r) => [r.id, myWorkSection(r, c.viewer, NOW)]).filter(([, v]) => v))
    assert.deepEqual(sections, c.sections, c.viewer.userId)
    const others = waitingOnOthers(REQUESTS, c.viewer, {}, NOW)
    const ids = [...others.team.flatMap((g) => g.requests), ...others.client].map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length, 'no duplicates inside Waiting on others')
    assert.equal(others.total, Object.values(c.sections).filter((s) => s !== 'turn').length)
    assert.ok(others.team.every((g) => g.count > 0), 'no empty groups')
  }
})

test('3: Noha and Executives see "Stuck · N days" first in their group; nobody else does', () => {
  const noha = S.myWorkCases.find((c) => c.viewer.userId === 'u-noha')
  const others = waitingOnOthers(REQUESTS, noha.viewer, {}, NOW)
  for (const rows of [...others.team.map((g) => g.requests), others.client]) {
    const flags = rows.map((r) => stuckDays(r, noha.viewer, NOW) !== null)
    assert.deepEqual(flags, [...flags].sort((a, b) => Number(b) - Number(a)), 'stuck ones first')
  }
  const bd = { userId: 'u-ahmed', activeRole: 'business_development' }
  assert.ok(REQUESTS.every((r) => stuckDays(r, bd, NOW) === null))
})

test('1: to-dos validate like the server and group into open · done today · completed (30 days)', () => {
  for (const c of S.todoCases) assert.deepEqual(validateTodo(c.input), c.expect, JSON.stringify(c.input))
  const today = '2026-10-29'
  const todos = [
    { id: 1, text: 'Call Sodic', dueOn: '2026-10-27', createdAt: '2026-10-20T08:00:00Z' },
    { id: 2, text: 'No date', createdAt: '2026-10-21T08:00:00Z' },
    { id: 3, text: 'Today', dueOn: today, linkKind: 'client', linkId: 'CL-0008', createdAt: '2026-10-22T08:00:00Z' },
    { id: 4, text: 'Done today', doneAt: '2026-10-29T07:00:00Z', createdAt: '2026-10-01T08:00:00Z' },
    { id: 5, text: 'Done last week', doneAt: '2026-10-22T07:00:00Z', createdAt: '2026-10-01T08:00:00Z' },
    { id: 6, text: 'Done long ago', doneAt: '2026-08-01T07:00:00Z', createdAt: '2026-07-01T08:00:00Z' },
    { id: 7, text: 'Later', dueOn: '2026-11-03', linkKind: 'client', linkId: 'CL-0008', createdAt: '2026-10-23T08:00:00Z' },
  ]
  const g = todoGroups(todos, today, (t) => t.doneAt.slice(0, 10))
  assert.deepEqual(g.open.map((t) => t.id), [1, 3, 7, 2], 'overdue, then by date, then without a date')
  assert.deepEqual(g.doneToday.map((t) => t.id), [4])
  assert.deepEqual(g.completed.map((t) => t.id), [5], 'only the last 30 days')
  assert.equal(isTodoOverdue(todos[0], today), true)
  assert.equal(todosDueToday(todos, today), 1)
  assert.equal(linkedTodosLine(todos, 'client', 'CL-0008'), '2 to-dos: Today')
  assert.equal(linkedTodosLine(todos, 'event', 'PR-1'), null)
})
