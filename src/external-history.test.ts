import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { emptyScore } from './domain'
import { bridgeHarness, resetApp } from './command-test-harness'
import { externalAIFor } from './external-authority'
import { dispatchExternalReadTool, type ExternalToolContext } from './external-tools'

function contextFor(registration: ExternalToolContext['registration'], ownerId: string, datasetId: string, epoch: number): ExternalToolContext {
  return {
    registration, ownerId, datasetId, externalEpoch: epoch,
    policyEpoch: registration.policy_epoch, sourcePermissionRevision: registration.source_permission_revision,
  }
}

// coach_get_history aggregates only granted tasks within the requested range.
// Ungranted completions/sessions never affect the totals; memory and conversations stay out.
it('history returns granted-task aggregates with bounded ranges and scope gating', async () => {
  await resetApp()
  const allowed = await createTask({ ...newTaskInput(), title: '許可タスク', score: { ...emptyScore(), mode: 'manual', manualPoints: 25 } })
  const secret = await createTask({ ...newTaskInput(), title: '非共有タスク', score: { ...emptyScore(), mode: 'manual', manualPoints: 40 } })
  const h = await bridgeHarness({ taskIds: [allowed], fields: ['title'], allowHistory: true })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    expect(registration.client.grant.keys).toContain('history:read')
    await db.completions.add({
      id: 'completion-allowed', taskId: allowed, originalAt: '2026-10-02T01:00:00.000Z', currentAt: '2026-10-02T01:00:00.000Z',
      localDate: '2026-10-02', timezone: 'Asia/Tokyo', originalPoints: 25, netPoints: 25,
      title: '許可タスク', project: '', scoreState: 'confirmed',
    })
    await db.completions.add({
      id: 'completion-secret', taskId: secret, originalAt: '2026-10-02T02:00:00.000Z', currentAt: '2026-10-02T02:00:00.000Z',
      localDate: '2026-10-02', timezone: 'Asia/Tokyo', originalPoints: 40, netPoints: 40,
      title: '非共有タスク', project: '', scoreState: 'confirmed',
    })
    await db.sessions.add({ id: 'session-allowed', taskId: allowed, startedAt: '2026-10-02T03:00:00.000Z', endedAt: '2026-10-02T03:30:00.000Z', minutes: 30 })
    await db.sessions.add({ id: 'session-secret', taskId: secret, startedAt: '2026-10-02T04:00:00.000Z', endedAt: '2026-10-02T05:00:00.000Z', minutes: 60 })
    const total = await dispatchExternalReadTool('coach_get_history', { from: '2026-10-01', to: '2026-10-03' }, context) as {
      from: string; to: string; points: string; completed_count: number; unknown_score_count: number; work_minutes: number; scope_note: string; buckets: unknown[]
    }
    expect(total).toMatchObject({ from: '2026-10-01', to: '2026-10-03', points: '25', completed_count: 1, unknown_score_count: 0, work_minutes: 30, buckets: [] })
    expect(total.scope_note).not.toContain('非共有')
    const daily = await dispatchExternalReadTool('coach_get_history', { from: '2026-10-01', to: '2026-10-03', group_by: 'day' }, context) as { buckets: { from: string; to: string; points: string; completed_count: number }[] }
    expect(daily.buckets).toEqual([{ from: '2026-10-02', to: '2026-10-02', points: '25', completed_count: 1, unknown_score_count: 0, work_minutes: 30 }])
    // Bounds fail closed without touching the aggregates.
    await expect(dispatchExternalReadTool('coach_get_history', { from: '2026-10-03', to: '2026-10-01' }, context)).rejects.toThrow('INVALID_DATE_RANGE')
    await expect(dispatchExternalReadTool('coach_get_history', { from: '2025-01-01', to: '2026-06-01' }, context)).rejects.toThrow('DATE_RANGE_TOO_WIDE')
    await expect(dispatchExternalReadTool('coach_get_history', { from: '2026-13-40', to: '2026-10-03' }, context)).rejects.toThrow()
  } finally {
    await h.close()
  }
})

it('history without the history:read scope is denied', async () => {
  await resetApp()
  const allowed = await createTask({ ...newTaskInput(), title: '許可タスク' })
  const h = await bridgeHarness({ taskIds: [allowed], fields: ['title'] })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    expect(registration.client.grant.keys).not.toContain('history:read')
    await expect(dispatchExternalReadTool('coach_get_history', { from: '2026-10-01', to: '2026-10-03' }, context)).rejects.toThrow('INSUFFICIENT_SCOPE')
  } finally {
    await h.close()
  }
})
