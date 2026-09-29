import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { completeTask, createRoutine, createTask, correctCompletion, expandRoutines, newTaskInput, undoCompletion, updateTask } from './commands'
import { emptyScore, today } from './domain'

beforeEach(async () => { await db.delete(); await db.open() })

describe('ローカル正式保存と台帳', () => {
  it('再送しても一回だけ作成・加点する', async () => {
    const input = { ...newTaskInput(), title: 'テスト', score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 25 } }
    const id = await createTask(input, 'create-key')
    expect(await createTask(input, 'create-key')).toBe(id)
    expect(await db.tasks.count()).toBe(1)
    await completeTask(id, 1, 'complete-key')
    await completeTask(id, 1, 'complete-key')
    expect(await db.ledger.count()).toBe(1)
    expect((await db.completions.where('taskId').equals(id).first())?.netPoints).toBe(25)
  })
  it('完了取消、訂正、再完了の正味ポイントを保つ', async () => {
    const id = await createTask({ ...newTaskInput(), title: '記録', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
    await completeTask(id, 1)
    await correctCompletion(id, 35, '実績を確認')
    await undoCompletion(id, 2)
    expect((await db.ledger.toArray()).reduce((n, e) => n + e.delta, 0)).toBe(0)
    await completeTask(id, 3)
    expect((await db.ledger.toArray()).reduce((n, e) => n + e.delta, 0)).toBe(40)
    expect(await db.completions.count()).toBe(1)
  })
  it('旧revisionの編集を拒否する', async () => {
    const input = { ...newTaskInput(), title: '競合' }, id = await createTask(input)
    await updateTask(id, 1, { ...input, title: '変更済み' })
    await expect(updateTask(id, 1, { ...input, title: '後勝ち' })).rejects.toThrow('別の画面')
    expect((await db.tasks.get(id))?.title).toBe('変更済み')
  })
  it('同じrequest keyの異なる内容を拒否する', async () => {
    await createTask({ ...newTaskInput(), title: 'A' }, 'same')
    await expect(createTask({ ...newTaskInput(), title: 'B' }, 'same')).rejects.toThrow('IDEMPOTENCY_MISMATCH')
  })
  it('ルーティン展開を繰り返しても重複しない', async () => {
    await createRoutine({ title: '毎日確認', cadence: 'daily', interval: 1, weekdays: [], monthDay: 1, startDate: today(), endDate: null, afterTaskId: null, score: emptyScore(), project: '', active: true })
    await expandRoutines(today(), 3)
    await expandRoutines(today(), 3)
    expect(await db.tasks.count()).toBe(3)
  })
})
