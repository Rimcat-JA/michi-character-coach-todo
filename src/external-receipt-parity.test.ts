import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { bridgeHarness, resetApp } from './command-test-harness'
import { externalAIFor } from './external-authority'
import { dispatchExternalChangeTool } from './external-change-plans'
import { clearExternalInstructionAuthority } from './external-instructions'
import type { ExternalChangeRequest } from './external-command-gate'
import type { ExternalToolContext } from './external-tools'

afterEach(clearExternalInstructionAuthority)

// Reference receipt parity (test_external_plugin.py PluginReceiptTests) through the real
// renderer route. Commit/replay/idempotency basics live in external-change-plans.test.ts;
// these cover the remaining re-authorization cases: digest tampering, mid-flight revision
// conflicts, and scope reduction between prepare and submit. None of them writes the task.
function contextFor(registration: ExternalToolContext['registration'], ownerId: string, datasetId: string, epoch: number): ExternalToolContext {
  return {
    registration, ownerId, datasetId, externalEpoch: epoch,
    policyEpoch: registration.policy_epoch, sourcePermissionRevision: registration.source_permission_revision,
  }
}

it('reference receipt: digest tampering on submit fails without a task write', async () => {
  await resetApp()
  const taskId = await createTask({ ...newTaskInput(), title: '本人のタスク' })
  const h = await bridgeHarness({ taskIds: [taskId], fields: ['notes'] })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    const request: ExternalChangeRequest = {
      request_key: crypto.randomUUID(), operation: 'task.update', task_id: taskId,
      expected_revision: 1, payload: { changes: { notes: '提案メモ' } },
      basis: { kind: 'external_request', note: '提案' },
    }
    const prepared = await dispatchExternalChangeTool('coach_prepare_change', request, context)
    await expect(dispatchExternalChangeTool('coach_submit_change', {
      request_key: crypto.randomUUID(), change_set_id: prepared.change_set_id, digest: '0'.repeat(64),
    }, context)).rejects.toThrow('DIGEST_MISMATCH')
    expect((await db.tasks.get(taskId))?.revision).toBe(1)
  } finally {
    await h.close()
  }
})

it('reference receipt: task revision change between prepare and submit conflicts without retarget', async () => {
  await resetApp()
  const taskId = await createTask({ ...newTaskInput(), title: '本人のタスク' })
  const h = await bridgeHarness({ taskIds: [taskId], fields: ['notes'] })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    const request: ExternalChangeRequest = {
      request_key: crypto.randomUUID(), operation: 'task.update', task_id: taskId,
      expected_revision: 1, payload: { changes: { notes: '提案メモ' } },
      basis: { kind: 'external_request', note: '提案' },
    }
    const prepared = await dispatchExternalChangeTool('coach_prepare_change', request, context)
    // Owner edits the task directly, moving the revision forward.
    await db.tasks.update(taskId, { notes: '本人の直接編集', revision: 2 })
    await expect(dispatchExternalChangeTool('coach_submit_change', {
      request_key: crypto.randomUUID(), change_set_id: prepared.change_set_id, digest: prepared.digest,
    }, context)).rejects.toThrow('REVISION_CONFLICT')
    expect((await db.tasks.get(taskId))?.notes).toBe('本人の直接編集')
  } finally {
    await h.close()
  }
})

it('reference receipt: old approval cannot override a revised grant, even with a fresh context', async () => {
  await resetApp()
  const taskId = await createTask({ ...newTaskInput(), title: '本人のタスク' })
  const h = await bridgeHarness({ taskIds: [taskId], fields: ['notes', 'scheduled_date'] })
  try {
    const settings = (await db.settings.get('main'))!
    const before = h.status().registration!
    const context = contextFor(before, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    const request: ExternalChangeRequest = {
      request_key: crypto.randomUUID(), operation: 'task.update', task_id: taskId,
      expected_revision: 1, payload: { changes: { notes: '提案メモ' } },
      basis: { kind: 'external_request', note: '提案' },
    }
    const prepared = await dispatchExternalChangeTool('coach_prepare_change', request, context)
    // Owner narrows the grant; the old plan stays bound to its exact prior context.
    const revised = await h.controller.revise({
      clientId: before.client.id, expectedRevision: before.client.revision,
      taskIds: [taskId], fields: ['notes'], expiresAt: before.client.grant.expires_at,
      automation: null, maxScheduleShiftDays: 3, maxOperationsPerDay: 5, allowSplit: false, ruleIds: [],
      allowHistory: false, allowRoutinePreview: false, allowContextRead: false, allowExternalContext: false,
      allowDetection: false, allowHandoffPrepare: false, allowHandoffs: false, allowRoutineChange: false,
    })
    expect(revised.registration?.client.revision).toBe(2)
    const fresh = revised.registration!
    const freshContext = contextFor(fresh, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    await expect(dispatchExternalChangeTool('coach_submit_change', {
      request_key: crypto.randomUUID(), change_set_id: prepared.change_set_id, digest: prepared.digest,
    }, freshContext)).rejects.toThrow('STALE_GRANT')
    expect((await db.tasks.get(taskId))?.revision).toBe(1)
  } finally {
    await h.close()
  }
})
