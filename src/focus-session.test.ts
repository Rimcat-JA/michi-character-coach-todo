import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTask, newTaskInput } from './commands'
import { db, ensureSettings } from './db'
import { beginFocus, completeFocusedTask, focusElapsedSeconds, parseFocusRuntime, pauseFocus, resumeFocus } from './focus-session'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('Super Focus', () => {
  it('中断10分を作業時間へ足さず、壁時計で再開後の経過を復元する', () => {
    const started = beginFocus('task', '2026-10-01T00:00:00.000Z')
    const paused = pauseFocus(started, '2026-10-01T00:05:00.000Z')
    expect(paused.segment).toEqual({ taskId: 'task', startedAt: '2026-10-01T00:00:00.000Z', endedAt: '2026-10-01T00:05:00.000Z' })
    expect(focusElapsedSeconds(paused.state, '2026-10-01T00:15:00.000Z')).toBe(300)
    const resumed = resumeFocus(paused.state, '2026-10-01T00:15:00.000Z')
    expect(focusElapsedSeconds(resumed, '2026-10-01T00:19:00.000Z')).toBe(540)
    expect(parseFocusRuntime(JSON.stringify(resumed))).toEqual(resumed)
  })
  it('ポイント未設定のタスクは手動確認なしで完了させず、0pt確認なら完了する', async () => {
    const id = await createTask({ ...newTaskInput(), title: 'ポイントを確認する作業' })
    const task = (await db.tasks.get(id))!
    await expect(completeFocusedTask(task, null)).rejects.toThrow('必要ポイント')
    expect((await db.tasks.get(id))?.status).toBe('open')
    await completeFocusedTask(task, 0)
    expect((await db.tasks.get(id))?.status).toBe('completed')
    expect((await db.tasks.get(id))?.effectivePoints).toBe(0)
    expect((await db.completions.where('taskId').equals(id).first())?.netPoints).toBe(0)
  })
})
