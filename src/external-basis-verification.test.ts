import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { bridgeHarness, click, resetApp } from './command-test-harness'
import { externalAIFor } from './external-authority'
import { dispatchExternalChangeTool } from './external-change-plans'
import { clearExternalInstructionAuthority, confirmExternalInstructionFromUI } from './external-instructions'
import type { ExternalChangeRequest } from './external-command-gate'
import type { ExternalToolContext } from './external-tools'

afterEach(clearExternalInstructionAuthority)

// Real-route basis check: app_instruction issued by native UI can prepare to awaiting_approval,
// but never auto-applies. Fake refs fail closed. Detection/rule refs without issuance fail closed.
it('verified app_instruction reaches the shared inbox route while fake refs do not', async () => {
  await resetApp()
  const taskId = await createTask({ ...newTaskInput(), title: '本人のタスク' })
  const h = await bridgeHarness({ taskIds: [taskId], fields: ['notes', 'scheduled_date'] })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    const context: ExternalToolContext = {
      registration, ownerId: settings.profileId, datasetId: settings.datasetId,
      externalEpoch: externalAIFor(settings).epoch,
      policyEpoch: registration.policy_epoch,
      sourcePermissionRevision: registration.source_permission_revision,
    }
    const draft: ExternalChangeRequest = {
      request_key: crypto.randomUUID(), operation: 'task.update', task_id: taskId,
      expected_revision: 1, payload: { changes: { scheduled_date: '2026-10-04' } },
      basis: { kind: 'external_request', note: '提案' },
    }
    // Fake instruction ref fails closed before any plan is stored.
    await expect(dispatchExternalChangeTool('coach_prepare_change', {
      ...draft, request_key: crypto.randomUUID(),
      basis: { kind: 'app_instruction', reference_id: crypto.randomUUID() },
    }, context)).rejects.toThrow('UNVERIFIED_REFERENCE')
    // Detection/rule refs without real issuance also fail closed.
    for (const kind of ['verified_detection', 'approved_rule_instance'] as const) {
      await expect(dispatchExternalChangeTool('coach_prepare_change', {
        ...draft, request_key: crypto.randomUUID(),
        basis: { kind, reference_id: crypto.randomUUID() },
      }, context)).rejects.toThrow('UNVERIFIED_REFERENCE')
    }
    expect(await db.commands.toCollection().filter((row) => row.key.startsWith('externalplan:')).count()).toBe(0)
    // Native UI issues a ref bound to the exact action/context.
    const reference_id = await confirmExternalInstructionFromUI(draft, context, click())
    const verified = { ...draft, request_key: crypto.randomUUID(), basis: { kind: 'app_instruction' as const, reference_id } }
    const prepared = await dispatchExternalChangeTool('coach_prepare_change', verified, context)
    expect(prepared.state).toBe('awaiting_approval')
    // Exact task is unchanged before native approval.
    expect((await db.tasks.get(taskId))?.scheduledDate).not.toBe('2026-10-04')
    // Tampered payload with the same ref fails closed.
    await expect(dispatchExternalChangeTool('coach_prepare_change', {
      ...verified, request_key: crypto.randomUUID(), payload: { changes: { scheduled_date: '2026-10-05' } },
    }, context)).rejects.toThrow('UNVERIFIED_REFERENCE')
  } finally {
    await h.close()
  }
})
