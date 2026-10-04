import type { SnapshotDocument } from './source-library'

function validateOcrMetadata(value: unknown): asserts value is NonNullable<SnapshotDocument['ocr']> {
  const row = value as NonNullable<SnapshotDocument['ocr']>
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'assetHash,engine,languages,license,pages,version') throw new Error('文書のOCR記録が不正です')
  if (typeof row.engine !== 'string' || !row.engine.trim() || row.engine.length > 100 || typeof row.version !== 'string' || !row.version.trim() || row.version.length > 40) throw new Error('文書のOCR記録が不正です')
  if (row.languages !== 'eng+jpn' || typeof row.license !== 'string' || !row.license.trim() || row.license.length > 500) throw new Error('文書のOCR記録が不正です')
  if (!/^[a-f0-9]{64}$/.test(row.assetHash)) throw new Error('文書のOCR記録が不正です')
  if (!Array.isArray(row.pages) || row.pages.length > 200) throw new Error('文書のOCR記録が不正です')
  for (const page of row.pages) {
    if (!page || typeof page !== 'object' || Array.isArray(page) || Object.keys(page).sort().join(',') !== 'chars,confidence,page,status,verified') throw new Error('文書のOCR記録が不正です')
    if (!Number.isSafeInteger(page.page) || page.page < 1 || page.page > 200 || typeof page.status !== 'string' || !page.status.trim() || page.status.length > 60) throw new Error('文書のOCR記録が不正です')
    if (!(page.confidence === null || typeof page.confidence === 'number' && page.confidence >= 0 && page.confidence <= 1) || !Number.isSafeInteger(page.chars) || page.chars < 0 || page.chars > 200000 || typeof page.verified !== 'boolean') throw new Error('文書のOCR記録が不正です')
  }
}

export function validateDocumentMetadata(value: unknown, lineCount: number): asserts value is SnapshotDocument {
  const row = value as SnapshotDocument
  const keys = row && typeof row === 'object' && !Array.isArray(row) ? Object.keys(row).sort().join(',') : ''
  if (keys !== 'fileSha256,format,locations,name,notices,size,unread' && keys !== 'fileSha256,format,locations,name,notices,ocr,size,unread') throw new Error('文書の出典位置・未読範囲が不正です')
  if (!['pdf', 'docx', 'pptx', 'xlsx'].includes(row.format) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 || !/^[a-f0-9]{64}$/.test(row.fileSha256) || !Number.isSafeInteger(row.size) || row.size < 1 || row.size > 25 * 1024 * 1024 || !Array.isArray(row.locations) || row.locations.length !== lineCount || row.locations.some(location => typeof location !== 'string' || !location.trim() || location.length > 300) || !Array.isArray(row.unread) || row.unread.length > 10000 || row.unread.some(item => !item || Object.keys(item).sort().join(',') !== 'location,reason' || typeof item.location !== 'string' || item.location.length > 300 || typeof item.reason !== 'string' || item.reason.length > 500) || !Array.isArray(row.notices) || row.notices.length > 30 || row.notices.some(text => typeof text !== 'string' || text.length > 500)) throw new Error('文書の出典位置・未読範囲が不正です')
  if (row.ocr !== undefined) validateOcrMetadata(row.ocr)
}
