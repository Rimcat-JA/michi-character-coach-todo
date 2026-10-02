import Dexie from 'dexie'
import { allowWhileFrozen } from './dataset-guard'
import { db as baseDb } from './db'
import { ConflictError } from './commands'
import { changePolicyFor } from './change-set'
import { uid, validateDate } from './domain'
import type { CoachMemory, MemoryTombstone } from './coach-memory'
import { purgeChatSourceResponses } from './chat-history'
import { purgeCoachNotificationSource } from './coach-notification-save'
import type { CoachMessage } from './chat-history'
import { legacyReviewTasks, purgeTaskSourceEvidence, scrubLegacySourceCopies, type LegacyReviewTask } from './task-source-evidence'
import { candidateExpired, defaultSourceRetention } from './retention-defaults'
import { withdrawSourceObligations } from './detection-ledger'
import { validateDocumentMetadata } from './document-metadata'
import { assertSourceProcessingActive } from './source-processing-guard'

export type SourceProvider = 'local' | 'slack' | 'line' | 'teams' | 'discord' | 'other'
export type SourcePermissions = { acquire: boolean; retain: boolean; index: boolean; aiEgress: boolean; notify: boolean; externalWrite: boolean; disclose: boolean }
export type ContextSource = {
  id: string; ownerId: string; title: string; provider: SourceProvider; externalId: string | null; conversation: string | null; author: string | null; sourceUrl: string | null
  date: string; timezone: string; revision: number; latestRevision: number; permissionRevision: number; permissions: SourcePermissions
  aiProvider: 'openrouter'; allowedModels: string[]; coverage: { fromDate: string; toDate: string; complete: false; method: 'manual-import'; lastCheckedAt: string }
  retentionUntil: string | null; createdAt: string; updatedAt: string; deletedAt: string | null
}
export type SourceSpan = { id: string; index: number; start: number; end: number; text: string }
/** Office/PDF extraction metadata: locations[i] names where span i came from (page, paragraph, slide or cell). The original file is not kept, only its whole-file hash. */
export type SnapshotDocument = { format: 'pdf' | 'docx' | 'pptx' | 'xlsx'; name: string; fileSha256: string; size: number; locations: string[]; unread: { location: string; reason: string }[]; notices: string[] }
export type ContextSnapshot = { id: string; sourceId: string; ownerId: string; revision: number; originalText: string; text: string; sha256: string; spans: SourceSpan[]; createdAt: string; document?: SnapshotDocument }
export type SourceSummary = { id: string; ownerId: string; sourceId: string; sourceRevision: number; permissionRevision: number; policyEpoch: number; sourcePermissionRevision: number; model: string; provider: 'openrouter'; text: string; sha256: string; createdAt: string }
export type SourceArtifact = { id: string; ownerId: string; sourceId: string; sourceRevision: number; permissionRevision: number; kind: 'cache' | 'embedding' | 'candidate'; payload: string; createdAt: string }
/** retentionUntil omitted = design default (conversation exports 90 days, local documents none); null = owner chose no expiry. */
export type SourceImport = Pick<ContextSource, 'title' | 'provider' | 'externalId' | 'conversation' | 'author' | 'sourceUrl' | 'date' | 'permissions' | 'allowedModels'> & { retentionUntil?: string | null; text: string; fromDate: string; toDate: string; timezone?: string; document?: SnapshotDocument }
export type SourceErasure = { original: number; summaries: number; caches: number; embeddings: number; candidates: number; memories: number; aiReplies: number; taskQuotes: number; legacyCopies: number }
export type SourceDeletionReport = { sourceId: string; alreadyDeleted: boolean; erased: SourceErasure; reviewTaskIds: string[]; reviewTasks: LegacyReviewTask[]; sentModels: string[] }
export type SourceSendRoute = 'source-summary' | 'source-detection' | 'coach-chat'
export type SourceDerivedCounts = { summaries: number; caches: number; embeddings: number; candidates: number; taskQuotes: number; memories: number }
export const sourceDb = baseDb
/** Page/paragraph/cell of a span id (`${snapshotId}:${index}`), when the snapshot came from an extracted document. */
export function spanLocation(snapshot: Pick<ContextSnapshot, 'id' | 'document'> | undefined, spanId: string): string | null {
  if (!snapshot?.document || !spanId.startsWith(`${snapshot.id}:`)) return null
  const index = Number(spanId.slice(snapshot.id.length + 1))
  return Number.isSafeInteger(index) ? snapshot.document.locations[index] ?? null : null
}
const db = sourceDb
const providerNames: SourceProvider[] = ['local', 'slack', 'line', 'teams', 'discord', 'other']
export const permissionKeys = ['acquire', 'retain', 'index', 'aiEgress', 'notify', 'externalWrite', 'disclose'] as const
export const defaultSourcePermissions = (): SourcePermissions => ({ acquire: true, retain: true, index: true, aiEgress: false, notify: false, externalWrite: false, disclose: false })
export function validateSourcePermissions(value: unknown): asserts value is SourcePermissions {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== permissionKeys.length || permissionKeys.some(key => !Object.hasOwn(value, key) || typeof (value as Record<string, unknown>)[key] !== 'boolean')) throw new Error('資料の7項目の許可を確認してください')
}
export function validateSourceModels(models: unknown): asserts models is string[] {
  if (!Array.isArray(models) || models.length > 20 || models.some(model => typeof model !== 'string' || !/^[\w~./:-]{3,120}$/.test(model)) || new Set(models).size !== models.length) throw new Error('許可するOpenRouterモデルIDを確認してください')
}
export function normalizeSourceText(text: string) {
  if (typeof text !== 'string' || !text.trim() || text.length > 200000) throw new Error('資料本文は1〜200000文字で指定してください')
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').normalize('NFC')
}
export function sourceSpans(snapshotId: string, text: string): SourceSpan[] {
  let start = 0
  const spans = text.split('\n').map((line, index) => { const span = { id: `${snapshotId}:${index}`, index, start, end: start + line.length, text: line }; start += line.length + 1; return span })
  if (spans.length > 10000) throw new Error('資料の行数が10000行を超えています')
  return spans
}
async function hash(text: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('') }
function validTime(value: string | null) {
  if (value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) throw new Error('保持期限の日時を確認してください')
}
const live = (source: ContextSource, ownerId: string) => source.ownerId === ownerId && !source.deletedAt && (source.retentionUntil === null || Date.parse(source.retentionUntil) > Date.now())
const canRead = (source: ContextSource, ownerId: string) => live(source, ownerId) && source.permissions.acquire && source.permissions.retain
async function owner() { const settings = await db.settings.get('main'); if (!settings || !settings.profileId.trim()) throw new Error('本人の設定がありません'); return settings }
async function bumpPolicy() {
  const settings = await owner(), policy = changePolicyFor(settings)
  if (!Number.isSafeInteger(policy.epoch + 1) || !Number.isSafeInteger(policy.sourcePermissionRevision + 1)) throw new Error('資料の権限版が上限に達しています')
  await db.settings.put({ ...settings, changePolicy: { ...policy, epoch: policy.epoch + 1, sourcePermissionRevision: policy.sourcePermissionRevision + 1 } })
}
// Expiry erases the same rows but needs no report, so tasks, receipts and audits stay unlocked.
const expiryTables = () => [db.contextSources, db.contextSnapshots, db.sourceSummaries, db.sourceArtifacts, db.coachMemories, db.memoryTombstones, db.coachConversations, db.coachMessages, db.settings, db.taskSourceEvidence, db.taskNotes, db.detectedObligations, db.obligationObservations]
const purgeTables = () => [...expiryTables(), db.tasks, db.audits, db.commands]
/** Redacted deletion record shared by manual deletion, expiry and restore. */
export function erasedSourceRow(source: ContextSource, at: string): ContextSource {
  return { ...source, title: '削除した資料', externalId: null, conversation: null, author: null, sourceUrl: null, permissions: Object.fromEntries(permissionKeys.map(key => [key, false])) as SourcePermissions, revision: source.revision + 1, permissionRevision: source.permissionRevision + 1, deletedAt: at, updatedAt: at }
}
/** Body-free, append-only record that this source's text left for a model. Never purged: the provider copy cannot be recalled (design 23.3). */
export async function recordSourceSent(source: Pick<ContextSource, 'id' | 'latestRevision' | 'permissionRevision'>, model: string, route: SourceSendRoute): Promise<void> {
  await db.audits.add({ id: uid(), taskId: null, operation: 'source.sent', at: new Date().toISOString(), detail: JSON.stringify({ sourceId: source.id, model, route, snapshotRevision: source.latestRevision, permissionRevision: source.permissionRevision }) })
}
function usesSource(memory: CoachMemory, sourceId: string) { return memory.sources.some(ref => (ref.kind as string) === 'library' && ref.refId === sourceId || ref.kind === 'derived-summary' && ref.refId === `library:${sourceId}`) }
async function purgeDerived(source: ContextSource, at: string, quotes: boolean): Promise<Omit<SourceErasure, 'original' | 'legacyCopies'>> {
  await purgeCoachNotificationSource(source.id, at)
  const aiReplies = await purgeChatSourceResponses(source.id, source.ownerId), artifacts = await db.sourceArtifacts.where('sourceId').equals(source.id).toArray()
  const erased = { summaries: await db.sourceSummaries.where('sourceId').equals(source.id).delete(), caches: artifacts.filter(row => row.kind === 'cache').length, embeddings: artifacts.filter(row => row.kind === 'embedding').length, candidates: artifacts.filter(row => row.kind === 'candidate').length, memories: 0, aiReplies, taskQuotes: quotes ? await purgeTaskSourceEvidence(source.id) + await db.taskNotes.where('ownerId').equals(source.ownerId).filter(note=>note.kind==='source'&&note.sourceId===source.id).delete() : 0 }
  await db.sourceArtifacts.where('sourceId').equals(source.id).delete()
  // Erasure is 出典失効: open ledger observations are withdrawn, digests stay so a dismissal still suppresses a re-import.
  if (quotes) await withdrawSourceObligations(source.ownerId, source.id, at)
  const memories = await db.coachMemories.where('ownerId').equals(source.ownerId).toArray()
  for (const memory of memories) if (!memory.sourcePurged && !memory.contentPurged && usesSource(memory, source.id)) {
    erased.memories++
    const existing = new Set((await db.memoryTombstones.where('ownerId').equals(source.ownerId).toArray()).map(row => row.sourceKey))
    for (const tombstone of await db.memoryTombstones.where('ownerId').equals(source.ownerId).toArray()) if (tombstone.memoryId === memory.id) await db.memoryTombstones.put({ ...tombstone, reason: 'source-deleted', at })
    for (const ref of memory.sources) {
      const sourceKey = JSON.stringify([ref.kind, ref.refId, ref.revision, ref.digest])
      if (!existing.has(sourceKey)) await db.memoryTombstones.add({ id: uid(), ownerId: source.ownerId, memoryId: memory.id, sourceKey, reason: 'source-deleted', at } satisfies MemoryTombstone)
    }
    // Source-derived text and its historical copies must not survive as a hidden cache.
    await db.coachMemories.put({ ...memory, text: '', sourcePurged: true, history: [], revision: memory.revision + 1, deletedAt: at, updatedAt: at })
  }
  return erased
}
// Models that already received this source's text; the provider copy cannot be recalled (design 23.3).
async function sentModels(source: ContextSource): Promise<string[]> {
  const models = new Set((await db.sourceSummaries.where('sourceId').equals(source.id).toArray()).map(row => row.model))
  for (const row of await db.sourceArtifacts.where('sourceId').equals(source.id).toArray()) if (row.kind === 'candidate') { try { const payload = JSON.parse(row.payload) as { detectorModel?: unknown; verifierModel?: unknown }; for (const model of [payload.detectorModel, payload.verifierModel]) if (typeof model === 'string') models.add(model) } catch { /* Malformed caches carry no provenance. */ } }
  for (const audit of await db.audits.toArray()) if (audit.operation === 'detection.approved' || audit.operation === 'source.sent' || audit.operation.startsWith('egress.')) {
    try {
      const detail = JSON.parse(audit.detail) as { source?: { sourceId?: unknown }; detectorModel?: unknown; sourceId?: unknown; model?: unknown; tasks?: { sources?: { sourceId?: unknown }[] }[] }
      if (audit.operation === 'detection.approved') { if (detail.source?.sourceId === source.id && typeof detail.detectorModel === 'string') models.add(detail.detectorModel); if (detail.source?.sourceId === source.id && typeof (detail as { verifierModel?: unknown }).verifierModel === 'string') models.add((detail as { verifierModel: string }).verifierModel) }
      else if (typeof detail.model === 'string' && (detail.sourceId === source.id || Array.isArray(detail.tasks) && detail.tasks.some(task => Array.isArray(task?.sources) && task.sources.some(ref => ref?.sourceId === source.id)))) models.add(detail.model)
    } catch { /* Plain audit text is not send provenance. */ }
  }
  for (const message of await db.coachMessages.where('ownerId').equals(source.ownerId).toArray()) if (message.origin === 'live_ai' && message.model && message.selectedSources.some(ref => ref.kind === 'library' && ref.id === source.id)) models.add(message.model)
  return [...models].sort()
}

