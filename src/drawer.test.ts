import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput, updateTask } from './commands'
import { createTimeBlock } from './calendar-planning'
import { applyDrawerMove, groupDrawerTasks, previewDrawerMove } from './drawer'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

describe('下部一覧からカレンダーへの移動', () => {
  it('時間枠へのdropを確認後だけ端末内で保存し、外部書込・実績を増やさない', async () => {
    const taskId = await createTask({ ...newTaskInput(), title: '配置する作業' })
    const blockId = await createTimeBlock({ kind: 'activity', category: '作業', projectId: null, date: '2026-10-01', startMinute: 540, endMinute: 600, timezone: 'Asia/Tokyo' })
    const task = (await db.tasks.get(taskId))!, block = (await db.timeBlocks.get(blockId))!
    const plan = previewDrawerMove(task, block.date, block)
    expect(plan).toMatchObject({ fromDate: null, toDate: '2026-10-01', blockId, externalWrite: false })
    expect((await db.tasks.get(taskId))?.scheduledDate).toBeNull()
    await applyDrawerMove(plan)
    expect((await db.tasks.get(taskId))?.scheduledDate).toBe('2026-10-01')
    expect((await db.timeBlocks.get(blockId))?.taskIds).toEqual([taskId])
    expect(await db.tasks.count()).toBe(1)
    expect(await db.ledger.count()).toBe(0)
    await expect(applyDrawerMove({ ...plan, externalWrite: true as false })).rejects.toThrow('承認')
  })
  it('確認後にタスクが変わったら古い移動案を拒否する', async () => {
    const input = { ...newTaskInput(), title: '改訂される作業' }, taskId = await createTask(input)
    const task = (await db.tasks.get(taskId))!, plan = previewDrawerMove(task, '2026-10-02')
    await updateTask(taskId, task.revision, { ...input, title: '新しい名前' })
    await expect(applyDrawerMove(plan)).rejects.toThrow('別の画面')
    expect((await db.tasks.get(taskId))?.scheduledDate).toBeNull()
  })
  it('期限超過・日付なし・予定済みを重複なく分ける', async () => {
    await createTask({ ...newTaskInput(), title: '期限超過', dueDate: '2026-09-30' })
    await createTask({ ...newTaskInput(), title: '日付なし' })
    await createTask({ ...newTaskInput(), title: '予定済み', scheduledDate: '2026-10-03' })
    const groups = groupDrawerTasks(await db.tasks.toArray(), '2026-10-01')
    expect([groups.overdue.length, groups.unscheduled.length, groups.planned.length]).toEqual([1, 1, 1])
  })
})
