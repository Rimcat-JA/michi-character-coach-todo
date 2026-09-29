import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, logSession, newTaskInput } from './commands'
import { createContainer } from './containers'
import { emptyScore } from './domain'
import { assignTaskToTimeBlock, createCalendarEvent, createTimeBlock, finishTimeBlock, linkSessionToTimeBlock, timeBlockCapacity } from './calendar-planning'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('時間枠と予定', () => {
  it('学習60分枠の2タスクを容量へ二重計上しない', async () => {
    const score = { ...emptyScore(), mode: 'formula' as const, minutes: 30, travelMinutes: 0, difficulty: 0, uncertainty: 0, coordination: 0, physical: 0, outing: false }
    const a = await createTask({ ...newTaskInput(), title: 'A', score }), b = await createTask({ ...newTaskInput(), title: 'B', score })
    const blockId = await createTimeBlock({ kind: 'activity', category: '学習', projectId: null, date: '2026-10-01', startMinute: 540, endMinute: 600, timezone: 'Asia/Tokyo' })
    await assignTaskToTimeBlock(blockId, 1, a)
    await assignTaskToTimeBlock(blockId, 2, b)
    expect(timeBlockCapacity('2026-10-01', await db.tasks.toArray(), await db.timeBlocks.toArray())).toMatchObject({ reservedMinutes: 60, standaloneMinutes: 0, totalMinutes: 60 })
    expect(await db.tasks.count()).toBe(2)
  })
  it('案件30分枠を終了し実績タイマーへリンクしてもタスクは完了しない', async () => {
    const project = await createContainer({ kind: 'project', name: '案件A', parentId: null })
    const taskId = await createTask({ ...newTaskInput(), title: '作業', containerId: project })
    const blockId = await createTimeBlock({ kind: 'work_session', category: '案件A', projectId: project, date: '2026-10-01', startMinute: 600, endMinute: 630, timezone: 'Asia/Tokyo' })
    await logSession(taskId, '2026-10-01T01:00:00.000Z', '2026-10-01T01:30:00.000Z')
    const session = (await db.sessions.toArray())[0]
    await linkSessionToTimeBlock(blockId, 1, session.id)
    await finishTimeBlock(blockId, 2)
    expect((await db.timeBlocks.get(blockId))?.closed).toBe(true)
    expect((await db.tasks.get(taskId))?.status).toBe('open')
    expect(await db.completions.count()).toBe(0)
  })
  it('過ぎた会議を作ってもタスク・完了ポイントは増えない', async () => {
    await createCalendarEvent({ kind: 'meeting', title: '会議', startAt: '2026-01-01T09:00:00.000Z', endAt: '2026-01-01T10:00:00.000Z', timezone: 'Asia/Tokyo', linkedTaskId: null })
    expect(await db.calendarEvents.count()).toBe(1)
    expect(await db.tasks.count()).toBe(0)
    expect(await db.completions.count()).toBe(0)
    expect(await db.ledger.count()).toBe(0)
  })
})