export async function importLocalSource(input: SourceImport): Promise<string> {
  await assertSourceProcessingActive()
  const text = normalizeSourceText(input.text)
  if (input.document) validateDocumentMetadata(input.document, text.split('\n').length)
  const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  try { if (typeof timezone !== 'string' || !timezone.trim() || timezone.length > 100) throw new Error(); new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format() } catch { throw new Error('資料のタイムゾーンを確認してください') }
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || !providerNames.includes(input.provider)) throw new Error('資料名と由来を確認してください')
  for (const value of [input.externalId, input.conversation, input.author]) if (value !== null && (typeof value !== 'string' || value.length > 200)) throw new Error('資料の識別情報を確認してください')
  if (input.sourceUrl !== null) { try { const url = new URL(input.sourceUrl); if (!['http:', 'https:'].includes(url.protocol) || input.sourceUrl.length > 2000) throw new Error() } catch { throw new Error('出典URLを確認してください') } }
  for (const date of [input.date, input.fromDate, input.toDate]) { if (typeof date !== 'string' || !date) throw new Error('資料の日付と取得範囲を確認してください'); validateDate(date, '取得範囲') }
  if (input.fromDate > input.toDate || input.date < input.fromDate || input.date > input.toDate) throw new Error('資料の日付を取得範囲内にしてください')
  const retentionUntil = input.retentionUntil === undefined ? defaultSourceRetention(input.provider) : input.retentionUntil
  validateSourcePermissions(input.permissions); validateSourceModels(input.allowedModels); validTime(retentionUntil)
  if (!input.permissions.acquire || !input.permissions.retain) throw new Error('取り込みには取得と保存の許可が必要です')
  if (input.permissions.aiEgress && !input.allowedModels.length) throw new Error('AI送信を許可するモデルIDを指定してください')
  if (retentionUntil !== null && Date.parse(retentionUntil) <= Date.now()) throw new Error('保持期限は未来の日時にしてください')
  const digest = await Dexie.waitFor(hash(text)), id = uid(), snapshotId = `${id}:1`, spans = sourceSpans(snapshotId, text), at = new Date().toISOString()
  return db.transaction('rw', [db.contextSources, db.contextSnapshots, db.settings, db.datasetState], async () => {
    await assertSourceProcessingActive()
    const settings = await owner()
    const existing = await db.contextSources.where('ownerId').equals(settings.profileId).toArray()
    if (existing.length >= 10000) throw new Error('資料は10000件まで取り込めます')
    for (const source of existing.filter(source => live(source, settings.profileId) && source.provider === input.provider && source.externalId === input.externalId && source.title === input.title.trim())) {
      const snapshot = await db.contextSnapshots.get(`${source.id}:${source.latestRevision}`)
      if (snapshot?.sha256 === digest && snapshot.document?.fileSha256 === input.document?.fileSha256) return source.id
    }
    await bumpPolicy()
    await db.contextSources.add({ id, ownerId: settings.profileId, title: input.title.trim(), provider: input.provider, externalId: input.externalId, conversation: input.conversation, author: input.author, sourceUrl: input.sourceUrl, date: input.date, timezone, revision: 1, latestRevision: 1, permissionRevision: 1, permissions: { ...input.permissions }, aiProvider: 'openrouter', allowedModels: [...input.allowedModels], coverage: { fromDate: input.fromDate, toDate: input.toDate, complete: false, method: 'manual-import', lastCheckedAt: at }, retentionUntil, createdAt: at, updatedAt: at, deletedAt: null })
    await db.contextSnapshots.add({ id: snapshotId, sourceId: id, ownerId: settings.profileId, revision: 1, originalText: input.text, text, sha256: digest, spans, createdAt: at, ...(input.document ? { document: structuredClone(input.document) } : {}) })
    return id
  })
}

