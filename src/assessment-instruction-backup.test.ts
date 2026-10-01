import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput } from './commands'
import { calculateScore, emptyScore, uid, type Assessment, type AssessmentInstruction } from './domain'
import { captureSnapshot, restoreBackup } from './backup'
import { validateSnapshot } from './backup-validation'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })

async function delegatedAssessment() {
  const owner = (await db.settings.get('main'))!
  const id = await createTask({ ...newTaskInput(), title: '本人の指定ポイント', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
  await completeTask(id, 1)
  const task = (await db.tasks.get(id))!, score = { ...task.score, manualPoints: 30 }, assessmentId = uid()
  const instruction: AssessmentInstruction = { id: uid(), digest: 'a'.repeat(64), ownerId: owner.profileId, datasetId: owner.datasetId, actorId: 'coach', actorKind: 'coach', model: 'deepseek/deepseek-v4.1-flash', taskRevision: task.revision, approvedBy: owner.profileId }
  const assessment: Assessment = { id: assessmentId, taskId: id, score, result: calculateScore(score), createdAt: new Date().toISOString(), origin: 'user_instruction_via_agent', ruleVersion: 'v1', instruction }
  await db.transaction('rw', db.tasks, db.assessments, async () => {
    await db.assessments.add(assessment)
    await db.tasks.update(id, { score, effectivePoints: 30, assessmentId, revision: task.revision + 1 })
  })
  return { assessmentId, id, snapshot: await captureSnapshot() }
}

it('本人の代理指示による評価を復元し、完了時25ptと台帳を維持する', async () => {
  const value = await delegatedAssessment(), ledger = value.snapshot.ledger, completions = value.snapshot.completions
  const serialized = JSON.parse(JSON.stringify(value.snapshot))
  validateSnapshot(serialized)
  await restoreBackup(serialized)
  expect(await db.assessments.get(value.assessmentId)).toEqual(value.snapshot.assessments.find(row => row.id === value.assessmentId))
  expect((await db.tasks.get(value.id))!.effectivePoints).toBe(30)
  expect(await db.completions.toArray()).toEqual(completions)
  expect(await db.ledger.toArray()).toEqual(ledger)
  expect(ledger.reduce((sum, row) => sum + row.delta, 0)).toBe(25)
})

it.each(['missing', 'foreign-owner', 'foreign-dataset', 'wrong-approver', 'future-revision', 'extra-authority', 'bad-digest', 'human-origin', 'non-manual-score'] as const)('%sの評価指示情報は復元前に拒否し、現在のデータを維持する', async tamper => {
  const value = await delegatedAssessment(), altered = JSON.parse(JSON.stringify(value.snapshot)), row = altered.assessments.find((item: Assessment) => item.id === value.assessmentId)
  if (tamper === 'missing') delete row.instruction
  if (tamper === 'foreign-owner') row.instruction.ownerId = 'different-owner'
  if (tamper === 'foreign-dataset') row.instruction.datasetId = uid()
  if (tamper === 'wrong-approver') row.instruction.approvedBy = 'another-person'
  if (tamper === 'future-revision') row.instruction.taskRevision = 1000
  if (tamper === 'extra-authority') row.instruction.approved = true
  if (tamper === 'bad-digest') row.instruction.digest = 'not-a-digest'
  if (tamper === 'human-origin') row.origin = 'human'
  if (tamper === 'non-manual-score') { row.score = emptyScore(); row.result = calculateScore(row.score) }
  await expect(restoreBackup(altered)).rejects.toThrow('評価履歴')
  expect(await db.tasks.toArray()).toEqual(value.snapshot.tasks)
  expect(await db.assessments.toArray()).toEqual(value.snapshot.assessments)
  expect(await db.ledger.toArray()).toEqual(value.snapshot.ledger)
})
