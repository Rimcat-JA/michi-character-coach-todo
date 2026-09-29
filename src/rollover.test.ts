import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { suggestedTasks } from './planning'
import { dueSnoozes, rolloverTask, snoozeTask } from './rollover'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('繰越とスヌーズ', () => {
  it('一週間繰り越してもタスクは一件、初回予定日と7件の履歴を保つ', async () => {
    const id = await createTask({ ...newTaskInput(), title: '週をまたぐ作業', scheduledDate: '2026-10-01', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
    for (let day = 2; day <= 8; day++) await rolloverTask(id, day - 1, `2026-10-${String(day).padStart(2, '0')}`)
    const task = await db.tasks.get(id), entries = (await db.rollovers.where('taskId').equals(id).toArray()).sort((a, b) => a.fromDate.localeCompare(b.fromDate))
    expect(await db.tasks.count()).toBe(1)
    expect(task).toMatchObject({ scheduledDate: '2026-10-08', firstScheduledDate: '2026-10-01', effectivePoints: 25 })
    expect(entries).toHaveLength(7)
    expect(entries[0].fromDate).toBe('2026-10-01')
    expect(entries.at(-1)?.toDate).toBe('2026-10-08')
  })
  it('再表示時刻より前は候補から外し、到達後に同じタスクを再表示する', async () => {
    const id = await createTask({ ...newTaskInput(), title: 'あとで確認' })
    await snoozeTask(id, 1, '2026-10-01T09:00:00.000Z')
    const tasks = await db.tasks.toArray()
    expect(suggestedTasks(tasks, '2026-10-01', 3, [], '2026-10-01T08:59:00.000Z')).toEqual([])
    expect(suggestedTasks(tasks, '2026-10-01', 3, [], '2026-10-01T09:00:00.000Z').map(task => task.id)).toEqual([id])
    expect(dueSnoozes(tasks, '2026-10-01T09:00:00.000Z').map(task => task.id)).toEqual([id])
    expect(await db.tasks.count()).toBe(1)
  })
})