/** Owner accepts a watched file's new revision; missing files never call this operation. */
export async function addSourceRevision(id: string, expectedRevision: number, input: { text: string; document?: SnapshotDocument }) {
  await assertSourceProcessingActive()
  const text = normalizeSourceText(input.text)
  if (input.document) validateDocumentMetadata(input.document, text.split('\n').length)
  const digest = await hash(text)
  return db.transaction('rw', [...purgeTables(), db.datasetState], async () => {
    await assertSourceProcessingActive()
    const settings = await owner(), source = await db.contextSources.get(id)
    if (!source || !canRead(source, settings.profileId) || source.revision !== expectedRevision) throw new ConflictError()
    const previous = await db.contextSnapshots.get(`${id}:${source.latestRevision}`)
    if (previous?.sha256 === digest && previous.document?.fileSha256 === input.document?.fileSha256) return source.latestRevision
    const revision = source.latestRevision + 1, snapshotId = `${id}:${revision}`, at = new Date().toISOString()
    if (revision > 100000) throw new Error('資料の版数が上限に達しています')
    // Previous original and citations are retained; candidates, vectors, and model replies expire.
    await purgeDerived(source, at, false)
    await withdrawSourceObligations(source.ownerId, id, at)
    await bumpPolicy()
    await db.contextSources.put({ ...source, latestRevision: revision, revision: source.revision + 1, updatedAt: at, coverage: { ...source.coverage, lastCheckedAt: at } })
    await db.contextSnapshots.add({ id: snapshotId, sourceId: id, ownerId: settings.profileId, revision, originalText: input.text, text, sha256: digest, spans: sourceSpans(snapshotId, text), createdAt: at, ...(input.document ? { document: structuredClone(input.document) } : {}) })
    return revision
  })
}

