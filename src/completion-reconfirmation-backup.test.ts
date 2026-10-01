import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { captureSnapshot, restoreBackup } from './backup'
import { validateSnapshot } from './backup-validation'
import { completeTask, correctCompletion, createTask, newTaskInput, undoCompletion, updateTask } from './commands'
import { calculateScore, emptyScore } from './domain'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const task = async (id: string) => (await db.tasks.get(id))!
const completion = async (id: string) => (await db.completions.where('taskId').equals(id).first())!
const finish = async (id: string) => completeTask(id, (await task(id)).revision)
const undo = async (id: string) => undoCompletion(id, (await task(id)).revision)

async function reconfirmedSnapshot(points = 3) {
  const id = await createTask({ ...newTaskInput(), title: '原実績40ptと再確認を保持', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
  await finish(id); await undo(id)
  const open = await task(id)
  await updateTask(id, open.revision, { ...open, score: { ...open.score, manualPoints: 9 } })
  const original = await captureSnapshot(), snapshot = structuredClone(original), at = new Date().toISOString()
  const row = snapshot.completions.find(item => item.taskId === id)!, savedTask = snapshot.tasks.find(item => item.id === id)!
  const score = { ...emptyScore(), mode: 'manual' as const, manualPoints: points }, assessmentId = 'reconfirmation-assessment'
  snapshot.assessments.push({ id: assessmentId, taskId: id, score, result: calculateScore(score), origin: 'human', ruleVersion: 'v1', createdAt: at })
  Object.assign(row, { currentAt: at, netPoints: points, lastConfirmedPoints: points, scoreState: 'confirmed', reconfirmedAssessmentId: assessmentId })
  Object.assign(savedTask, { status: 'completed', revision: savedTask.revision + 1, updatedAt: at })
  snapshot.ledger.push({ id: 'reconfirmation-restore', completionId: row.id, taskId: id, kind: 'restore', delta: points, at, reason: '本人が過去実績を再確認', assessmentId })
  return { id, original, snapshot, assessmentId }
}

describe('本人再確認の評価参照とバックアップ', () => {
  it.each([0, 3])('%i ptの実復元後も同一実績・原記録・未来見積を保持して再完了する', async points => {
    const { id, original, snapshot, assessmentId } = await reconfirmedSnapshot(points)
    expect(() => validateSnapshot(snapshot)).not.toThrow()
    await restoreBackup(snapshot)
    const restored = await completion(id)
    expect(restored).toMatchObject({ id: original.completions[0].id, originalAt: original.completions[0].originalAt, originalPoints: 40, title: original.completions[0].title, project: original.completions[0].project, netPoints: points, reconfirmedAssessmentId: assessmentId })
    expect((await task(id)).effectivePoints).toBe(9)
    expect((await task(id)).assessmentId).toBe(original.tasks[0].assessmentId)
    for (const entry of original.ledger) expect(await db.ledger.get(entry.id)).toEqual(entry)
    await undo(id); await finish(id)
    expect((await completion(id)).netPoints).toBe(points)
    expect((await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0)).toBe(points)
  })

  it('再確認3ptから訂正2ptへ変更後の復元と再完了で元評価3ptを復活させない', async () => {
    const { id, snapshot, assessmentId } = await reconfirmedSnapshot()
    await restoreBackup(snapshot)
    await correctCompletion(id, 2, '後日に本人が訂正')
    const adjustment = (await db.ledger.toArray()).find(entry => entry.kind === 'adjust')!
    expect(() => validateSnapshot({ ...snapshot, completions: [{ ...snapshot.completions[0], netPoints: 2 }], ledger: [...snapshot.ledger, adjustment] })).not.toThrow()
    await undo(id)
    const corrected = await captureSnapshot()
    expect(corrected.completions[0].lastConfirmedPoints).toBe(2)
    expect(corrected.assessments.find(item => item.id === assessmentId)!.score.manualPoints).toBe(3)
    await restoreBackup(corrected); await finish(id)
    expect((await completion(id)).netPoints).toBe(2)
    expect((await task(id)).effectivePoints).toBe(9)
    expect((await db.ledger.toArray()).reduce((sum, entry) => sum + entry.delta, 0)).toBe(2)
  })

  it.each(['missing', 'other-task', 'routine', 'formula', 'amount', 'result', 'restore-kind', 'restore-reference', 'marker-reference', 'cache-missing', 'cache-null', 'cache-negative'] as const)('%s の参照を復元前に拒否し既存DBを保持する', async invalid => {
    const { snapshot, assessmentId } = await reconfirmedSnapshot()
    const otherId = await createTask({ ...newTaskInput(), title: '無関係の評価', score: { ...emptyScore(), mode: 'manual', manualPoints: 1 } })
    const before = await captureSnapshot(), corrupted = structuredClone(snapshot)
    const assessment = corrupted.assessments.find(item => item.id === assessmentId)!, entry = corrupted.ledger.find(item => item.assessmentId === assessmentId)!, row = corrupted.completions[0]
    if (invalid === 'missing') corrupted.assessments = corrupted.assessments.filter(item => item.id !== assessmentId)
    if (invalid === 'other-task') { assessment.taskId = otherId; corrupted.tasks.push((await task(otherId))); corrupted.assessments.push((await db.assessments.get((await task(otherId)).assessmentId))!) }
    if (invalid === 'routine') assessment.origin = 'routine'
    if (invalid === 'formula') { assessment.score = { ...emptyScore(), mode: 'formula', minutes: 0, travelMinutes: 0, difficulty: 0, uncertainty: 0, coordination: 0, physical: 0, outing: false }; assessment.result = calculateScore(assessment.score) }
    if (invalid === 'amount') { assessment.score.manualPoints = 4; assessment.result = calculateScore(assessment.score) }
    if (invalid === 'result') assessment.result.effective = 4
    if (invalid === 'restore-kind') entry.kind = 'adjust'
    if (invalid === 'restore-reference') delete entry.assessmentId
    if (invalid === 'marker-reference') row.reconfirmedAssessmentId = corrupted.tasks[0].assessmentId
    if (invalid === 'cache-missing') delete row.lastConfirmedPoints
    if (invalid === 'cache-null') row.lastConfirmedPoints = null
    if (invalid === 'cache-negative') row.lastConfirmedPoints = -1
    await expect(restoreBackup(corrupted)).rejects.toThrow()
    expect(await db.tasks.toArray()).toEqual(before.tasks)
    expect(await db.completions.toArray()).toEqual(before.completions)
    expect(await db.assessments.toArray()).toEqual(before.assessments)
    expect(await db.ledger.toArray()).toEqual(before.ledger)
  })

  it('参照情報のない旧形式1の実績と台帳は互換のまま復元する', async () => {
    const { snapshot } = await reconfirmedSnapshot()
    delete snapshot.completions[0].reconfirmedAssessmentId
    delete snapshot.ledger.find(item => item.id === 'reconfirmation-restore')!.assessmentId
    expect(() => validateSnapshot(snapshot)).not.toThrow()
    await restoreBackup(snapshot)
    expect(await db.completions.toArray()).toEqual(snapshot.completions)
    expect(await db.ledger.toArray()).toEqual(snapshot.ledger)
  })
})
