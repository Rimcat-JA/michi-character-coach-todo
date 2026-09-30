import { ConflictError } from './commands'
import { db } from './db'
import { uid } from './domain'

export type MemoryKind = 'explicit' | 'inferred'
export type MemorySourceRef = { kind: 'human' | 'day-note' | 'review' | 'goal-checkin' | 'library' | 'derived-summary'; refId: string; revision: number; digest: string | null }
export type CoachMemory = {
  id: string; ownerId: string; kind: MemoryKind; text: string; revision: number; sources: MemorySourceRef[]
  history: { text: string; kind: MemoryKind; sources: MemorySourceRef[]; revision: number; at: string }[]
  createdAt: string; updatedAt: string; deletedAt: string | null; sourcePurged?: true
}
export type MemoryTombstone = { id: string; ownerId: string; memoryId: string; sourceKey: string; reason: 'deleted' | 'corrected' | 'source-deleted'; at: string }
export type MemorySourceOption = { label: string; kind: 'day-note' | 'review' | 'goal-checkin' | 'library'; refId: string; summary: boolean }
const libraryDb = db

function validInput(kind: MemoryKind, text: string) {
  if (!['explicit', 'inferred'].includes(kind) || typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('記憶の種類と本文（1〜2000文字）を確認してください')
}
export function memorySourceKey(source: MemorySourceRef): string {
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).length !== 4 ||
    !['kind', 'refId', 'revision', 'digest'].every(key => Object.hasOwn(source, key)) ||
    !['human', 'day-note', 'review', 'goal-checkin', 'library', 'derived-summary'].includes(source.kind) || typeof source.refId !== 'string' || !source.refId.trim() || source.refId.length > 400 || !Number.isSafeInteger(source.revision) || source.revision < 1 ||
    (source.kind === 'derived-summary' ? typeof source.digest !== 'string' || !/^[a-f0-9]{64}$/.test(source.digest) : source.digest !== null)) throw new Error('記憶の出典を確認してください')
  return JSON.stringify([source.kind, source.refId, source.revision, source.digest])
}
async function digestOf(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function sourceContent(kind: MemorySourceOption['kind'], refId: string, summary: boolean, ownerId: string): Promise<{ text: string; revision: number }> {
  if (kind === 'library') {
    const source = await libraryDb.contextSources.get(refId)
    if (!source || source.ownerId !== ownerId || source.deletedAt || source.retentionUntil !== null && Date.parse(source.retentionUntil) <= Date.now() || !source.permissions.acquire || !source.permissions.retain || !source.permissions.index) throw new Error('本人の許可済み資料がありません')
    if (summary) {
      const settings = await db.settings.get('main')
      const summaries = (await libraryDb.sourceSummaries.where('sourceId').equals(refId).toArray()).filter(item => item.ownerId === ownerId && item.sourceRevision === source.latestRevision && item.permissionRevision === source.permissionRevision && item.policyEpoch === (settings?.changePolicy?.epoch ?? 0) && item.sourcePermissionRevision === (settings?.changePolicy?.sourcePermissionRevision ?? 0) && source.permissions.aiEgress && source.allowedModels.includes(item.model)).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      if (!summaries.length) throw new Error('本人の現行の資料要約がありません')
      return { text: summaries[0].text, revision: source.latestRevision }
    }
    const snapshot = await libraryDb.contextSnapshots.get(`${refId}:${source.latestRevision}`)
    if (!snapshot || snapshot.ownerId !== ownerId) throw new Error('本人の資料本文がありません')
    return { text: snapshot.text, revision: snapshot.revision }
  }
  if (kind === 'day-note') {
    const note = await db.dayNotes.get(refId)
    if (!note || note.deletedAt || note.ownerId !== ownerId || summary && (!note.aiSummary || note.summaryOfHumanRevision !== note.humanRevision)) throw new Error('本人の現行の日記・要約がありません')
    return { text: summary ? note.aiSummary! : note.humanText, revision: summary ? note.summaryRevision : note.humanRevision }
  }
  if (kind === 'review') {
    const record = await db.reviewRecords.get(refId)
    if (!record || record.deletedAt || record.ownerId !== ownerId || summary && (!record.aiSummary || record.summaryOfAnswerRevision !== record.answerRevision || record.summaryOfActualRevision !== record.actualRevision)) throw new Error('本人の現行のレビュー・要約がありません')
    return { text: summary ? record.aiSummary! : record.answer, revision: summary ? record.summaryRevision : record.answerRevision }
  }
  const checkIn = await db.goalCheckIns.get(refId)
  const goal = checkIn ? await db.goals.get(checkIn.goalId) : null
  if (!checkIn || checkIn.deletedAt || !goal || goal.deletedAt || goal.ownerId !== ownerId || summary && !checkIn.summary) throw new Error('本人の現行のチェックインがありません')
  return { text: summary ? checkIn.summary! : checkIn.answer, revision: checkIn.summaryRevision }
}
function parseSource(source: MemorySourceRef): { kind: MemorySourceOption['kind']; refId: string; summary: boolean } {
  if (source.kind === 'human') throw new Error('手動入力の出典はアプリが保存します')
  if (source.kind !== 'derived-summary') return { kind: source.kind, refId: source.refId, summary: false }
  const split = source.refId.indexOf(':')
  const kind = source.refId.slice(0, split), refId = source.refId.slice(split + 1)
  if (!['day-note', 'review', 'goal-checkin', 'library'].includes(kind) || !refId) throw new Error('要約の出典を確認してください')
  return { kind: kind as MemorySourceOption['kind'], refId, summary: true }
}
async function verifySource(source: MemorySourceRef, ownerId: string): Promise<string> {
  memorySourceKey(source)
  const parsed = parseSource(source), current = await sourceContent(parsed.kind, parsed.refId, parsed.summary, ownerId)
  if (current.revision !== source.revision || parsed.summary && await digestOf(current.text) !== source.digest) throw new ConflictError()
  return current.text
}

export async function memorySourceFromOption(option: MemorySourceOption, ownerId: string): Promise<MemorySourceRef> {
  if (!option || !['day-note', 'review', 'goal-checkin', 'library'].includes(option.kind) || typeof option.refId !== 'string' || !option.refId.trim() || typeof option.summary !== 'boolean') throw new Error('記憶の出典を確認してください')
  const settings = await db.settings.get('main')
  if (!settings || settings.profileId !== ownerId) throw new Error('本人の設定がありません')
  const current = await sourceContent(option.kind, option.refId, option.summary, ownerId)
  return { kind: option.summary ? 'derived-summary' : option.kind, refId: option.summary ? `${option.kind}:${option.refId}` : option.refId, revision: current.revision, digest: option.summary ? await digestOf(current.text) : null }
}

export function memorySuppressed(sources: MemorySourceRef[], tombstones: MemoryTombstone[], ownerId: string): boolean {
  const keys = new Set(tombstones.filter(tombstone => tombstone.ownerId === ownerId).map(tombstone => tombstone.sourceKey))
  return sources.some(source => keys.has(memorySourceKey(source)))
}
const sourceTables = (sources: MemorySourceRef[]) => [db.dayNotes, db.reviewRecords, db.goalCheckIns, db.goals, ...(sources.some(source => source.kind === 'library' || source.kind === 'derived-summary' && source.refId.startsWith('library:')) ? [libraryDb.contextSources, libraryDb.contextSnapshots, libraryDb.sourceSummaries] : [])]

export async function createCoachMemory(input: { kind: MemoryKind; text: string; sources?: MemorySourceRef[] }): Promise<string> {
  validInput(input.kind, input.text)
  const id = uid(), settings = await db.settings.get('main')
  if (!settings || !settings.profileId.trim()) throw new Error('本人の設定がありません')
  const sources = input.sources?.map(source => ({ ...source })) ?? [{ kind: 'human' as const, refId: id, revision: 1, digest: null }]
  if (!sources.length || sources.length > 20 || new Set(sources.map(memorySourceKey)).size !== sources.length) throw new Error('記憶の出典が重複・過多です')
  const checked = input.sources ? await Promise.all(sources.map(source => verifySource(source, settings.profileId))) : []
  return db.transaction('rw', [db.coachMemories, db.memoryTombstones, db.settings, ...sourceTables(sources)], async () => {
    const currentSettings = await db.settings.get('main')
    if (!currentSettings || currentSettings.profileId !== settings.profileId) throw new Error('本人の設定が変わりました')
    // Compare the content again inside the transaction after any async digest check.
    for (let index = 0; index < checked.length; index++) {
      const source = sources[index], parsed = parseSource(source), current = await sourceContent(parsed.kind, parsed.refId, parsed.summary, settings.profileId)
      if (current.revision !== source.revision || current.text !== checked[index]) throw new ConflictError()
    }
    const tombstones = await db.memoryTombstones.where('ownerId').equals(settings.profileId).toArray()
    if (input.kind === 'inferred' && memorySuppressed(sources, tombstones, settings.profileId)) throw new Error('訂正・削除した出典の同じ版から、推測を再登録できません')
    const existing = await db.coachMemories.where('ownerId').equals(settings.profileId).toArray()
    if (existing.length >= 10000) throw new Error('記憶は10000件まで保存できます')
    if (input.kind === 'inferred' && existing.some(memory => !memory.deletedAt && memory.kind === 'inferred' && memory.sources.some(source => sources.some(candidate => memorySourceKey(candidate) === memorySourceKey(source))))) throw new Error('この出典の推測は保存済みです。内容を訂正してください')
    const at = new Date().toISOString()
    await db.coachMemories.add({ id, ownerId: settings.profileId, kind: input.kind, text: input.text.trim(), revision: 1, sources, history: [], createdAt: at, updatedAt: at, deletedAt: null })
    return id
  })
}

async function addTombstones(memory: CoachMemory, reason: MemoryTombstone['reason'], at: string) {
  const existing = new Set((await db.memoryTombstones.where('ownerId').equals(memory.ownerId).toArray()).map(tombstone => tombstone.sourceKey))
  for (const source of memory.sources) {
    const sourceKey = memorySourceKey(source)
    if (!existing.has(sourceKey)) { await db.memoryTombstones.add({ id: uid(), ownerId: memory.ownerId, memoryId: memory.id, sourceKey, reason, at }); existing.add(sourceKey) }
  }
}
export async function editCoachMemory(id: string, expectedRevision: number, kind: MemoryKind, text: string): Promise<void> {
  validInput(kind, text)
  await db.transaction('rw', [db.coachMemories, db.memoryTombstones, db.settings], async () => {
    const memory = await db.coachMemories.get(id), settings = await db.settings.get('main')
    if (!memory || memory.deletedAt || !settings || memory.ownerId !== settings.profileId) throw new Error('本人の記憶がありません')
    if (memory.revision !== expectedRevision) throw new ConflictError()
    if (memory.kind === kind && memory.text === text.trim()) return
    if (memory.history.length >= 1000) throw new Error('記憶の変更履歴が1000件に達しています')
    const clock = new Date().toISOString(), at = clock < memory.updatedAt ? memory.updatedAt : clock
    if (memory.kind === 'inferred') await addTombstones(memory, 'corrected', at)
    await db.coachMemories.put({ ...memory, kind, text: text.trim(), revision: memory.revision + 1, history: [...memory.history, { text: memory.text, kind: memory.kind, sources: memory.sources.map(source => ({ ...source })), revision: memory.revision, at }], updatedAt: at })
  })
}
export async function deleteCoachMemory(id: string, expectedRevision: number): Promise<void> {
  await db.transaction('rw', [db.coachMemories, db.memoryTombstones, db.settings], async () => {
    const memory = await db.coachMemories.get(id), settings = await db.settings.get('main')
    if (!memory || !settings || memory.ownerId !== settings.profileId) throw new Error('本人の記憶がありません')
    if (memory.revision !== expectedRevision) throw new ConflictError()
    if (memory.deletedAt) return
    const clock = new Date().toISOString(), at = clock < memory.updatedAt ? memory.updatedAt : clock
    await addTombstones(memory, 'deleted', at)
    await db.coachMemories.put({ ...memory, revision: memory.revision + 1, deletedAt: at, updatedAt: at, history: [...memory.history, { text: memory.text, kind: memory.kind, sources: memory.sources.map(source => ({ ...source })), revision: memory.revision, at }] })
  })
}

export async function invalidateMemoriesForSource(kind: MemorySourceOption['kind'], refId: string): Promise<void> {
  if (!['day-note', 'review', 'goal-checkin', 'library'].includes(kind) || typeof refId !== 'string' || !refId.trim()) throw new Error('記憶の出典を確認してください')
  await db.transaction('rw', [db.coachMemories, db.memoryTombstones, db.settings], async () => {
    const settings = await db.settings.get('main')
    if (!settings) throw new Error('本人の設定がありません')
    const memories = await db.coachMemories.where('ownerId').equals(settings.profileId).toArray()
    for (const memory of memories) if (!memory.deletedAt && memory.sources.some(source => source.kind === kind && source.refId === refId || source.kind === 'derived-summary' && source.refId === `${kind}:${refId}`)) {
      const clock = new Date().toISOString(), at = clock < memory.updatedAt ? memory.updatedAt : clock
      await addTombstones(memory, 'source-deleted', at)
      await db.coachMemories.put({ ...memory, deletedAt: at, updatedAt: at, revision: memory.revision + 1, history: [...memory.history, { text: memory.text, kind: memory.kind, sources: memory.sources.map(source => ({ ...source })), revision: memory.revision, at }] })
    }
  })
}

export function currentMemoryContext(memories: CoachMemory[], ownerId: string) {
  const own = memories.filter(memory => memory.ownerId === ownerId && !memory.deletedAt)
  const content = (kind: MemoryKind) => own.filter(memory => memory.kind === kind).map(memory => ({ id: memory.id, text: memory.text, sources: memory.sources.map(source => ({ ...source })) }))
  return { explicit: content('explicit'), inferred: content('inferred') }
}
export async function availableMemoryContext(ownerId: string) {
  const settings = await db.settings.get('main')
  if (!settings || settings.profileId !== ownerId) throw new Error('本人の設定がありません')
  const memories = await db.coachMemories.where('ownerId').equals(ownerId).toArray(), available: CoachMemory[] = []
  for (const memory of memories) {
    if (memory.deletedAt) continue
    try { for (const source of memory.sources) if (source.kind !== 'human') await verifySource(source, ownerId); available.push(memory) }
    catch { /* Deleted, changed, or inaccessible source is excluded from reuse. */ }
  }
  return currentMemoryContext(available, ownerId)
}
