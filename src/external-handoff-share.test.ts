import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { db } from './db'
import { createTask, newTaskInput } from './commands'
import { createFileBridgeController } from './file-bridge-commands'
import { bridgeHarness, click, resetApp } from './command-test-harness'
import { externalAIFor } from './external-authority'
import { acceptHandoffDraft, dispatchExternalHandoffTool, listHandoffDrafts, rejectHandoffDraft } from './external-handoffs'
import { dispatchSharedContextTool, listContextSharePackages, revokeContextSharePackage, shareContextPackage } from './context-share'
import { captureSnapshot, restoreBackup } from './backup'
import { defaultSourcePermissions, importLocalSource } from './source-library'
import type { ExternalToolContext } from './external-tools'

const model = 'synthetic/coach-a'
function contextFor(registration: ExternalToolContext['registration'], ownerId: string, datasetId: string, epoch: number): ExternalToolContext {
  return {
    registration, ownerId, datasetId, externalEpoch: epoch,
    policyEpoch: registration.policy_epoch, sourcePermissionRevision: registration.source_permission_revision,
  }
}
function untrusted() { return new Event('click') }
async function source() {
  const id = await importLocalSource({
    title: '合成資料', provider: 'local', externalId: null, conversation: null, author: 'Karin',
    sourceUrl: null, date: '2026-10-01', fromDate: '2026-10-01', toDate: '2026-10-01',
    text: '見積書の金額は100万円です。', permissions: { ...defaultSourcePermissions(), aiEgress: true },
    allowedModels: [model], retentionUntil: null,
  })
  const snapshot = (await db.contextSnapshots.toArray()).find((row) => row.sourceId === id)!
  return { id, snapshot }
}

// Handoff drafts stay descriptive until native accept stores exactly one labeled note.
// Shares bind one recipient with expiry; every ref is re-checked on fetch.
it('handoff draft, native accept-once, reject and retention', async () => {
  await resetApp()
  const target = await createTask({ ...newTaskInput(), title: '対象タスク' })
  const other = await createTask({ ...newTaskInput(), title: '非共有タスク' })
  const h = await bridgeHarness({ taskIds: [target], fields: ['title'], allowHandoffPrepare: true })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    expect(registration.client.grant.keys).toContain('handoff:prepare')
    const key = crypto.randomUUID()
    const draft = await dispatchExternalHandoffTool('coach_prepare_handoff', {
      request_key: key, summary: '次は見積書を確認してください。', task_ids: [target],
    }, context) as { handoff_id: string; state: string; review_url: string }
    expect(draft.state).toBe('draft')
    expect(draft.review_url).toBe(`michi://handoff/${draft.handoff_id}`)
    expect(await dispatchExternalHandoffTool('coach_prepare_handoff', {
      request_key: key, summary: '次は見積書を確認してください。', task_ids: [target],
    }, context)).toEqual(draft)
    await expect(dispatchExternalHandoffTool('coach_prepare_handoff', {
      request_key: key, summary: '別内容', task_ids: [target],
    }, context)).rejects.toThrow('IDEMPOTENCY_MISMATCH')
    // Foreign tasks fail closed; drafts never enter memory or tasks by themselves.
    await expect(dispatchExternalHandoffTool('coach_prepare_handoff', {
      request_key: crypto.randomUUID(), summary: 'x', task_ids: [other],
    }, context)).rejects.toThrow('NOT_FOUND')
    expect(await db.tasks.count()).toBe(2)
    expect(await db.coachMemories.count()).toBe(0)
    expect(await db.taskNotes.count()).toBe(0)
    // Synthetic clicks cannot accept or reject.
    await expect(acceptHandoffDraft(draft.handoff_id, 1, null, untrusted())).rejects.toThrow()
    await expect(rejectHandoffDraft(draft.handoff_id, 1, untrusted())).rejects.toThrow()
    // Native accept stores exactly one labeled note; a second accept replays it.
    const listed = await listHandoffDrafts()
    expect(listed.map((row) => row.id)).toContain(draft.handoff_id)
    const noteId = await acceptHandoffDraft(draft.handoff_id, 1, null, click())
    const notes = await db.taskNotes.where('taskId').equals(target).toArray()
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ id: noteId, kind: 'source' })
    expect(notes[0].body).toContain('外部AIからの引継ぎ')
    expect(await acceptHandoffDraft(draft.handoff_id, 2, null, click())).toBe(noteId)
    expect(await db.taskNotes.where('taskId').equals(target).toArray()).toHaveLength(1)
    // Reject path stores nothing.
    const second = await dispatchExternalHandoffTool('coach_prepare_handoff', {
      request_key: crypto.randomUUID(), summary: '却下される案', task_ids: [target],
    }, context) as { handoff_id: string }
    await rejectHandoffDraft(second.handoff_id, 1, click())
    expect((await listHandoffDrafts()).find((row) => row.id === second.handoff_id)?.state).toBe('rejected')
    expect(await db.taskNotes.count()).toBe(1)
  } finally {
    await h.close()
  }
})

