import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput, updateTask } from './commands'
import { emptyScore } from './domain'
import { applyChangeSet, approveChangeSetFromUI, clearChangeSetAuthority, prepareTaskChanges, prepareUndoFromAudits, type ChangeContext, type PreparedChangeSet } from './change-set'
import { latestCoachChange } from './change-history'
import { COACH_MEDIATED_REASONS, parseCoachAuthorityCommand } from './automation-policy'
import { replanReason } from './replan-candidates'
import { confirmTaskInstructionFromUI } from './task-user-instruction'

function humanClick() { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
let owner: ChangeContext, ids: string[]
beforeEach(async () => {
  clearChangeSetAuthority(); await db.delete(); await db.open()
  const settings = await ensureSettings()
  owner = { principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['title', 'notes', 'scheduledDate', 'dueDate', 'manualPoints'], sourceRevisions: [] }
  ids = []
  for (const title of ['報告書', '買い物']) ids.push(await createTask({ ...newTaskInput(), title, scheduledDate: '2026-10-01', dueDate: '2026-10-09', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } }))
})
const approveAndApply = async (prepared: PreparedChangeSet, key: string) => applyChangeSet(prepared, await approveChangeSetFromUI(prepared, owner, humanClick()), owner, key)
async function replanBoth() {
  const prepared = await prepareTaskChanges(ids.map(taskId => ({ taskId, expectedRevision: 1, patch: { scheduledDate: '2026-10-02' } })), { ...owner, allowedFields: ['scheduledDate'] }, replanReason)
  await approveAndApply(prepared, 'replan')
}

