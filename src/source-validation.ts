import { validateDate } from './domain'
import type { ContextSnapshot, ContextSource, SourceArtifact, SourceSummary } from './source-library'
import { validateDocumentMetadata } from './document-metadata'

function fail(): never { throw new Error('バックアップの資料・取得範囲・派生情報が不正です') }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail()
  return value as Record<string, unknown>
}
const string = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0)
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const normalized = (text: string) => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').normalize('NFC')
function timestamp(value: unknown): asserts value is string {
  if (!string(value, 30) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail()
}
function date(value: unknown): asserts value is string { if (!string(value, 10)) fail(); try { validateDate(value, '資料の日付') } catch { fail() } }
function rows(value: unknown, max: number): unknown[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > max) fail(); return value }
function addId(ids: Set<string>, value: unknown, max = 250): asserts value is string { if (!string(value, max) || ids.has(value)) fail(); ids.add(value) }
const permissionKeys = ['acquire', 'retain', 'index', 'aiEgress', 'notify', 'externalWrite', 'disclose']
function models(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 20 || value.some(model => !string(model, 120) || !/^[\w~./:-]{3,120}$/.test(model)) || new Set(value).size !== value.length) fail()
}

export function validateSourceRecords(sourceRows: unknown, snapshotRows: unknown, summaryRows: unknown, artifactRows: unknown, ownerId: string, policy?: { epoch: number; sourcePermissionRevision: number }): void {
  const sources = rows(sourceRows, 10000), snapshots = rows(snapshotRows, 100000), summaries = rows(summaryRows, 100000), artifacts = rows(artifactRows, 100000)
  if (!string(ownerId, 200)) fail()
  const bySource = new Map<string, ContextSource>(), ids = new Set<string>()
  for (const raw of sources) {
    const source = object(raw, ['id', 'ownerId', 'title', 'provider', 'externalId', 'conversation', 'author', 'sourceUrl', 'date', 'timezone', 'revision', 'latestRevision', 'permissionRevision', 'permissions', 'aiProvider', 'allowedModels', 'coverage', 'retentionUntil', 'createdAt', 'updatedAt', 'deletedAt'])
    addId(ids, source.id, 200)
    if (source.ownerId !== ownerId || !string(source.title, 200) || !['local', 'slack', 'line', 'teams', 'discord', 'other'].includes(source.provider as string) || source.aiProvider !== 'openrouter' || !integer(source.revision, 1, 100000) || !integer(source.latestRevision, 1, 100000) || !integer(source.permissionRevision, 1, 100000) || source.revision !== source.latestRevision + source.permissionRevision - 1) fail()
    for (const value of [source.externalId, source.conversation, source.author]) if (value !== null && !string(value, 200, true)) fail()
    if (source.sourceUrl !== null) { if (!string(source.sourceUrl, 2000)) fail(); try { if (!['http:', 'https:'].includes(new URL(source.sourceUrl).protocol)) fail() } catch { fail() } }
    date(source.date)
    if (!string(source.timezone, 100)) fail()
    try { new Intl.DateTimeFormat('en-CA', { timeZone: source.timezone }) } catch { fail() }
    const permissions = object(source.permissions, permissionKeys)
    if (permissionKeys.some(key => typeof permissions[key] !== 'boolean')) fail()
    models(source.allowedModels)
    if (permissions.aiEgress && !source.allowedModels.length) fail()
    const coverage = object(source.coverage, ['fromDate', 'toDate', 'complete', 'method', 'lastCheckedAt'])
    date(coverage.fromDate); date(coverage.toDate); timestamp(coverage.lastCheckedAt)
    if (coverage.fromDate > coverage.toDate || source.date < coverage.fromDate || source.date > coverage.toDate || coverage.complete !== false || coverage.method !== 'manual-import') fail()
    timestamp(source.createdAt); timestamp(source.updatedAt)
    if (source.updatedAt < source.createdAt || coverage.lastCheckedAt < source.createdAt || coverage.lastCheckedAt > source.updatedAt) fail()
    if (source.retentionUntil !== null) timestamp(source.retentionUntil)
    if (source.deletedAt !== null) {
      timestamp(source.deletedAt)
      if (source.deletedAt !== source.updatedAt || source.deletedAt < source.createdAt || permissionKeys.some(key => permissions[key]) || source.title !== '削除した資料' || [source.externalId, source.conversation, source.author, source.sourceUrl].some(value => value !== null)) fail()
    }
    bySource.set(source.id, source as ContextSource)
  }
  const snapshotIds = new Set<string>(), snapshotVersions = new Set<string>()
  for (const raw of snapshots) {
    const snapshot = object(raw, ['id', 'sourceId', 'ownerId', 'revision', 'originalText', 'text', 'sha256', 'spans', 'createdAt', ...(raw && typeof raw === 'object' && Object.hasOwn(raw, 'document') ? ['document'] : [])])
    addId(snapshotIds, snapshot.id)
    const source = bySource.get(snapshot.sourceId as string)
    if (!source || source.deletedAt || !source.permissions.retain || snapshot.ownerId !== ownerId || !integer(snapshot.revision, 1, source.latestRevision) || snapshot.id !== `${source.id}:${snapshot.revision}` || !string(snapshot.originalText, 200000) || !string(snapshot.text, 200000) || snapshot.text !== normalized(snapshot.originalText) || !digest(snapshot.sha256)) fail()
    timestamp(snapshot.createdAt)
    if (snapshot.createdAt < source.createdAt || snapshot.createdAt > source.updatedAt) fail()
    const lines = snapshot.text.split('\n')
    if (snapshot.document !== undefined) validateDocumentMetadata(snapshot.document, lines.length)
    if (!Array.isArray(snapshot.spans) || snapshot.spans.length !== lines.length || lines.length > 10000) fail()
    let start = 0
    for (let index = 0; index < lines.length; index++) {
      const span = object(snapshot.spans[index], ['id', 'index', 'start', 'end', 'text'])
      if (span.id !== `${snapshot.id}:${index}` || span.index !== index || span.start !== start || span.end !== start + lines[index].length || span.text !== lines[index] || snapshot.text.slice(span.start as number, span.end as number) !== span.text) fail()
      start += lines[index].length + 1
    }
    snapshotVersions.add(snapshot.id)
  }
  const summaryIds = new Set<string>()
  for (const raw of summaries) {
    const summary = object(raw, ['id', 'ownerId', 'sourceId', 'sourceRevision', 'permissionRevision', 'policyEpoch', 'sourcePermissionRevision', 'model', 'provider', 'text', 'sha256', 'createdAt'])
    addId(summaryIds, summary.id, 200)
    const source = bySource.get(summary.sourceId as string)
    if (!source || source.deletedAt || !source.permissions.acquire || !source.permissions.retain || !source.permissions.index || !source.permissions.aiEgress || summary.ownerId !== ownerId || summary.sourceRevision !== source.latestRevision || summary.permissionRevision !== source.permissionRevision || !snapshotVersions.has(`${source.id}:${summary.sourceRevision}`) || !integer(summary.policyEpoch) || !integer(summary.sourcePermissionRevision) || summary.provider !== 'openrouter' || !string(summary.model, 120) || !source.allowedModels.includes(summary.model) || !string(summary.text, 10000) || !digest(summary.sha256)) fail()
    if (policy && (summary.policyEpoch > policy.epoch || summary.sourcePermissionRevision > policy.sourcePermissionRevision)) fail()
    timestamp(summary.createdAt)
    if (summary.createdAt < source.createdAt) fail()
  }
  const artifactIds = new Set<string>()
  for (const raw of artifacts) {
    const artifact = object(raw, ['id', 'ownerId', 'sourceId', 'sourceRevision', 'permissionRevision', 'kind', 'payload', 'createdAt'])
    addId(artifactIds, artifact.id, 200)
    const source = bySource.get(artifact.sourceId as string)
    if (!source || source.deletedAt || !source.permissions.acquire || !source.permissions.retain || !source.permissions.index || artifact.ownerId !== ownerId || artifact.sourceRevision !== source.latestRevision || artifact.permissionRevision !== source.permissionRevision || !snapshotVersions.has(`${source.id}:${artifact.sourceRevision}`) || !['cache', 'embedding', 'candidate'].includes(artifact.kind as string) || !string(artifact.payload, 200000, true)) fail()
    timestamp(artifact.createdAt)
    if (artifact.createdAt < source.createdAt) fail()
  }
}

export async function verifySourceDigests(snapshots: ContextSnapshot[] = [], summaries: SourceSummary[] = []): Promise<void> {
  for (const item of [...snapshots, ...summaries]) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.text)))
    if ([...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('') !== item.sha256) fail()
  }
}
export type SourceLibrarySnapshot = { contextSources?: ContextSource[]; contextSnapshots?: ContextSnapshot[]; sourceSummaries?: SourceSummary[]; sourceArtifacts?: SourceArtifact[] }
