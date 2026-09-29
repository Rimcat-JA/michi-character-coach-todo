import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput, updateTask } from './commands'
import { emptyScore, today, type Completion } from './domain'
import { dailyPoints, historicalProjectPoints, periodSummary, pointHeatmap } from './analytics'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('実績統計とヒートマップ', () => {
  it('タスクを別カテゴリへ移しても完了時カテゴリと40ptを維持する', async () => {
    const id = await createTask({ ...newTaskInput(), title: '作業', project: '学習', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    await completeTask(id, 1)
    await updateTask(id, 2, { ...newTaskInput(), title: '作業', project: '仕事', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    expect((await db.tasks.get(id))?.project).toBe('仕事')
    expect(historicalProjectPoints(await db.completions.toArray())).toEqual([{ project: '学習', completed: 1, points: 40, pending: 0 }])
    const summary = periodSummary(await db.completions.toArray(), [], today(), today())
    expect(summary).toMatchObject({ completed: 1, points: 40, minutes: 0 })
  })

  it('日合計と明細が一致し、0・未設定・未同期を区別する', () => {
    const base = { originalAt: '2026-10-01T10:00:00.000Z', currentAt: '2026-10-01T10:00:00.000Z', localDate: '2026-10-01', originalPoints: 0, scoreState: 'confirmed' as const, project: '学習' }
    const items: Completion[] = [
      { ...base, id: 'a', taskId: 'a', title: 'A', netPoints: 10 },
      { ...base, id: 'b', taskId: 'b', title: 'B', netPoints: 0 },
      { ...base, id: 'c', taskId: 'c', title: 'C', netPoints: null, scoreState: 'pending' },
      { ...base, id: 'd', taskId: 'd', title: 'D', netPoints: 8, project: '仕事' },
    ]
    const day = dailyPoints(items, '2026-10-01')
    expect(day).toMatchObject({ points: 18, completed: 4, pending: 1, state: 'points' })
    expect(day.details.reduce((sum, detail) => sum + (detail.points ?? 0), 0)).toBe(day.points)
    expect(dailyPoints(items.slice(1, 2), '2026-10-01').state).toBe('zero')
    expect(dailyPoints(items.slice(2, 3), '2026-10-01').state).toBe('pending')
    expect(dailyPoints([], '2026-10-01').state).toBe('empty')
    expect(pointHeatmap(items, '2026-10-01', 1, new Set(['2026-10-01']))[0].state).toBe('unsynced')
  })
})
