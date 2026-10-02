import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput, updateTask } from './commands'
import { emptyScore, uid } from './domain'
import { changePolicyFor, type TaskChangeField } from './change-set'
import { presetRules } from './automation-policy'
import { previewAutomationPolicy, setAutomationPolicyFromUI } from './automation-control'
import { confirmCommandValuesFromUI, prepareCommand, submitCommand, uiCoachActor, type CommandOutcome } from './command-bus'
import { applyAssistedTasks, prepareAssistedTasks } from './task-assist'
import { defaultSourcePermissions, importLocalSource } from './source-library'
import { applyDetectionCreateFromUI, clearDetectionAuthority, detectObligationsForSource, prepareDetectionCreate, prepareDetectionFromUI, type DetectionTransport, type PreparedDetection } from './detection-run'
import { requiredDetectionClaims, type DetectionChange } from './detection-contract'
import { changeTrace } from './change-history'
import { bridgeHarness, click, outcomeOf, resetApp, type BridgeHarness } from './command-test-harness'

// N03 creator independence across real entrances: human UI, N02 assist, file/MCP create (agent A),
// detection adoption, the in-app coach (models X/Y via fixed synthetic answers) and MCP (agent B).
const model = 'synthetic/model-x'
beforeEach(async () => { clearDetectionAuthority(); await resetApp(model) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
type Step = { step: string; taskId: string; result: { state: string; code: string | null } }
const owner = async () => (await db.settings.get('main'))!
async function coach(taskId: string, modelId: string, payload: Record<string, unknown>, options: { confirm?: boolean; checked?: TaskChangeField[]; revision?: number; settings?: Awaited<ReturnType<typeof owner>> } = {}): Promise<CommandOutcome> {
  const settings = options.settings ?? await owner(), task = (await db.tasks.get(taskId))!
  const first = await prepareCommand({ schema_version: '1', command_id: uid(), type: 'task.update', target_id: taskId, expected_revision: options.revision ?? task.revision, payload, basis: { kind: 'app_instruction' } }, uiCoachActor(settings, modelId))
  if (!first.prepared) return first.outcome
  let prepared = first.prepared
  if (prepared.stage === 'owner_values') {
    if (!options.confirm) return submitCommand(prepared, { event: click(), requestKey: uid() })
    const confirmed = await confirmCommandValuesFromUI(prepared, click(), '本人がこの値を指示した')
    if (!confirmed.prepared) return confirmed.outcome
    prepared = confirmed.prepared
  }
  return submitCommand(prepared, { event: click(), checkedProtectedFields: options.checked ?? [], requestKey: uid() })
}
async function external(harness: BridgeHarness, via: 'file' | 'mcp', taskId: string, payload: Record<string, unknown>): Promise<{ state: string; code: string | null }> {
  await harness.controller.refresh(); await harness.refreshSnapshot()
  const revision = (await db.tasks.get(taskId))!.revision, commandId = crypto.randomUUID()
  if (via === 'file') await harness.writeCommand({ command_id: commandId, type: 'task.update', target_id: taskId, expected_revision: revision, payload })
  else { const reply = await harness.mcpCall('michi_propose_update', { commandId, snapshotId: harness.snapshotId(), targetId: taskId, expectedRevision: revision, payload }); if (reply.isError) return { state: 'denied', code: reply.content[0].text } }
  const scanned = await harness.controller.scanInbox(), entry = scanned.entries.find(item => item.filename.startsWith(commandId))!
  if (entry.state !== 'awaiting_approval') return { state: 'rejected', code: entry.state === 'rejected' ? entry.error : null }
  return outcomeOf(async () => { const prepared = await harness.controller.prepare(entry.reference); await harness.controller.applyFromUI(prepared, click()) })
}
async function detected() {
  const sourceId = await importLocalSource({ title: '合成資料', provider: 'local', externalId: null, conversation: null, author: 'Karin', sourceUrl: null, date: '2026-10-01', fromDate: '2026-10-01', toDate: '2026-10-01', text: 'Karinさん、2026年10月2日までに見積書を送ってください。', permissions: { ...defaultSourcePermissions(), aiEgress: true }, allowedModels: [model], retentionUntil: null })
  const row = await db.contextSources.get(sourceId), value = await prepareDetectionFromUI(sourceId, row!.revision, model, { confirmedAliases: ['Karinさん'], authorIsOwner: false, existingTaskIds: [] }, click())
  const transport = (prepared: PreparedDetection): DetectionTransport => {
    const source = prepared.request.sources[0], span = source.spans[0]
    const change: DetectionChange = { action: 'create', target_task_id: null, expected_revision: null, title: '見積書を送る', assignee_id: prepared.ownerId, basis: 'explicit_request', obligation_state: 'requested', change_fields: ['title', 'assignee', 'due'], due: { kind: 'date', value: '2026-10-02', timezone: 'Asia/Tokyo', raw: span.text }, recurrence: null, applicability_ref: null, rule_ref: null, evidence: [{ source_id: source.source_id, revision: source.revision, span_id: span.span_id, quote: span.text, supports: ['action', 'assignee', 'active', 'due'] }] }
    return { detect: vi.fn(async () => JSON.stringify({ schema_version: '1', changes: [change], review_items: [], ignored: [] })), verify: vi.fn(async ({ change: checked }: { change: DetectionChange }) => JSON.stringify({ verdict: 'entailed', checks: requiredDetectionClaims(checked).map(field => ({ field, verdict: 'entailed', source_refs: [`${source.source_id}:${span.span_id}`], reason: '合成の原文を照合した' })) })) } as unknown as DetectionTransport
  }
  const run = await detectObligationsForSource(value, transport(value)), confirmation = await prepareDetectionCreate(run, run.candidates[0].id)
  return (await applyDetectionCreateFromUI(run, confirmation, confirmation.digest, click())).taskIds[0]
}
async function titleRule(rule: 'deny' | 'require_approval') {
  const settings = await owner(), policy = changePolicyFor(settings), context = { principal: { id: settings.profileId, kind: 'human' as const }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: [] as TaskChangeField[], sourceRevisions: [] }
  const input = { preset: 'custom' as const, rules: presetRules('A1'), allowedHours: {}, titleRule: rule, bounds: policy.bounds, locks: policy.locks }
  await setAutomationPolicyFromUI(context, click(), input, (await previewAutomationPolicy(input)).token)
}

describe('N03 proxy edits do not depend on who created the task', () => {
  it('human / N02 / agent A / detection tasks: coach X → agent B (MCP) → human → coach Y title → agent A, rejecting only what the rules reject', async () => {
    const steps: Step[] = [], record = (step: string, taskId: string, result: { state: string; code: string | null }) => { steps.push({ step, taskId, result: { state: result.state, code: result.code } }) }
    const human = await createTask({ ...newTaskInput(), title: '本人が作った25pt', notes: '本人のメモ', scheduledDate: '2026-10-01', dueDate: '2026-10-09', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
    const assisted = await prepareAssistedTasks([{ input: { ...newTaskInput(), title: 'N02で作った作業', notes: '', scheduledDate: '2026-10-02' }, notices: [], source: '合成の作成補助' }], 'ai')
    const [n02] = await applyAssistedTasks(assisted, assisted.digest)
    const fromSource = await detected()
    for (const [step, id] of [['create:human', human], ['create:n02', n02], ['create:detection', fromSource]] as const) record(step, id, { state: 'applied', code: null })
    const agentA = await bridgeHarness({ taskIds: [human, n02, fromSource], fields: ['title', 'notes', 'scheduled_date'] })
    let agentB: BridgeHarness | null = null
    try {
      const commandId = crypto.randomUUID()
      await agentA.writeCommand({ command_id: commandId, type: 'task.create', target_id: null, expected_revision: null, payload: { title: 'エージェントAが作った作業', scheduled_date: '2026-10-03' } })
      const scanned = await agentA.controller.scanInbox(), entry = scanned.entries.find(item => item.filename.startsWith(commandId)) as Extract<typeof scanned.entries[number], { state: 'awaiting_approval' }>
      const created = await agentA.controller.applyFromUI(await agentA.controller.prepare(entry.reference), click()), byAgent = created.receipt.taskIds[0]
      record('create:agent-a', byAgent, { state: 'applied', code: null })
      const all = [human, n02, fromSource, byAgent]
      for (const id of all) { await db.tasks.update(id, { scheduledDate: (await db.tasks.get(id))!.scheduledDate ?? '2026-10-04' }) }
      for (const id of all) record('coach-x:notes', id, await coach(id, 'synthetic/model-x', { notes: 'コーチXの提案メモ' }))
      agentB = await bridgeHarness({ taskIds: all, fields: ['scheduled_date'] })
      for (const id of all) record('agent-b:schedule', id, await external(agentB, 'mcp', id, { scheduled_date: '2026-10-06' }))
      for (const id of all) { const task = (await db.tasks.get(id))!; record('human:notes', id, await outcomeOf(() => updateTask(id, task.revision, { ...task, notes: `${task.notes}（本人が追記）` }))) }
      for (const id of all) record('coach-y:title', id, await coach(id, 'synthetic/model-y', { title: `${(await db.tasks.get(id))!.title}（改題）` }, { confirm: true }))
      for (const id of [human, n02, fromSource]) record('agent-a:notes', id, await external(agentA, 'file', id, { notes: 'エージェントAの追記' }))
      const allowed = steps.filter(step => step.result.state === 'applied')
      expect(allowed.length).toBeGreaterThanOrEqual(12)
      expect(steps.filter(step => step.result.state !== 'applied')).toEqual([])

      // Rejections come only from revision, ownership, owner-value and field rules — never from the creator.
      const rejections: Step[] = []
      rejections.push({ step: 'stale revision', taskId: n02, result: await coach(n02, 'synthetic/model-x', { notes: '古い版から' }, { revision: 1 }) })
      const other = { ...(await owner()), datasetId: crypto.randomUUID() }
      rejections.push({ step: 'other dataset', taskId: byAgent, result: await coach(byAgent, 'synthetic/model-x', { notes: '別領域から' }, { settings: other }) })
      const at = new Date().toISOString(), containerId = crypto.randomUUID()
      await db.containers.add({ id: containerId, parentId: null, kind: 'project', name: '共有', ownerId: (await owner()).profileId, revision: 1, createdAt: at, updatedAt: at, deletedAt: null })
      const foreign = await createTask({ ...newTaskInput(), title: '他人の領域へ移るタスク', containerId }); await db.containers.update(containerId, { ownerId: 'another-owner' })
      rejections.push({ step: 'foreign container', taskId: foreign, result: await coach(foreign, 'synthetic/model-x', { notes: '他人の領域' }) })
      rejections.push({ step: 'manual points without owner instruction', taskId: human, result: await coach(human, 'synthetic/model-x', { manual_points: 40 }) })
      rejections.push({ step: 'deadline without per-field approval', taskId: fromSource, result: await coach(fromSource, 'synthetic/model-x', { due_date: '2026-10-20' }, { confirm: true }) })
      rejections.push({ step: 'agent B field not granted', taskId: human, result: await external(agentB, 'mcp', human, { notes: '許可外の項目' }) })
      // Raising a field rule changes the epoch, which also revokes the agent connections (checked above first).
      await titleRule('deny')
      rejections.push({ step: 'fieldRules title deny', taskId: byAgent, result: await coach(byAgent, 'synthetic/model-y', { title: '禁止された改題' }, { confirm: true }) })
      expect(rejections.map(item => ({ step: item.step, state: item.result.state, code: item.result.code }))).toEqual([
        { step: 'stale revision', state: 'conflict', code: 'CONFLICT' },
        { step: 'other dataset', state: 'denied', code: 'UNAUTHORIZED' },
        { step: 'foreign container', state: 'denied', code: 'UNAUTHORIZED' },
        { step: 'manual points without owner instruction', state: 'awaiting_approval', code: 'USER_INSTRUCTION_REQUIRED' },
        { step: 'deadline without per-field approval', state: 'awaiting_approval', code: 'PROTECTED_FIELD_APPROVAL_REQUIRED' },
        { step: 'agent B field not granted', state: 'denied', code: 'FIELD_NOT_GRANTED' },
        { step: 'fieldRules title deny', state: 'denied', code: 'CHANGES_STOPPED' },
      ])

      // Audits name the operator of each step; S21 shows the operator, not the creator.
      const trace = changeTrace(await db.audits.toArray(), 0, 500).entries.filter(entry => entry.operation === 'changeset.update' && entry.taskId === human)
      expect(new Set(trace.map(entry => `${entry.operator.kind}:${entry.operator.model ?? entry.entrance}`))).toEqual(new Set(['coach:synthetic/model-x', 'external-agent:mcp', 'coach:synthetic/model-y', 'external-agent:file']))
      expect((await changeTrace(await db.audits.toArray(), 0, 500)).entries.some(entry => entry.operation === 'update' && entry.taskId === human && entry.operator.kind === 'human' && entry.fields.includes('notes'))).toBe(true)
      const titleAssessment = (await db.audits.toArray()).filter(audit => audit.operation === 'changeset.update').map(audit => JSON.parse(audit.detail)).filter(detail => Object.hasOwn(detail.fieldOrigins ?? {}, 'title'))
      expect(titleAssessment.every(detail => detail.fieldOrigins.title === 'user_instruction_via_agent')).toBe(true)
      // Manual 25pt, assessments and the ledger are unchanged: nobody changed points.
      expect((await db.tasks.get(human))!).toMatchObject({ score: { mode: 'manual', manualPoints: 25 }, effectivePoints: 25, dueDate: '2026-10-09' })
      expect(await db.assessments.where('taskId').equals(human).count()).toBe(1)
      expect(await db.ledger.count()).toBe(0)
    } finally { await agentA.close(); await agentB?.close() }
  }, 30000)
})
