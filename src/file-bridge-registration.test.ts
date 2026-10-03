import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { bridgeHarness, resetApp } from './command-test-harness'
import { assertFileBridgeRegistration } from './file-bridge-contract'
import { dispatchExternalRoutineTool } from './external-routine-plans'
import { externalAIFor } from './external-authority'

// Renderer registration contract: new read/share scopes validate, unknown keys and
// non-boolean disclosure flags are rejected. Failures never create authority.
it('expanded grant keys and disclosure flags validate exactly', async () => {
  await resetApp()
  const taskId = await createTask({ ...newTaskInput(), title: '本人のタスク' })
  const h = await bridgeHarness({
    taskIds: [taskId], fields: ['notes'],
    allowHistory: true, allowRoutinePreview: true, allowContextRead: true, allowExternalContext: true,
    allowDetection: true, allowHandoffPrepare: true, allowHandoffs: true,
  })
  try {
    const registration = h.status().registration!
    expect(() => assertFileBridgeRegistration(registration)).not.toThrow()
    expect(registration.client.grant.keys).toEqual(expect.arrayContaining(
      ['history:read', 'routines:read', 'context:read', 'detection:request', 'detection:read', 'handoff:prepare'],
    ))
    expect(registration.client.grant.allow_external_context).toBe(true)
    expect(registration.client.grant.allow_handoffs).toBe(true)
    expect(() => assertFileBridgeRegistration({
      ...registration, client: { ...registration.client, grant: { ...registration.client.grant, keys: [...registration.client.grant.keys, 'admin:all'] } },
    })).toThrow()
    expect(() => assertFileBridgeRegistration({
      ...registration, client: { ...registration.client, grant: { ...registration.client.grant, allow_external_context: 'yes' } },
    })).toThrow()
    // Backup still excludes the live registration/credentials.
    const { commands } = await import('./backup').then((module) => module.captureSnapshot())
    expect(commands.some((row) => /^external(plan|prepare|submit|instruction):/.test(row.key))).toBe(false)
    expect(await db.tasks.get(taskId)).toBeDefined()
  } finally {
    await h.close()
  }
})

it('new-series proposals validate without bound series; existing series still bind', async () => {
  await resetApp()
  const taskId = await createTask({ ...newTaskInput(), title: '本人のタスク' })
  const h = await bridgeHarness({ taskIds: [taskId], fields: ['notes'], allowRoutineChange: true })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    expect(registration.client.grant.keys).toContain('routines:prepare')
    expect(registration.rule_ids ?? []).toEqual([])
    expect(() => assertFileBridgeRegistration(registration)).not.toThrow()
    const context = {
      registration, ownerId: settings.profileId, datasetId: settings.datasetId,
      externalEpoch: externalAIFor(settings).epoch,
      policyEpoch: registration.policy_epoch, sourcePermissionRevision: registration.source_permission_revision,
    }
    const definition = {
      id: null, context_id: '123e4567-e89b-42d3-a456-426614174000', title: '週次報告', trigger_type: 'rrule',
      trigger_config: { dtstart_date: '2026-10-05', local_time: '09:00', rrule: 'FREQ=WEEKLY;COUNT=3', rdates: [], exdates: [] },
      timezone: 'Asia/Tokyo', business_calendar_id: null, basis: 'user_instruction', evidence_refs: [],
      steps: [{ step_key: 'main', task_blueprint: { title: '報告書を書く', notes: '', score: { mode: 'unset' }, estimated_minutes: 30, travel_minutes: 0 }, offset_minutes: 0 }],
    }
    const prepared = await dispatchExternalRoutineTool('coach_prepare_routine_change', {
      request_key: crypto.randomUUID(), basis: { kind: 'external_request', note: '新規提案' },
      routine_id: null, expected_revision: null, scope: 'new', definition,
    }, context)
    expect(prepared.state).toBe('awaiting_approval')
  } finally {
    await h.close()
  }
})
