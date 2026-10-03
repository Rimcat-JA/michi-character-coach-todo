import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { bridgeHarness, resetApp } from './command-test-harness'
import { assertFileBridgeRegistration } from './file-bridge-contract'

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
