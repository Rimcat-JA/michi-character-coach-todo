import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { completeTask, createTask, newTaskInput, updateTask } from './commands'
import { emptyScore } from './domain'
import { applyChangeSet, approveChangeSetFromUI, clearChangeSetAuthority, prepareTaskChanges, prepareUndoFromAudit, type ChangeContext, type PreparedChangeSet, type TaskChangeField } from './change-set'
import { confirmTaskInstructionFromUI } from './task-user-instruction'
import { presetRules } from './automation-policy'
import { previewAutomationPolicy, setAutomationPolicyFromUI } from './automation-control'
import { changePolicyFor } from './change-set'
import { agentChangeHistory } from './change-history'

function humanClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
const all: TaskChangeField[] = ['title', 'notes', 'scheduledDate', 'dueDate', 'manualPoints']
let owner: ChangeContext, coach: ChangeContext, taskId: string
beforeEach(async () => {
  clearChangeSetAuthority(); await db.delete(); await db.open()
  const settings = await ensureSettings(); await db.settings.update('main', { aiEnabled: true })
  owner = { ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: all, sourceRevisions: [], principal: { id: settings.profileId, kind: 'human' } }
  coach = { ...owner, principal: { id: 'app-coach', kind: 'coach', model: 'model/A' } }
  const current = changePolicyFor((await db.settings.get('main'))!), next = { preset: 'A2' as const, rules: presetRules('A2'), allowedHours: {}, titleRule: 'require_approval' as const, bounds: current.bounds, locks: current.locks }
  await setAutomationPolicyFromUI(owner, humanClick(), next, (await previewAutomationPolicy(next)).token)
  taskId = await createTask({ ...newTaskInput(), title: '自動で動いた予定', notes: '元のメモ', scheduledDate: '2026-10-01', dueDate: '2026-10-09', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
})
async function autoMove() {
  const prepared = await prepareTaskChanges([{ taskId, expectedRevision: 1, patch: { scheduledDate: '2026-10-03' } }], coach)
  await applyChangeSet(prepared, null, coach, 'auto-move')
  return agentChangeHistory(await db.audits.toArray())[0]
}
const approveAndApply = async (prepared: PreparedChangeSet, key: string, fields: TaskChangeField[] = []) => applyChangeSet(prepared, await approveChangeSetFromUI(prepared, owner, humanClick(), fields), owner, key)

describe('N09 undo of automatic/approved agent changes', () => {
  it('restores the auto-moved date as a new owner-approved revision linked to the original audit, without touching completions or the ledger', async () => {
    const other = await createTask({ ...newTaskInput(), title: '完了済み', score: { ...emptyScore(), mode: 'manual', manualPoints: 35 } }); await completeTask(other, 1)
    const original = await autoMove(), ledger = await db.ledger.toArray(), completions = await db.completions.toArray()
    expect(original).toMatchObject({ decision: 'auto', fields: ['scheduledDate'] })
    await expect(prepareUndoFromAudit(original.auditId, coach)).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' })
    const undo = await prepareUndoFromAudit(original.auditId, owner)
    if (undo.status !== 'prepared') throw new Error(undo.status)
    expect(undo.prepared.principal.kind).toBe('human'); expect(undo.prepared.changes[0]).toMatchObject({ baseRevision: 2, before: { scheduledDate: '2026-10-03' }, after: { scheduledDate: '2026-10-01' } })
    await expect(applyChangeSet(undo.prepared, null, owner, 'no-click')).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' })
    await approveAndApply(undo.prepared, 'undo')
    expect(await db.tasks.get(taskId)).toMatchObject({ scheduledDate: '2026-10-01', dueDate: '2026-10-09', effectivePoints: 40, revision: 3 })
    const link = (await db.audits.toArray()).map(audit => audit.operation === 'changeset.update' ? JSON.parse(audit.detail) : null).find(detail => detail?.undoOf)
    expect(link).toMatchObject({ undoOf: original.auditId, principal: { kind: 'human' }, decision: 'approved' })
    expect(await db.ledger.toArray()).toEqual(ledger); expect(await db.completions.toArray()).toEqual(completions)
    expect(await prepareUndoFromAudit(original.auditId, owner)).toEqual({ status: 'already_undone', auditId: original.auditId })
    expect(await db.tasks.get(taskId)).toMatchObject({ scheduledDate: '2026-10-01', revision: 3 })
  })
  it('shows a re-diff instead of overwriting after an intervening edit', async () => {
    const original = await autoMove(), task = (await db.tasks.get(taskId))!
    await updateTask(taskId, task.revision, { ...task, scheduledDate: '2026-10-05' })
    const undo = await prepareUndoFromAudit(original.auditId, owner)
    expect(undo).toEqual({ status: 'conflict', auditId: original.auditId, taskId, rediff: [{ field: 'scheduledDate', recorded: '2026-10-03', current: '2026-10-05', restore: '2026-10-01' }] })
    expect((await db.tasks.get(taskId))?.scheduledDate).toBe('2026-10-05')
  })
  it('requires a new owner instruction to undo an approved agent score change and keeps the assessment history', async () => {
    const requests = [{ taskId, expectedRevision: 1, patch: { manualPoints: 30 } }]
    const instruction = await confirmTaskInstructionFromUI({ message: '40ptを30ptへ', referenceDate: '2026-10-01', timezone: 'Asia/Tokyo', changes: requests }, owner, humanClick())
    const prepared = await prepareTaskChanges(requests, coach, '本人指示による点数変更', instruction)
    await applyChangeSet(prepared, await approveChangeSetFromUI(prepared, owner, humanClick(), ['manualPoints']), coach, 'points')
    const original = agentChangeHistory(await db.audits.toArray())[0], assessments = await db.assessments.count()
    expect(original).toMatchObject({ decision: 'approved', fields: ['manualPoints'] })
    await expect(prepareUndoFromAudit(original.auditId, owner)).rejects.toMatchObject({ code: 'USER_INSTRUCTION_REQUIRED' })
    const undoRequests = [{ taskId, expectedRevision: 2, patch: { manualPoints: 40 } }]
    const again = await confirmTaskInstructionFromUI({ message: '30ptを40ptへ戻す', referenceDate: '2026-10-01', timezone: 'Asia/Tokyo', changes: undoRequests }, owner, humanClick())
    const undo = await prepareUndoFromAudit(original.auditId, owner, again)
    if (undo.status !== 'prepared') throw new Error(undo.status)
    await approveAndApply(undo.prepared, 'undo-points', ['manualPoints'])
    expect(await db.tasks.get(taskId)).toMatchObject({ effectivePoints: 40, revision: 3 }); expect(await db.assessments.count()).toBe(assessments + 1); expect(await db.ledger.count()).toBe(0)
  })
  it('undoing an approved deadline change also needs a new owner instruction; the date is never guessed back', async () => {
    const requests = [{ taskId, expectedRevision: 1, patch: { dueDate: '2026-10-12' } }]
    const instruction = await confirmTaskInstructionFromUI({ message: '締め切りを12日に', referenceDate: '2026-10-01', timezone: 'Asia/Tokyo', changes: requests }, owner, humanClick())
    const prepared = await prepareTaskChanges(requests, coach, '本人指示による締め切り変更', instruction)
    await applyChangeSet(prepared, await approveChangeSetFromUI(prepared, owner, humanClick(), ['dueDate']), coach, 'deadline')
    const original = agentChangeHistory(await db.audits.toArray())[0]
    await expect(prepareUndoFromAudit(original.auditId, owner)).rejects.toMatchObject({ code: 'USER_INSTRUCTION_REQUIRED', message: expect.stringContaining('締め切り') })
    expect(await db.tasks.get(taskId)).toMatchObject({ dueDate: '2026-10-12', revision: 2 })
  })
})
