import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { completeTask, createTask, newTaskInput, updateTask } from './commands'
import { emptyScore, uid, type Task } from './domain'
import { changePolicyFor, type TaskChangeField } from './change-set'
import { OPERATION_INFO, presetRules } from './automation-policy'
import { previewAutomationPolicy, reduceAuthority, setAutomationPolicyFromUI } from './automation-control'
import { parseCoachSplit, prepareCoachSplitRequest, splitRequestNeedsConfirmation } from './coach-task-change'
import { commandOutcome, pendingCommands, prepareCommand, submitCommand, uiCoachActor, type PreparedCommand } from './command-bus'
import { confirmSplitCommandFromUI, splitBody, type SplitChildDraft } from './task-split-change'
import { prepareTripBundle } from './trip-bundles'
import { applyTripBundle } from './trip-bundle-save'
import { bridgeHarness, click, outcomeOf, resetApp } from './command-test-harness'
import { captureSnapshot, restoreBackup } from './backup'
import { validateSnapshot } from './backup-validation'
// Each case drives the real file bridge service and MCP client on a temp folder; allow for a loaded runner.
vi.setConfig({ testTimeout: 30000 })

// N03 proxy split. Coach answers are fixed strings (synthetic transport); no model or network is used.
const message = '調査15ptと実装25ptに分けて'
const answer = JSON.stringify({ children: [{ title_quote: '調査', points: 15 }, { title_quote: '実装', points: 25 }], reason: '本人の指定どおり' })
beforeEach(async () => { await resetApp() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

async function parent(overrides: Partial<Task> = {}) { return createTask({ ...newTaskInput(), title: '40ptの作業', scheduledDate: '2026-10-05', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 }, ...overrides }) }
async function coachSplit(taskId: string, children: SplitChildDraft[], text = message): Promise<{ first: PreparedCommand; review: PreparedCommand | null; outcome: ReturnType<typeof commandOutcome> }> {
  const settings = (await db.settings.get('main'))!, task = (await db.tasks.get(taskId))!
  const first = await prepareCommand({ schema_version: '1', command_id: uid(), type: 'task.split', target_id: taskId, expected_revision: task.revision, payload: { children: children.map(child => ({ title: child.title, points: child.points })) }, basis: { kind: 'app_instruction' } }, uiCoachActor(settings, 'synthetic/coach-a'))
  if (!first.prepared) throw Object.assign(new Error(first.outcome.message), { code: first.outcome.code })
  const confirmed = await confirmSplitCommandFromUI(first.prepared, children, click(), text)
  return { first: first.prepared, review: confirmed.prepared, outcome: confirmed.outcome }
}
const proposed = (taskId: string) => { const proposal = parseCoachSplit(answer, { id: taskId, revision: 1 }, message); if (proposal.status !== 'proposal') throw new Error('expected proposal'); return proposal.children }
async function setSplitMode(mode: 'deny' | 'require_approval') {
  const settings = (await db.settings.get('main'))!, policy = changePolicyFor(settings), owner = { principal: { id: settings.profileId, kind: 'human' as const }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: [] as TaskChangeField[], sourceRevisions: [] }
  const input = { preset: 'custom' as const, rules: presetRules('A1').map(rule => rule.operation === 'task.split' ? { ...rule, mode } : rule), allowedHours: {}, titleRule: 'require_approval' as const, bounds: policy.bounds, locks: policy.locks }
  await setAutomationPolicyFromUI(owner, click(), input, (await previewAutomationPolicy(input)).token)
}
const ledgerTotal = async () => (await db.ledger.toArray()).reduce((sum, row) => sum + row.delta, 0)

describe('N03 coach split from the owner\'s words', () => {
  it('40pt → 調査15/実装25: preview only, native approval allocates, completing both adds exactly 40', async () => {
    const taskId = await parent(), children = proposed(taskId)
    expect(children).toEqual([{ title: '調査', points: 15, titleOrigin: 'owner_text', pointsOrigin: 'owner_text' }, { title: '実装', points: 25, titleOrigin: 'owner_text', pointsOrigin: 'owner_text' }])
    const { review } = await coachSplit(taskId, children)
    const body = splitBody(review!)
    expect(body.stage).toBe('review'); if (body.stage !== 'review') return
    expect(body.split).toMatchObject({ total: 40, parentScoreBefore: { manualPoints: 40 }, children: [{ title: '調査', points: 15 }, { title: '実装', points: 25 }] })
    // Preview only: nothing is written before the owner's native approval.
    expect(await db.tasks.count()).toBe(1); expect((await db.tasks.get(taskId))!.revision).toBe(1)
    expect(await submitCommand(review!, { event: click(), checkedProtectedFields: [], requestKey: 'k1' })).toMatchObject({ state: 'awaiting_approval', code: 'PROTECTED_FIELD_APPROVAL_REQUIRED' })
    expect(await submitCommand(review!, { event: new Event('click'), checkedProtectedFields: ['manualPoints'], requestKey: 'k1' })).toMatchObject({ state: 'awaiting_approval', code: 'HUMAN_APPROVAL_REQUIRED' })
    const applied = await submitCommand(review!, { event: click(), checkedProtectedFields: ['manualPoints'], requestKey: 'k1' })
    expect(applied).toMatchObject({ state: 'applied', code: null })
    const updated = (await db.tasks.get(taskId))!, kids = (await db.tasks.toArray()).filter(task => task.id !== taskId).sort((a, b) => a.score.manualPoints! - b.score.manualPoints!)
    expect(updated).toMatchObject({ score: { mode: 'manual', manualPoints: 0 }, effectivePoints: 0, revision: 2 })
    expect(kids.map(task => ({ title: task.title, score: task.score.mode, points: task.score.manualPoints, effective: task.effectivePoints }))).toEqual([{ title: '調査', score: 'allocated', points: 15, effective: 15 }, { title: '実装', score: 'allocated', points: 25, effective: 25 }])
    const assessments = await db.assessments.toArray()
    expect(assessments.filter(item => item.taskId === taskId)).toHaveLength(2)
    expect(assessments.filter(item => item.origin === 'user_instruction_via_agent').map(item => item.taskId).sort()).toEqual([taskId, ...kids.map(task => task.id)].sort())
    expect(assessments.find(item => item.taskId === kids[0].id)!.instruction).toMatchObject({ actorKind: 'coach', model: 'synthetic/coach-a', approvedBy: (await db.settings.get('main'))!.profileId })
    expect((await db.checklistItems.where('taskId').equals(taskId).toArray()).map(item => item.convertedTaskId).sort()).toEqual(kids.map(task => task.id).sort())
    const audit = JSON.parse((await db.audits.toArray()).find(item => item.operation === 'breakdown')!.detail)
    expect(audit).toMatchObject({ schema: 'command.audit/1', entrance: 'ui_coach', basis: 'app_instruction', principal: { kind: 'coach', model: 'synthetic/coach-a' }, decision: 'approved', origin: 'user_instruction_via_agent', operation: 'task.split', total: 40, before: { manualPoints: 40 }, after: { manualPoints: 0 } })
    expect(await db.ledger.count()).toBe(0)
    for (const kid of kids) await completeTask(kid.id, kid.revision)
    expect(await ledgerTotal()).toBe(40)
    expect(await submitCommand(review!, { event: click(), checkedProtectedFields: ['manualPoints'], requestKey: 'k1' })).toMatchObject({ state: 'rejected', code: 'UNVERIFIED_CHANGE_SET' })
    expect(await ledgerTotal()).toBe(40)
  })
  it('missing allocation waits for the owner; vague requests create nothing', async () => {
    const taskId = await parent(), task = (await db.tasks.get(taskId))!
    const partial = parseCoachSplit(JSON.stringify({ children: [{ title_quote: '調査', points: 15 }, { title_quote: '実装', points: null }], reason: '配分は一部のみ' }), task, '調査15ptと実装に分けて')
    expect(partial).toMatchObject({ status: 'proposal', children: [{ points: 15 }, { points: null, pointsOrigin: null }] })
    if (partial.status !== 'proposal') return
    const missing = await coachSplit(taskId, partial.children, '調査15ptと実装に分けて')
    expect(missing).toMatchObject({ review: null, outcome: { state: 'awaiting_approval', code: 'SPLIT_ALLOCATION_REQUIRED' } })
    const owner = await coachSplit(taskId, partial.children.map(child => child.points === null ? { ...child, points: 25, pointsOrigin: 'human' as const } : child), '調査15ptと実装に分けて')
    expect(owner.review).not.toBeNull()
    for (const vague of ['半分にして', 'いい感じに分けて']) {
      expect(splitRequestNeedsConfirmation(vague)).toBeTruthy()
      expect(parseCoachSplit(answer, task, vague)).toMatchObject({ status: 'needs_confirmation' })
      await expect(prepareCoachSplitRequest(task, vague, 'synthetic/coach-a')).rejects.toThrow()
    }
    expect(pendingCommands().filter(command => command.envelope.type === 'task.split' && splitBody(command).stage === 'review')).toHaveLength(1)
    expect(await db.tasks.count()).toBe(1)
  })
  it('rejects invented titles, wrong sums, completed or trip-allocated parents, stale, foreign, AI OFF, epoch, digest and DOM click', async () => {
    const taskId = await parent()
    expect(() => parseCoachSplit(JSON.stringify({ children: [{ title_quote: '調査', points: 15 }, { title_quote: 'テスト', points: 25 }], reason: 'x' }), { id: taskId, revision: 1 }, message)).toThrow(/本人の相談文にありません/)
    expect(parseCoachSplit(JSON.stringify({ children: [{ title_quote: '調査', points: 20 }, { title_quote: '実装', points: 20 }], reason: 'x' }), { id: taskId, revision: 1 }, message)).toMatchObject({ status: 'proposal', children: [{ points: null }, { points: null }] })
    expect((await coachSplit(taskId, [{ title: '調査', points: 15, titleOrigin: 'owner_text', pointsOrigin: 'owner_text' }, { title: '実装', points: 20, titleOrigin: 'owner_text', pointsOrigin: 'human' }])).outcome).toMatchObject({ state: 'rejected', code: 'SPLIT_INVALID' })
    const done = await parent({ title: '完了済み' }); await completeTask(done, 1)
    await expect(coachSplit(done, proposed(done))).rejects.toMatchObject({ code: 'SPLIT_NOT_ALLOWED' })
    const trip = await parent({ title: '外出に配分' }), other = await parent({ title: '同じ外出' })
    const bundle = await prepareTripBundle(await db.tasks.bulkGet([trip, other]) as Task[], { title: '共通外出', travelMinutes: 10, members: [trip, other].map(id => ({ taskId: id, attributes: { minutes: 15, difficulty: 0, uncertainty: 0, coordination: 0, physical: 0 } })) })
    await applyTripBundle(bundle, bundle.manualConfirmationIds)
    await expect(coachSplit(trip, proposed(trip))).rejects.toMatchObject({ code: 'SPLIT_NOT_ALLOWED' })
    // Stale revision between preview and approval.
    const stale = await coachSplit(taskId, proposed(taskId)), current = (await db.tasks.get(taskId))!
    await updateTask(taskId, current.revision, { ...current, notes: '本人が先に編集' })
    expect(await submitCommand(stale.review!, { event: click(), checkedProtectedFields: ['manualPoints'], requestKey: 'stale' })).toMatchObject({ state: 'conflict', code: 'CONFLICT' })
    // Foreign container.
    const settings = (await db.settings.get('main'))!, at = new Date().toISOString(), containerId = crypto.randomUUID()
    await db.containers.add({ id: containerId, parentId: null, kind: 'project', name: '共有', ownerId: settings.profileId, revision: 1, createdAt: at, updatedAt: at, deletedAt: null })
    const foreign = await parent({ containerId }); await db.containers.update(containerId, { ownerId: 'another-owner' })
    await expect(coachSplit(foreign, proposed(foreign))).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    // Digest substitution and a synthetic DOM click.
    const fresh = await parent({ title: '新しい40pt' }), ready = await coachSplit(fresh, proposed(fresh))
    expect(await submitCommand({ ...structuredClone(ready.review!), reason: '差し替え' } as PreparedCommand, { event: click(), checkedProtectedFields: ['manualPoints'], requestKey: 'swap' })).toMatchObject({ state: 'rejected', code: 'DIGEST_MISMATCH' })
    expect(await submitCommand(ready.review!, { event: new Event('click'), checkedProtectedFields: ['manualPoints'], requestKey: 'dom' })).toMatchObject({ state: 'awaiting_approval', code: 'HUMAN_APPROVAL_REQUIRED' })
    // Epoch change (split stays require_approval) then AI OFF.
    await setSplitMode('require_approval'); await setSplitMode('deny'); await setSplitMode('require_approval')
    expect(await submitCommand(ready.review!, { event: click(), checkedProtectedFields: ['manualPoints'], requestKey: 'epoch' })).toMatchObject({ state: 'expired', code: 'POLICY_CHANGED' })
    const again = await coachSplit(fresh, proposed(fresh))
    await reduceAuthority('aiChanges', 'button')
    expect(await submitCommand(again.review!, { event: click(), checkedProtectedFields: ['manualPoints'], requestKey: 'off' })).toMatchObject({ state: 'denied', code: 'CHANGES_STOPPED' })
    expect((await db.tasks.toArray()).filter(task => task.generationKey?.startsWith('breakdown:'))).toHaveLength(0)
    expect(await db.ledger.count()).toBe(1)
  })
  it('task.split can never be automatic and is denied when the operation is stopped', async () => {
    expect(OPERATION_INFO['task.split'].allowed).not.toContain('auto_within_bounds')
    const taskId = await parent(); await setSplitMode('deny')
    await expect(coachSplit(taskId, proposed(taskId))).rejects.toMatchObject({ code: 'CHANGES_STOPPED' })
  })
  it('an audit failure rolls back the parent, children, assessments, checklist and receipts', async () => {
    const taskId = await parent(), { review } = await coachSplit(taskId, proposed(taskId)), before = { tasks: await db.tasks.toArray(), assessments: await db.assessments.count(), checklist: await db.checklistItems.count(), commands: await db.commands.count() }
    const add = db.audits.add.bind(db.audits)
    vi.spyOn(db.audits, 'add').mockImplementation(((row: Parameters<typeof add>[0]) => row.operation === 'breakdown' ? Promise.reject(new Error('audit write failed')) : add(row)) as typeof db.audits.add)
    expect(await submitCommand(review!, { event: click(), checkedProtectedFields: ['manualPoints'], requestKey: 'fail' })).toMatchObject({ state: 'failed' })
    expect(await db.tasks.toArray()).toEqual(before.tasks)
    expect({ assessments: await db.assessments.count(), checklist: await db.checklistItems.count(), commands: await db.commands.count() }).toEqual({ assessments: before.assessments, checklist: before.checklist, commands: before.commands })
  })
})
describe('N03 split parity: S06, file inbox and MCP give the same card and the same result', () => {
  const project = async (taskId: string) => {
    const tasks = await db.tasks.toArray(), parentTask = tasks.find(task => task.id === taskId)!
    return { parent: { score: parentTask.score, effectivePoints: parentTask.effectivePoints, revision: parentTask.revision }, children: tasks.filter(task => task.id !== taskId).map(task => ({ title: task.title, score: task.score, effectivePoints: task.effectivePoints, status: task.status })).sort((a, b) => a.title.localeCompare(b.title)), origins: (await db.assessments.toArray()).filter(item => item.origin === 'user_instruction_via_agent').length, checklist: await db.checklistItems.count(), ledger: await db.ledger.count() }
  }
  it('applies the same 15/25 allocation through every entrance only after owner confirmation and approval', async () => {
    const states = []
    const values: SplitChildDraft[] = [{ title: '調査', points: 15, titleOrigin: 'agent_proposal', pointsOrigin: 'agent_proposal' }, { title: '実装', points: 25, titleOrigin: 'agent_proposal', pointsOrigin: 'agent_proposal' }]
    {
      const taskId = await parent(), { review } = await coachSplit(taskId, values)
      expect(await submitCommand(review!, { event: click(), checkedProtectedFields: ['manualPoints'], requestKey: 'ui' })).toMatchObject({ state: 'applied' }); states.push(await project(taskId))
    }
    for (const entrance of ['file', 'mcp'] as const) {
      await resetApp()
      const taskId = await parent(), harness = await bridgeHarness({ taskIds: [taskId], fields: ['title'], allowSplit: true })
      try {
        const commandId = crypto.randomUUID(), children = values.map(child => ({ title: child.title, points: child.points }))
        if (entrance === 'file') await harness.writeCommand({ command_id: commandId, type: 'task.split', target_id: taskId, expected_revision: 1, payload: { children } })
        else { expect(await harness.mcpTools()).toContain('michi_propose_split'); expect((await harness.mcpCall('michi_propose_split', { commandId, snapshotId: harness.snapshotId(), targetId: taskId, expectedRevision: 1, children })).isError).toBeFalsy() }
        const scanned = await harness.controller.scanInbox(), entry = scanned.entries.find(item => item.state === 'awaiting_approval') as Extract<typeof scanned.entries[number], { state: 'awaiting_approval' }>
        const prepared = await harness.controller.prepare(entry.reference)
        expect(splitBody(prepared.command).stage).toBe('owner_values')
        await expect(harness.controller.applyFromUI(prepared, click(), ['manualPoints'])).rejects.toMatchObject({ code: 'USER_INSTRUCTION_REQUIRED' })
        const confirmed = await harness.controller.confirmSplitFromUI(prepared, values, click(), '外部の分割案を本人が確認')
        await expect(harness.controller.applyFromUI(confirmed, click(), [])).rejects.toMatchObject({ code: 'PROTECTED_FIELD_APPROVAL_REQUIRED' })
        expect((await harness.controller.applyFromUI(confirmed, click(), ['manualPoints'])).result?.state).toBe('applied')
        states.push(await project(taskId))
      } finally { await harness.close() }
    }
    expect(states[1]).toEqual(states[0]); expect(states[2]).toEqual(states[0])
    expect(states[0]).toMatchObject({ parent: { score: { manualPoints: 0 }, effectivePoints: 0 }, origins: 3, checklist: 2, ledger: 0 })
  })
  it('after an S06, file or MCP split (and a re-split of an allocated child) backups still export and restore the allocated agent rows', async () => {
    const values: SplitChildDraft[] = [{ title: '調査', points: 15, titleOrigin: 'agent_proposal', pointsOrigin: 'agent_proposal' }, { title: '実装', points: 25, titleOrigin: 'agent_proposal', pointsOrigin: 'agent_proposal' }]
    for (const entrance of ['ui_coach', 'file', 'mcp'] as const) {
      await resetApp()
      const taskId = await parent()
      if (entrance === 'ui_coach') {
        const { review } = await coachSplit(taskId, values)
        expect(await submitCommand(review!, { event: click(), checkedProtectedFields: ['manualPoints'], requestKey: 'ui' })).toMatchObject({ state: 'applied' })
        // A re-split of an allocated child keeps the instruction origin on an 'allocated' parent row.
        const child = (await db.tasks.toArray()).find(task => task.title === '実装')!, again = await coachSplit(child.id, [{ ...values[0], title: '設計', points: 10 }, { ...values[1], title: '実装本体', points: 15 }])
        expect(await submitCommand(again.review!, { event: click(), checkedProtectedFields: ['manualPoints'], requestKey: 'ui-2' })).toMatchObject({ state: 'applied' })
        expect((await db.assessments.toArray()).some(item => item.taskId === child.id && item.origin === 'user_instruction_via_agent' && item.score.mode === 'allocated' && item.score.manualPoints === 0)).toBe(true)
      } else {
        const harness = await bridgeHarness({ taskIds: [taskId], fields: ['title'], allowSplit: true })
        try {
          const commandId = crypto.randomUUID(), children = values.map(child => ({ title: child.title, points: child.points }))
          if (entrance === 'file') await harness.writeCommand({ command_id: commandId, type: 'task.split', target_id: taskId, expected_revision: 1, payload: { children } })
          else expect((await harness.mcpCall('michi_propose_split', { commandId, snapshotId: harness.snapshotId(), targetId: taskId, expectedRevision: 1, children })).isError).toBeFalsy()
          const scanned = await harness.controller.scanInbox(), entry = scanned.entries.find(item => item.state === 'awaiting_approval') as Extract<typeof scanned.entries[number], { state: 'awaiting_approval' }>
          const confirmed = await harness.controller.confirmSplitFromUI(await harness.controller.prepare(entry.reference), values, click(), '外部の分割案を本人が確認')
          expect((await harness.controller.applyFromUI(confirmed, click(), ['manualPoints'])).result?.state).toBe('applied')
        } finally { await harness.close() }
      }
      const kid = (await db.tasks.toArray()).find(task => task.title === '調査')!
      await completeTask(kid.id, kid.revision)
      const agentRows = (await db.assessments.toArray()).filter(item => item.origin === 'user_instruction_via_agent' && item.score.mode === 'allocated')
      expect(agentRows.length).toBeGreaterThanOrEqual(2)
      const snapshot = await captureSnapshot()
      expect(() => validateSnapshot(JSON.parse(JSON.stringify(snapshot)))).not.toThrow()
      const before = { assessments: (await db.assessments.toArray()).sort((a, b) => a.id.localeCompare(b.id)), ledger: await ledgerTotal(), receipts: (await db.commands.toArray()).map(row => row.key).filter(key => key.startsWith('breakdown:')).sort() }
      // An allocated instruction row without its own split receipt is still rejected.
      const forged = structuredClone(snapshot), forgedTask = forged.tasks.find(task => task.id === kid.id)!
      forgedTask.generationKey = 'breakdown:unknown-split:0'
      expect(() => validateSnapshot(forged)).toThrow('本人指示による評価履歴が不正です')
      const unsplit = structuredClone(snapshot); unsplit.commands = unsplit.commands.filter(row => !row.key.startsWith('breakdown:'))
      expect(() => validateSnapshot(unsplit)).toThrow('本人指示による評価履歴が不正です')
      await restoreBackup(JSON.parse(JSON.stringify(snapshot)))
      expect({ assessments: (await db.assessments.toArray()).sort((a, b) => a.id.localeCompare(b.id)), ledger: await ledgerTotal(), receipts: (await db.commands.toArray()).map(row => row.key).filter(key => key.startsWith('breakdown:')).sort() }).toEqual(before)
      expect(before.ledger).toBe(15)
    }
  })
  it('with text and schedule denied but splitting allowed, every entrance reaches the owner split stage and task.update on the same connection is CHANGES_STOPPED', async () => {
    const denyEdits = async () => {
      const settings = (await db.settings.get('main'))!, policy = changePolicyFor(settings), owner = { principal: { id: settings.profileId, kind: 'human' as const }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: [] as TaskChangeField[], sourceRevisions: [] }
      const input = { preset: 'custom' as const, rules: presetRules('A1').map(rule => rule.operation === 'task.text' || rule.operation === 'task.schedule' ? { ...rule, mode: 'deny' as const } : rule.operation === 'task.split' ? { ...rule, mode: 'require_approval' as const } : rule), allowedHours: {}, titleRule: 'require_approval' as const, bounds: policy.bounds, locks: policy.locks }
      await setAutomationPolicyFromUI(owner, click(), input, (await previewAutomationPolicy(input)).token)
    }
    const values: SplitChildDraft[] = [{ title: '調査', points: 15, titleOrigin: 'agent_proposal', pointsOrigin: 'agent_proposal' }, { title: '実装', points: 25, titleOrigin: 'agent_proposal', pointsOrigin: 'agent_proposal' }]
    const results: Record<string, unknown> = {}
    {
      const taskId = await parent(); await denyEdits()
      const settings = (await db.settings.get('main'))!, first = await prepareCommand({ schema_version: '1', command_id: uid(), type: 'task.split', target_id: taskId, expected_revision: 1, payload: { children: values.map(child => ({ title: child.title, points: child.points })) }, basis: { kind: 'app_instruction' } }, uiCoachActor(settings, 'synthetic/coach-a'))
      const update = await prepareCommand({ schema_version: '1', command_id: uid(), type: 'task.update', target_id: taskId, expected_revision: 1, payload: { notes: 'コーチの案' }, basis: { kind: 'app_instruction' } }, uiCoachActor(settings, 'synthetic/coach-a'))
      const confirmed = await confirmSplitCommandFromUI(first.prepared!, values, click(), '外部の分割案を本人が確認')
      results.ui_coach = { split: { state: first.outcome.state, code: first.outcome.code }, stage: splitBody(confirmed.prepared!).stage, update: { state: update.outcome.state, code: update.outcome.code }, applied: (await submitCommand(confirmed.prepared!, { event: click(), checkedProtectedFields: ['manualPoints'], requestKey: 'ui' })).state }
    }
    for (const entrance of ['file', 'mcp'] as const) {
      await resetApp()
      const taskId = await parent(); await denyEdits()
      const harness = await bridgeHarness({ taskIds: [taskId], fields: ['title', 'notes'], allowSplit: true })
      try {
        const splitId = crypto.randomUUID(), updateId = crypto.randomUUID(), children = values.map(child => ({ title: child.title, points: child.points }))
        if (entrance === 'file') { await harness.writeCommand({ command_id: splitId, type: 'task.split', target_id: taskId, expected_revision: 1, payload: { children } }); await harness.writeCommand({ command_id: updateId, type: 'task.update', target_id: taskId, expected_revision: 1, payload: { notes: 'コーチの案' } }) }
        else { expect((await harness.mcpCall('michi_propose_split', { commandId: splitId, snapshotId: harness.snapshotId(), targetId: taskId, expectedRevision: 1, children })).isError).toBeFalsy(); expect((await harness.mcpCall('michi_propose_update', { commandId: updateId, snapshotId: harness.snapshotId(), targetId: taskId, expectedRevision: 1, payload: { notes: 'コーチの案' } })).isError).toBeFalsy() }
        const scanned = await harness.controller.scanInbox(), reference = (id: string) => (scanned.entries.find(item => item.filename.startsWith(id) && item.state === 'awaiting_approval') as Extract<typeof scanned.entries[number], { state: 'awaiting_approval' }>).reference
        const update = await outcomeOf(() => harness.controller.prepare(reference(updateId)))
        const prepared = await harness.controller.prepare(reference(splitId)), stage = splitBody(prepared.command).stage
        const confirmed = await harness.controller.confirmSplitFromUI(prepared, values, click(), '外部の分割案を本人が確認')
        results[entrance] = { split: { state: 'awaiting_approval', code: stage === 'owner_values' ? 'USER_INSTRUCTION_REQUIRED' : stage }, stage: splitBody(confirmed.command).stage, update: { state: update.state, code: update.code }, applied: (await harness.controller.applyFromUI(confirmed, click(), ['manualPoints'])).result?.state }
        expect(await harness.mcpCall('michi_command_result', { commandId: updateId })).toMatchObject({ isError: true, structuredContent: { state: 'denied', code: 'CHANGES_STOPPED' } })
        if (entrance === 'mcp') {
          // Queued entries are closed as a policy change, not as a stop, while the grant still carries an allowed operation.
          const queued = crypto.randomUUID(); await harness.refreshSnapshot()
          await harness.mcpCall('michi_propose_update', { commandId: queued, snapshotId: harness.snapshotId(), targetId: taskId, expectedRevision: 2, payload: { notes: '待機中' } })
          await harness.controller.scanInbox(); await harness.controller.closePending('CHANGES_STOPPED')
          expect(await harness.mcpCall('michi_command_result', { commandId: queued })).toMatchObject({ isError: true, structuredContent: { state: 'expired', code: 'POLICY_CHANGED' } })
        }
      } finally { await harness.close() }
    }
    expect(results.ui_coach).toEqual({ split: { state: 'awaiting_approval', code: 'USER_INSTRUCTION_REQUIRED' }, stage: 'review', update: { state: 'denied', code: 'CHANGES_STOPPED' }, applied: 'applied' })
    expect(results.file).toEqual(results.ui_coach); expect(results.mcp).toEqual(results.ui_coach)
  })
  it('the split tool is listed and accepted only when the owner granted splitting', async () => {
    const taskId = await parent(), harness = await bridgeHarness({ taskIds: [taskId], fields: ['title'] })
    try {
      expect(await harness.mcpTools()).not.toContain('michi_propose_split')
      expect(await harness.mcpCall('michi_propose_split', { commandId: crypto.randomUUID(), snapshotId: harness.snapshotId(), targetId: taskId, expectedRevision: 1, children: [{ title: '調査', points: 15 }, { title: '実装', points: 25 }] })).toMatchObject({ isError: true, content: [{ text: 'OPERATION_NOT_GRANTED' }] })
      await harness.writeCommand({ type: 'task.split', target_id: taskId, expected_revision: 1, payload: { children: [{ title: '調査', points: 15 }, { title: '実装', points: 25 }] } })
      const scanned = await harness.controller.scanInbox(), entry = scanned.entries.find(item => item.state === 'awaiting_approval') as Extract<typeof scanned.entries[number], { state: 'awaiting_approval' }> | undefined
      if (entry) await expect(harness.controller.prepare(entry.reference)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
      else expect(scanned.entries[0]).toMatchObject({ state: 'rejected' })
      expect(await db.tasks.count()).toBe(1)
    } finally { await harness.close() }
  })
})
