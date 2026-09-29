import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { suggestedTasks } from './planning'
import { createThemeRule, themeStrength } from './themes'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('重点テーマ', () => {
  it('火曜の執筆テーマがあっても当日の必須期限を候補から排除しない', async () => {
    const dueId = await createTask({ ...newTaskInput(), title: '今日が期限', project: '事務', dueDate: '2026-09-29' })
    const writingId = await createTask({ ...newTaskInput(), title: '執筆', project: '執筆' })
    await createThemeRule({ category: '執筆', weekdays: [2], startDate: '2026-09-01', endDate: '2026-10-31', strength: 3 })
    const tasks = await db.tasks.toArray(), rules = await db.themeRules.toArray()
    expect(themeStrength(tasks.find(task => task.id === writingId)!, '2026-09-29', rules)).toBe(3)
    expect(suggestedTasks(tasks, '2026-09-29', 1, [], '2026-09-29T09:00:00.000Z', rules).map(task => task.id)).toEqual([dueId])
    expect(suggestedTasks(tasks, '2026-09-29', 2, [], '2026-09-29T09:00:00.000Z', rules).map(task => task.id)).toEqual([dueId, writingId])
    expect(suggestedTasks(tasks, '2026-09-30', 2, [], '2026-09-30T09:00:00.000Z', rules).map(task => task.id)).toEqual([dueId, writingId])
  })
})
