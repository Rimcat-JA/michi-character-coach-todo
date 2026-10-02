import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { db, ensureSettings } from './db'
import { importLocalSource, addSourceRevision, defaultSourcePermissions, spanLocation } from './source-library'
import { captureSnapshot } from './backup'
import { validateSnapshot } from './backup-validation'
beforeEach(async () => { await db.delete(); await db.open(); await ensureSettings() })
const metadata = { format: 'docx' as const, name: 'test.docx', fileSha256: 'a'.repeat(64), size: 100, locations: ['段落1'], unread: [], notices: [] }
const input = () => ({ title: '文書', text: '提出', document: metadata, provider: 'local' as const, externalId: null, conversation: null, author: null, sourceUrl: null, date: '2026-10-01', fromDate: '2026-10-01', toDate: '2026-10-01', permissions: defaultSourcePermissions(), allowedModels: [], retentionUntil: null })
it('文書位置をbackupに保持し、同じ資料IDで版を上げ、候補・索引を消す', async () => {
  const id = await importLocalSource(input()), snapshot = (await db.contextSnapshots.get(`${id}:1`))!
  expect(spanLocation(snapshot, snapshot.spans[0].id)).toBe('段落1')
  const settings = (await db.settings.get('main'))!
  await db.sourceArtifacts.add({ id: `embedding:${id}`, ownerId: settings.profileId, sourceId: id, sourceRevision: 1, permissionRevision: 1, kind: 'embedding', payload: '{}', createdAt: new Date().toISOString() })
  expect((await captureSnapshot()).sourceArtifacts).toEqual([])
  await addSourceRevision(id, 1, { text: '訂正後の依頼', document: { ...metadata, fileSha256: 'b'.repeat(64) } })
  expect((await db.contextSources.get(id))!.latestRevision).toBe(2); expect(await db.contextSources.count()).toBe(1); expect(await db.contextSnapshots.count()).toBe(2); expect(await db.sourceArtifacts.count()).toBe(0)
  expect(await db.tasks.count()).toBe(0); expect(await db.ledger.count()).toBe(0)
  const backup = await captureSnapshot(); expect(() => validateSnapshot(backup)).not.toThrow()
})
it('凍結と期限切れは新規取込・改訂を止め、文書位置の偽装を拒否する', async () => {
  const id = await importLocalSource(input())
  await db.datasetState.put({ id: 'main', mode: 'frozen', updatedAt: new Date().toISOString(), moveId: 'move' })
  await expect(importLocalSource(input())).rejects.toThrow('凍結'); await expect(addSourceRevision(id, 1, { text: 'new' })).rejects.toThrow('凍結')
  await db.datasetState.delete('main'); await expect(importLocalSource({ ...input(), document: { ...metadata, locations: [] } })).rejects.toThrow('出典位置')
  await db.contextSources.update(id, { retentionUntil: '2020-01-01T00:00:00.000Z' }); await expect(addSourceRevision(id, 1, { text: 'new' })).rejects.toThrow()
})
