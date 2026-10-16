import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { bridgeHarness, click, resetApp } from './command-test-harness'
import { assertFileBridgeCommand } from './file-bridge-contract'
import { dispatchExternalChangeTool } from './external-change-plans'
import { dispatchExternalReadTool, type ExternalToolContext } from './external-tools'
import { externalAIFor } from './external-authority'
import { changePolicyFor, taskChangeValueText } from './change-set'
import { presetRules } from './automation-policy'
import { previewAutomationPolicy, setAutomationPolicyFromUI } from './automation-control'
import type { ExternalChangeRequest } from './external-command-gate'

const require = createRequire(import.meta.url)
const { createAppChangeDispatcher } = require('../electron/mcp-app-changes.cjs')
const { parseEnvelope } = require('../electron/local-file-bridge.cjs')
const clock = { at: '2026-10-04T01:00:12.345Z', timezone: 'Asia/Tokyo' }
const payload = { due_date: '2026-10-04', due_at: clock }

it('owner value and protected-diff text retain seconds, milliseconds and the exact UTC instant', () => {
  expect(taskChangeValueText(clock)).toContain(clock.at)
  expect(taskChangeValueText(clock)).toContain(clock.timezone)
})

it('an explicit null clock requires owner confirmation and preserves the deadline day', async () => {
  await resetApp()
  const id = await createTask({ ...newTaskInput(), title: '時刻の解除', dueDate: payload.due_date, dueAt: clock.at, dueTimezone: clock.timezone })
  const h = await bridgeHarness({ taskIds: [id], fields: ['due_at'] })
  try {
    await h.writeCommand({ type: 'task.update', target_id: id, expected_revision: 1, payload: { due_at: null } })
    const entry = (await h.controller.scanInbox()).entries.find(entry => entry.state === 'awaiting_approval')!
    if (entry.state !== 'awaiting_approval') throw Error('Missing clock clear proposal')
    const prepared = await h.controller.prepare(entry.reference)
    expect(prepared.command.stage).toBe('owner_values')
    expect((await db.tasks.get(id))?.dueAt).toBe(clock.at)
    const confirmed = await h.controller.confirmValuesFromUI(prepared, click())
    await h.controller.applyFromUI(confirmed, click(), ['dueAt'])
    expect(await db.tasks.get(id)).toMatchObject({ dueDate: payload.due_date, dueAt: null, dueTimezone: null, revision: 2 })
  } finally { await h.close() }
})

for (const entrance of ['file', 'mcp'] as const) it(`${entrance}: clock deadline requires exact native values and approval; receipt replay is harmless`, async () => {
  await resetApp()
  const taskId = await createTask({ ...newTaskInput(), title: '時刻付き期限', dueDate: '2026-10-02' })
  const h = await bridgeHarness({ taskIds: [taskId], fields: ['due_date', 'due_at'] })
  try {
    expect((await h.mcpCall('michi_snapshot', {})).structuredContent).toMatchObject({ tasks: [{ due_date: '2026-10-02', due_at: null }] })
    if (entrance === 'file') await h.writeCommand({ type: 'task.update', target_id: taskId, expected_revision: 1, payload })
    else expect((await h.mcpCall('michi_propose_update', { commandId: crypto.randomUUID(), snapshotId: h.snapshotId(), targetId: taskId, expectedRevision: 1, payload })).isError).not.toBe(true)
    const pending = (await h.controller.scanInbox()).entries.find(entry => entry.state === 'awaiting_approval')!
    if (pending.state !== 'awaiting_approval') throw Error('Missing proposal')
    const prepared = await h.controller.prepare(pending.reference)
    expect(prepared.command.stage).toBe('owner_values')
    expect((await db.tasks.get(taskId))?.dueAt).toBeFalsy()
    await expect(h.controller.confirmValuesFromUI(prepared, new Event('click'))).rejects.toThrow()
    const confirmed = await h.controller.confirmValuesFromUI(prepared, click())
    expect(confirmed.changeSet?.changes[0].after.dueAt).toEqual(clock)
    await expect(h.controller.applyFromUI(confirmed, click(), ['dueDate'])).rejects.toThrow()
    const result = await h.controller.applyFromUI(confirmed, click(), ['dueDate', 'dueAt'])
    expect(result.receipt.taskIds).toEqual([taskId])
    expect(await db.tasks.get(taskId)).toMatchObject({ dueDate: payload.due_date, dueAt: clock.at, dueTimezone: clock.timezone, revision: 2 })
    await h.controller.applyFromUI(confirmed, click(), ['dueDate', 'dueAt'])
    expect((await db.tasks.get(taskId))?.revision).toBe(2)
    await h.refreshSnapshot()
    expect((await h.mcpCall('michi_snapshot', {})).structuredContent).toMatchObject({ tasks: [{ due_at: clock }] })
  } finally { await h.close() }
})