describe('N08 「さっきの変更を戻して」（コーチ経由の直前ChangeSetのinverse）', () => {
  it('コーチ画面で本人が選んだ2件の移動を一つの取り消し案にし、承認後に両方の予定日だけを戻す', async () => {
    expect(parseCoachAuthorityCommand('さっきの変更を戻して')).toEqual({ kind: 'undo-latest' })
    await replanBoth()
    const latest = latestCoachChange(await db.audits.toArray())
    expect(latest.map(fact => fact.taskId).sort()).toEqual([...ids].sort())
    const undo = await prepareUndoFromAudits(latest.map(fact => fact.auditId), owner)
    if (undo.status !== 'prepared') throw new Error(undo.status)
    expect(undo.prepared.changes.map(change => [change.fields, change.before.scheduledDate, change.after.scheduledDate])).toEqual([[['scheduledDate'], '2026-10-02', '2026-10-01'], [['scheduledDate'], '2026-10-02', '2026-10-01']])
    // Nothing changes before the owner's native click.
    expect((await db.tasks.bulkGet(ids)).map(task => task!.scheduledDate)).toEqual(['2026-10-02', '2026-10-02'])
    await expect(approveChangeSetFromUI(undo.prepared, owner, new Event('click'))).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' })
    await approveAndApply(undo.prepared, 'undo')
    const after = await db.tasks.bulkGet(ids)
    expect(after.map(task => [task!.scheduledDate, task!.dueDate, task!.effectivePoints])).toEqual([['2026-10-01', '2026-10-09', 25], ['2026-10-01', '2026-10-09', 25]])
    expect(await db.ledger.count()).toBe(0)
    // Both rows link to their own original audit, so the same change is not offered twice.
    const links = (await db.audits.toArray()).map(audit => audit.operation === 'changeset.update' ? JSON.parse(audit.detail) : null).filter(detail => detail?.undoOf).map(detail => detail.undoOf).sort()
    expect(links).toEqual(latest.map(fact => fact.auditId).sort())
    expect(await prepareUndoFromAudits(latest.map(fact => fact.auditId), owner)).toMatchObject({ status: 'already_undone' })
    expect(latestCoachChange(await db.audits.toArray()).map(fact => fact.changeSetId)).toEqual(latest.map(fact => fact.changeSetId))
  })
  it('2件のうち1件だけ個別に取り消した後は、残りの1件だけを取り消し案にする（取り消し済みとは言わない）', async () => {
    await replanBoth()
    const latest = latestCoachChange(await db.audits.toArray()), [first, second] = latest
    const single = await prepareUndoFromAudits([first.auditId], owner)
    if (single.status !== 'prepared') throw new Error(single.status)
    await approveAndApply(single.prepared, 'undo-one')
    const rest = await prepareUndoFromAudits(latest.map(fact => fact.auditId), owner)
    if (rest.status !== 'prepared') throw new Error(rest.status)
    expect(rest.prepared.changes.map(change => change.taskId)).toEqual([second.taskId])
    await approveAndApply(rest.prepared, 'undo-rest')
    expect((await db.tasks.bulkGet(ids)).map(task => task!.scheduledDate)).toEqual(['2026-10-01', '2026-10-01'])
    expect(await prepareUndoFromAudits(latest.map(fact => fact.auditId), owner)).toMatchObject({ status: 'already_undone' })
  })
  it('その後に本人が編集していれば上書きせず再差分を返す', async () => {
    await replanBoth()
    const latest = latestCoachChange(await db.audits.toArray()), second = (await db.tasks.get(ids[1]))!
    await updateTask(ids[1], second.revision, { ...second, scheduledDate: '2026-10-05' })
    const undo = await prepareUndoFromAudits(latest.map(fact => fact.auditId), owner)
    expect(undo).toMatchObject({ status: 'conflict', taskId: ids[1], rediff: [{ field: 'scheduledDate', recorded: '2026-10-02', current: '2026-10-05', restore: '2026-10-01' }] })
    expect((await db.tasks.get(ids[0]))!.scheduledDate).toBe('2026-10-02')
  })
  it('通常の本人編集・24時間より前の本人変更・別ChangeSetの混在は対象にしない', async () => {
    const ordinary = await prepareTaskChanges([{ taskId: ids[0], expectedRevision: 1, patch: { scheduledDate: '2026-10-04' } }], { ...owner, allowedFields: ['scheduledDate'] }, '本人の通常編集')
    await approveAndApply(ordinary, 'ordinary')
    expect(latestCoachChange(await db.audits.toArray())).toEqual([])
    const ordinaryAudit = (await db.audits.toArray()).find(audit => audit.operation === 'changeset.update')!
    await expect(prepareUndoFromAudits([ordinaryAudit.id], owner)).rejects.toMatchObject({ code: 'UNDO_UNAVAILABLE' })
    const consult = await prepareTaskChanges([{ taskId: ids[1], expectedRevision: 1, patch: { scheduledDate: '2026-10-02' } }], { ...owner, allowedFields: ['scheduledDate'] }, COACH_MEDIATED_REASONS[1])
    await approveAndApply(consult, 'consult')
    const latest = latestCoachChange(await db.audits.toArray())
    expect(latest.map(fact => fact.taskId)).toEqual([ids[1]])
    expect(latestCoachChange(await db.audits.toArray(), new Date(Date.parse(latest[0].at) + 25 * 3600000).toISOString())).toEqual([])
    await expect(prepareUndoFromAudits([latest[0].auditId, ordinaryAudit.id], owner)).rejects.toMatchObject({ code: 'UNDO_UNAVAILABLE' })
    await expect(prepareUndoFromAudits([latest[0].auditId], { ...owner, principal: { id: 'app-coach', kind: 'coach', model: 'm' } })).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' })
  })
  it('期限・ポイントを含む本人のコーチ相談の取り消しは新しい本人指示なしでは作らない', async () => {
    const requests = [{ taskId: ids[0], expectedRevision: 1, patch: { dueDate: '2026-10-20' } }]
    const instruction = await confirmTaskInstructionFromUI({ message: '期限を2026-10-20に変更', referenceDate: '2026-10-01', timezone: 'Asia/Tokyo', changes: requests }, owner, humanClick())
    const consult = await prepareTaskChanges(requests, { ...owner, allowedFields: ['dueDate'] }, COACH_MEDIATED_REASONS[1], instruction)
    await applyChangeSet(consult, await approveChangeSetFromUI(consult, owner, humanClick(), ['dueDate']), owner, 'due')
    const latest = latestCoachChange(await db.audits.toArray())
    await expect(prepareUndoFromAudits(latest.map(fact => fact.auditId), owner)).rejects.toMatchObject({ code: 'USER_INSTRUCTION_REQUIRED' })
    expect((await db.tasks.get(ids[0]))!.dueDate).toBe('2026-10-20')
  })
})
