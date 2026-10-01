import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, correctCompletion, createTask, newTaskInput, undoCompletion, updateTask } from './commands'
import { addChecklistItem, convertChecklistItem } from './checklist'
import { applyBreakdownProposal, suggestBreakdown } from './breakdown'
import { emptyScore, uid } from './domain'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

const parentInput = () => ({ ...newTaskInput(), title: '配分履歴の独立確認', score: { ...emptyScore(), mode: 'manual' as const, manualPoints: 40 } })
const task = async (id: string) => (await db.tasks.get(id))!
const completion = async (id: string) => (await db.completions.where('taskId').equals(id).first())!
const finish = async (id: string) => completeTask(id, (await task(id)).revision)
const undo = async (id: string) => undoCompletion(id, (await task(id)).revision)
const sum = async () => (await db.ledger.toArray()).reduce((total, entry) => total + entry.delta, 0)
const time = (second: number) => vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 0, 0, second)))
async function legacyCache(id: string, points: number) {
  const { allocationAssessmentId: _marker, ...old } = await completion(id)
  await db.completions.put({ ...old, lastConfirmedPoints: points })
}
const snapshot = async () => ({
  tasks: await db.tasks.toArray(), assessments: await db.assessments.toArray(),
  completions: await db.completions.toArray(), ledger: await db.ledger.toArray(),
  items: await db.checklistItems.toArray(), audits: await db.audits.toArray(), commands: await db.commands.toArray(),
})

