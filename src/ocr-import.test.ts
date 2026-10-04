import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, ensureSettings } from './db'
import { ConflictError } from './commands'
import { validateDocumentMetadata } from './document-metadata'
import { addSourceRevision, defaultSourcePermissions, deleteSource, importLocalSource, readSource, searchSources, setSourcePermissions, sourceDb } from './source-library'
import { validateSourceRecords, verifySourceDigests } from './source-validation'

import type { SnapshotDocument } from './source-library'
const ocrDocument = (text: string): SnapshotDocument => {
  const lines = text.split('\n')
  return {
    format: 'pdf' as const,
    name: 'scan.pdf',
    fileSha256: 'b'.repeat(64),
    size: 1024,
    locations: lines.map((_, i) => `ページ1・OCR行${i + 1}`),
    unread: [],
    notices: ['OCR（端末内・外部送信なし）: engine v1'],
    ocr: {
      engine: 'michi-local-block-ocr',
      version: '1.0.0',
      languages: 'eng+jpn' as const,
      license: 'repo-local',
      assetHash: 'c'.repeat(64),
      pages: [{ page: 1, status: 'ok', confidence: 0.99, chars: text.length, verified: true }],
    },
  }
}
let ownerId: string
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'))
  await db.delete()
  await db.open()
  ownerId = (await ensureSettings()).profileId
})

describe('OCR文書の取込と検証', () => {
  it('OCRメタデータを行数と照合し、不正なengine記録を拒否する', () => {
    expect(() => validateDocumentMetadata(ocrDocument('MEETING 1000'), 1)).not.toThrow()
    const badHash = ocrDocument('MEETING 1000')
    badHash.ocr = { ...badHash.ocr!, assetHash: 'xyz' }
    expect(() => validateDocumentMetadata(badHash, 1)).toThrow('OCR')
    const badConfidence = ocrDocument('MEETING 1000')
    badConfidence.ocr = { ...badConfidence.ocr!, pages: [{ page: 1, status: 'ok', confidence: 2, chars: 1, verified: true }] }
    expect(() => validateDocumentMetadata(badConfidence, 1)).toThrow('OCR')
    const extraKey = ocrDocument('MEETING 1000') as unknown as Record<string, unknown>
    extraKey.ocr = { ...(extraKey.ocr as object), bbox: [] }
    expect(() => validateDocumentMetadata(extraKey, 1)).toThrow('OCR')
    // OCRなしの従来文書はそのまま通る
    const legacy: SnapshotDocument = { ...ocrDocument('MEETING 1000'), ocr: undefined }
    expect(() => validateDocumentMetadata(legacy, 1)).not.toThrow()
    // 行数不一致は拒否
    expect(() => validateDocumentMetadata(ocrDocument('A\nB'), 1)).toThrow('出典位置')
  })

  it('OCR取込は本文・出典・索引を保存し、タスク・台帳・候補を自動生成しない', async () => {
    const id = await importLocalSource({
      title: 'スキャン議事録', provider: 'local', externalId: null, conversation: null, author: null, sourceUrl: null,
      date: '2026-10-04', fromDate: '2026-10-04', toDate: '2026-10-04', text: 'MEETING 1000',
      document: ocrDocument('MEETING 1000'), permissions: defaultSourcePermissions(), allowedModels: [], retentionUntil: null,
    })
    const { snapshot } = await readSource(id)
    expect(snapshot.document?.ocr?.engine).toBe('michi-local-block-ocr')
    expect(snapshot.document?.locations).toEqual(['ページ1・OCR行1'])
    expect((await searchSources('MEETING', '2026-10-04', '2026-10-04')).hits.length).toBe(1)
    expect(await db.tasks.count()).toBe(0)
    expect(await sourceDb.sourceArtifacts.where('sourceId').equals(id).count()).toBe(0)
    const data = { sources: await sourceDb.contextSources.toArray(), snapshots: await sourceDb.contextSnapshots.toArray(), summaries: await sourceDb.sourceSummaries.toArray(), artifacts: await sourceDb.sourceArtifacts.toArray() }
    const policy = (await db.settings.get('main'))!.changePolicy
    expect(() => validateSourceRecords(data.sources, data.snapshots, data.summaries, data.artifacts, ownerId, policy)).not.toThrow()
    await expect(verifySourceDigests(data.snapshots, data.summaries)).resolves.toBeUndefined()
  })

  it('OCR資料の削除・許可取消・期限は派生物を消去し、古い版の遅延応答を採用しない', async () => {
    const id = await importLocalSource({
      title: 'スキャン資料', provider: 'local', externalId: null, conversation: null, author: null, sourceUrl: null,
      date: '2026-10-04', fromDate: '2026-10-04', toDate: '2026-10-04', text: '本人確認',
      document: ocrDocument('本人確認'), permissions: defaultSourcePermissions(), allowedModels: [], retentionUntil: null,
    })
    await expect(addSourceRevision(id, 999, { text: '本人確認', document: ocrDocument('本人確認') })).rejects.toThrow(ConflictError)
    await setSourcePermissions(id, 1, { ...defaultSourcePermissions(), retain: false }, [], null)
    expect(await sourceDb.contextSnapshots.where('sourceId').equals(id).count()).toBe(0)
    await expect(readSource(id)).rejects.toThrow('許可')
    await deleteSource(id, 2)
    expect((await searchSources('本人', '2026-10-04', '2026-10-04')).hits).toEqual([])
  })
})