export async function setSourcePermissions(id: string, expectedRevision: number, permissions: SourcePermissions, allowedModels: string[], retentionUntil: string | null): Promise<void> {
  validateSourcePermissions(permissions); validateSourceModels(allowedModels); validTime(retentionUntil)
  if (permissions.aiEgress && !allowedModels.length) throw new Error('AI送信を許可するモデルIDを指定してください')
  await db.transaction('rw', purgeTables(), async () => {
    const settings = await owner(), source = await db.contextSources.get(id)
    if (!source || !live(source, settings.profileId)) throw new Error('本人の有効な資料がありません')
    if (source.revision !== expectedRevision) throw new ConflictError()
    const clock = new Date().toISOString(), at = clock < source.updatedAt ? source.updatedAt : clock
    await bumpPolicy()
    await purgeDerived(source, at, !permissions.acquire || !permissions.retain || !permissions.index)
    if (!permissions.retain) await db.contextSnapshots.where('sourceId').equals(id).delete()
    await db.contextSources.put({ ...source, permissions: { ...permissions }, allowedModels: [...allowedModels], retentionUntil, permissionRevision: source.permissionRevision + 1, revision: source.revision + 1, updatedAt: at })
  })
}
export async function deleteSource(id: string, expectedRevision: number): Promise<SourceDeletionReport> {
  return db.transaction('rw', purgeTables(), async () => {
    const settings = await owner(), source = await db.contextSources.get(id)
    if (!source || source.ownerId !== settings.profileId) throw new Error('本人の資料がありません')
    if (source.revision !== expectedRevision) throw new ConflictError()
    if (source.deletedAt) return { sourceId: id, alreadyDeleted: true, erased: { original: 0, summaries: 0, caches: 0, embeddings: 0, candidates: 0, memories: 0, aiReplies: 0, taskQuotes: 0, legacyCopies: 0 }, reviewTaskIds: [], reviewTasks: [], sentModels: [] }
    return eraseSource(source, true)
  })
}
/** Runs inside a purge transaction. Only the reported deletion reads tasks/audits and rewrites legacy receipt copies. */
async function eraseSource(source: ContextSource, report: boolean): Promise<SourceDeletionReport> {
  const clock = new Date().toISOString(), at = clock < source.updatedAt ? source.updatedAt : clock, models = report ? await sentModels(source) : []
  await bumpPolicy(); const erased = await purgeDerived(source, at, true)
  const original = await db.contextSnapshots.where('sourceId').equals(source.id).delete()
  const legacyCopies = report ? await scrubLegacySourceCopies(source.id) : 0, reviewTasks = report ? legacyReviewTasks(await db.tasks.toArray(), source.id) : []
  await db.contextSources.put(erasedSourceRow(source, at))
  return { sourceId: source.id, alreadyDeleted: false, erased: { original, ...erased, legacyCopies }, reviewTaskIds: reviewTasks.map(task => task.id), reviewTasks, sentModels: models }
}
async function expireSource(id: string, expectedRevision: number): Promise<void> {
  await db.transaction('rw', expiryTables(), async () => {
    allowWhileFrozen()
    const settings = await owner(), source = await db.contextSources.get(id)
    if (!source || source.ownerId !== settings.profileId) throw new Error('本人の資料がありません')
    if (source.revision !== expectedRevision) throw new ConflictError()
    if (source.deletedAt || source.retentionUntil === null || Date.parse(source.retentionUntil) > Date.now()) return
    await eraseSource(source, false)
  })
}
/** Inside the restore transaction: the same derived-row purge a deletion or permission save runs, for sources erased or re-permissioned here. */
export async function purgeRestoredSourceDerived(source: ContextSource, at: string): Promise<void> {
  await purgeDerived(source, at, Boolean(source.deletedAt) || !source.permissions.acquire || !source.permissions.retain || !source.permissions.index)
  if (source.deletedAt || !source.permissions.retain) await db.contextSnapshots.where('sourceId').equals(source.id).delete()
}
export type RestoredSourceConsent = { sources: ContextSource[]; erased: string[]; revised: string[] }
const earlierRetention = (left: string | null, right: string | null) => left === null ? right : right === null ? left : left < right ? left : right
/** Erasures, permission/model revocations and earlier expiries made on this device after the backup are re-applied before the restore writes, never undone.
 * A backup row is narrowed only when this device saved permissions after it (higher permissionRevision); a newer backup's re-grant is kept. */
