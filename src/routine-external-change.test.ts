import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { calendarFixture } from './calendar-test-fixtures'
import { parseRoutineAssistAnswer, type RoutineAssistInput } from './routine-assist'
import { confirmRoutineInstructionFromUI } from './routine-instruction'
import { applyRoutineAssistConfigurationFromUI, clearRoutineAssistanceAuthority, prepareRoutineAssistConfiguration } from './routine-assist-save'
import { applyCalendarProposalFromUI, clearCalendarRulesAuthority, prepareCalendarGeneration } from './calendar-rules-save'
import { completeTask } from './commands'
import { changePolicyFor, type TaskChangeField } from './change-set'
import { presetRules } from './automation-policy'
import { previewAutomationPolicy, reduceAuthority, setAutomationPolicyFromUI } from './automation-control'
import { commandOutcome } from './command-bus'
import { routineBody } from './routine-external-change'
import { bridgeHarness, click, resetApp, type BridgeHarness } from './command-test-harness'
// Each case drives the real file bridge service and MCP client on a temp folder; allow for a loaded runner.
vi.setConfig({ testTimeout: 30000 })

// N03/N05 external series edit through the stdio MCP client and the inbox. No model or network is used.
beforeEach(async () => {
  clearRoutineAssistanceAuthority(); clearCalendarRulesAuthority()
  const settings = await resetApp('synthetic/model'), state = calendarFixture()
  state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId; state.activities = []; state.bindings[0].activityIds = []
  await db.calendarRules.put(state)
})
afterEach(() => { clearRoutineAssistanceAuthority(); clearCalendarRulesAuthority(); vi.restoreAllMocks(); vi.useRealTimers() })
function input(): RoutineAssistInput { return { message: '毎月第2営業日に勤怠提出を作って。10pt', referenceDate: '2026-10-01', targetRuleId: null, expectedRuleRevision: null, selection: { contextId: 'company', bindingId: 'self', calendarId: 'business', activityId: null, timezone: 'Asia/Tokyo', validFrom: '2026-01-01', validTo: '2026-12-31', time: '09:00', stepKind: 'task', durationMinutes: null, scheduledOffsetDays: 0, dueOffsetDays: null }, scope: { kind: 'all_uncompleted' } } }
async function ownerRoutine() {
  const selected = input(), candidate = parseRoutineAssistAnswer(JSON.stringify({ title_quote: '勤怠提出', recurrence_quote: '毎月第2営業日', trigger: { kind: 'monthly_business', ordinal: 2, from: 'start', time: '09:00' }, manual_points: 10, reason: '本人の周期' }), selected, (await db.calendarRules.get('main'))!)
  const prepared = await prepareRoutineAssistConfiguration(await confirmRoutineInstructionFromUI(selected, candidate, 'synthetic/model', click()))
  const ruleId = await applyRoutineAssistConfigurationFromUI(prepared, prepared.digest, click())
  await applyCalendarProposalFromUI(await prepareCalendarGeneration('2026-10-01', '2026-12-31'), click())
  const tasks = (await db.tasks.toArray()).sort((a, b) => a.scheduledDate!.localeCompare(b.scheduledDate!))
  await completeTask(tasks[0].id, tasks[0].revision)
  return { ruleId, tasks: (await db.tasks.toArray()).sort((a, b) => a.scheduledDate!.localeCompare(b.scheduledDate!)) }
}
const third = { kind: 'monthly_business', ordinal: 3, from: 'start', time: '09:00' }
async function scanOne(harness: BridgeHarness) {
  const scanned = await harness.controller.scanInbox(), entry = scanned.entries.find(item => item.state === 'awaiting_approval') as Extract<typeof scanned.entries[number], { state: 'awaiting_approval' }> | undefined
  return { scanned, entry }
}
async function setRoutineMode(mode: 'deny' | 'require_approval', extra = false) {
  const settings = (await db.settings.get('main'))!, policy = changePolicyFor(settings), owner = { principal: { id: settings.profileId, kind: 'human' as const }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: [] as TaskChangeField[], sourceRevisions: [] }
  const input = { preset: 'custom' as const, rules: presetRules('A1').map(rule => rule.operation === 'routine.change' ? { ...rule, mode } : extra && rule.operation === 'task.split' ? { ...rule, mode: 'deny' as const } : rule), allowedHours: {}, titleRule: 'require_approval' as const, bounds: policy.bounds, locks: policy.locks }
  await setAutomationPolicyFromUI(owner, click(), input, (await previewAutomationPolicy(input)).token)
}

