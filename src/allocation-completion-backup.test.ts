import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, correctCompletion, createTask, newTaskInput, undoCompletion, updateTask } from './commands'
import { applyBreakdownProposal, suggestBreakdown } from './breakdown'
import { addChecklistItem, convertChecklistItem } from './checklist'
import { captureSnapshot, restoreBackup } from './backup'
import { validateSnapshot } from './backup-validation'
import { emptyScore } from './domain'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

const task = async (id: string) => (await db.tasks.get(id))!
const completion = async (id: string) => (await db.completions.where('taskId').equals(id).first())!
const finish = async (id: string) => completeTask(id, (await task(id)).revision)
const undo = async (id: string) => undoCompletion(id, (await task(id)).revision)

async function allocate(kind: 'breakdown' | 'checklist') {
  const id = await createTask({ ...newTaskInput(), title: '復元する40ptの配分', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
  await finish(id)
  await undo(id)
  const children = kind === 'breakdown'
    ? await applyBreakdownProposal(suggestBreakdown(await task(id), 'large'))
    : [await convertChecklistItem(await addChecklistItem(id, '20ptを子へ配分'), (await task(id)).revision, 20)]
  return { id, children }
}

describe('配分同期のバックアップ互換性', () => {
  it.each(['breakdown', 'checklist'] as const)('%s 後の取消済み履歴を実復元しても親子の正味40ptを維持する', async kind => {
    const { id, children } = await allocate(kind)
    const saved = await captureSnapshot(), original = await completion(id)
    expect(original.allocationAssessmentId).toBe((await task(id)).assessmentId)
    await restoreBackup(saved)
    expect(await completion(id)).toEqual(original)
    expect(await db.ledger.toArray()).toEqual(saved.ledger)
    await finish(id)
    for (const child of children) await finish(child)
    expect((await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0)).toBe(40)
    expect(await completion(id)).toMatchObject({ id: original.id, originalAt: original.originalAt, originalPoints: 40 })
    expect(() => validateSnapshot(saved)).not.toThrow()
  })

  it('同期後の同ミリ秒の実績訂正と将来見積変更を復元しても訂正値を復活させる', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
    const { id } = await allocate('breakdown')
    const marker = (await completion(id)).allocationAssessmentId
    await finish(id)
    await correctCompletion(id, 3, '配分後に本人が確認した実績')
    await undo(id)
    const parent = await task(id)
    await updateTask(id, parent.revision, { ...parent, score: { ...parent.score, manualPoints: 9 } })
    const saved = await captureSnapshot()
    await restoreBackup(saved)
    await finish(id)
    expect(await completion(id)).toMatchObject({ allocationAssessmentId: marker, originalPoints: 40, netPoints: 3 })
    expect((await task(id)).effectivePoints).toBe(9)
    for (const entry of saved.ledger) expect(await db.ledger.get(entry.id)).toEqual(entry)
  })

  it('同期情報のない旧バックアップも形式1のまま検証・復元できる', async () => {
    const { id } = await allocate('breakdown')
    const saved = await captureSnapshot()
    delete saved.completions[0].allocationAssessmentId
    expect(() => validateSnapshot(saved)).not.toThrow()
    await restoreBackup(saved)
    expect((await completion(id)).allocationAssessmentId).toBeUndefined()
    expect(await db.ledger.toArray()).toEqual(saved.ledger)
  })

  it.each(['missing', 'other-task', 'null', 'empty', 'number'] as const)('%s の配分評価参照を実復元前に拒否して元DBを保持する', async invalid => {
    const { id } = await allocate('breakdown')
    const otherId = await createTask({ ...newTaskInput(), title: '無関係の評価', score: { ...emptyScore(), mode: 'manual', manualPoints: 1 } })
    const before = await captureSnapshot(), corrupted = structuredClone(before)
    const invalidReference = invalid === 'other-task' ? (await task(otherId)).assessmentId : invalid === 'null' ? null : invalid === 'empty' ? '' : invalid === 'number' ? 7 : '存在しない評価'
    Object.assign(corrupted.completions[0], { allocationAssessmentId: invalidReference })
    await expect(restoreBackup(corrupted)).rejects.toThrow('配分評価参照')
    expect(await completion(id)).toEqual(before.completions[0])
    expect(await db.tasks.toArray()).toEqual(before.tasks)
    expect(await db.ledger.toArray()).toEqual(before.ledger)
  })

  it.each(['unset', 'formula'] as const)('%s の将来評価は配分同期の参照に使えない', async mode => {
    const { id } = await allocate('breakdown')
    const parent = await task(id)
    const score = mode === 'unset' ? emptyScore() : { ...emptyScore(), mode, minutes: 0, travelMinutes: 0, difficulty: 0, uncertainty: 0, coordination: 0, physical: 0, outing: false }
    await updateTask(id, parent.revision, { ...parent, score })
    const before = await captureSnapshot(), corrupted = structuredClone(before)
    corrupted.completions[0].allocationAssessmentId = (await task(id)).assessmentId
    await expect(restoreBackup(corrupted)).rejects.toThrow('配分評価参照')
    expect(await completion(id)).toEqual(before.completions[0])
    expect(await db.ledger.toArray()).toEqual(before.ledger)
  })

  it('同期済み取消記録の確定ポイント欠落を復元前に拒否する', async () => {
    const { id } = await allocate('breakdown')
    const before = await captureSnapshot(), corrupted = structuredClone(before)
    delete corrupted.completions[0].lastConfirmedPoints
    await expect(restoreBackup(corrupted)).rejects.toThrow('配分評価参照')
    expect(await completion(id)).toEqual(before.completions[0])
    expect(await db.ledger.toArray()).toEqual(before.ledger)
  })

  it('有効な完了の同期情報には取消用キャッシュがなくても復元できる', async () => {
    const { id } = await allocate('breakdown')
    await finish(id)
    const saved = await captureSnapshot()
    delete saved.completions[0].lastConfirmedPoints
    expect(() => validateSnapshot(saved)).not.toThrow()
    await restoreBackup(saved)
    await undo(id)
    await finish(id)
    expect((await completion(id)).netPoints).toBe(0)
  })
})