export function applyCurrentSourceConsent(backup: ContextSource[], local: ContextSource[], ownerId: string, at: string): RestoredSourceConsent {
  const here = new Map(local.filter(source => source.ownerId === ownerId).map(source => [source.id, source])), erased = new Set<string>(), revised = new Set<string>()
  const sources = backup.map(row => {
    const current = here.get(row.id)
    if (row.ownerId !== ownerId) return row
    if (current?.deletedAt) { if (!row.deletedAt) erased.add(row.id); return current }
    let next = row
    if (current && !row.deletedAt && current.permissionRevision > row.permissionRevision) {
      const permissions = Object.fromEntries(permissionKeys.map(key => [key, row.permissions[key] && current.permissions[key]])) as SourcePermissions, allowedModels = row.allowedModels.filter(model => current.allowedModels.includes(model))
      if (!allowedModels.length) permissions.aiEgress = false
      next = { ...row, permissions, allowedModels, retentionUntil: earlierRetention(row.retentionUntil, current.retentionUntil), permissionRevision: current.permissionRevision, revision: row.latestRevision + current.permissionRevision - 1, updatedAt: current.updatedAt > row.updatedAt ? current.updatedAt : row.updatedAt }
      revised.add(row.id)
    }
    if (!next.deletedAt && next.retentionUntil !== null && Date.parse(next.retentionUntil) <= Date.parse(at)) { erased.add(row.id); revised.delete(row.id); return erasedSourceRow(next, at < next.updatedAt ? next.updatedAt : at) }
    return next
  })
  const restored = new Set(backup.map(row => row.id))
  // A tombstone the backup lacks is kept as-is; the backup holds nothing derived from that source.
  for (const current of here.values()) if (current.deletedAt && !restored.has(current.id)) sources.push(current)
  return { sources, erased: [...erased], revised: [...revised] }
}
type RestoredSourceRows = { contextSnapshots?: ContextSnapshot[]; sourceSummaries?: SourceSummary[]; sourceArtifacts?: SourceArtifact[]; coachMessages?: CoachMessage[]; coachMemories?: CoachMemory[] }
/** Drops what purgeDerived would remove before the restore writes it: originals, summaries, artifacts and AI replies of the touched sources. */
export function withoutTouchedSourceRows<T extends RestoredSourceRows>(data: T, consent: RestoredSourceConsent): T {
  const touched = new Set([...consent.erased, ...consent.revised]), retained = new Set(consent.sources.filter(source => !source.deletedAt && source.permissions.retain).map(source => source.id))
  if (!touched.size) return data
  const memories = new Set((data.coachMemories ?? []).filter(memory => [...touched].some(id => usesSource(memory, id))).map(memory => memory.id))
  const keep = <R extends { sourceId: string }>(rows: R[] | undefined) => rows?.filter(row => !touched.has(row.sourceId))
  return { ...data, contextSnapshots: data.contextSnapshots?.filter(row => retained.has(row.sourceId) && !consent.erased.includes(row.sourceId)), sourceSummaries: keep(data.sourceSummaries), sourceArtifacts: keep(data.sourceArtifacts), coachMessages: data.coachMessages?.filter(message => message.role !== 'assistant' || !message.selectedSources.some(ref => ref.kind === 'library' && touched.has(ref.id) || ref.kind === 'memory' && memories.has(ref.id))) }
}
/** Unadopted detection candidates expire after 30 days; adopted tasks, evidence rows and approval audits stay. */
export async function purgeExpiredDetectionCandidates(): Promise<number> {
  return db.transaction('rw', db.sourceArtifacts, db.settings, async () => {
    const settings = await owner(), rows = (await db.sourceArtifacts.where('ownerId').equals(settings.profileId).toArray()).filter(row => row.kind === 'candidate' && row.id.startsWith('detection:') && candidateExpired(row.createdAt))
    for (const row of rows) await db.sourceArtifacts.delete(row.id)
    return rows.length
  })
}
export async function sourceDerivedCounts(ownerId: string): Promise<Map<string, SourceDerivedCounts>> {
  const counts = new Map<string, SourceDerivedCounts>(), row = (id: string) => { if (!counts.has(id)) counts.set(id, { summaries: 0, caches: 0, embeddings: 0, candidates: 0, taskQuotes: 0, memories: 0 }); return counts.get(id)! }
  for (const summary of await db.sourceSummaries.where('ownerId').equals(ownerId).toArray()) row(summary.sourceId).summaries++
  for (const artifact of await db.sourceArtifacts.where('ownerId').equals(ownerId).toArray()) row(artifact.sourceId)[artifact.kind === 'cache' ? 'caches' : artifact.kind === 'embedding' ? 'embeddings' : 'candidates']++
  for (const evidence of await db.taskSourceEvidence.where('ownerId').equals(ownerId).toArray()) row(evidence.sourceId).taskQuotes++
  for (const note of await db.taskNotes.where('ownerId').equals(ownerId).toArray()) if(note.sourceId)row(note.sourceId).taskQuotes++
  for (const memory of await db.coachMemories.where('ownerId').equals(ownerId).toArray()) if (!memory.deletedAt && !memory.sourcePurged) for (const ref of memory.sources) { const id = ref.kind === 'derived-summary' && ref.refId.startsWith('library:') ? ref.refId.slice(8) : (ref.kind as string) === 'library' ? ref.refId : null; if (id) row(id).memories++ }
  return counts
}
let sourcePurge: Promise<void> | null = null
export async function purgeExpiredSources(): Promise<void> {
  if (sourcePurge) return sourcePurge
  sourcePurge = (async () => { const settings = await owner(), sources = await db.contextSources.where('ownerId').equals(settings.profileId).toArray(); for (const source of sources) if (!source.deletedAt && source.retentionUntil !== null && Date.parse(source.retentionUntil) <= Date.now()) await expireSource(source.id, source.revision) })()
  try { await sourcePurge } finally { sourcePurge = null }
}
export async function readSource(id: string): Promise<{ source: ContextSource; snapshot: ContextSnapshot }> {
  const settings = await owner(), source = await db.contextSources.get(id)
  if (!source || !canRead(source, settings.profileId)) throw new Error('資料の閲覧が許可されていません')
  const snapshot = await db.contextSnapshots.get(`${id}:${source.latestRevision}`)
  if (!snapshot || snapshot.ownerId !== settings.profileId) throw new Error('資料本文は保持されていません')
  return { source, snapshot }
}
export async function searchSources(query: string, fromDate: string, toDate: string) {
  if (typeof query !== 'string' || query.length > 200) throw new Error('検索語を200文字以内で指定してください')
  validateDate(fromDate, '検索開始日'); validateDate(toDate, '検索終了日')
  if (!fromDate || !toDate || fromDate > toDate) throw new Error('検索範囲を確認してください')
  const settings = await owner(), sources = (await db.contextSources.where('ownerId').equals(settings.profileId).toArray()).filter(source => canRead(source, settings.profileId) && source.permissions.index && source.coverage.fromDate <= toDate && source.coverage.toDate >= fromDate)
  const hits: { source: ContextSource; snapshotRevision: number; span: SourceSpan }[] = []
  for (const source of sources) {
    const snapshot = await db.contextSnapshots.get(`${source.id}:${source.latestRevision}`)
    if (!snapshot || snapshot.ownerId !== settings.profileId) continue
    for (const span of snapshot.spans) if (span.text && span.text.toLocaleLowerCase().includes(query.normalize('NFC').trim().toLocaleLowerCase())) { hits.push({ source, snapshotRevision: snapshot.revision, span }); if (hits.length >= 100) break }
    if (hits.length >= 100) break
  }
  return { hits, coverage: sources.map(source => ({ sourceId: source.id, ...source.coverage })), notice: '本人が取り込んだ、許可と保持期限の範囲内だけを文字検索しました。外部サービスの全履歴や未取得期間は確認していません。' }
}

