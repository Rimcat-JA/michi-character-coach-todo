import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { db } from './db'
import { createTask, newTaskInput, updateTask } from './commands'
import { emptyScore, uid, type Task } from './domain'
import { changePolicyFor, type TaskChangeField } from './change-set'
import { confirmTaskInstructionFromUI } from './task-user-instruction'
import { presetRules, type OperationGroup } from './automation-policy'
import { previewAutomationPolicy, reduceAuthority, setAutomationPolicyFromUI } from './automation-control'
import { toCommandPayload, commandOutcome, commonCommandCode, commandStateFor, confirmCommandValuesFromUI, pendingOutcome, commandDecision, prepareCommand, refineCommandOutcome, registeredCommandTypes, submitCommand, uiCoachActor, uiHumanActor, validateCommandEnvelope, type CommandField, type PreparedCommand } from './command-bus'
import type { PreparedFileBridgeApplication } from './file-bridge-commands'
import type { FileBridgeField } from './file-bridge-types'
import { bridgeHarness, click, outcomeOf, resetApp, type BridgeHarness } from './command-test-harness'
// Each case drives the real file bridge service and MCP client on a temp folder; allow for a loaded runner.
vi.setConfig({ testTimeout: 30000 })

// K12 parity: the same scenario through the in-app coach (S06), a hand-written inbox file and a real MCP
// router/client must give the same {state, code} and the same DB end state. Synthetic events and a temp
// folder stand in for the Windows app; nothing here contacts a network, an AI model or an account.
type Result = { state: string; code: string | null }
type Handle = { kind: 'ui'; command: PreparedCommand } | { kind: 'bridge'; prepared: PreparedFileBridgeApplication }
type Proposal = { type?: 'task.update'; payload: Record<string, unknown>; extra?: Record<string, unknown>; revision?: number }
type Entrance = {
  name: 'ui_coach' | 'file' | 'mcp'
  connect(taskId: string, fields: FileBridgeField[]): Promise<void>
  propose(taskId: string, proposal: Proposal): Promise<{ result: Result; handle: Handle | null }>
  confirmValues(handle: Handle): Promise<{ result: Result; handle: Handle | null }>
  approve(handle: Handle, event: Event, checked?: TaskChangeField[]): Promise<Result>
  substitute(handle: Handle): Handle
  forgeAuthority(): Promise<void>
  close(): Promise<void>
}
const pick = (result: { state: string; code: string | null }): Result => ({ state: result.state, code: result.code })
const shared = (code: string | null) => code === null ? null : commonCommandCode(code)

