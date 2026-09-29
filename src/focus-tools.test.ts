import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTask, newTaskInput } from './commands'
import { db, ensureSettings } from './db'
import { emptyScore, type Task } from './domain'
import { recommendFocusProjects, setFocusProjects } from './focus-projects'
import { suggestedTasks } from './planning'
import { buildMatrix } from './matrix'
import { truncateTasks } from './list-view'
import { taskStaleness } from './staleness'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, generationKey: id, routineId: null, title: id, notes: '', project: '', labels: [], scheduledDate: null, dueDate: null, targetDate: null, reviewDate: null, availableFrom: null, importance: 1, score: emptyScore(), effectivePoints: null, assessmentId: id, status: 'open', revision: 1, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', deletedAt: null, ...overrides }
}

describe('重点案件と一覧表示', () => {
  it('コーチ候補Aの後に本人がBを選ぶと次の推薦で戻さない', async () => {
    const a = await createTask({ ...newTaskInput(), title: '案件A', project: 'A' })
    const b = await createTask({ ...newTaskInput(), title: '案件B', project: 'B' })
    const tasks = await db.tasks.toArray(), date = '2026-10-01'
    expect(recommendFocusProjects(tasks, date)).toContain('A')
    await setFocusProjects(date, ['A'], 'coach')
    await setFocusProjects(date, ['B'], 'user')
    await setFocusProjects(date, ['A'], 'coach')
    const selection = (await db.focusSelections.toArray())[0]
    expect(selection).toMatchObject({ projects: ['B'], source: 'user', revision: 2 })
    expect(suggestedTasks(tasks, date, 2, [], '2026-10-01T00:00:00.000Z', [], selection.projects).map(item => item.id)).toEqual([b, a])
  })
  it('重要度×緊急度Matrixでも同一タスクを一度だけ集計する', () => {
    const a = task('a', { importance: 3, dueDate: '2026-10-01', effectivePoints: 20 })
    const b = task('b', { importance: 1, dueDate: null, effectivePoints: 10 })
    const matrix = buildMatrix([a, b, a], 'importance', 'urgency', '2026-10-01', [], 'owner')
    expect(matrix.taskIds).toHaveLength(2)
    expect(matrix.points).toBe(30)
    expect(matrix.cells.reduce((sum, cell) => sum + cell.points, 0)).toBe(30)
    expect(matrix.cells.find(cell => cell.row === '最優先' && cell.column === '今日')?.tasks.map(item => item.id)).toEqual(['a'])
  })
  it('20件中5件だけ表示して残り15件を示し、元データを保つ', () => {
    const tasks = Array.from({ length: 20 }, (_, index) => task(String(index)))
    const result = truncateTasks(tasks, 5)
    expect(result.shown).toHaveLength(5)
    expect(result.remaining).toBe(15)
    expect(result.total).toBe(20)
    expect(tasks).toHaveLength(20)
  })
  it('予定変更回数が違っても初回予定日が同じなら経過日数が同じ', () => {
    const once = task('once', { firstScheduledDate: '2026-10-01', scheduledDate: '2026-10-02' })
    const many = task('many', { firstScheduledDate: '2026-10-01', scheduledDate: '2026-10-10', revision: 8, updatedAt: '2026-10-09T00:00:00.000Z' })
    expect(taskStaleness(once, '2026-10-12').daysSinceFirstScheduled).toBe(11)
    expect(taskStaleness(many, '2026-10-12').daysSinceFirstScheduled).toBe(11)
    expect(taskStaleness(once, '2026-10-12').daysSinceUpdate).not.toBe(taskStaleness(many, '2026-10-12').daysSinceUpdate)
  })
})