it('catalog datetime preserves the offset instant, reaches the signed inbox, and exposes both protected diffs', async () => {
  await resetApp()
  const taskId = await createTask({ ...newTaskInput(), title: 'カタログからの依頼' })
  const h = await bridgeHarness({ taskIds: [taskId], fields: ['due_date', 'due_at'] })
  try {
    const settings = (await db.settings.get('main'))!, registration = h.status().registration!
    const context: ExternalToolContext = { registration, ownerId: settings.profileId, datasetId: settings.datasetId, externalEpoch: externalAIFor(settings).epoch, policyEpoch: registration.policy_epoch, sourcePermissionRevision: registration.source_permission_revision }
    const dispatch = createAppChangeDispatcher({ getHub: async () => h.service, readDB: (table: 'commands', key: string) => db[table].get(key), dispatch: (name: string, args: Record<string, unknown>, ctx: ExternalToolContext) => dispatchExternalChangeTool(name, args, ctx) })
    const request: ExternalChangeRequest = { request_key: crypto.randomUUID(), operation: 'task.update', task_id: taskId, expected_revision: 1, payload: { changes: { due: { kind: 'datetime', at: '2026-10-04T01:00:00+09:00' } } }, basis: { kind: 'external_request', note: '期限の提案' } }
    const plan = await dispatch('coach_prepare_change', request, context)
    expect(plan.field_diffs).toEqual([{ path: 'due_date', before: null, after: '2026-10-03' }, { path: 'due_at', before: null, after: { at: '2026-10-03T16:00:00.000Z', timezone: 'UTC' } }])
    await dispatch('coach_submit_change', { request_key: crypto.randomUUID(), change_set_id: plan.change_set_id, digest: plan.digest }, context)
    expect((await db.tasks.get(taskId))?.dueAt).toBeFalsy()
    const entry = (await h.controller.scanInbox()).entries.find(entry => entry.state === 'awaiting_approval')!
    if (entry.state !== 'awaiting_approval') throw Error('Missing catalog inbox')
    const confirmed = await h.controller.confirmValuesFromUI(await h.controller.prepare(entry.reference), click())
    await h.controller.applyFromUI(confirmed, click(), ['dueDate', 'dueAt'])
    expect(await db.tasks.get(taskId)).toMatchObject({ dueDate: '2026-10-03', dueAt: '2026-10-03T16:00:00.000Z', dueTimezone: 'UTC' })
  } finally { await h.close() }
})