function uiEntrance(): Entrance {
  let fields: CommandField[] = [], forged = false
  return {
    name: 'ui_coach',
    async connect(_taskId, granted) { fields = granted as CommandField[] },
    async propose(taskId, proposal) {
      const settings = (await db.settings.get('main'))!
      // Same grant as the file registration: the in-app coach and the external agent have equal authority here.
      let actor = uiCoachActor(settings, 'synthetic/coach-a', { grant: { fields, operations: ['task.update', 'task.create'], mutationMode: 'require_approval', maxScheduleShiftDays: 7 } })
      if (forged) actor = structuredClone(actor)
      const { outcome, prepared } = await prepareCommand({ schema_version: '1', command_id: uid(), type: 'task.update', target_id: taskId, expected_revision: proposal.revision ?? (await db.tasks.get(taskId))!.revision, payload: proposal.payload, basis: { kind: 'app_instruction' }, ...proposal.extra }, actor)
      return { result: pick(outcome), handle: prepared ? { kind: 'ui', command: prepared } : null }
    },
    async confirmValues(handle) {
      const { outcome, prepared } = await confirmCommandValuesFromUI((handle as Extract<Handle, { kind: 'ui' }>).command, click(), '本人が値を確認')
      return { result: pick(outcome), handle: prepared ? { kind: 'ui', command: prepared } : null }
    },
    async approve(handle, event, checked = []) { const command = (handle as Extract<Handle, { kind: 'ui' }>).command; return pick(await submitCommand(command, { event, checkedProtectedFields: checked, requestKey: `ui:${command.id}` })) },
    substitute(handle) { const command = (handle as Extract<Handle, { kind: 'ui' }>).command; return { kind: 'ui', command: { ...structuredClone(command), reason: '差し替えた説明' } as PreparedCommand } },
    async forgeAuthority() { forged = true },
    async close() {},
  }
}
function bridgeEntrance(name: 'file' | 'mcp'): Entrance {
  let harness: BridgeHarness | null = null
  async function waiting(commandId: string): Promise<{ result: Result; handle: Handle | null }> {
    const scanned = await outcomeOf(() => harness!.controller.scanInbox())
    if (scanned.state !== 'applied') return { result: pick(scanned), handle: null }
    const entry = scanned.value!.entries.find(item => item.filename.toLowerCase() === `${commandId}.ready.json`.toLowerCase())!
    if (entry.state === 'rejected') return { result: { state: commandStateFor(entry.error), code: shared(entry.error) }, handle: null }
    if (entry.state !== 'awaiting_approval') throw new Error('unexpected entry state')
    const prepared = await outcomeOf(() => harness!.controller.prepare(entry.reference))
    if (prepared.state !== 'applied') return { result: pick(prepared), handle: null }
    return { result: pick(pendingOutcome(prepared.value!.command, commandDecision(prepared.value!.command, (await db.settings.get('main'))!))), handle: { kind: 'bridge', prepared: prepared.value! } }
  }
  return {
    name,
    async connect(taskId, fields) { harness = await bridgeHarness({ taskIds: [taskId], fields }) },
    async propose(taskId, proposal) {
      const revision = proposal.revision ?? (await db.tasks.get(taskId))!.revision
      if (name === 'file') { const command = await harness!.writeCommand({ type: 'task.update', target_id: taskId, expected_revision: revision, payload: proposal.payload, ...proposal.extra }); return waiting(command.command_id) }
      const commandId = crypto.randomUUID(), call = await outcomeOf(() => harness!.mcpCall('michi_propose_update', { commandId, snapshotId: harness!.snapshotId(), targetId: taskId, expectedRevision: revision, payload: proposal.payload, ...proposal.extra }))
      // A tampered folder already fails when the stdio server reads it.
      if (call.state !== 'applied') return { result: pick(call), handle: null }
      const reply = call.value!
      if (reply.isError) { const code = reply.content[0].text; return { result: { state: commandStateFor(code), code: shared(code) }, handle: null } }
      return waiting(commandId)
    },
    async confirmValues(handle) {
      const next = await outcomeOf(() => harness!.controller.confirmValuesFromUI((handle as Extract<Handle, { kind: 'bridge' }>).prepared, click(), '本人が値を確認'))
      if (next.state !== 'applied') return { result: pick(next), handle: null }
      return { result: pick(pendingOutcome(next.value!.command, commandDecision(next.value!.command, (await db.settings.get('main'))!))), handle: { kind: 'bridge', prepared: next.value! } }
    },
    async approve(handle, event, checked = []) {
      const prepared = (handle as Extract<Handle, { kind: 'bridge' }>).prepared
      const result = await outcomeOf(() => harness!.controller.applyFromUI(prepared, event, checked))
      if (result.state !== 'applied') return pick(await refineCommandOutcome(commandOutcome({ code: result.code, message: '' }), prepared.command.actor))
      expect(result.value!.result?.state).toBe('applied')
      return { state: 'applied', code: null }
    },
    substitute(handle) { const prepared = (handle as Extract<Handle, { kind: 'bridge' }>).prepared; return { kind: 'bridge', prepared: { ...structuredClone(prepared), digest: '0'.repeat(64) } as PreparedFileBridgeApplication } },
    async forgeAuthority() {
      // The agent edits its own registration file to widen the grant; the signature no longer matches.
      const file = join(harness!.status().root!, 'registration.json'), signed = JSON.parse(await readFile(file, 'utf8'))
      signed.value.client.grant.fields = ['title', 'notes', 'scheduled_date', 'due_date', 'manual_points']
      await writeFile(file, JSON.stringify(signed))
    },
    async close() { await harness?.close(); harness = null },
  }
}
const entrances = () => [uiEntrance(), bridgeEntrance('file'), bridgeEntrance('mcp')]