export async function summarizeSelectedSource(id: string, expectedRevision: number, model: string, send: (text: string) => Promise<string>): Promise<string> {
  await purgeExpiredSources()
  let prepared: { source: ContextSource; snapshot: ContextSnapshot; ownerId: string; datasetId: string; epoch: number; sourcePermissionRevision: number }
  await db.transaction('rw', [db.contextSources, db.contextSnapshots, db.settings, db.audits], async () => {
    const settings = await owner(), { source, snapshot } = await readSource(id), policy = changePolicyFor(settings)
    if (source.revision !== expectedRevision) throw new ConflictError()
    if (!settings.aiEnabled || !source.permissions.index || !source.permissions.aiEgress || source.aiProvider !== 'openrouter' || !source.allowedModels.includes(model)) throw new Error('この資料とモデルへのAI送信は許可されていません')
    if (snapshot.text.length > 50000) throw new Error('AI要約は50000文字以内の資料で使えます')
    prepared = { source: structuredClone(source), snapshot: structuredClone(snapshot), ownerId: settings.profileId, datasetId: settings.datasetId, epoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision }
    // Recorded when the text is handed over, so a failed or rejected reply still counts as a possible provider copy.
    await recordSourceSent(source, model, 'source-summary')
  })
  // This helper is called only after the person selects a source and presses summarize.
  const result = await send(prepared!.snapshot.text)
  if (typeof result !== 'string' || !result.trim() || result.length > 10000) throw new Error('資料のAI要約を読み込めませんでした')
  const summaryDigest = await hash(result.trim())
  return db.transaction('rw', [db.contextSources, db.contextSnapshots, db.sourceSummaries, db.settings], async () => {
    const settings = await owner(), policy = changePolicyFor(settings), { source, snapshot } = await readSource(id)
    if (settings.profileId !== prepared.ownerId || settings.datasetId !== prepared.datasetId || !settings.aiEnabled || source.revision !== prepared.source.revision || source.permissionRevision !== prepared.source.permissionRevision || snapshot.sha256 !== prepared.snapshot.sha256 || policy.epoch !== prepared.epoch || policy.sourcePermissionRevision !== prepared.sourcePermissionRevision || !source.permissions.index || !source.permissions.aiEgress || !source.allowedModels.includes(model)) throw new ConflictError()
    const summaryId = uid()
    await db.sourceSummaries.add({ id: summaryId, ownerId: settings.profileId, sourceId: id, sourceRevision: snapshot.revision, permissionRevision: source.permissionRevision, policyEpoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision, model, provider: 'openrouter', text: result.trim(), sha256: summaryDigest, createdAt: new Date().toISOString() })
    return summaryId
  })
}

export async function currentSourceSummaries(sourceId: string): Promise<SourceSummary[]> {
  const settings = await owner(), policy = changePolicyFor(settings), source = await db.contextSources.get(sourceId)
  if (!source || !canRead(source, settings.profileId) || !source.permissions.index || !source.permissions.aiEgress) return []
  return (await db.sourceSummaries.where('sourceId').equals(sourceId).toArray()).filter(summary => summary.ownerId === settings.profileId && summary.sourceRevision === source.latestRevision && summary.permissionRevision === source.permissionRevision && summary.policyEpoch === policy.epoch && summary.sourcePermissionRevision === policy.sourcePermissionRevision && source.allowedModels.includes(summary.model)).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}
