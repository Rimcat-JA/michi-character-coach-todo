import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTask, newTaskInput } from './commands'
import { db, ensureSettings } from './db'
import { assignDaySection, groupTodayTasks, setDaySectionMode, type DaySectionMode } from './day-sections'
import { emptyScore, type TimeBlock } from './domain'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('今日の区分', () => {
  it('区分を変えてもIDと合計ポイントは変わらず、複数時間枠でも一度だけ数える', async () => {
    const a = await createTask({ ...newTaskInput(), title: '作業A', project: '執筆', scheduledDate: '2026-10-01', score: { ...emptyScore(), mode: 'manual', manualPoints: 20 } })
    const b = await createTask({ ...newTaskInput(), title: '作業B', project: '生活', scheduledDate: '2026-10-01', score: { ...emptyScore(), mode: 'manual', manualPoints: 10 } })
    await assignDaySection(a, 1, 'dayHalf', 'morning')
    await assignDaySection(a, 2, 'customSection', '最優先')
    const tasks = [await db.tasks.get(a), await db.tasks.get(b), await db.tasks.get(a)].filter((item): item is NonNullable<typeof item> => Boolean(item))
    const base = { id: 'block1', ownerId: (await db.settings.get('main'))!.profileId, kind: 'activity' as const, category: '学習', projectId: null, date: '2026-10-01', startMinute: 540, endMinute: 600, timezone: 'Asia/Tokyo', linkedSessionId: null, closed: false, revision: 1, createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z' }
    const blocks: TimeBlock[] = [{ ...base, taskIds: [a, b] }, { ...base, id: 'block2', startMinute: 600, endMinute: 660, taskIds: [a] }]
    for (const mode of ['halfday', 'category', 'timeblock', 'custom'] as DaySectionMode[]) {
      const grouped = groupTodayTasks(tasks, mode, '2026-10-01', blocks)
      expect(new Set(grouped.taskIds)).toEqual(new Set([a, b]))
      expect(grouped.taskIds).toHaveLength(2)
      expect(grouped.points).toBe(30)
      expect(grouped.sections.flatMap(section => section.tasks.map(task => task.id))).toHaveLength(2)
      if (mode === 'halfday') expect(grouped.sections.find(section => section.label === '午前')?.tasks.map(task => task.id)).toEqual([a])
      if (mode === 'category') expect(grouped.sections.find(section => section.label === '執筆')?.tasks.map(task => task.id)).toEqual([a])
      if (mode === 'timeblock') expect(grouped.sections.find(section => section.label.includes('09:00'))?.tasks.map(task => task.id)).toEqual([a, b])
      if (mode === 'custom') expect(grouped.sections.find(section => section.label === '最優先')?.tasks.map(task => task.id)).toEqual([a])
      await setDaySectionMode(mode)
      expect((await db.settings.get('main'))?.daySectionMode).toBe(mode)
    }
    expect((await db.tasks.get(a))?.effectivePoints).toBe(20)
  })
})
