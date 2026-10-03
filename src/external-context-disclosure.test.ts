import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { bridgeHarness, resetApp } from './command-test-harness'
import { externalAIFor } from './external-authority'
import { dispatchExternalReadTool, type ExternalToolContext } from './external-tools'
import { defaultSourcePermissions, importLocalSource } from './source-library'

const model = 'synthetic/coach-a'
function contextFor(registration: ExternalToolContext['registration'], ownerId: string, datasetId: string, epoch: number): ExternalToolContext {
  return {
    registration, ownerId, datasetId, externalEpoch: epoch,
    policyEpoch: registration.policy_epoch, sourcePermissionRevision: registration.source_permission_revision,
  }
}
async function source() {
  return importLocalSource({
    title: '合成資料', provider: 'local', externalId: null, conversation: null, author: 'Karin',
    sourceUrl: null, date: '2026-10-01', fromDate: '2026-10-01', toDate: '2026-10-01',
    text: '見積書の金額は100万円です。納期は来週です。', permissions: { ...defaultSourcePermissions(), aiEgress: true },
    allowedModels: [model], retentionUntil: null,
  })
}

// Context search discloses only currently permitted sources to a consented client.
// Without the key or the flag it stays empty with a reason that leaks nothing.
it('context search gates excerpts on scope, consent and live permission', async () => {
  await resetApp()
  const allowed = await createTask({ ...newTaskInput(), title: '許可タスク' })
  const sourceId = await source()
  const consented = await bridgeHarness({ taskIds: [allowed], fields: ['title'], allowContextRead: true, allowExternalContext: true })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = consented.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    expect(registration.client.grant.keys).toContain('context:read')
    expect(registration.client.grant.allow_external_context).toBe(true)
    const found = await dispatchExternalReadTool('coach_search_context', { query: '100万円', scope_ids: [sourceId], limit: 5 }, context) as {
      excerpts: { id: string; text: string; trust: string }[]; coverage_note: string
    }
    expect(found.excerpts).toHaveLength(1)
    expect(found.excerpts[0].text).toContain('100万円')
    expect(found.excerpts[0].trust).toBe('user_shared')
    const missed = await dispatchExternalReadTool('coach_search_context', { query: '存在しない語句です', scope_ids: [sourceId] }, context) as { excerpts: unknown[] }
    expect(missed.excerpts).toEqual([])
  } finally {
    await consented.close()
  }
  // Same source, unconsented client: empty with reason, no leak.
  const plain = await bridgeHarness({ taskIds: [allowed], fields: ['title'], allowContextRead: true })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = plain.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    expect(registration.client.grant.allow_external_context).toBe(false)
    const denied = await dispatchExternalReadTool('coach_search_context', { query: '100万円', scope_ids: [sourceId] }, context) as {
      excerpts: unknown[]; coverage_note: string
    }
    expect(denied.excerpts).toEqual([])
    expect(denied.coverage_note).toContain('許可されていません')
  } finally {
    await plain.close()
  }
})