describe('external series change through the common routine engine', () => {
  it('MCP this_and_future: owner confirms, setting saved alone, generation needs a second approval, completed occurrence and ledger kept', async () => {
    const { ruleId, tasks } = await ownerRoutine(), completed = await db.tasks.get(tasks[0].id), ledger = await db.ledger.toArray(), completions = await db.completions.toArray()
    const harness = await bridgeHarness({ taskIds: [], fields: ['title'], ruleIds: [ruleId] })
    try {
      expect(await harness.mcpTools()).toContain('michi_propose_routine_change')
      const view = await harness.mcpCall('michi_snapshot', {})
      expect(view.structuredContent!.routines).toEqual([expect.objectContaining({ id: ruleId, revision: expect.any(Number), title: '勤怠提出', trigger: expect.objectContaining({ kind: 'monthly_business', ordinal: 2 }) })])
      const revision = (view.structuredContent!.routines as { revision: number }[])[0].revision, commandId = crypto.randomUUID()
      const args = { commandId, snapshotId: harness.snapshotId(), ruleId, expectedRuleRevision: revision, scope: { kind: 'this_and_future', from_date: tasks[1].scheduledDate }, trigger: third }
      expect((await harness.mcpCall('michi_propose_routine_change', args)).isError).toBeFalsy()
      const { entry } = await scanOne(harness), prepared = await harness.controller.prepare(entry!.reference)
      expect(routineBody(prepared.command).stage).toBe('owner_values')
      await expect(harness.controller.applyFromUI(prepared, click())).rejects.toMatchObject({ code: 'USER_INSTRUCTION_REQUIRED' })
      await expect(harness.controller.confirmRoutineFromUI(prepared, new Event('click'))).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' })
      const review = await harness.controller.confirmRoutineFromUI(prepared, click()), body = routineBody(review.command)
      expect(body.stage).toBe('review'); if (body.stage !== 'review') return
      expect(body.assistance.instruction).toMatchObject({ basis: 'external_request', model: null })
      expect(body.assistance.configuration.preview.length).toBeGreaterThan(0)
      const before = await db.tasks.toArray()
      expect((await harness.controller.applyFromUI(review, click())).result?.state).toBe('applied')
      // The setting is saved; tasks do not change until the separate generation approval.
      expect(await db.tasks.toArray()).toEqual(before)
      const rule = (await db.calendarRules.get('main'))!.rules.find(item => item.id === ruleId)!
      expect(rule.revision).toBeGreaterThan(revision)
      const approvals = (await db.audits.toArray()).filter(audit => audit.operation === 'routine.assistance.approved').map(audit => JSON.parse(audit.detail))
      expect(approvals.find(item => item.origin === 'external_request')).toMatchObject({ origin: 'external_request', model: null, source: { entrance: 'mcp', basis: 'external_request', commandId, actorId: harness.status().registration!.client.id } })
      await applyCalendarProposalFromUI(await prepareCalendarGeneration('2026-10-01', '2026-12-31'), click())
      expect(await db.tasks.get(tasks[0].id)).toEqual(completed); expect(await db.ledger.toArray()).toEqual(ledger); expect(await db.completions.toArray()).toEqual(completions)
      const moved = (await db.tasks.toArray()).filter(task => task.status === 'open' && !task.deletedAt).map(task => task.scheduledDate)
      expect(moved.length).toBeGreaterThan(0); expect(moved).not.toContain(tasks[1].scheduledDate)
      // Replaying the same command ID yields no second configuration.
      expect(await harness.mcpCall('michi_propose_routine_change', args)).toMatchObject({ structuredContent: { replayed: true } })
      await harness.controller.scanInbox()
      expect((await db.audits.toArray()).filter(audit => audit.operation === 'routine.assistance.approved')).toHaveLength(approvals.length)
    } finally { await harness.close() }
  })
  it('stale rule revision is a conflict, a missing grant is denied, and title/points cannot be carried', async () => {
    const { ruleId, tasks } = await ownerRoutine(), harness = await bridgeHarness({ taskIds: [], fields: ['title'], ruleIds: [ruleId] })
    try {
      const view = await harness.mcpCall('michi_snapshot', {}), revision = (view.structuredContent!.routines as { revision: number }[])[0].revision
      const stale = await harness.mcpCall('michi_propose_routine_change', { commandId: crypto.randomUUID(), snapshotId: harness.snapshotId(), ruleId, expectedRuleRevision: revision + 1, scope: { kind: 'all_uncompleted' }, trigger: third })
      expect(stale).toMatchObject({ isError: true, content: [{ text: 'TARGET_OR_REVISION_INVALID' }] })
      const file = await harness.writeCommand({ type: 'routine.change', target_id: ruleId, expected_revision: revision + 1, payload: { scope: { kind: 'all_uncompleted' }, definition: { trigger: third } } })
      const scanned = await harness.controller.scanInbox()
      expect(scanned.entries.find(item => item.filename.startsWith(file.command_id))).toMatchObject({ state: 'rejected', error: 'REVISION_CONFLICT' })
      const titled = await harness.writeCommand({ type: 'routine.change', target_id: ruleId, expected_revision: revision, payload: { scope: { kind: 'all_uncompleted' }, definition: { trigger: third, title: '別名', manual_points: 99 } } })
      expect((await harness.controller.scanInbox()).entries.find(item => item.filename.startsWith(titled.command_id))).toMatchObject({ state: 'rejected', error: 'UNSUPPORTED_FIELD' })
    } finally { await harness.close() }
    const ungranted = await bridgeHarness({ taskIds: [tasks[1].id], fields: ['notes'] })
    try {
      expect(await ungranted.mcpTools()).not.toContain('michi_propose_routine_change')
      expect(await ungranted.mcpCall('michi_propose_routine_change', { commandId: crypto.randomUUID(), snapshotId: ungranted.snapshotId(), ruleId, expectedRuleRevision: 1, scope: { kind: 'all_uncompleted' }, trigger: third })).toMatchObject({ isError: true, content: [{ text: 'OPERATION_NOT_GRANTED' }] })
      const file = await ungranted.writeCommand({ type: 'routine.change', target_id: ruleId, expected_revision: 1, payload: { scope: { kind: 'all_uncompleted' }, definition: { trigger: third } } })
      const entry = (await ungranted.controller.scanInbox()).entries.find(item => item.filename.startsWith(file.command_id))!
      expect(entry).toMatchObject({ state: 'rejected' }); expect(commandOutcome({ code: (entry as { error: string }).error }).state).toBe('denied')
    } finally { await ungranted.close() }
  })
  it('AI OFF or a policy epoch bump after the owner check invalidates the change; routine.change=deny refuses it', async () => {
    const { ruleId } = await ownerRoutine()
    const run = async () => {
      const harness = await bridgeHarness({ taskIds: [], fields: ['title'], ruleIds: [ruleId] }), rule = (await db.calendarRules.get('main'))!.rules.find(item => item.id === ruleId)!
      await harness.writeCommand({ type: 'routine.change', target_id: ruleId, expected_revision: rule.revision, payload: { scope: { kind: 'all_uncompleted' }, definition: { trigger: third } } })
      const { entry } = await scanOne(harness), prepared = await harness.controller.prepare(entry!.reference)
      return { harness, review: await harness.controller.confirmRoutineFromUI(prepared, click()) }
    }
    const before = (await db.calendarRules.get('main'))!.revision
    const epoch = await run()
    try { await setRoutineMode('require_approval', true); expect(commandOutcome(await epoch.harness.controller.applyFromUI(epoch.review, click()).catch(error => error)).state).toMatch(/expired|rejected/) } finally { await epoch.harness.close() }
    const off = await run()
    try { await reduceAuthority('aiChanges', 'button'); expect(commandOutcome(await off.harness.controller.applyFromUI(off.review, click()).catch(error => error))).toMatchObject({ state: 'denied', code: 'CHANGES_STOPPED' }) } finally { await off.harness.close() }
    expect((await db.calendarRules.get('main'))!.revision).toBe(before)
  })
  it('with text and schedule denied but routine.change allowed, file and MCP reach the owner check while task.update on the same connection is CHANGES_STOPPED', async () => {
    const results: Record<string, unknown> = {}
    for (const entrance of ['file', 'mcp'] as const) {
      if (entrance === 'mcp') { await resetApp('synthetic/model'); const state = calendarFixture(), settings = (await db.settings.get('main'))!; state.ownerId = settings.profileId; state.datasetId = settings.datasetId; state.bindings[0].personId = settings.profileId; state.activities = []; state.bindings[0].activityIds = []; await db.calendarRules.put(state) }
      const { ruleId, tasks } = await ownerRoutine(), open = tasks.find(task => task.status === 'open')!
      const settings = (await db.settings.get('main'))!, policy = changePolicyFor(settings), owner = { principal: { id: settings.profileId, kind: 'human' as const }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: [] as TaskChangeField[], sourceRevisions: [] }
      const modes = { preset: 'custom' as const, rules: presetRules('A1').map(rule => rule.operation === 'task.text' || rule.operation === 'task.schedule' ? { ...rule, mode: 'deny' as const } : rule.operation === 'routine.change' ? { ...rule, mode: 'require_approval' as const } : rule), allowedHours: {}, titleRule: 'require_approval' as const, bounds: policy.bounds, locks: policy.locks }
      await setAutomationPolicyFromUI(owner, click(), modes, (await previewAutomationPolicy(modes)).token)
      const harness = await bridgeHarness({ taskIds: [open.id], fields: ['title', 'notes'], ruleIds: [ruleId] })
      try {
        const rule = (await db.calendarRules.get('main'))!.rules.find(item => item.id === ruleId)!, routineId = crypto.randomUUID(), updateId = crypto.randomUUID()
        if (entrance === 'file') { await harness.writeCommand({ command_id: routineId, type: 'routine.change', target_id: ruleId, expected_revision: rule.revision, payload: { scope: { kind: 'all_uncompleted' }, definition: { trigger: third } } }); await harness.writeCommand({ command_id: updateId, type: 'task.update', target_id: open.id, expected_revision: open.revision, payload: { notes: '外部の案' } }) }
        else { expect((await harness.mcpCall('michi_propose_routine_change', { commandId: routineId, snapshotId: harness.snapshotId(), ruleId, expectedRuleRevision: rule.revision, scope: { kind: 'all_uncompleted' }, trigger: third })).isError).toBeFalsy(); expect((await harness.mcpCall('michi_propose_update', { commandId: updateId, snapshotId: harness.snapshotId(), targetId: open.id, expectedRevision: open.revision, payload: { notes: '外部の案' } })).isError).toBeFalsy() }
        const scanned = await harness.controller.scanInbox(), reference = (id: string) => (scanned.entries.find(item => item.filename.startsWith(id) && item.state === 'awaiting_approval') as Extract<typeof scanned.entries[number], { state: 'awaiting_approval' }>).reference
        const update = commandOutcome(await harness.controller.prepare(reference(updateId)).catch(error => error))
        const prepared = await harness.controller.prepare(reference(routineId)), review = await harness.controller.confirmRoutineFromUI(prepared, click())
        results[entrance] = { update: { state: update.state, code: update.code }, stage: [routineBody(prepared.command).stage, routineBody(review.command).stage], applied: (await harness.controller.applyFromUI(review, click())).result?.state, signed: (({ state, code }) => ({ state, code }))((await harness.mcpCall('michi_command_result', { commandId: updateId })).structuredContent!) }
        expect((await db.tasks.get(open.id))!.notes).toBe(open.notes)
      } finally { await harness.close() }
    }
    expect(results.file).toMatchObject({ update: { state: 'denied', code: 'CHANGES_STOPPED' }, stage: ['owner_values', 'review'], applied: 'applied', signed: { state: 'denied', code: 'CHANGES_STOPPED' } })
    expect(results.mcp).toEqual(results.file)
  })
  it('routine.change=deny stops an external series request before any owner check', async () => {
    const { ruleId } = await ownerRoutine(); await setRoutineMode('deny')
    const harness = await bridgeHarness({ taskIds: [], fields: ['title'], ruleIds: [ruleId] })
    try {
      const rule = (await db.calendarRules.get('main'))!.rules.find(item => item.id === ruleId)!
      await harness.writeCommand({ type: 'routine.change', target_id: ruleId, expected_revision: rule.revision, payload: { scope: { kind: 'all_uncompleted' }, definition: { trigger: third } } })
      const { entry } = await scanOne(harness)
      expect(commandOutcome(await harness.controller.prepare(entry!.reference).catch(error => error))).toMatchObject({ state: 'denied', code: 'CHANGES_STOPPED' })
    } finally { await harness.close() }
  })
})