it('handoff without the scope is denied and target-less accept needs a home', async () => {
  await resetApp()
  const target = await createTask({ ...newTaskInput(), title: '対象タスク' })
  const h = await bridgeHarness({ taskIds: [target], fields: ['title'] })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = h.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    expect(registration.client.grant.keys).not.toContain('handoff:prepare')
    await expect(dispatchExternalHandoffTool('coach_prepare_handoff', {
      request_key: crypto.randomUUID(), summary: 'x', task_ids: [target],
    }, context)).rejects.toThrow('INSUFFICIENT_SCOPE')
  } finally {
    await h.close()
  }
  await resetApp()
  const solo = await createTask({ ...newTaskInput(), title: '対象タスク' })
  const g = await bridgeHarness({ taskIds: [solo], fields: ['title'], allowHandoffPrepare: true })
  try {
    const settings = (await db.settings.get('main'))!
    const registration = g.status().registration!
    const context = contextFor(registration, settings.profileId, settings.datasetId, externalAIFor(settings).epoch)
    const draft = await dispatchExternalHandoffTool('coach_prepare_handoff', {
      request_key: crypto.randomUUID(), summary: '宛先なし', task_ids: [],
    }, context) as { handoff_id: string }
    await expect(acceptHandoffDraft(draft.handoff_id, 1, null, click())).rejects.toThrow()
    expect(await db.taskNotes.count()).toBe(0)
  } finally {
    await g.close()
  }
})

it('recipient-bound share: fetch, wrong recipient, revoke, source delete and restore', async () => {
  await resetApp()
  const shared = await createTask({ ...newTaskInput(), title: '共有タスク' })
  await createTask({ ...newTaskInput(), title: '非共有タスク' })
  const { id: sourceId, snapshot } = await source()
  const h = await bridgeHarness({ taskIds: [shared], fields: ['title'], allowHandoffPrepare: true, allowHandoffs: true })
  try {
    const recipientA = h.status().registration!.client.id
    const other = createFileBridgeController(h.gateway)
    await other.configure({ intendedHost: 'claude', taskIds: [shared], fields: ['title'], lifetimeHours: 1, allowHandoffs: true }, click())
    const settings = (await db.settings.get('main'))!
    const clients = externalAIFor(settings).clients
    const outsiderB = clients.find((row) => row.registration.client.id !== recipientA)!.registration.client.id
    const contextOf = (clientId: string) => {
      const current = externalAIFor(settings)
      const row = current.clients.find((entry) => entry.registration.client.id === clientId)!
      return contextFor(row.registration, settings.profileId, settings.datasetId, current.epoch)
    }
    const packageId = await shareContextPackage({
      recipientClientId: recipientA, taskIds: [shared],
      sourceQuotes: [{ sourceId, snapshotRevision: snapshot.revision, spanId: snapshot.spans[0].id }],
    }, click())
    expect((await listContextSharePackages()).map((row) => row.id)).toContain(packageId)
    const fetched = await dispatchSharedContextTool('coach_get_shared_context', { package_id: packageId }, contextOf(recipientA)) as {
      id: string; tasks: { id: string; title: string }[]; excerpts: { text: string }[]; expires_at: string
    }
    expect(fetched.id).toBe(packageId)
    expect(fetched.tasks.map((row) => row.id)).toEqual([shared])
    expect(fetched.tasks[0].title).toBe('共有タスク')
    expect(JSON.stringify(fetched)).not.toContain('非共有タスク')
    expect(fetched.excerpts).toHaveLength(1)
    expect(fetched.excerpts[0].text).toContain('100万円')
    // Outsider client is denied without leaking counts or titles.
    await expect(dispatchSharedContextTool('coach_get_shared_context', { package_id: packageId }, contextOf(outsiderB))).rejects.toThrow('SHARE_UNAVAILABLE')
    // Synthetic clicks cannot revoke; native revoke denies later fetches.
    await expect(revokeContextSharePackage(packageId, untrusted())).rejects.toThrow()
    await revokeContextSharePackage(packageId, click())
    await expect(dispatchSharedContextTool('coach_get_shared_context', { package_id: packageId }, contextOf(recipientA))).rejects.toThrow('SHARE_UNAVAILABLE')
    // Restore clears share authority: drafts and packages do not survive.
    const snapshot0 = await captureSnapshot()
    expect(snapshot0.commands.some((row) => /^externalhandoff(request)?|^externalshare/.test(row.key))).toBe(false)
    await dispatchExternalHandoffTool('coach_prepare_handoff', {
      request_key: crypto.randomUUID(), summary: '復元で消える案', task_ids: [shared],
    }, contextOf(recipientA)).catch(() => null)
    await restoreBackup(snapshot0)
    expect(await db.externalHandoffs.count()).toBe(0)
    expect(await db.contextSharePackages.count()).toBe(0)
    expect((await db.tasks.get(shared))?.title).toBe('共有タスク')
  } finally {
    await h.close()
  }
})

it('a source deleted after sharing denies the whole package fetch', async () => {
  await resetApp()
  const shared = await createTask({ ...newTaskInput(), title: '共有タスク' })
  const { id: sourceId, snapshot } = await source()
  const h = await bridgeHarness({ taskIds: [shared], fields: ['title'], allowHandoffs: true })
  try {
    const recipientA = h.status().registration!.client.id
    const settings = (await db.settings.get('main'))!
    const current = externalAIFor(settings)
    const row = current.clients.find((entry) => entry.registration.client.id === recipientA)!
    const context = contextFor(row.registration, settings.profileId, settings.datasetId, current.epoch)
    const packageId = await shareContextPackage({
      recipientClientId: recipientA, taskIds: [shared],
      sourceQuotes: [{ sourceId, snapshotRevision: snapshot.revision, spanId: snapshot.spans[0].id }],
    }, click())
    const before = await dispatchSharedContextTool('coach_get_shared_context', { package_id: packageId }, context) as { excerpts: unknown[] }
    expect(before.excerpts).toHaveLength(1)
    await db.contextSources.update(sourceId, { deletedAt: new Date().toISOString() })
    await expect(dispatchSharedContextTool('coach_get_shared_context', { package_id: packageId }, context)).rejects.toThrow('SHARE_UNAVAILABLE')
  } finally {
    await h.close()
  }
})