describe('配分と再完了の独立回帰', () => {
  it.each(['breakdown', 'checklist'] as const)('%s 後の明示実績訂正は同ミリ秒の取消・再完了でも維持する', async kind => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
    const id = await createTask(parentInput())
    await finish(id)
    const original = await completion(id)
    await undo(id)
    const historicalLedger = await db.ledger.toArray()
    if (kind === 'breakdown') await applyBreakdownProposal(suggestBreakdown(await task(id), 'large'))
    else await convertChecklistItem(await addChecklistItem(id, '明示的な10pt配分'), (await task(id)).revision, 10)
    await finish(id)
    const correctedPoints = kind === 'breakdown' ? 3 : 27
    await correctCompletion(id, correctedPoints, '配分後の実績を本人が確認')
    await undo(id)
    expect((await completion(id)).lastConfirmedPoints).toBe(correctedPoints)
    const beforeRestore = await db.ledger.toArray()
    await finish(id)
    await undo(id)
    await finish(id)
    const final = await completion(id)
    expect(final).toMatchObject({ id: original.id, originalAt: original.originalAt, originalPoints: 40, netPoints: correctedPoints })
    expect(await db.completions.where('taskId').equals(id).count()).toBe(1)
    expect(await sum()).toBe(correctedPoints)
    for (const entry of [...historicalLedger, ...beforeRestore]) expect(await db.ledger.get(entry.id)).toEqual(entry)
  })

  it.each(['breakdown', 'checklist'] as const)('初完了より前の %s でも同ミリ秒の訂正を再確定する', async kind => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await createTask(parentInput())
    if (kind === 'breakdown') await applyBreakdownProposal(suggestBreakdown(await task(id), 'large'))
    else await convertChecklistItem(await addChecklistItem(id, '初完了前の10pt配分'), (await task(id)).revision, 10)
    await finish(id)
    const original = await completion(id)
    const points = kind === 'breakdown' ? 3 : 27
    await correctCompletion(id, points, '初完了後の本人訂正')
    await undo(id)
    const historical = await db.ledger.toArray()
    await finish(id)
    expect(await completion(id)).toMatchObject({ id: original.id, originalPoints: kind === 'breakdown' ? 0 : 30, netPoints: points })
    expect(await sum()).toBe(points)
    for (const entry of historical) expect(await db.ledger.get(entry.id)).toEqual(entry)
  })

  it.each(['unset', 'formula'] as const)('初完了前に配分親を %s へ編集しても本人訂正3ptを再確定する', async mode => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await createTask(parentInput())
    await applyBreakdownProposal(suggestBreakdown(await task(id), 'large'))
    const score = mode === 'unset' ? emptyScore() : { ...emptyScore(), mode, minutes: 12, travelMinutes: 0, difficulty: 0, uncertainty: 0, coordination: 0, physical: 0, outing: false }
    await updateTask(id, (await task(id)).revision, { ...await task(id), score })
    await finish(id)
    const original = await completion(id)
    await correctCompletion(id, 3, '初回完了後に本人が確定')
    await undo(id)
    const historical = await db.ledger.toArray()
    await finish(id)
    expect(await completion(id)).toMatchObject({ id: original.id, originalPoints: original.originalPoints, netPoints: 3 })
    expect(await sum()).toBe(3)
    for (const entry of historical) expect(await db.ledger.get(entry.id)).toEqual(entry)
  })

  it('配分のない取消後に将来評価を編集しても確定済み35ptを再利用する', async () => {
    const id = await createTask(parentInput())
    await finish(id)
    await correctCompletion(id, 35, '実績は35pt')
    await undo(id)
    const original = await completion(id), ledger = await db.ledger.toArray()
    await updateTask(id, (await task(id)).revision, { ...parentInput(), score: { ...emptyScore(), mode: 'manual', manualPoints: 99 } })
    await finish(id)
    expect((await task(id)).effectivePoints).toBe(99)
    expect(await completion(id)).toMatchObject({ id: original.id, originalPoints: 40, netPoints: 35 })
    expect(await sum()).toBe(35)
    for (const entry of ledger) expect(await db.ledger.get(entry.id)).toEqual(entry)
  })

  it('取消済み配分同期記録の確定cache欠落は将来評価を代入せず拒否する', async () => {
    const id = await createTask(parentInput())
    await finish(id); await undo(id)
    await applyBreakdownProposal(suggestBreakdown(await task(id), 'large'))
    await updateTask(id, (await task(id)).revision, { ...await task(id), score: { ...emptyScore(), mode: 'manual', manualPoints: 99 } })
    const { lastConfirmedPoints: _cache, ...incomplete } = await completion(id)
    await db.completions.put(incomplete)
    const before = await snapshot()
    await expect(finish(id)).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
    expect(await sum()).toBe(0)
  })

  it.each(['self', 'unrelated'] as const)('%s converted link は配分の証拠にならず確定実績を変更しない', async link => {
    const id = await createTask(parentInput())
    await finish(id)
    await correctCompletion(id, 35, '確定値を保持')
    await undo(id)
    await updateTask(id, (await task(id)).revision, { ...parentInput(), score: { ...emptyScore(), mode: 'manual', manualPoints: 99 } })
    const itemId = await addChecklistItem(id, '参照整合性の検証')
    const childId = link === 'self' ? id : await createTask({ ...parentInput(), title: '配分から作成していない別タスク' })
    await db.checklistItems.update(itemId, { convertedTaskId: childId })
    const before = await snapshot()
    let rejected = false
    try { await finish(id) } catch { rejected = true }
    if (rejected) expect(await snapshot()).toEqual(before)
    else {
      expect((await completion(id)).netPoints).toBe(35)
      expect(await sum()).toBe(35)
    }
  })

  it.each(['breakdown', 'checklist'] as const)('%s の最終記録失敗は取消済み完了キャッシュも含め全て戻す', async kind => {
    const id = await createTask(parentInput())
    await finish(id)
    await correctCompletion(id, 35, '取消前の確定値')
    await undo(id)
    const itemId = kind === 'checklist' ? await addChecklistItem(id, '後半で失敗する配分') : null
    const before = await snapshot()
    if (kind === 'breakdown') {
      vi.spyOn(db.commands, 'add').mockRejectedValueOnce(new Error('保存末尾の失敗'))
      await expect(applyBreakdownProposal(suggestBreakdown(await task(id), 'large'))).rejects.toThrow('保存末尾')
    } else {
      vi.spyOn(db.audits, 'bulkAdd').mockRejectedValueOnce(new Error('保存末尾の失敗'))
      await expect(convertChecklistItem(itemId!, (await task(id)).revision, 10)).rejects.toThrow('保存末尾')
    }
    expect(await snapshot()).toEqual(before)
    expect((await completion(id)).lastConfirmedPoints).toBe(35)
    expect(await sum()).toBe(0)
  })

  it.each(['breakdown', 'checklist'] as const)('%s 旧データの取消後配分は明示再完了時だけ残額へ修復する', async kind => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await createTask(parentInput())
    time(1); await finish(id)
    const original = await completion(id)
    time(2); await undo(id)
    time(3)
    if (kind === 'breakdown') await applyBreakdownProposal(suggestBreakdown(await task(id), 'large'))
    else await convertChecklistItem(await addChecklistItem(id, '旧データの10pt配分'), (await task(id)).revision, 10)
    await legacyCache(id, 40)
    const historical = await db.ledger.toArray()
    expect(await sum()).toBe(0)
    time(4); await finish(id)
    const remaining = kind === 'breakdown' ? 0 : 30
    expect(await completion(id)).toMatchObject({ id: original.id, originalPoints: 40, netPoints: remaining })
    expect(await sum()).toBe(remaining)
    for (const entry of historical) expect(await db.ledger.get(entry.id)).toEqual(entry)
  })

  it('旧データでも配分後の本人実績訂正27ptを保持する', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await createTask(parentInput())
    time(1); await finish(id)
    time(2); await undo(id)
    time(3); await convertChecklistItem(await addChecklistItem(id, '10pt配分'), (await task(id)).revision, 10)
    time(4); await finish(id)
    time(5); await correctCompletion(id, 27, '配分後の本人訂正')
    time(6); await undo(id)
    await legacyCache(id, 27)
    const historical = await db.ledger.toArray()
    time(7); await finish(id)
    expect((await completion(id)).netPoints).toBe(27)
    expect(await sum()).toBe(27)
    for (const entry of historical) expect(await db.ledger.get(entry.id)).toEqual(entry)
  })

  it('旧版の配分後restore40は明示訂正の証拠にならず二重加点を再現しない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await createTask(parentInput())
    time(1); await finish(id)
    time(2); await undo(id)
    time(3); await applyBreakdownProposal(suggestBreakdown(await task(id), 'large'))
    await legacyCache(id, 40)
    // 旧版が取消前の40ptを再利用した、整合する過去のrestoreを再現する。
    time(4)
    const oldCompletion = await completion(id), oldTask = await task(id), at = new Date().toISOString()
    await db.ledger.add({ id: uid(), taskId: id, completionId: oldCompletion.id, kind: 'restore', delta: 40, at, reason: '完了を再確定' })
    await db.completions.put({ ...oldCompletion, currentAt: at, netPoints: 40, scoreState: 'confirmed' })
    await db.tasks.put({ ...oldTask, status: 'completed', revision: oldTask.revision + 1, updatedAt: at })
    await db.audits.add({ id: uid(), taskId: id, operation: 'complete', at, detail: '0ptで完了' })
    time(5); await undo(id)
    const before = await snapshot()
    time(6)
    let rejected = false
    try { await finish(id) } catch { rejected = true }
    if (rejected) expect(await snapshot()).toEqual(before)
    else {
      expect((await completion(id)).netPoints).toBe(0)
      expect(await sum()).toBe(0)
      for (const entry of before.ledger) expect(await db.ledger.get(entry.id)).toEqual(entry)
    }
  })

  it('旧データの配分と確定が同ミリ秒なら順序を推測して加点しない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await createTask(parentInput())
    await finish(id); await undo(id)
    await applyBreakdownProposal(suggestBreakdown(await task(id), 'large'))
    await legacyCache(id, 40)
    const before = await snapshot()
    await expect(finish(id)).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it.each(['parent-unset', 'child-manual-deleted'] as const)('旧データで %s に変更しても古い40ptを親へ戻さない', async change => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await createTask(parentInput())
    time(1); await finish(id)
    time(2); await undo(id)
    time(3); const [childId] = await applyBreakdownProposal(suggestBreakdown(await task(id), 'large'))
    await legacyCache(id, 40)
    time(4)
    if (change === 'parent-unset') await updateTask(id, (await task(id)).revision, { ...await task(id), score: emptyScore() })
    else {
      await updateTask(childId, (await task(childId)).revision, { ...await task(childId), title: '配分後に編集した子', score: { ...emptyScore(), mode: 'manual', manualPoints: 13 } })
      await db.tasks.update(childId, { deletedAt: new Date().toISOString() })
    }
    const before = await snapshot()
    time(5)
    let rejected = false
    try { await finish(id) } catch { rejected = true }
    if (rejected) expect(await snapshot()).toEqual(before)
    else {
      expect((await completion(id)).netPoints ?? 0).toBe(0)
      expect(await sum()).toBe(0)
      for (const entry of before.ledger) expect(await db.ledger.get(entry.id)).toEqual(entry)
    }
  })

  it('別の親の正規breakdown生成子も当該親の配分証拠にはならない', async () => {
    const id = await createTask(parentInput())
    await finish(id); await correctCompletion(id, 35, '当該親の確定値'); await undo(id)
    await updateTask(id, (await task(id)).revision, { ...parentInput(), score: { ...emptyScore(), mode: 'manual', manualPoints: 99 } })
    const other = await createTask({ ...parentInput(), title: '別の親' })
    const [child] = await applyBreakdownProposal(suggestBreakdown(await task(other), 'large'))
    const itemId = await addChecklistItem(id, '別の親の子への誤リンク')
    await db.checklistItems.update(itemId, { convertedTaskId: child })
    const before = await snapshot()
    let rejected = false
    try { await finish(id) } catch { rejected = true }
    if (rejected) expect(await snapshot()).toEqual(before)
    else expect((await completion(id)).netPoints).toBe(35)
  })
})
