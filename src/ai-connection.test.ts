import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { createTask, newTaskInput } from './commands'
import { prepareTaskChanges, applyChangeSet, changePolicyFor, type ChangeContext } from './change-set'
import { updateAIConnection } from './ai-connection'

beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings(); await updateAIConnection(true, 'provider/model') })
it('OFFから同じモデルで再接続しても、停止前の案を適用できない', async () => {
  const id = await createTask({ ...newTaskInput(), title: '停止の試験' })
  const settings = (await db.settings.get('main'))!
  const context: ChangeContext = { ownerId: settings.profileId, datasetId: settings.datasetId, principal: { id: 'local-coach', kind: 'coach', model: 'provider/model' }, allowedFields: ['notes', 'scheduledDate'], sourceRevisions: [] }
  const prepared = await prepareTaskChanges([{ taskId: id, expectedRevision: 1, patch: { notes: '変更しない' } }], context)
  await updateAIConnection(false)
  await updateAIConnection(true, 'provider/model')
  expect(changePolicyFor((await db.settings.get('main'))!).epoch).toBe(changePolicyFor(settings).epoch + 2)
  await expect(applyChangeSet(prepared, null, context, 'before-stop')).rejects.toThrow()
  expect((await db.tasks.get(id))!.notes).toBe('')
})
