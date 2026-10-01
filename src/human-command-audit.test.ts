import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { bulkUpdateTasksAtomic, completeTask, correctCompletion, createTask, newTaskInput, restoreTask, setTaskFlag, trashTask, undoCompletion, updateTask } from './commands'
import { applyBreakdownProposal, suggestBreakdown } from './breakdown'
import { emptyScore } from './domain'
import { changeTrace } from './change-history'
import { resetApp } from './command-test-harness'

// K12-G3: owner direct edits stay self-authorized but leave the same structured audit shape as other entrances.
beforeEach(async () => { await resetApp() })
afterEach(() => { vi.restoreAllMocks() })
const detail = async (taskId: string, operation: string) => (await db.audits.where('taskId').equals(taskId).toArray()).filter(audit => audit.operation === operation).map(audit => JSON.parse(audit.detail))
const ledger = async () => (await db.ledger.toArray()).reduce((sum, row) => sum + row.delta, 0)
const manual = (points: number) => ({ ...emptyScore(), mode: 'manual' as const, manualPoints: points })

describe('structured human command audits', () => {
  it('update / bulk / flag / complete / correct / undo / re-complete / trash / restore record operator, entrance and before/after', async () => {
    const settings = (await db.settings.get('main'))!, id = await createTask({ ...newTaskInput(), title: '40ptの作業', notes: '元のメモ', scheduledDate: '2026-10-01', score: manual(40) })
    const task = (await db.tasks.get(id))!
    await updateTask(id, 1, { ...task, notes: '本人の新しいメモ', scheduledDate: '2026-10-03' }, 'edit-1')
    expect(await detail(id, 'update')).toEqual([expect.objectContaining({ schema: 'command.audit/1', entrance: 'ui_human', principal: { kind: 'human', id: settings.profileId }, decision: 'self', basis: 'app_instruction', commandKey: 'edit-1', revisionBefore: 1, revisionAfter: 2, fields: ['notes', 'scheduledDate'], before: { notes: '元のメモ', scheduledDate: '2026-10-01' }, after: { notes: '本人の新しいメモ', scheduledDate: '2026-10-03' } })])
    await bulkUpdateTasksAtomic([{ id, revision: 2 }], { importance: 3 }, 'bulk-1')
    expect((await detail(id, 'bulk_update'))[0]).toMatchObject({ fields: ['importance'], before: { importance: 1 }, after: { importance: 3 }, revisionBefore: 2, revisionAfter: 3, commandKey: 'bulk-1' })
    await setTaskFlag(id, 3, 'pinned', true, 'flag-1')
    expect((await detail(id, 'set_flag'))[0]).toMatchObject({ fields: ['pinned'], before: { pinned: false }, after: { pinned: true } })
    await completeTask(id, 4, 'done-1')
    expect((await detail(id, 'complete'))[0]).toMatchObject({ fields: ['completionPoints', 'status'], before: { status: 'open', completionPoints: null }, after: { status: 'completed', completionPoints: 40 } })
    expect(await ledger()).toBe(40)
    await correctCompletion(id, 35, '実際は35pt', 'fix-1')
    expect((await detail(id, 'correct_points'))[0]).toMatchObject({ before: { completionPoints: 40 }, after: { completionPoints: 35 }, extra: { reason: '実際は35pt' } })
    await undoCompletion(id, 5, 'undo-1')
    expect((await detail(id, 'undo'))[0]).toMatchObject({ before: { status: 'completed', completionPoints: 35 }, after: { status: 'open', completionPoints: null } })
    expect(await ledger()).toBe(0)
    // Owner invariant: 40 → corrected 35 → cancelled → normal re-complete keeps 35.
    await completeTask(id, 6, 'done-2')
    expect((await detail(id, 'complete')).map(item => item.after.completionPoints).sort()).toEqual([35, 40])
    expect(await ledger()).toBe(35)
    expect((await db.completions.toArray())[0]).toMatchObject({ originalPoints: 40, netPoints: 35 })
    const other = await createTask({ ...newTaskInput(), title: '片付ける作業' })
    await trashTask(other, 1, 'trash-1'); await restoreTask(other, 2, 'restore-1')
    expect((await detail(other, 'trash'))[0]).toMatchObject({ before: { deletedAt: null }, after: { deletedAt: expect.any(String) } })
    expect((await detail(other, 'restore_task'))[0]).toMatchObject({ before: { deletedAt: expect.any(String) }, after: { deletedAt: null } })
    // Receipts are unchanged: each command key still has its own receipt.
    for (const key of ['edit-1', 'bulk-1', 'flag-1', 'done-1', 'fix-1', 'undo-1', 'done-2', 'trash-1', 'restore-1']) expect(await db.commands.get(key)).toBeTruthy()
    const trace = changeTrace(await db.audits.toArray()).entries.filter(entry => entry.taskId === id)
    expect(trace.map(entry => entry.operation).sort()).toEqual(['bulk_update', 'complete', 'complete', 'correct_points', 'set_flag', 'undo', 'update'])
    expect(trace.every(entry => entry.entrance === 'ui_human' && entry.operator.kind === 'human' && entry.decision === 'self' && !entry.legacy)).toBe(true)
  })
  it('the wizard breakdown keeps its behaviour and writes a structured audit with the allocation', async () => {
    const id = await createTask({ ...newTaskInput(), title: '大きな作業', score: manual(30) }), task = (await db.tasks.get(id))!
    const proposal = suggestBreakdown(task, 'large'), ids = await applyBreakdownProposal(proposal)
    expect(ids).toHaveLength(proposal.steps.length)
    const audit = (await detail(id, 'breakdown'))[0]
    expect(audit).toMatchObject({ schema: 'command.audit/1', entrance: 'ui_human', decision: 'self', operation: 'breakdown', commandKey: `breakdown:${proposal.id}`, before: { manualPoints: 30, children: [] }, after: { manualPoints: 0, children: proposal.steps.map((step, index) => ({ taskId: ids[index], title: step.title, points: step.points })) }, extra: { splitId: proposal.id, total: 30 } })
    expect((await db.assessments.toArray()).every(item => item.origin === 'human')).toBe(true)
    expect(await applyBreakdownProposal(proposal)).toEqual(ids)
  })
  it('an audit write failure rolls back the edit, the assessment and the receipt', async () => {
    const id = await createTask({ ...newTaskInput(), title: '25ptの作業', score: manual(25) }), task = (await db.tasks.get(id))!, before = { tasks: await db.tasks.toArray(), assessments: await db.assessments.count(), commands: await db.commands.count(), ledger: await db.ledger.count() }
    const add = db.audits.add.bind(db.audits)
    vi.spyOn(db.audits, 'add').mockImplementation(((row: Parameters<typeof add>[0]) => ['update', 'complete'].includes(row.operation) ? Promise.reject(new Error('audit write failed')) : add(row)) as typeof db.audits.add)
    await expect(updateTask(id, 1, { ...task, score: manual(30) }, 'edit-fail')).rejects.toThrow('audit write failed')
    await expect(completeTask(id, 1, 'done-fail')).rejects.toThrow('audit write failed')
    expect(await db.tasks.toArray()).toEqual(before.tasks)
    expect({ assessments: await db.assessments.count(), commands: await db.commands.count(), ledger: await db.ledger.count() }).toEqual({ assessments: before.assessments, commands: before.commands, ledger: before.ledger })
    expect(await db.completions.count()).toBe(0)
  })
  it('long values are bounded and the detail stays a string for old and new backups', async () => {
    const id = await createTask({ ...newTaskInput(), title: '長いメモ', notes: '' }), task = (await db.tasks.get(id))!
    await updateTask(id, 1, { ...task, notes: 'あ'.repeat(5000) })
    const row = (await db.audits.where('taskId').equals(id).toArray()).find(audit => audit.operation === 'update')!
    expect(typeof row.detail).toBe('string'); expect(row.detail.length).toBeLessThan(4000)
    expect(JSON.parse(row.detail).after.notes).toMatch(/…（5000文字）$/)
  })
})
