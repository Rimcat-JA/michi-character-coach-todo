import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { commitDueSchedule, proposeDueSchedule } from './due-planner'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('期限タスクの配置案', () => {
  it('空き30分に締切前60分タスクがあると過密配置せず未配置理由を返す', async () => {
    await db.settings.update('main', { dailyMinutes: 30, dailyPoints: 100 })
    const id = await createTask({ ...newTaskInput(), title: '長い作業', dueDate: '2026-10-01', score: { ...emptyScore(), mode: 'manual', manualPoints: 20, minutes: 60 } })
    const plan = proposeDueSchedule(await db.tasks.toArray(), [], [], (await db.settings.get('main'))!, '2026-10-01')
    expect(plan.placements).toEqual([])
    expect(plan.unplaced).toEqual([{ taskId: id, reason: '期限前の時間またはポイント容量が不足' }])
    expect((await db.tasks.get(id))?.scheduledDate).toBeNull()
  })
  it('容量内の案を確認後に保存し、古い案は拒否する', async () => {
    await db.settings.update('main', { dailyMinutes: 90, dailyPoints: 30 })
    const id = await createTask({ ...newTaskInput(), title: '調査', dueDate: '2026-10-02', score: { ...emptyScore(), mode: 'manual', manualPoints: 25, minutes: 60 } })
    const settings = (await db.settings.get('main'))!
    const plan = proposeDueSchedule(await db.tasks.toArray(), [], [], settings, '2026-10-01')
    expect(plan.placements).toEqual([{ taskId: id, revision: 1, date: '2026-10-01' }])
    await commitDueSchedule(plan.placements, '2026-10-01')
    expect((await db.tasks.get(id))?.scheduledDate).toBe('2026-10-01')
    await expect(commitDueSchedule(plan.placements, '2026-10-01')).rejects.toThrow('古く')
    expect(await db.tasks.count()).toBe(1)
  })
})
