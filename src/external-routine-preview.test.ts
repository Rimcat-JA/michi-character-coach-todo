import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { bridgeHarness, resetApp } from './command-test-harness'
import { externalAIFor } from './external-authority'
import { dispatchExternalReadTool, type ExternalToolContext } from './external-tools'

function contextFor(registration: ExternalToolContext['registration'], ownerId: string, datasetId: string, epoch: number): ExternalToolContext {
  return {
    registration, ownerId, datasetId, externalEpoch: epoch,
    policyEpoch: registration.policy_epoch, sourcePermissionRevision: registration.source_permission_revision,
  }
}

const definition = {
  id: null,
  context_id: '123e4567-e89b-42d3-a456-426614174000',
  title: '週次報告',
  trigger_type: 'rrule',
  trigger_config: { dtstart_date: '2026-10-05', local_time: '09:00', rrule: 'FREQ=WEEKLY;COUNT=3', rdates: [], exdates: [] },
  timezone: 'Asia/Tokyo',
  business_calendar_id: null,
  basis: 'user_instruction',
  evidence_refs: [],
  steps: [{ step_key: 'main', task_blueprint: { title: '報告書を書く', notes: '', score: { mode: 'unset' }, estimated_minutes: 30, travel_minutes: 0 }, offset_minutes: 0 }],
}

// coach_preview_routine is pure date math: no DB reads beyond authority, no saves,
// no new obligations. Basis labels grant nothing here.
it('routine preview expands occurrences without writing state', async () => {
  await resetApp()
  const allowed = await createTask({ ...newTaskInput(), title: '許可タスク' })
  const h = await bridgeHarness({ taskIds: [allowed], fields: ['title'], allowRoutinePreview: true })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    expect(registration.client.grant.keys).toContain('routines:read')
    const preview = await dispatchExternalReadTool('coach_preview_routine', { definition }, context) as {
      occurrences: { logical_key: string; starts_at: string | null; task_titles: string[] }[]; conflicts: string[]; unknowns: string[]
    }
    expect(preview.occurrences.map((row) => row.logical_key)).toEqual(['2026-10-05', '2026-10-12', '2026-10-19'])
    expect(preview.occurrences[0]).toEqual({ logical_key: '2026-10-05', starts_at: '2026-10-05T00:00:00.000Z', task_titles: ['報告書を書く'] })
    expect(preview.conflicts).toEqual([])
    expect(preview.unknowns).toEqual([])
    // Nothing was stored: no tasks, plans, or routines appeared.
    expect(await db.tasks.count()).toBe(1)
    expect(await db.commands.toCollection().filter((row) => row.key.startsWith('external')).count()).toBe(0)
    // Malformed definitions fail closed with explicit codes.
    await expect(dispatchExternalReadTool('coach_preview_routine', { definition: { ...definition, title: '  ' } }, context)).rejects.toThrow('INVALID_ROUTINE_DEFINITION')
    await expect(dispatchExternalReadTool('coach_preview_routine', { definition: { ...definition, timezone: 'Mars/Olympus' } }, context)).rejects.toThrow('INVALID_TIMEZONE')
    await expect(dispatchExternalReadTool('coach_preview_routine', { definition: { ...definition, trigger_config: { ...definition.trigger_config, rrule: 'FREQ=MINUTELY' } } }, context)).rejects.toThrow('UNSUPPORTED_RRULE')
  } finally {
    await h.close()
  }
})

it('routine preview without the routines:read scope is denied', async () => {
  await resetApp()
  const allowed = await createTask({ ...newTaskInput(), title: '許可タスク' })
  const h = await bridgeHarness({ taskIds: [allowed], fields: ['title'] })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    expect(registration.client.grant.keys).not.toContain('routines:read')
    await expect(dispatchExternalReadTool('coach_preview_routine', { definition }, context)).rejects.toThrow('INSUFFICIENT_SCOPE')
  } finally {
    await h.close()
  }
})
