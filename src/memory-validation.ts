import type { CoachMemory, MemorySourceRef, MemoryTombstone } from './coach-memory'

const kinds = ['explicit', 'inferred']
const sourceKinds = ['human', 'day-note', 'review', 'goal-checkin', 'library', 'derived-summary']
function fail(): never { throw new Error('バックアップのコーチ記憶・再登録防止記録が不正です') }
function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) fail()
  return value as Record<string, unknown>
}
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const revision = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max
function timestamp(value: unknown): asserts value is string {
  if (!text(value, 30) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail()
}
function source(value: unknown, memoryId?: string): MemorySourceRef {
  const row = object(value, ['kind', 'refId', 'revision', 'digest'])
  if (!sourceKinds.includes(row.kind as string) || !text(row.refId, 400) || !revision(row.revision)) fail()
  if (row.kind === 'derived-summary') {
    if (!text(row.digest, 64) || !/^[a-f0-9]{64}$/.test(row.digest) || !/^(day-note|review|goal-checkin|library):.+$/.test(row.refId)) fail()
  } else if (row.digest !== null) fail()
  if (row.kind === 'human' && (row.revision !== 1 || memoryId !== undefined && row.refId !== memoryId)) fail()
  return row as MemorySourceRef
}
function key(ref: MemorySourceRef) { return JSON.stringify([ref.kind, ref.refId, ref.revision, ref.digest]) }
function sources(value: unknown, memoryId: string): MemorySourceRef[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) fail()
  const refs = value.map(row => source(row, memoryId))
  if (new Set(refs.map(key)).size !== refs.length) fail()
  return refs
}
function sourceFromKey(value: unknown) {
  if (!text(value, 600)) fail()
  let parts: unknown
  try { parts = JSON.parse(value) } catch { fail() }
  if (!Array.isArray(parts) || parts.length !== 4) fail()
  const ref = source({ kind: parts[0], refId: parts[1], revision: parts[2], digest: parts[3] })
  if (key(ref) !== value) fail()
  return ref
}

export function validateMemoryRecords(memories: unknown, tombstones: unknown, ownerId: string): void {
  if (memories === undefined && tombstones === undefined) return
  if (!text(ownerId, 200) || memories !== undefined && !Array.isArray(memories) || tombstones !== undefined && !Array.isArray(tombstones)) fail()
  const memoryRows = (memories ?? []) as unknown[], tombstoneRows = (tombstones ?? []) as unknown[]
  if (memoryRows.length > 10000 || tombstoneRows.length > 200000) fail()
  const byId = new Map<string, CoachMemory>()
  for (const raw of memoryRows) {
    const row = object(raw, ['id', 'ownerId', 'kind', 'text', 'revision', 'sources', 'history', 'createdAt', 'updatedAt', 'deletedAt'], ['sourcePurged', 'retentionUntil', 'contentPurged'])
    if (row.retentionUntil !== undefined && row.retentionUntil !== null) timestamp(row.retentionUntil)
    if (row.contentPurged !== undefined && row.contentPurged !== 'retention' || row.contentPurged !== undefined && row.sourcePurged !== undefined) fail()
    const purged = row.sourcePurged === true || row.contentPurged === 'retention'
    if (row.sourcePurged !== undefined && row.sourcePurged !== true || !text(row.id, 200) || byId.has(row.id) || row.ownerId !== ownerId || !kinds.includes(row.kind as string) || (purged ? row.text !== '' || row.deletedAt === null : !text(row.text, 2000)) || !revision(row.revision, 1003)) fail()
    timestamp(row.createdAt); timestamp(row.updatedAt)
    if (row.updatedAt < row.createdAt) fail()
    if (row.deletedAt !== null) { timestamp(row.deletedAt); if (row.deletedAt < row.createdAt || row.deletedAt !== row.updatedAt) fail() }
    if (row.contentPurged === 'retention' && (typeof row.retentionUntil !== 'string' || row.retentionUntil > (row.deletedAt as string))) fail()
    sources(row.sources, row.id)
    if (!Array.isArray(row.history) || row.history.length > 1001 || (purged ? row.history.length !== 0 : row.history.length !== row.revision - 1)) fail()
    let previousAt = row.createdAt
    for (let index = 0; index < row.history.length; index++) {
      const event = object(row.history[index], ['text', 'kind', 'sources', 'revision', 'at'])
      timestamp(event.at)
      if (!text(event.text, 2000) || !kinds.includes(event.kind as string) || event.revision !== index + 1 || event.at < previousAt || event.at > row.updatedAt) fail()
      sources(event.sources, row.id)
      previousAt = event.at
    }
    byId.set(row.id, row as CoachMemory)
  }
  const ids = new Set<string>(), sourceKeys = new Set<string>()
  for (const raw of tombstoneRows) {
    const row = object(raw, ['id', 'ownerId', 'memoryId', 'sourceKey', 'reason', 'at'])
    if (!text(row.id, 200) || ids.has(row.id) || row.ownerId !== ownerId || !text(row.memoryId, 200) || !['deleted', 'corrected', 'source-deleted', 'retention'].includes(row.reason as string)) fail()
    timestamp(row.at)
    const ref = sourceFromKey(row.sourceKey)
    const memory = byId.get(row.memoryId)
    if (!memory || row.at < memory.createdAt || row.at > memory.updatedAt || sourceKeys.has(row.sourceKey as string)) fail()
    const allSources = [...memory.sources, ...memory.history.flatMap(event => event.sources)]
    if (!allSources.some(candidate => key(candidate) === key(ref))) fail()
    if ((row.reason === 'deleted' || row.reason === 'source-deleted' || row.reason === 'retention') && !memory.deletedAt || row.reason === 'retention' && memory.contentPurged !== 'retention' || row.reason === 'corrected' && !memory.history.some(event => event.kind === 'inferred')) fail()
    ids.add(row.id); sourceKeys.add(row.sourceKey as string)
  }
  for (const memory of byId.values()) {
    const correctedInferredSources = memory.history.filter(event => event.kind === 'inferred').flatMap(event => event.sources)
    const protectedSources = memory.deletedAt ? [...memory.sources, ...correctedInferredSources] : correctedInferredSources
    if (protectedSources.some(ref => !sourceKeys.has(key(ref)))) fail()
  }
}

// Useful to callers that already validated a snapshot before restoration.
export type MemorySnapshot = { coachMemories?: CoachMemory[]; memoryTombstones?: MemoryTombstone[] }
