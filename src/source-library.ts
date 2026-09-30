import { db as baseDb } from './db'
import { ConflictError } from './commands'
import { changePolicyFor } from './change-set'
import { uid, validateDate } from './domain'
import type { CoachMemory, MemoryTombstone } from './coach-memory'
import { purgeChatSourceResponses } from './chat-history'

export type SourceProvider = 'local' | 'slack' | 'line' | 'teams' | 'discord' | 'other'
export type SourcePermissions = { acquire: boolean; retain: boolean; index: boolean; aiEgress: boolean; notify: boolean; externalWrite: boolean; disclose: boolean }
export type ContextSource = {
  id: string; ownerId: string; title: string; provider: SourceProvider; externalId: string | null; conversation: string | null; author: string | null; sourceUrl: string | null
  date: string; timezone: string; revision: number; latestRevision: number; permissionRevision: number; permissions: SourcePermissions
  aiProvider: 'openrouter'; allowedModels: string[]; coverage: { fromDate: string; toDate: string; complete: false; method: 'manual-import'; lastCheckedAt: string }
  retentionUntil: string | null; createdAt: string; updatedAt: string; deletedAt: string | null
}
export type SourceSpan = { id: string; index: number; start: number; end: number; text: string }
export type ContextSnapshot = { id: string; sourceId: string; ownerId: string; revision: number; originalText: string; text: string; sha256: string; spans: SourceSpan[]; createdAt: string }
export type SourceSummary = { id: string; ownerId: string; sourceId: string; sourceRevision: number; permissionRevision: number; policyEpoch: number; sourcePermissionRevision: number; model: string; provider: 'openrouter'; text: string; sha256: string; createdAt: string }
export type SourceArtifact = { id: string; ownerId: string; sourceId: string; sourceRevision: number; permissionRevision: number; kind: 'cache' | 'embedding' | 'candidate'; payload: string; createdAt: string }
export type SourceImport = Pick<ContextSource, 'title' | 'provider' | 'externalId' | 'conversation' | 'author' | 'sourceUrl' | 'date' | 'permissions' | 'allowedModels' | 'retentionUntil'> & { text: string; fromDate: string; toDate: string }
export const sourceDb = baseDb
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
const purgeTables = () => [db.contextSources, db.contextSnapshots, db.sourceSummaries, db.sourceArtifacts, db.coachMemories, db.memoryTombstones, db.coachConversations, db.coachMessages, db.settings]
function usesSource(memory: CoachMemory, sourceId: string) { return memory.sources.some(ref => (ref.kind as string) === 'library' && ref.refId === sourceId || ref.kind === 'derived-summary' && ref.refId === `library:${sourceId}`) }
async function purgeDerived(source: ContextSource, at: string) {
  await purgeChatSourceResponses(source.id, source.ownerId)
  await db.sourceSummaries.where('sourceId').equals(source.id).delete()
  await db.sourceArtifacts.where('sourceId').equals(source.id).delete()
  const memories = await db.coachMemories.where('ownerId').equals(source.ownerId).toArray()
  for (const memory of memories) if (!memory.sourcePurged && usesSource(memory, source.id)) {
    const existing = new Set((await db.memoryTombstones.where('ownerId').equals(source.ownerId).toArray()).map(row => row.sourceKey))
    for (const tombstone of await db.memoryTombstones.where('ownerId').equals(source.ownerId).toArray()) if (tombstone.memoryId === memory.id) await db.memoryTombstones.put({ ...tombstone, reason: 'source-deleted', at })
    for (const ref of memory.sources) {
      const sourceKey = JSON.stringify([ref.kind, ref.refId, ref.revision, ref.digest])
      if (!existing.has(sourceKey)) await db.memoryTombstones.add({ id: uid(), ownerId: source.ownerId, memoryId: memory.id, sourceKey, reason: 'source-deleted', at } satisfies MemoryTombstone)
    }
    // Source-derived text and its historical copies must not survive as a hidden cache.
    await db.coachMemories.put({ ...memory, text: '', sourcePurged: true, history: [], revision: memory.revision + 1, deletedAt: at, updatedAt: at })
  }
}

