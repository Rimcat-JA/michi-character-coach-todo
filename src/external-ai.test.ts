import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi, afterEach } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { applyChangeSet, changePolicyFor, clearChangeSetAuthority, prepareTaskChanges, type ChangeContext } from './change-set'
import { updateAIConnection } from './ai-connection'
import { setExternalAIEnabled } from './external-ai'
import { defaultExternalAI, externalAIFor, validateExternalAI } from './external-authority'
import { captureSnapshot, restoreBackup } from './backup'
import { reduceAuthority } from './automation-control'
beforeEach(async () => { clearChangeSetAuthority(); await db.delete(); await db.open(); await ensureSettings() })
afterEach(() => vi.unstubAllGlobals())
const click = () => { const event = new Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); return event }
async function context(kind: 'coach'|'external-agent'): Promise<ChangeContext> {
  const s = (await db.settings.get('main'))!
  return { ownerId: s.profileId, datasetId: s.datasetId, principal: { kind, id: kind === 'coach' ? 'app-coach' : crypto.randomUUID() }, allowedFields: ['notes','scheduledDate'], sourceRevisions: [] }
}
it('external AI is OFF by default and enabling requires the native owner event', async () => {
  expect(externalAIFor((await db.settings.get('main'))!).enabled).toBe(false)
  await expect(setExternalAIEnabled(true, new Event('click'))).rejects.toThrow()
  await expect(setExternalAIEnabled(true)).rejects.toThrow()
  await setExternalAIEnabled(true, click())
  expect(externalAIFor((await db.settings.get('main'))!).enabled).toBe(true)
})
it('external stop keeps BYOK, model, reminders and shared policy intact; stale external proposals do not revive', async () => {
  await updateAIConnection(true, 'synthetic/coach'); await setExternalAIEnabled(true, click())
  const s = (await db.settings.get('main'))!, policy = changePolicyFor(s)
  await db.settings.update('main', { notifications: true, changePolicy: { ...policy, taskUpdate: 'auto_within_bounds' } })
  const external = await context('external-agent'), id = await createTask({ ...newTaskInput(), title: '本人の25pt', scheduledDate: '2026-10-03' })
  const proposal = await prepareTaskChanges([{ taskId: id, expectedRevision: 1, patch: { scheduledDate: '2026-10-04' } }], external)
  const invalidate = vi.fn(); vi.stubGlobal('window', { michiFileBridge: { invalidate } })
  await setExternalAIEnabled(false); await setExternalAIEnabled(true, click())
  const next = (await db.settings.get('main'))!
  expect(next.aiEnabled).toBe(true); expect(next.aiModel).toBe(s.aiModel); expect(next.aiConnectionEpoch).toBe(s.aiConnectionEpoch)
  expect(next.notifications).toBe(true); expect(changePolicyFor(next).epoch).toBe(policy.epoch)
  await expect(applyChangeSet(proposal, null, external, 'old-external')).rejects.toThrow()
  expect((await db.tasks.get(id))!.scheduledDate).toBe('2026-10-03'); expect(invalidate).toHaveBeenCalledTimes(2)
})
it('BYOK stop/resume preserves an external prepared change and external epoch while canceling coach authority', async () => {
  await updateAIConnection(true, 'synthetic/coach'); await setExternalAIEnabled(true, click())
  const s = (await db.settings.get('main'))!, policy = changePolicyFor(s)
  await db.settings.update('main', { changePolicy: { ...policy, taskUpdate: 'auto_within_bounds' } })
  const external = await context('external-agent'), coach = await context('coach')
  const a = await createTask({ ...newTaskInput(), title: '外部' }), b = await createTask({ ...newTaskInput(), title: 'コーチ' })
  const ext = await prepareTaskChanges([{ taskId: a, expectedRevision: 1, patch: { notes: '外部の案' } }], external)
  const app = await prepareTaskChanges([{ taskId: b, expectedRevision: 1, patch: { notes: '古いコーチ案' } }], coach)
  const invalidate = vi.fn(); vi.stubGlobal('window', { michiFileBridge: { invalidate } })
  await updateAIConnection(false); await applyChangeSet(ext, null, external, 'external-during-byok-off')
  await updateAIConnection(true, 'synthetic/coach')
  expect(externalAIFor((await db.settings.get('main'))!).epoch).toBe(externalAIFor(s).epoch)
  expect(invalidate).not.toHaveBeenCalled(); expect((await db.tasks.get(a))!.notes).toBe('外部の案')
  await expect(applyChangeSet(app, null, coach, 'old-coach')).rejects.toThrow(); expect((await db.tasks.get(b))!.notes).toBe('')
})
it('N09 global AI processing stop also disables external AI, and BYOK resume cannot revive it', async () => {
  await setExternalAIEnabled(true, click()); await reduceAuthority('aiProcessing', 'button')
  await updateAIConnection(true, 'synthetic/coach')
  expect(externalAIFor((await db.settings.get('main'))!).enabled).toBe(false)
})
it('backup excludes connection registrations and restore keeps external disabled', async () => {
  await setExternalAIEnabled(true, click())
  const s = (await db.settings.get('main'))!
  await db.commands.put({ key: `filebridge:scope:${s.profileId}:${s.datasetId}`, hash: 'legacy-scope', resultId: 'private-registration', at: new Date().toISOString() })
  const snapshot = await captureSnapshot()
  expect(snapshot.settings[0].externalAI?.clients).toEqual([]); expect(snapshot.settings[0].externalAI?.enabled).toBe(false)
  expect(snapshot.commands.some(row => row.resultId.includes('private-registration'))).toBe(false)
  await restoreBackup(snapshot); expect(externalAIFor((await db.settings.get('main'))!).enabled).toBe(false)
})
it('malformed authority and fabricated real-host acceptance cannot be saved', () => {
  for (const bad of [{ ...defaultExternalAI(), enabled: 'yes' }, { ...defaultExternalAI(), approved: true }, { ...defaultExternalAI(), epoch: -1 }, { ...defaultExternalAI(), clients: [{ shippingState: 'integration_verified' }] }]) expect(() => validateExternalAI(bad)).toThrow()
})
