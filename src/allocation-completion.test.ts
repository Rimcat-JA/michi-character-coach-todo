import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, correctCompletion, createTask, newTaskInput, undoCompletion } from './commands'
import { addChecklistItem, convertChecklistItem } from './checklist'
import { applyBreakdownProposal, suggestBreakdown } from './breakdown'
import { emptyScore } from './domain'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const task = async (id: string) => (await db.tasks.get(id))!
const completion = async (id: string) => (await db.completions.where('taskId').equals(id).first())!
const finish = async (id: string, key?: string) => completeTask(id, (await task(id)).revision, key)
const undo = async (id: string) => undoCompletion(id, (await task(id)).revision)
const total = async () => (await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0)
const parent = () => createTask({ ...newTaskInput(), title: '元の40pt作業', notes: '保持するメモ', project: '保持する案件', scheduledDate: '2026-10-01', dueDate: '2026-10-09', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
const time = (second: number) => vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 0, 0, second)))
const snapshot = async () => ({ tasks: await db.tasks.toArray(), assessments: await db.assessments.toArray(), completions: await db.completions.toArray(), ledger: await db.ledger.toArray(), items: await db.checklistItems.toArray(), audits: await db.audits.toArray(), commands: await db.commands.toArray(), settings: await db.settings.toArray() })
async function allocate(id: string, kind: 'breakdown' | 'checklist') {
  if (kind === 'breakdown') {
    const proposal = suggestBreakdown(await task(id), 'large'), ids = await applyBreakdownProposal(proposal)
    return { ids, replay: () => applyBreakdownProposal(proposal), remaining: 0 }
  }
  const item = await addChecklistItem(id, '本人が配分する20pt作業'), revision = (await task(id)).revision
  const child = await convertChecklistItem(item, revision, 20)
  return { ids: [child], replay: () => convertChecklistItem(item, revision, 20), remaining: 20 }
}
async function oldCache(id: string) {
  const { allocationAssessmentId: _marker, ...old } = await completion(id)
  await db.completions.put({ ...old, lastConfirmedPoints: 40 })
}

describe('配分後の完了ポイント保存', () => {
  it.each(['breakdown', 'checklist'] as const)('%s は取消済み親の残額だけを同期し、再送・親子完了でも40ptを保存する', async kind => {
    const id = await parent(); await finish(id); await undo(id)
    const old = await completion(id), history = await db.ledger.toArray(), oldTask = await task(id)
    const allocated = await allocate(id, kind), current = await task(id)
    expect(await completion(id)).toEqual({ ...old, lastConfirmedPoints: allocated.remaining, allocationAssessmentId: current.assessmentId })
    expect(current).toMatchObject({ notes: oldTask.notes, project: oldTask.project, scheduledDate: oldTask.scheduledDate, dueDate: oldTask.dueDate, effectivePoints: allocated.remaining })
    expect(await db.ledger.toArray()).toEqual(history)
    const saved = await snapshot(); await allocated.replay(); expect(await snapshot()).toEqual(saved)
    const revision = current.revision
    await completeTask(id, revision, 'restore-parent-once')
    const restored = await snapshot(); await completeTask(id, revision, 'restore-parent-once'); expect(await snapshot()).toEqual(restored)
    for (const child of [...allocated.ids].reverse()) await finish(child)
    expect(await total()).toBe(40)
    expect(await completion(id)).toMatchObject({ id: old.id, originalAt: old.originalAt, originalPoints: 40, netPoints: allocated.remaining, title: old.title, project: old.project })
    for (const entry of history) expect(await db.ledger.get(entry.id)).toEqual(entry)
  })

  it('複数の項目を順次独立化しても直近の親残額だけを復活させる', async () => {
    const id = await parent(); await finish(id); await undo(id)
    const first = await convertChecklistItem(await addChecklistItem(id, '20ptの項目'), (await task(id)).revision, 20)
    const second = await convertChecklistItem(await addChecklistItem(id, '10ptの項目'), (await task(id)).revision, 10)
    expect(await completion(id)).toMatchObject({ lastConfirmedPoints: 10, allocationAssessmentId: (await task(id)).assessmentId })
    for (const child of [first, second, id]) await finish(child)
    expect(await total()).toBe(40)
  })

  it.each(['breakdown', 'checklist'] as const)('%s のopen親に有効な完了記録が残っていると全配分を拒否する', async kind => {
    const id = await parent(); await finish(id)
    await db.tasks.update(id, { status: 'open' })
    const item = kind === 'checklist' ? await addChecklistItem(id, '未保存の子') : null
    const before = await snapshot()
    if (item) await expect(convertChecklistItem(item, (await task(id)).revision, 20)).rejects.toThrow('完了記録が一致')
    else await expect(applyBreakdownProposal(suggestBreakdown(await task(id), 'large'))).rejects.toThrow('完了記録が一致')
    expect(await snapshot()).toEqual(before)
    await expect(finish(id)).rejects.toThrow('完了記録が一致'); expect(await snapshot()).toEqual(before)
  })

  it.each(['breakdown', 'checklist'] as const)('%s の事前完了なし親も初完了で同期記録を付け、同ミリ秒の訂正を保つ', async kind => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await parent(), allocated = await allocate(id, kind)
    expect(await db.completions.where('taskId').equals(id).count()).toBe(0)
    await finish(id)
    expect((await completion(id)).allocationAssessmentId).toBe((await task(id)).assessmentId)
    await correctCompletion(id, 3, '本人が完了時の実績を3ptへ訂正'); await undo(id); await finish(id)
    expect((await completion(id)).netPoints).toBe(3)
    expect(await total()).toBe(3)
    expect(allocated.ids.length).toBeGreaterThan(0)
  })

  it('通常の本人訂正35ptは配分同期記録を付けず復活し、監査も35ptになる', async () => {
    const id = await parent(); await finish(id); await correctCompletion(id, 35, '実績訂正'); await undo(id); await finish(id)
    expect(await completion(id)).toMatchObject({ originalPoints: 40, netPoints: 35 })
    expect((await completion(id)).allocationAssessmentId).toBeUndefined()
    const audit = (await db.audits.where('taskId').equals(id).toArray()).filter(value => value.operation === 'complete')
    expect(audit.some(value => { const detail = JSON.parse(value.detail); return detail.summary === '35ptで完了' && detail.after.completionPoints === 35 })).toBe(true)
    expect(await total()).toBe(35)
  })
})

