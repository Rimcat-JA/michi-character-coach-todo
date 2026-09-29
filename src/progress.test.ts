import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput } from './commands'
import { createContainer } from './containers'
import { emptyScore, today } from './domain'
import { captureDayProgressBaseline, createTimeTarget, dayProgress, timeTargetProgress } from './progress'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('時間目標と今日の進捗', () => {
  it('重複する2端末の作業区間を週3時間目標へ一度だけ加算する', async () => {
    const category = await createContainer({ kind: 'category', name: '学習', parentId: null })
    const project = await createContainer({ kind: 'project', name: '数学', parentId: category })
    const taskId = await createTask({ ...newTaskInput(), title: '演習', containerId: project })
    const id = await createTimeTarget(category, '2026-10-01', '2026-10-07', 180)
    await db.sessions.bulkAdd([
      { id: 'device-a', taskId, startedAt: '2026-10-02T10:00:00.000Z', endedAt: '2026-10-02T10:30:00.000Z', minutes: 30 },
      { id: 'device-b', taskId, startedAt: '2026-10-02T10:20:00.000Z', endedAt: '2026-10-02T10:50:00.000Z', minutes: 30 },
    ])
    const target = (await db.settings.get('main'))!.timeTargets!.find(value => value.id === id)!
    expect(timeTargetProgress(target, await db.tasks.toArray(), await db.containers.toArray(), await db.sessions.toArray())).toEqual({ minutes: 50, targetMinutes: 180, percent: 28 })
  })

  it('初回の分母を固定し途中追加を別表示、空の分母でもNaNにしない', async () => {
    const date = today()
    const first = await createTask({ ...newTaskInput(), title: '最初', scheduledDate: date, score: { ...emptyScore(), mode: 'manual', manualPoints: 20, minutes: 30 } })
    const baseline = await captureDayProgressBaseline(date)
    expect((await captureDayProgressBaseline(date)).capturedAt).toBe(baseline.capturedAt)
    const second = await createTask({ ...newTaskInput(), title: '追加', scheduledDate: date, score: { ...emptyScore(), mode: 'manual', manualPoints: 10, minutes: 15 } })
    await completeTask(first, 1)
    const result = dayProgress(baseline, date, await db.tasks.toArray(), await db.completions.toArray())
    expect(result).toMatchObject({ baselineTotal: 1, baselineDone: 1, baselinePercent: 100, baselineMinutes: 30, baselinePoints: 20, addedTotal: 1, addedDone: 0, addedMinutes: 15, addedPoints: 10 })
    expect(second).not.toBe(first)
    expect(dayProgress(undefined, '2026-10-03', [], []).baselinePercent).toBe(0)
  })
})
