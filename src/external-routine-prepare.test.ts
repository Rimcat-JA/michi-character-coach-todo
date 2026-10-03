import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { bridgeHarness, resetApp } from './command-test-harness'
import { emptyCalendarRulesState } from './calendar-rules-validation'
import { calendarFixture, monthlyRule } from './calendar-test-fixtures'
import { externalAIFor } from './external-authority'
import { dispatchExternalRoutineTool } from './external-routine-plans'
import type { ExternalToolContext } from './external-tools'

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

const base = {
  request_key: '89bc15dc-58f1-4647-9737-b9cc4c113462',
  basis: { kind: 'external_request', note: '周期の提案' },
  scope: 'new',
  routine_id: null,
  expected_revision: null,
  definition,
}

// coach_prepare_routine_change records a descriptive proposal only: no rule/task writes,
// no inference, no auto-apply. Application stays owner-driven through the routine screens.
it('routine prepare records an owner-reviewable plan with replay bounds', async () => {
  await resetApp()
  const allowed = await createTask({ ...newTaskInput(), title: '許可タスク' })
  const settings0 = (await db.settings.get('main'))!
  const ruleId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
  const template = calendarFixture()
  await db.calendarRules.put({
    ...emptyCalendarRulesState(settings0.profileId, settings0.datasetId),
    contexts: template.contexts,
    bindings: template.bindings.map((binding) => ({ ...binding, personId: settings0.profileId })),
    calendars: template.calendars,
    activities: template.activities,
    sources: template.sources,
    facts: [],
    rules: [monthlyRule({ id: ruleId, revision: 3 })],
    instances: [],
  })
  const h = await bridgeHarness({ taskIds: [allowed], fields: ['title'], ruleIds: [ruleId] })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    expect(registration.client.grant.keys).toContain('routines:prepare')
    // New-scope proposals need no rule binding.
    const created = await dispatchExternalRoutineTool('coach_prepare_routine_change', { ...base, request_key: crypto.randomUUID() }, context)
    expect(created.state).toBe('awaiting_approval')
    expect(created.approval_url).toBeNull()
    expect(created.field_diffs).toHaveLength(1)
    // Existing-rule scope binds the granted rule and its exact revision.
    const kept = await dispatchExternalRoutineTool('coach_prepare_routine_change', {
      ...base, request_key: crypto.randomUUID(), scope: 'all_uncompleted', routine_id: ruleId, expected_revision: 3,
    }, context)
    expect(kept.state).toBe('awaiting_approval')
    await expect(dispatchExternalRoutineTool('coach_prepare_routine_change', {
      ...base, request_key: crypto.randomUUID(), scope: 'all_uncompleted', routine_id: ruleId, expected_revision: 2,
    }, context)).rejects.toThrow('REVISION_CONFLICT')
    await expect(dispatchExternalRoutineTool('coach_prepare_routine_change', {
      ...base, request_key: crypto.randomUUID(), scope: 'all_uncompleted', routine_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', expected_revision: 1,
    }, context)).rejects.toThrow('NOT_FOUND')
    // Same key replays the same plan; different content under the same key fails.
    const key = crypto.randomUUID()
    const first = await dispatchExternalRoutineTool('coach_prepare_routine_change', { ...base, request_key: key }, context)
    expect(await dispatchExternalRoutineTool('coach_prepare_routine_change', { ...base, request_key: key }, context)).toEqual(first)
    await expect(dispatchExternalRoutineTool('coach_prepare_routine_change', {
      ...base, request_key: key, definition: { ...definition, title: '別内容' },
    }, context)).rejects.toThrow('IDEMPOTENCY_MISMATCH')
    // Fake evidence refs fail closed; nothing was saved to rules or tasks.
    await expect(dispatchExternalRoutineTool('coach_prepare_routine_change', {
      ...base, request_key: crypto.randomUUID(), basis: { kind: 'app_instruction', reference_id: crypto.randomUUID() },
    }, context)).rejects.toThrow('UNVERIFIED_REFERENCE')
    expect((await db.calendarRules.get('main'))?.rules).toHaveLength(1)
    expect(await db.tasks.count()).toBe(1)
    // Routine plans are excluded from backup like other external proposal metadata.
    const { captureSnapshot } = await import('./backup')
    expect((await captureSnapshot()).commands.some((row) => /^externalroutine(plan|prepare):/.test(row.key))).toBe(false)
  } finally {
    await h.close()
  }
})

it('routine prepare without the routines:prepare scope is denied', async () => {
  await resetApp()
  const allowed = await createTask({ ...newTaskInput(), title: '許可タスク' })
  const h = await bridgeHarness({ taskIds: [allowed], fields: ['title'] })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    expect(registration.client.grant.keys).not.toContain('routines:prepare')
    await expect(dispatchExternalRoutineTool('coach_prepare_routine_change', { ...base, request_key: crypto.randomUUID() }, context)).rejects.toThrow('INSUFFICIENT_SCOPE')
  } finally {
    await h.close()
  }
})
