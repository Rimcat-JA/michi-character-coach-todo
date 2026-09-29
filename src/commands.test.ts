import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { bulkUpdateTasksAtomic, completeTask, createRoutine, createTask, createTasksAtomic, correctCompletion, expandRoutines, logSession, newTaskInput, setTaskFlag, trashTask, undoCompletion, updateTask } from './commands'
import { addDays, emptyScore, today } from './domain'

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
    expect((await db.ledger.toArray()).reduce((n, e) => n + e.delta, 0)).toBe(35)
    expect(await db.completions.count()).toBe(1)
  })
  it('旧revisionの編集を拒否する', async () => {
    const input = { ...newTaskInput(), title: '競合' }, id = await createTask(input)
    await updateTask(id, 1, { ...input, title: '変更済み' })
    await expect(updateTask(id, 1, { ...input, title: '後勝ち' })).rejects.toThrow('別の画面')
    expect((await db.tasks.get(id))?.title).toBe('変更済み')
  })
  it('予定日だけ変更しても締め切りと目標日は変えない', async () => {
    const input = { ...newTaskInput(), title: '別々の日付', scheduledDate: '2026-10-01', dueDate: '2026-10-03', targetDate: '2026-10-02' }
    const id = await createTask(input)
    await updateTask(id, 1, { ...input, scheduledDate: '2026-10-04' })
    const updated = await db.tasks.get(id)
    expect(updated?.scheduledDate).toBe('2026-10-04')
    expect(updated?.dueDate).toBe('2026-10-03')
    expect(updated?.targetDate).toBe('2026-10-02')
  })
  it('個人目標日を変更しても外部期限を変えない', async () => {
    const input = { ...newTaskInput(), title: '独立した期限', targetDate: '2026-10-02', dueDate: '2026-10-05' }
    const id = await createTask(input)
    await updateTask(id, 1, { ...input, targetDate: '2026-10-03' })
    const updated = await db.tasks.get(id)
    expect(updated?.targetDate).toBe('2026-10-03')
    expect(updated?.dueDate).toBe('2026-10-05')
  })
  it('保留解除で属性と手動ポイントを保ち、Orbitとピンは新規発生回を作らない', async () => {
    const id = await createTask({ ...newTaskInput(), title: '再開予定', frog: 4, weight: 2, score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
    await setTaskFlag(id, 1, 'backburner', true)
    await setTaskFlag(id, 2, 'orbit', true)
    await setTaskFlag(id, 3, 'pinned', true)
    await setTaskFlag(id, 4, 'pinned', false)
    await setTaskFlag(id, 5, 'backburner', false)
    const task = await db.tasks.get(id)
    expect(task).toMatchObject({ backburner: false, orbit: true, pinned: false, frog: 4, weight: 2, effectivePoints: 25, scheduledDate: null, dueDate: null })
    expect(await db.tasks.count()).toBe(1)
    expect(await db.completions.count()).toBe(0)
  })
  it('FrogとWeightの編集は点数を変えない', async () => {
    const input = { ...newTaskInput(), title: '負担感', score: { ...emptyScore(), mode: 'formula' as const, minutes: 30, travelMinutes: 0, difficulty: 1, uncertainty: 0, coordination: 0, physical: 0, outing: false } }
    const id = await createTask(input)
    const before = (await db.tasks.get(id))?.effectivePoints
    await updateTask(id, 1, { ...input, frog: 4, weight: 1 })
    expect((await db.tasks.get(id))?.effectivePoints).toBe(before)
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
  it('月末・除外日・今回だけ編集・完了後3日を正しく展開する', async () => {
    const monthlyId = await createRoutine({ title: '月末確認', cadence: 'monthly', interval: 1, weekdays: [], monthDay: 31, startDate: '2026-01-31', endDate: '2026-04-30', excludedDates: ['2026-03-31'], afterTaskId: null, score: emptyScore(), project: '', active: true })
    await expandRoutines('2026-01-01', 120)
    const monthly = await db.tasks.where('routineId').equals(monthlyId).toArray()
    expect(monthly.map(task => task.scheduledDate).sort()).toEqual(['2026-01-31', '2026-02-28', '2026-04-30'])
    const feb = monthly.find(task => task.scheduledDate === '2026-02-28')!
    await updateTask(feb.id, feb.revision, { ...newTaskInput(), title: '今回だけ短くする', scheduledDate: feb.scheduledDate })
    await expandRoutines('2026-01-01', 120)
    expect((await db.tasks.get(feb.id))?.title).toBe('今回だけ短くする')
    expect(await db.tasks.where('routineId').equals(monthlyId).count()).toBe(3)

    const afterId = await createRoutine({ title: '完了後の次回', cadence: 'after_completion', interval: 3, weekdays: [], monthDay: 1, startDate: today(), endDate: null, excludedDates: [], afterTaskId: null, score: emptyScore(), project: '', active: true })
    await expandRoutines(today(), 1)
    const first = (await db.tasks.where('routineId').equals(afterId).first())!
    await completeTask(first.id, first.revision)
    await expandRoutines(today(), 1)
    const occurrences = await db.tasks.where('routineId').equals(afterId).toArray()
    expect(occurrences.map(task => task.scheduledDate).sort()).toEqual([today(), addDays(today(), 3)])
  })
  it('一括登録の途中で不正行があれば全てロールバックする', async () => {
    const good = { ...newTaskInput(), title: '有効' }
    const bad = { ...newTaskInput(), title: '' }
    await expect(createTasksAtomic([good, bad], 'bulk-invalid')).rejects.toThrow('タイトル')
    expect(await db.tasks.count()).toBe(0)
    expect(await db.assessments.count()).toBe(0)
    expect(await db.commands.count()).toBe(0)
    expect(await db.audits.count()).toBe(0)
  })
  it('一括登録の同じキーの再送では重複作成しない', async () => {
    const inputs = [{ ...newTaskInput(), title: '1' }, { ...newTaskInput(), title: '2' }]
    const ids = await createTasksAtomic(inputs, 'bulk-same')
    expect(await createTasksAtomic(inputs, 'bulk-same')).toEqual(ids)
    expect(await db.tasks.count()).toBe(2)
  })
  it('一括編集は一件でもrevision競合なら全件を変更しない', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, (_, index) => createTask({ ...newTaskInput(), title: `タスク${index}` })))
    const captured = ids.map(id => ({ id, revision: 1 }))
    await updateTask(ids[4], 1, { ...newTaskInput(), title: '別画面で更新' })
    await expect(bulkUpdateTasksAtomic(captured, { project: '新しい案件' }, 'bulk-conflict')).rejects.toThrow('別の画面')
    expect((await db.tasks.toArray()).every(task => task.project === '')).toBe(true)
    expect(await db.commands.get('bulk-conflict')).toBeUndefined()
    const refreshed = ids.map((id, index) => ({ id, revision: index === 4 ? 2 : 1 }))
    expect(await bulkUpdateTasksAtomic(refreshed, { project: '新しい案件' }, 'bulk-success')).toEqual(ids)
    expect(await bulkUpdateTasksAtomic(refreshed, { project: '新しい案件' }, 'bulk-success')).toEqual(ids)
    expect((await db.tasks.toArray()).every(task => task.project === '新しい案件' && task.revision >= 2)).toBe(true)
  })
  it('完了タスクをゴミ箱へ移しても実績は残り、完了取消でだけ減る', async () => {
    const id = await createTask({ ...newTaskInput(), title: '残す実績', score: { ...emptyScore(), mode: 'manual', manualPoints: 30 } })
    await completeTask(id, 1)
    await trashTask(id, 2)
    expect((await db.ledger.toArray()).reduce((total, entry) => total + entry.delta, 0)).toBe(30)
    expect((await db.tasks.get(id))?.deletedAt).not.toBeNull()
    await undoCompletion(id, 3)
    expect((await db.ledger.toArray()).reduce((total, entry) => total + entry.delta, 0)).toBe(0)
  })
  it('作業区間の逆転と存在しないタスクを保存しない', async () => {
    const id = await createTask({ ...newTaskInput(), title: '時間の記録' })
    await expect(logSession(id, '2026-10-01T10:30:00.000Z', '2026-10-01T10:00:00.000Z')).rejects.toThrow('日時')
    await expect(logSession('missing', '2026-10-01T10:00:00.000Z', '2026-10-01T10:30:00.000Z')).rejects.toThrow('対象')
    expect(await db.sessions.count()).toBe(0)
    await logSession(id, '2026-10-01T10:00:00.000Z', '2026-10-01T10:30:00.000Z')
    expect((await db.sessions.toArray())[0].minutes).toBe(30)
  })
})