for (const fields of [['due_date'], ['due_at']] as const) it(`catalog cannot change a clock with only ${fields[0]} permission`, async () => {
  await resetApp(); const id = await createTask({ ...newTaskInput(), title: '非許可項目' }), h = await bridgeHarness({ taskIds: [id], fields: [...fields] })
  try {
    const s = (await db.settings.get('main'))!, r = h.status().registration!
    await expect(dispatchExternalChangeTool('coach_prepare_change', { request_key: crypto.randomUUID(), operation: 'task.update', task_id: id, expected_revision: 1, payload: { changes: { due: { kind: 'datetime', at: clock.at } } }, basis: { kind: 'external_request', note: '提案' } }, { registration: r, ownerId: s.profileId, datasetId: s.datasetId, externalEpoch: externalAIFor(s).epoch, policyEpoch: r.policy_epoch, sourcePermissionRevision: r.source_permission_revision })).rejects.toThrow('FIELD_DENIED')
    expect((await db.commands.toArray()).filter(row => row.key.startsWith('externalplan:'))).toHaveLength(0)
    expect((await h.mcpCall('michi_snapshot', {})).structuredContent).toMatchObject({ tasks: [{ [fields[0]]: null }] })
  } finally { await h.close() }
})

for (const bad of [{ at: '2026-02-30T01:00:00.000Z', timezone: 'UTC' }, { ...clock, timezone: 'invalid/zone' }, { ...clock, at: '2026-10-04T10:00:00+09:00' }, { ...clock, approved: true }, 'tomorrow']) it(`renderer/main reject malformed clock ${JSON.stringify(bad)}`, () => {
  const command = { schema_version: '1', command_id: crypto.randomUUID(), snapshot_id: crypto.randomUUID(), expires_at: new Date(Date.now() + 60000).toISOString(), type: 'task.update', target_id: crypto.randomUUID(), expected_revision: 1, payload: { ...payload, due_at: bad } }
  expect(() => assertFileBridgeCommand(command)).toThrow()
  expect(() => parseEnvelope(JSON.stringify(command))).toThrow('INVALID_PAYLOAD')
})

it('a mismatched local day cannot be confirmed, and auto grants never apply deadlines', async () => {
  const settings = await resetApp(), policy = changePolicyFor(settings)
  const next = { preset: 'A2' as const, rules: presetRules('A2'), allowedHours: {}, titleRule: 'require_approval' as const, bounds: policy.bounds, locks: policy.locks }
  await setAutomationPolicyFromUI({ principal: { id: settings.profileId, kind: 'human' }, ownerId: settings.profileId, datasetId: settings.datasetId, allowedFields: ['notes', 'scheduledDate'], sourceRevisions: [] }, click(), next, (await previewAutomationPolicy(next)).token)
  const id = await createTask({ ...newTaskInput(), title: '日付整合' }), h = await bridgeHarness({ taskIds: [id], fields: ['notes', 'due_date', 'due_at'], automation: { maxScheduleShiftDays: 2, maxOperationsPerDay: 5 } })
  try {
    await h.writeCommand({ type: 'task.update', target_id: id, expected_revision: 1, payload: { ...payload, due_date: '2026-10-05' } })
    const entry = (await h.controller.scanInbox()).entries.find(entry => entry.state === 'awaiting_approval')!
    if (entry.state !== 'awaiting_approval') throw Error('Missing proposal')
    const prepared = await h.controller.prepare(entry.reference)
    await expect(h.controller.applyAutomatically(prepared)).rejects.toThrow()
    await expect(h.controller.confirmValuesFromUI(prepared, click())).rejects.toThrow()
    expect((await db.tasks.get(id))?.revision).toBe(1)
  } finally { await h.close() }
})

it('clock capabilities describe the actual implemented surface', async () => {
  await resetApp(); const h = await bridgeHarness({ taskIds: [], fields: [] })
  try {
    const s = (await db.settings.get('main'))!, r = h.status().registration!
    const result = await dispatchExternalReadTool('coach_get_capabilities', {}, { registration: r, ownerId: s.profileId, datasetId: s.datasetId, externalEpoch: externalAIFor(s).epoch, policyEpoch: r.policy_epoch, sourcePermissionRevision: r.source_permission_revision }) as { limitations: string[] }
    expect(result.limitations.join('')).not.toContain('時刻付き期限は未対応')
  } finally { await h.close() }
})