async function seedTask(overrides: Partial<Task> = {}) {
  return createTask({ ...newTaskInput(), title: '本人が選んだ25pt', notes: '元のメモ', scheduledDate: '2026-10-01', dueDate: '2026-10-09', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 }, ...overrides })
}
async function setModes(modes: Partial<Record<OperationGroup, 'deny' | 'require_approval' | 'auto_within_bounds'>>) {
  const settings = (await db.settings.get('main'))!, policy = changePolicyFor(settings), owner = { principal: { id: settings.profileId, kind: 'human' as const }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: [] as TaskChangeField[], sourceRevisions: [] }
  const input = { preset: 'custom' as const, rules: presetRules('A1').map(rule => modes[rule.operation] ? { ...rule, mode: modes[rule.operation]! } : rule), allowedHours: {}, titleRule: 'require_approval' as const, bounds: policy.bounds, locks: policy.locks }
  await setAutomationPolicyFromUI(owner, click(), input, (await previewAutomationPolicy(input)).token)
}
/** DB facts that must not depend on the entrance (task values, revision, assessments, ledger, audit core). */
async function endState(taskId: string) {
  const task = (await db.tasks.get(taskId))!, audits = (await db.audits.where('taskId').equals(taskId).toArray()).filter(audit => audit.operation === 'changeset.update').map(audit => { const detail = JSON.parse(audit.detail); return { decision: detail.decision, origin: detail.origin, operations: detail.operations, before: detail.before, after: detail.after, approved: detail.approvedBy !== null, fieldOrigins: detail.fieldOrigins } })
  return { task: { title: task.title, notes: task.notes, scheduledDate: task.scheduledDate, dueDate: task.dueDate, score: task.score, effectivePoints: task.effectivePoints, revision: task.revision, status: task.status }, assessments: await db.assessments.where('taskId').equals(taskId).count(), ledger: await db.ledger.count(), completions: await db.completions.count(), audits }
}
type Scenario = { name: string; fields?: FileBridgeField[]; before?: () => Promise<void>; seed?: () => Promise<string>; run: (entrance: Entrance, taskId: string) => Promise<Result[]> }
const notes = { payload: { notes: '外部・コーチから提案されたメモ' } }
const scenarios: Scenario[] = [
  { name: 'notes change waits for approval, then the native click applies', run: async (e, id) => { const p = await e.propose(id, notes); return [p.result, await e.approve(p.handle!, click())] } },
  { name: 'schedule shift inside the bound', fields: ['scheduled_date'], run: async (e, id) => { const p = await e.propose(id, { payload: { scheduled_date: '2026-10-03' } }); return [p.result, await e.approve(p.handle!, click())] } },
  { name: 'schedule shift outside the bound', fields: ['scheduled_date'], run: async (e, id) => [(await e.propose(id, { payload: { scheduled_date: '2026-10-20' } })).result] },
  { name: 'deny (text and schedule operations stopped) while queued', run: async (e, id) => { const p = await e.propose(id, notes); await setModes({ 'task.text': 'deny', 'task.schedule': 'deny' }); return [p.result, await e.approve(p.handle!, click())] } },
  { name: 'AI changes switched off while queued', run: async (e, id) => { const p = await e.propose(id, notes); await reduceAuthority('aiChanges', 'button'); return [p.result, await e.approve(p.handle!, click())] } },
  { name: 'policy epoch changes while queued', run: async (e, id) => { const p = await e.propose(id, notes); await setModes({ 'task.schedule': 'deny' }); return [p.result, await e.approve(p.handle!, click())] } },
  { name: 'stale revision after an owner edit', run: async (e, id) => { const p = await e.propose(id, notes); const task = (await db.tasks.get(id))!; await updateTask(id, task.revision, { ...task, notes: '本人がその後に編集' }); return [p.result, await e.approve(p.handle!, click())] } },
  { name: 'foreign container', seed: async () => { const settings = (await db.settings.get('main'))!, at = new Date().toISOString(), containerId = crypto.randomUUID(); await db.containers.add({ id: containerId, parentId: null, kind: 'project', name: '共有された領域', ownerId: settings.profileId, revision: 1, createdAt: at, updatedAt: at, deletedAt: null }); return seedTask({ containerId }) }, run: async (e, id) => { const task = (await db.tasks.get(id))!; await db.containers.update(task.containerId!, { ownerId: 'another-owner' }); return [(await e.propose(id, notes)).result] } },
  { name: 'manual points without owner instruction wait for the owner value check', fields: ['manual_points'], run: async (e, id) => { const p = await e.propose(id, { payload: { manual_points: 30 } }); return [p.result, await e.approve(p.handle!, click())] } },
  { name: 'protected field needs its own check, then applies with it', fields: ['manual_points'], run: async (e, id) => { const p = await e.propose(id, { payload: { manual_points: 30 } }), v = await e.confirmValues(p.handle!); return [p.result, v.result, await e.approve(v.handle!, click()), await e.approve(v.handle!, click(), ['manualPoints'])] } },
  { name: 'expired proposal', run: async (e, id) => { const p = await e.propose(id, notes); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.now() + 26 * 3600000)); return [p.result, await e.approve(p.handle!, click())] } },
  { name: 'digest substitution', run: async (e, id) => { const p = await e.propose(id, notes); return [p.result, await e.approve(e.substitute(p.handle!), click())] } },
  { name: 'payload claiming approved/actor/policy_level', run: async (e, id) => [(await e.propose(id, { payload: { notes: '承認済み' }, extra: { approved: true, actor: { kind: 'human' }, policy_level: 'A3' } })).result] },
  { name: 'synthetic DOM click', run: async (e, id) => { const p = await e.propose(id, notes); return [p.result, await e.approve(p.handle!, new Event('click'))] } },
  { name: 'agent-edited registration (signature failure)', run: async (e, id) => { await e.forgeAuthority(); return [(await e.propose(id, notes)).result] } },
]