export async function importLocalSource(input: SourceImport): Promise<string> {
  const text = normalizeSourceText(input.text)
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || !providerNames.includes(input.provider)) throw new Error('資料名と由来を確認してください')
  for (const value of [input.externalId, input.conversation, input.author]) if (value !== null && (typeof value !== 'string' || value.length > 200)) throw new Error('資料の識別情報を確認してください')
  if (input.sourceUrl !== null) { try { const url = new URL(input.sourceUrl); if (!['http:', 'https:'].includes(url.protocol) || input.sourceUrl.length > 2000) throw new Error() } catch { throw new Error('出典URLを確認してください') } }
  for (const date of [input.date, input.fromDate, input.toDate]) { if (typeof date !== 'string' || !date) throw new Error('資料の日付と取得範囲を確認してください'); validateDate(date, '取得範囲') }
  if (input.fromDate > input.toDate || input.date < input.fromDate || input.date > input.toDate) throw new Error('資料の日付を取得範囲内にしてください')
  validateSourcePermissions(input.permissions); validateSourceModels(input.allowedModels); validTime(input.retentionUntil)
  if (!input.permissions.acquire || !input.permissions.retain) throw new Error('取り込みには取得と保存の許可が必要です')
  if (input.permissions.aiEgress && !input.allowedModels.length) throw new Error('AI送信を許可するモデルIDを指定してください')
  if (input.retentionUntil !== null && Date.parse(input.retentionUntil) <= Date.now()) throw new Error('保持期限は未来の日時にしてください')
  const digest = await hash(text), id = uid(), snapshotId = `${id}:1`, spans = sourceSpans(snapshotId, text), at = new Date().toISOString()
  return db.transaction('rw', [db.contextSources, db.contextSnapshots, db.settings], async () => {
    const settings = await owner()
    const existing = await db.contextSources.where('ownerId').equals(settings.profileId).toArray()
    if (existing.length >= 10000) throw new Error('資料は10000件まで取り込めます')
    for (const source of existing.filter(source => live(source, settings.profileId) && source.provider === input.provider && source.externalId === input.externalId && source.title === input.title.trim())) {
      const snapshot = await db.contextSnapshots.get(`${source.id}:${source.latestRevision}`)
      if (snapshot?.sha256 === digest) return source.id
    }
    await bumpPolicy()
    await db.contextSources.add({ id, ownerId: settings.profileId, title: input.title.trim(), provider: input.provider, externalId: input.externalId, conversation: input.conversation, author: input.author, sourceUrl: input.sourceUrl, date: input.date, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, revision: 1, latestRevision: 1, permissionRevision: 1, permissions: { ...input.permissions }, aiProvider: 'openrouter', allowedModels: [...input.allowedModels], coverage: { fromDate: input.fromDate, toDate: input.toDate, complete: false, method: 'manual-import', lastCheckedAt: at }, retentionUntil: input.retentionUntil, createdAt: at, updatedAt: at, deletedAt: null })
    await db.contextSnapshots.add({ id: snapshotId, sourceId: id, ownerId: settings.profileId, revision: 1, originalText: input.text, text, sha256: digest, spans, createdAt: at })
    return id
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
    await purgeDerived(source, at)
    if (!permissions.retain) await db.contextSnapshots.where('sourceId').equals(id).delete()
    await db.contextSources.put({ ...source, permissions: { ...permissions }, allowedModels: [...allowedModels], retentionUntil, permissionRevision: source.permissionRevision + 1, revision: source.revision + 1, updatedAt: at })
  })
}
export async function deleteSource(id: string, expectedRevision: number): Promise<void> {
  await db.transaction('rw', purgeTables(), async () => {
    const settings = await owner(), source = await db.contextSources.get(id)
    if (!source || source.ownerId !== settings.profileId) throw new Error('本人の資料がありません')
    if (source.revision !== expectedRevision) throw new ConflictError()
    if (source.deletedAt) return
    const clock = new Date().toISOString(), at = clock < source.updatedAt ? source.updatedAt : clock
    await bumpPolicy(); await purgeDerived(source, at)
    await db.contextSnapshots.where('sourceId').equals(id).delete()
    await db.contextSources.put({ ...source, title: '削除した資料', externalId: null, conversation: null, author: null, sourceUrl: null, permissions: Object.fromEntries(permissionKeys.map(key => [key, false])) as SourcePermissions, revision: source.revision + 1, permissionRevision: source.permissionRevision + 1, deletedAt: at, updatedAt: at })
  })
}
export async function purgeExpiredSources(): Promise<void> {
  const settings = await owner(), sources = await db.contextSources.where('ownerId').equals(settings.profileId).toArray()
  for (const source of sources) if (!source.deletedAt && source.retentionUntil !== null && Date.parse(source.retentionUntil) <= Date.now()) await deleteSource(source.id, source.revision)
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
  await purgeExpiredSources()
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
  let prepared: { source: ContextSource; snapshot: ContextSnapshot; ownerId: string; datasetId: string; epoch: number; sourcePermissionRevision: number }
  await db.transaction('r', [db.contextSources, db.contextSnapshots, db.settings], async () => {
    const settings = await owner(), { source, snapshot } = await readSource(id), policy = changePolicyFor(settings)
    if (source.revision !== expectedRevision) throw new ConflictError()
    if (!settings.aiEnabled || !source.permissions.index || !source.permissions.aiEgress || source.aiProvider !== 'openrouter' || !source.allowedModels.includes(model)) throw new Error('この資料とモデルへのAI送信は許可されていません')
    if (snapshot.text.length > 50000) throw new Error('AI要約は50000文字以内の資料で使えます')
    prepared = { source: structuredClone(source), snapshot: structuredClone(snapshot), ownerId: settings.profileId, datasetId: settings.datasetId, epoch: policy.epoch, sourcePermissionRevision: policy.sourcePermissionRevision }
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
