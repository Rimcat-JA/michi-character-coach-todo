import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createRoutine, expandRoutines } from './commands'
import { emptyScore, today } from './domain'
import { createHabit, habitProgress, recordHabitLog } from './habits'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('習慣の継続記録', () => {
  it('ログと関連タスク完了を同じ達成キーで扱い、ポイントを二重加算しない', async () => {
    const date = today()
    const routineId = await createRoutine({ title: '読書', cadence: 'daily', interval: 1, weekdays: [], monthDay: 1, startDate: date, endDate: date, afterTaskId: null, score: { ...emptyScore(), mode: 'manual', manualPoints: 10 }, project: '', active: true })
    await expandRoutines(date, 1)
    const task = (await db.tasks.where('routineId').equals(routineId).first())!
    const habitId = await createHabit({ title: '読書', direction: 'increase', unit: '分', targetAmount: 20, cadence: 'daily', weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: 'Asia/Tokyo', routineId })
    const logId = await recordHabitLog(habitId, date, 20)
    expect((await db.habitLogs.get(logId))?.taskId).toBe(task.id)
    expect(await db.ledger.count()).toBe(0)
    await completeTask(task.id, task.revision)
    await recordHabitLog(habitId, date, 20)
    const progress = habitProgress((await db.habits.get(habitId))!, date, await db.habitLogs.toArray(), await db.tasks.toArray())
    expect(progress).toMatchObject({ amount: 20, metTarget: true, linkedTaskCompleted: true, achievementKey: `habit:${habitId}:${date}` })
    expect((await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0)).toBe(10)
    expect(await db.habitLogs.count()).toBe(1)
  })

  it('0の記録と未入力を区別し、訂正履歴を残す', async () => {
    const habitId = await createHabit({ title: 'お菓子', direction: 'decrease', unit: '個', targetAmount: 0, cadence: 'daily', weekdays: [], timezone: 'Asia/Tokyo', routineId: null })
    const habit = (await db.habits.get(habitId))!
    expect(habitProgress(habit, '2026-10-01', [], []).amount).toBeNull()
    const logId = await recordHabitLog(habitId, '2026-10-01', 1)
    await recordHabitLog(habitId, '2026-10-01', 0, '数え直し')
    const log = (await db.habitLogs.get(logId))!
    expect(log).toMatchObject({ amount: 0, revision: 2 })
    expect(log.history).toEqual([{ amount: 1, at: expect.any(String), reason: '数え直し' }])
    expect(habitProgress(habit, '2026-10-01', [log], []).metTarget).toBe(true)
  })
})