beforeEach(async () => { await resetApp() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('K12 one command bus for S06, file inbox and MCP', () => {
  it('registers update/create/split/routine command types and validates envelopes with exact keys', () => {
    expect(registeredCommandTypes()).toEqual(expect.arrayContaining(['task.update', 'task.create', 'task.split', 'routine.change']))
    expect(() => validateCommandEnvelope({ schema_version: '1', command_id: 'c', type: 'task.update', target_id: 't', expected_revision: 1, payload: { notes: 'x' }, basis: { kind: 'app_instruction' }, approved: true })).toThrow(expect.objectContaining({ code: 'COMMAND_SCHEMA' }))
    expect(() => validateCommandEnvelope({ schema_version: '1', command_id: 'c', type: 'task.complete', target_id: 't', expected_revision: 1, payload: {}, basis: { kind: 'app_instruction' } })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }))
    expect(() => validateCommandEnvelope({ schema_version: '1', command_id: 'c', type: 'task.update', target_id: 't', expected_revision: 1, payload: { status: 'completed' }, basis: { kind: 'app_instruction' } })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_FIELD' }))
  })
  for (const scenario of scenarios) it(`same outcome and DB state: ${scenario.name}`, async () => {
    const results: Record<string, { outcome: Result[]; state: Awaited<ReturnType<typeof endState>> }> = {}
    for (const entrance of entrances()) {
      await resetApp()
      try {
        if (scenario.before) await scenario.before()
        const taskId = scenario.seed ? await scenario.seed() : await seedTask()
        await entrance.connect(taskId, scenario.fields ?? ['notes', 'scheduled_date'])
        const outcome = await scenario.run(entrance, taskId)
        vi.useRealTimers()
        results[entrance.name] = { outcome, state: await endState(taskId) }
      } finally { vi.useRealTimers(); await entrance.close() }
    }
    expect(results.file.outcome).toEqual(results.ui_coach.outcome)
    expect(results.mcp.outcome).toEqual(results.ui_coach.outcome)
    expect(results.file.state).toEqual(results.ui_coach.state)
    expect(results.mcp.state).toEqual(results.ui_coach.state)
    expectations[scenario.name]?.(results.ui_coach.outcome, results.ui_coach.state)
  })
  it('S06 carries a clock deadline (N05 dueAt) through the bus only with the owner instruction and per-field checks', async () => {
    const settings = (await db.settings.get('main'))!, taskId = await seedTask(), human = { principal: { id: settings.profileId, kind: 'human' as const }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['dueDate', 'dueAt'] as TaskChangeField[], sourceRevisions: [] }
    const patch = { dueDate: '2026-10-09', dueAt: { at: '2026-10-09T08:00:00.000Z', timezone: 'Asia/Tokyo' } }
    const instruction = await confirmTaskInstructionFromUI({ message: '締め切りを10月9日17時にして', referenceDate: '2026-10-01', timezone: 'Asia/Tokyo', changes: [{ taskId, expectedRevision: 1, patch }] }, human, click())
    const { outcome, prepared } = await prepareCommand({ schema_version: '1', command_id: uid(), type: 'task.update', target_id: taskId, expected_revision: 1, payload: toCommandPayload(patch), basis: { kind: 'app_instruction' } }, uiHumanActor(settings), { instruction })
    expect(outcome).toMatchObject({ state: 'awaiting_approval', code: 'HUMAN_APPROVAL_REQUIRED' }); expect(prepared!.envelope.payload).toEqual({ due_date: '2026-10-09', due_at: patch.dueAt })
    expect(await submitCommand(prepared!, { event: click(), checkedProtectedFields: ['dueDate'], requestKey: 'clock-1' })).toMatchObject({ state: 'awaiting_approval', code: 'PROTECTED_FIELD_APPROVAL_REQUIRED' })
    expect(await submitCommand(prepared!, { event: click(), checkedProtectedFields: ['dueDate', 'dueAt'], requestKey: 'clock-1' })).toMatchObject({ state: 'applied' })
    expect(await db.tasks.get(taskId)).toMatchObject({ dueDate: '2026-10-09', dueAt: '2026-10-09T08:00:00.000Z', dueTimezone: 'Asia/Tokyo' })
    const { outcome: bad } = await prepareCommand({ schema_version: '1', command_id: uid(), type: 'task.update', target_id: taskId, expected_revision: 2, payload: { due_at: { at: 'x', timezone: 'Asia/Tokyo', extra: 1 } }, basis: { kind: 'app_instruction' } }, uiHumanActor(settings))
    expect(bad).toMatchObject({ state: 'rejected', code: 'INVALID_PAYLOAD' })
  })
  it('an S06 owner without a grant and the human entrance stay self-authorized, never via the agent grant', async () => {
    const settings = (await db.settings.get('main'))!, taskId = await seedTask()
    const { outcome, prepared } = await prepareCommand({ schema_version: '1', command_id: uid(), type: 'task.update', target_id: taskId, expected_revision: 1, payload: { notes: '本人の変更' }, basis: { kind: 'app_instruction' } }, uiHumanActor(settings))
    expect(outcome).toMatchObject({ state: 'awaiting_approval', code: 'HUMAN_APPROVAL_REQUIRED', entrance: 'ui_human' })
    expect(await submitCommand(prepared!, { event: click(), requestKey: 'owner-1' })).toMatchObject({ state: 'applied', code: null })
    const { outcome: external } = await prepareCommand({ schema_version: '1', command_id: uid(), type: 'task.update', target_id: taskId, expected_revision: 2, payload: { notes: 'x' }, basis: { kind: 'external_request' } }, uiHumanActor(settings))
    expect(external).toMatchObject({ state: 'rejected', code: 'BASIS_UNVERIFIED' })
  })
})
const expectations: Record<string, (outcome: Result[], state: Awaited<ReturnType<typeof endState>>) => void> = {
  'notes change waits for approval, then the native click applies': (outcome, state) => { expect(outcome).toEqual([{ state: 'awaiting_approval', code: 'HUMAN_APPROVAL_REQUIRED' }, { state: 'applied', code: null }]); expect(state.task).toMatchObject({ notes: '外部・コーチから提案されたメモ', revision: 2, score: { mode: 'manual', manualPoints: 25 }, dueDate: '2026-10-09' }); expect(state.audits).toEqual([expect.objectContaining({ decision: 'approved', origin: 'agent_proposal', approved: true })]); expect(state.ledger).toBe(0) },
  'schedule shift inside the bound': outcome => expect(outcome[1]).toEqual({ state: 'applied', code: null }),
  'schedule shift outside the bound': (outcome, state) => { expect(outcome).toEqual([{ state: 'denied', code: 'SCHEDULE_BOUND' }]); expect(state.task.revision).toBe(1) },
  'deny (text and schedule operations stopped) while queued': (outcome, state) => { expect(outcome[1]).toEqual({ state: 'denied', code: 'CHANGES_STOPPED' }); expect(state.task.revision).toBe(1) },
  'AI changes switched off while queued': (outcome, state) => { expect(outcome[1]).toEqual({ state: 'denied', code: 'CHANGES_STOPPED' }); expect(state.task.notes).toBe('元のメモ') },
  'policy epoch changes while queued': outcome => expect(outcome[1]).toEqual({ state: 'expired', code: 'POLICY_CHANGED' }),
  'stale revision after an owner edit': (outcome, state) => { expect(outcome[1]).toEqual({ state: 'conflict', code: 'CONFLICT' }); expect(state.task.notes).toBe('本人がその後に編集') },
  'foreign container': outcome => expect(outcome).toEqual([{ state: 'denied', code: 'UNAUTHORIZED' }]),
  'manual points without owner instruction wait for the owner value check': (outcome, state) => { expect(outcome).toEqual([{ state: 'awaiting_approval', code: 'USER_INSTRUCTION_REQUIRED' }, { state: 'awaiting_approval', code: 'USER_INSTRUCTION_REQUIRED' }]); expect(state.task.score.manualPoints).toBe(25) },
  'protected field needs its own check, then applies with it': (outcome, state) => { expect(outcome).toEqual([{ state: 'awaiting_approval', code: 'USER_INSTRUCTION_REQUIRED' }, { state: 'awaiting_approval', code: 'HUMAN_APPROVAL_REQUIRED' }, { state: 'awaiting_approval', code: 'PROTECTED_FIELD_APPROVAL_REQUIRED' }, { state: 'applied', code: null }]); expect(state.task.score).toMatchObject({ mode: 'manual', manualPoints: 30 }); expect(state.assessments).toBe(2); expect(state.ledger).toBe(0); expect(state.audits[0]).toMatchObject({ origin: 'user_instruction_via_agent' }) },
  'expired proposal': outcome => expect(outcome[1]).toEqual({ state: 'expired', code: 'EXPIRED' }),
  'digest substitution': (outcome, state) => { expect(outcome[1]).toEqual({ state: 'rejected', code: 'DIGEST_MISMATCH' }); expect(state.task.revision).toBe(1) },
  'payload claiming approved/actor/policy_level': outcome => expect(outcome).toEqual([{ state: 'rejected', code: 'COMMAND_SCHEMA' }]),
  'synthetic DOM click': (outcome, state) => { expect(outcome[1]).toEqual({ state: 'awaiting_approval', code: 'HUMAN_APPROVAL_REQUIRED' }); expect(state.task.revision).toBe(1) },
  'agent-edited registration (signature failure)': (outcome, state) => { expect(outcome).toEqual([{ state: 'denied', code: 'AUTHORITY_UNVERIFIED' }]); expect(state.task.revision).toBe(1) },
}

describe('K12 outcome parity reaches the agent through signed results', () => {
  it('a denial while queued is signed with CHANGES_STOPPED and michi_command_result returns it as an error', async () => {
    const taskId = await seedTask(), harness = await bridgeHarness({ taskIds: [taskId], fields: ['notes'] })
    try {
      const applied = crypto.randomUUID(), queued = crypto.randomUUID(), args = (commandId: string) => ({ commandId, snapshotId: harness.snapshotId(), targetId: taskId, expectedRevision: 1, payload: { notes: '外部から提案されたメモ' } })
      expect((await harness.mcpCall('michi_propose_update', args(applied))).isError).toBeFalsy()
      expect((await harness.mcpCall('michi_propose_update', args(queued))).isError).toBeFalsy()
      expect(await harness.mcpCall('michi_command_result', { commandId: applied })).toMatchObject({ structuredContent: { state: 'awaiting-person-in-app', notApplied: true } })
      const scanned = await harness.controller.scanInbox(), reference = (id: string) => scanned.entries.find(entry => entry.filename.startsWith(id) && entry.state === 'awaiting_approval') as Extract<typeof scanned.entries[number], { state: 'awaiting_approval' }>
      const prepared = await harness.controller.prepare(reference(applied).reference)
      await setModes({ 'task.text': 'deny', 'task.schedule': 'deny' })
      expect(commandOutcome(await harness.controller.applyFromUI(prepared, click()).catch(error => error))).toMatchObject({ state: 'denied', code: 'CHANGES_STOPPED' })
      // The app's screen closes the other queued entry with the same reason before dropping the stale connection.
      await harness.controller.closePending('CHANGES_STOPPED')
      for (const commandId of [applied, queued]) {
        const result = await harness.mcpCall('michi_command_result', { commandId })
        expect(result).toMatchObject({ isError: true, content: [{ text: 'CHANGES_STOPPED' }], structuredContent: { commandId, state: 'denied', code: 'CHANGES_STOPPED', signatureVerifiedByClient: false } })
      }
      expect((await db.tasks.get(taskId))!).toMatchObject({ notes: '元のメモ', revision: 1 })
    } finally { await harness.close() }
  })
  it('a conflict found inside the apply transaction is signed through the lease cancellation', async () => {
    const taskId = await seedTask(), harness = await bridgeHarness({ taskIds: [taskId], fields: ['notes'] })
    try {
      const commandId = crypto.randomUUID()
      await harness.mcpCall('michi_propose_update', { commandId, snapshotId: harness.snapshotId(), targetId: taskId, expectedRevision: 1, payload: { notes: '外部案' } })
      const scanned = await harness.controller.scanInbox(), entry = scanned.entries.find(item => item.state === 'awaiting_approval') as Extract<typeof scanned.entries[number], { state: 'awaiting_approval' }>
      const prepared = await harness.controller.prepare(entry.reference), task = (await db.tasks.get(taskId))!
      await updateTask(taskId, 1, { ...task, notes: '本人の編集' })
      expect(commandOutcome(await harness.controller.applyFromUI(prepared, click()).catch(error => error))).toMatchObject({ state: 'conflict', code: 'CONFLICT' })
      expect(await harness.mcpCall('michi_command_result', { commandId })).toMatchObject({ isError: true, structuredContent: { state: 'conflict', code: 'CONFLICT' } })
    } finally { await harness.close() }
  })
})