describe('旧版の配分キャッシュを明示再完了時に確認', () => {
  it.each(['breakdown', 'checklist'] as const)('%s の旧last40を残額へ修復し、親子完了の合計も40pt', async kind => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await parent(); time(1); await finish(id); time(2); await undo(id); time(3)
    const allocated = await allocate(id, kind); await oldCache(id)
    const old = await completion(id), history = await db.ledger.toArray()
    expect(old.lastConfirmedPoints).toBe(40); expect(await total()).toBe(0)
    time(4); await finish(id)
    expect(await completion(id)).toMatchObject({ id: old.id, originalAt: old.originalAt, originalPoints: 40, netPoints: allocated.remaining, lastConfirmedPoints: allocated.remaining, allocationAssessmentId: (await task(id)).assessmentId })
    for (const child of allocated.ids) await finish(child)
    expect(await total()).toBe(40)
    expect((await db.audits.where('taskId').equals(id).toArray()).some(value => value.operation === 'allocation_completion_repaired')).toBe(true)
    for (const entry of history) expect(await db.ledger.get(entry.id)).toEqual(entry)
  })

  it('旧キャッシュ修復の末尾receipt保存に失敗すると履歴・残額・markerを全部戻す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await parent(); time(1); await finish(id); time(2); await undo(id); time(3); await allocate(id, 'breakdown'); await oldCache(id)
    const before = await snapshot(); time(4)
    const failure = vi.spyOn(db.commands, 'add').mockRejectedValueOnce(new Error('完了receipt末尾失敗'))
    await expect(finish(id, 'late-repair')).rejects.toThrow('完了receipt末尾失敗')
    expect(await snapshot()).toEqual(before)
    failure.mockRestore(); await finish(id, 'late-repair')
    expect((await completion(id)).netPoints).toBe(0); expect(await total()).toBe(0)
  })

  it('初完了の末尾失敗も新しい同期記録と加点を残さない', async () => {
    const id = await parent(); await allocate(id, 'breakdown')
    const before = await snapshot()
    vi.spyOn(db.commands, 'add').mockRejectedValueOnce(new Error('初完了receipt失敗'))
    await expect(finish(id)).rejects.toThrow('初完了receipt失敗')
    expect(await snapshot()).toEqual(before)
  })

  it('時計逆行で旧配分と元完了の順序が不明ならポイントを推測しない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await parent(); time(2); await finish(id); time(3); await undo(id); time(1); await allocate(id, 'breakdown'); await oldCache(id)
    const before = await snapshot(); time(4)
    await expect(finish(id)).rejects.toThrow('順序を確定できません')
    expect(await snapshot()).toEqual(before)
  })

  it('二度目の配分だけ時計が戻った旧データも以前の訂正値を再利用しない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await parent(); time(1); await finish(id); time(2); await undo(id)
    time(4); await convertChecklistItem(await addChecklistItem(id, '前半10pt'), (await task(id)).revision, 10)
    time(5); await finish(id); await correctCompletion(id, 27, '前半配分後の訂正'); await undo(id)
    time(3); await convertChecklistItem(await addChecklistItem(id, '後半10pt'), (await task(id)).revision, 10)
    const { allocationAssessmentId: _marker, ...old } = await completion(id)
    await db.completions.put({ ...old, lastConfirmedPoints: 27 })
    const before = await snapshot(); time(6)
    await expect(finish(id)).rejects.toThrow('順序を確定できません')
    expect(await snapshot()).toEqual(before)
  })

  it('子を表示上削除しても配分は親へ戻らず、旧キャッシュから40ptを復活させない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const id = await parent(); time(1); await finish(id); time(2); await undo(id); time(3)
    const allocated = await allocate(id, 'breakdown'); await oldCache(id)
    for (const child of allocated.ids) await db.tasks.update(child, { deletedAt: new Date().toISOString() })
    time(4); await finish(id)
    expect((await completion(id)).netPoints).toBe(0); expect(await total()).toBe(0)
  })

  it('独立化した項目を別の親へ移した旧データから両方の親の確定値を推測しない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); time(0)
    const original = await parent(), other = await parent()
    time(1); await finish(original); await finish(other)
    time(2); await undo(original); await undo(other)
    time(3); await allocate(original, 'checklist'); await oldCache(original)
    const [item] = await db.checklistItems.where('taskId').equals(original).toArray()
    await db.checklistItems.update(item.id, { taskId: other })
    const before = await snapshot(); time(4)
    await expect(finish(other)).rejects.toThrow('元の親')
    expect(await snapshot()).toEqual(before)
    await expect(finish(original)).rejects.toThrow('子タスク参照がありません')
    expect(await snapshot()).toEqual(before)
  })
})
