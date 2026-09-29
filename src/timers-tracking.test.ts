import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, logSession, newTaskInput } from './commands'
import { correctWorkSession, unionSessionMinutes } from './time-tracking'
import { parsePomodoroRuntime, pausePomodoro, pomodoroElapsedMs, recordPomodoro, resumePomodoro, startPomodoro } from './pomodoro'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('作業区間訂正とポモドーロ', () => {
  it('元区間と訂正理由を残し、集計へ訂正後の時間を使う', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '作業' })
    await logSession(taskId, '2026-10-01T10:00:00.000Z', '2026-10-01T10:30:00.000Z')
    const original = (await db.sessions.toArray())[0]
    await correctWorkSession(original.id, 1, '2026-10-01T10:00:00.000Z', '2026-10-01T10:20:00.000Z', '終了を押し忘れた')
    const corrected = (await db.sessions.get(original.id))!
    expect(corrected).toMatchObject({ minutes: 20, revision: 2 })
    expect(corrected.corrections).toEqual([{ startedAt: original.startedAt, endedAt: original.endedAt, minutes: 30, reason: '終了を押し忘れた', at: expect.any(String) }])
    expect(unionSessionMinutes([corrected])).toBe(20)
    await expect(correctWorkSession(original.id, 1, original.startedAt, original.endedAt, '古い画面')).rejects.toThrow('別の画面')
  })

  it('画面tickに頼らず中断を除く25分を復元し、回数を一度だけ記録する', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '集中' })
    const start = startPomodoro(taskId, 25, '2026-10-01T10:00:00.000Z')
    const paused = pausePomodoro(start, '2026-10-01T10:15:00.000Z')
    expect(pomodoroElapsedMs(paused, '2026-10-01T10:25:00.000Z')).toBe(15 * 60000)
    const resumed = resumePomodoro(paused, '2026-10-01T10:25:00.000Z')
    expect(pomodoroElapsedMs(resumed, '2026-10-01T10:35:00.000Z')).toBe(25 * 60000)
    expect(parsePomodoroRuntime(JSON.stringify(resumed))).toEqual(resumed)
    await recordPomodoro(resumed, '2026-10-01T10:35:00.000Z')
    await recordPomodoro(resumed, '2026-10-01T10:35:00.000Z')
    expect(await db.pomodoroCycles.count()).toBe(1)
    expect((await db.pomodoroCycles.toArray())[0].elapsedMinutes).toBe(25)
    expect(await db.ledger.count()).toBe(0)
    expect(await db.sessions.count()).toBe(0)
  })
})
