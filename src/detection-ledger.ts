import { db } from './db'
import { contentDigest } from './canonical'
import { uid } from './domain'
import type { DetectionAction, DetectionChange } from './detection-contract'

export type ObligationState = 'unverified' | 'verified' | 'needs_review' | 'dismissed' | 'linked' | 'withdrawn'
export type ObligationEvidenceKey = { sourceId: string; snapshotRevision: number; spanId: string; quoteSha256: string }
/** Logical obligation (design 10.7). Holds ids and digests only: no quote, title or body survives here. */
export type DetectedObligation = { id: string; ownerId: string; datasetId: string; canonicalKey: string; state: ObligationState; linkedTaskId: string | null; evidenceKeys: ObligationEvidenceKey[]; action: DetectionAction; basis: DetectionChange['basis']; revision: number; createdAt: string; updatedAt: string }
export type ObservationVerdict = 'ready-for-review' | 'verification-rejected' | 'verification-unavailable' | 'dismissed' | 'reconsidered' | 'linked' | 'withdrawn'
/** Append-only: rows are never edited or deleted. */
export type ObligationObservation = { id: string; ownerId: string; obligationId: string; runId: string | null; candidateId: string | null; verdict: ObservationVerdict; at: string }

const states: ObligationState[] = ['unverified', 'verified', 'needs_review', 'dismissed', 'linked', 'withdrawn']
const verdicts: ObservationVerdict[] = ['ready-for-review', 'verification-rejected', 'verification-unavailable', 'dismissed', 'reconsidered', 'linked', 'withdrawn']
const sticky = (state: ObligationState) => state === 'dismissed' || state === 'linked'
async function sha256(text: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('') }
/** Width, spacing and composition differences of the same sentence give the same digest. */
export const normalizedQuote = (quote: string) => quote.normalize('NFKC').replace(/\s+/gu, ' ').trim()
export async function obligationEvidenceKeys(change: Pick<DetectionChange, 'evidence'>): Promise<ObligationEvidenceKey[]> {
  return Promise.all(change.evidence.map(async reference => ({ sourceId: reference.source_id, snapshotRevision: reference.revision, spanId: reference.span_id, quoteSha256: await sha256(normalizedQuote(reference.quote)) })))
}
/** Keyed by quoted content, not by source id or title: re-importing the same text maps to the same obligation,
 * while a new explicit request (a new quote) is a new key. */
export async function obligationKey(ownerId: string, change: Pick<DetectionChange, 'action' | 'basis' | 'target_task_id' | 'evidence'>): Promise<string> {
  const quotes = [...new Set((await obligationEvidenceKeys(change)).map(key => key.quoteSha256))].sort()
  return contentDigest({ ownerId, action: change.action, basis: change.basis, target: change.target_task_id, quotes })
}
const stateFor = (status: ObservationVerdict): ObligationState => status === 'ready-for-review' ? 'verified' : status === 'verification-rejected' ? 'needs_review' : 'unverified'
export const obligationTables = () => [db.detectedObligations, db.obligationObservations]
export async function findObligation(ownerId: string, canonicalKey: string): Promise<DetectedObligation | undefined> {
  return db.detectedObligations.where('[ownerId+canonicalKey]').equals([ownerId, canonicalKey]).first()
}
async function observe(row: DetectedObligation, verdict: ObservationVerdict, at: string, runId: string | null, candidateId: string | null) {
  await db.obligationObservations.add({ id: uid(), ownerId: row.ownerId, obligationId: row.id, runId, candidateId, verdict, at })
}
/** Runs inside the detection save transaction. A dismissed or linked obligation keeps its state; observations are appended. */
export async function recordObligationObservations(ownerId: string, datasetId: string, runId: string, candidates: { id: string; change: DetectionChange; status: ObservationVerdict; obligationKey: string }[], at: string): Promise<void> {
  for (const candidate of candidates) {
    const evidenceKeys = await obligationEvidenceKeys(candidate.change), existing = await findObligation(ownerId, candidate.obligationKey)
    let row: DetectedObligation
    if (!existing) { row = { id: uid(), ownerId, datasetId, canonicalKey: candidate.obligationKey, state: stateFor(candidate.status), linkedTaskId: null, evidenceKeys, action: candidate.change.action, basis: candidate.change.basis, revision: 1, createdAt: at, updatedAt: at }; await db.detectedObligations.add(row) }
    else {
      const merged = [...existing.evidenceKeys]
      for (const key of evidenceKeys) if (!merged.some(item => item.sourceId === key.sourceId && item.snapshotRevision === key.snapshotRevision && item.spanId === key.spanId)) merged.push(key)
      row = { ...existing, evidenceKeys: merged.slice(-100), state: sticky(existing.state) ? existing.state : stateFor(candidate.status), revision: existing.revision + 1, updatedAt: at < existing.updatedAt ? existing.updatedAt : at }
      await db.detectedObligations.put(row)
    }
    await observe(row, candidate.status, at, runId, candidate.id)
  }
}
/** Refuses adoption from evidence the owner dismissed or already reflected in a task. */
export async function assertObligationAdoptable(ownerId: string, canonicalKey: string): Promise<void> {
  const row = await findObligation(ownerId, canonicalKey)
  if (row?.state === 'dismissed') throw new Error('以前に本人が不要とした根拠です。採用するには「再検討する」を押してください')
  if (row?.state === 'linked') { const task = row.linkedTaskId ? await db.tasks.get(row.linkedTaskId) : undefined; throw new Error(`この根拠は反映済みです: ${task && !task.deletedAt ? task.title : 'タスク'}。新規作成せず既存タスクを確認してください`) }
}
export async function setObligationState(ownerId: string, canonicalKey: string, next: 'dismissed' | 'unverified', verdict: 'dismissed' | 'reconsidered', runId: string | null, candidateId: string | null, expectedRevision?: number): Promise<DetectedObligation> {
  const row = await findObligation(ownerId, canonicalKey)
  if (!row) throw new Error('この候補の根拠は台帳にありません。もう一度検出してください')
  if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new Error('根拠の状態が変わりました。画面を確認してください')
  if (row.state === 'linked') throw new Error('反映済みの根拠は変更できません。既存タスクを確認してください')
  if (next === 'unverified' && row.state !== 'dismissed') throw new Error('不要にした根拠だけを再検討できます')
  const at = new Date().toISOString(), updated = { ...row, state: next, revision: row.revision + 1, updatedAt: at < row.updatedAt ? row.updatedAt : at }
  await db.detectedObligations.put(updated); await observe(updated, verdict, updated.updatedAt, runId, candidateId)
  return updated
}
/** Inside the adoption transaction: the obligation points at the created task, so a second adoption is refused. */
export async function linkObligation(ownerId: string, datasetId: string, canonicalKey: string, change: DetectionChange, taskId: string, runId: string, candidateId: string, at: string): Promise<void> {
  const existing = await findObligation(ownerId, canonicalKey)
  if (existing?.state === 'linked' && existing.linkedTaskId === taskId) return
  if (existing && sticky(existing.state)) throw new Error('この根拠は不要または反映済みです')
  const row: DetectedObligation = existing ? { ...existing, state: 'linked', linkedTaskId: taskId, revision: existing.revision + 1, updatedAt: at < existing.updatedAt ? existing.updatedAt : at } : { id: uid(), ownerId, datasetId, canonicalKey, state: 'linked', linkedTaskId: taskId, evidenceKeys: await obligationEvidenceKeys(change), action: change.action, basis: change.basis, revision: 1, createdAt: at, updatedAt: at }
  await db.detectedObligations.put(row); await observe(row, 'linked', row.updatedAt, runId, candidateId)
}
/** Source erasure is 出典失効 (10.6), not a business cancellation: open observations become withdrawn; dismissals and links stay. */
export async function withdrawSourceObligations(ownerId: string, sourceId: string, at: string): Promise<number> {
  let count = 0
  for (const row of await db.detectedObligations.where('ownerId').equals(ownerId).toArray()) {
    if (sticky(row.state) || row.state === 'withdrawn' || !row.evidenceKeys.some(key => key.sourceId === sourceId)) continue
    const updated = { ...row, state: 'withdrawn' as const, revision: row.revision + 1, updatedAt: at < row.updatedAt ? row.updatedAt : at }
    await db.detectedObligations.put(updated); await observe(updated, 'withdrawn', updated.updatedAt, null, null); count++
  }
  return count
}
/** Task ids already linked from evidence in the given sources: offered as matching targets (id/title/due/revision only). */
export async function linkedTaskIdsForSources(ownerId: string, sourceIds: string[]): Promise<string[]> {
  const wanted = new Set(sourceIds), ids = new Set<string>()
  for (const row of await db.detectedObligations.where('ownerId').equals(ownerId).toArray()) if (row.state === 'linked' && row.linkedTaskId && row.evidenceKeys.some(key => wanted.has(key.sourceId))) ids.add(row.linkedTaskId)
  const tasks = await db.tasks.bulkGet([...ids])
  return tasks.filter(task => task && !task.deletedAt).map(task => task!.id).slice(0, 100)
}

function fail(): never { throw new Error('バックアップの検出台帳が不正です') }
const text = (value: unknown, max = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const time = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)))
export function validateObligationRecords(obligations: unknown, observations: unknown, ownerId: string, datasetId: string, taskIds: Set<string>): void {
  if (obligations === undefined && observations === undefined) return
  if (obligations !== undefined && (!Array.isArray(obligations) || obligations.length > 100000) || observations !== undefined && (!Array.isArray(observations) || observations.length > 500000)) fail()
  const ids = new Set<string>(), keys = new Set<string>()
  for (const row of (obligations ?? []) as unknown[]) {
    if (!exact(row, ['id', 'ownerId', 'datasetId', 'canonicalKey', 'state', 'linkedTaskId', 'evidenceKeys', 'action', 'basis', 'revision', 'createdAt', 'updatedAt']) || !text(row.id) || ids.has(row.id as string) || row.ownerId !== ownerId || row.datasetId !== datasetId || !digest(row.canonicalKey) || keys.has(row.canonicalKey as string) || !states.includes(row.state as ObligationState) || !['create', 'update', 'cancel', 'report_completion', 'define_recurrence'].includes(row.action as string) || !['explicit_request', 'self_commitment', 'documented_obligation', 'approved_rule'].includes(row.basis as string) || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1 || !time(row.createdAt) || !time(row.updatedAt) || (row.updatedAt as string) < (row.createdAt as string)) fail()
    if (row.state === 'linked' ? !text(row.linkedTaskId) || !taskIds.has(row.linkedTaskId as string) : row.linkedTaskId !== null) fail()
    if (!Array.isArray(row.evidenceKeys) || row.evidenceKeys.length < 1 || row.evidenceKeys.length > 100 || row.evidenceKeys.some(key => !exact(key, ['sourceId', 'snapshotRevision', 'spanId', 'quoteSha256']) || !text(key.sourceId) || !Number.isSafeInteger(key.snapshotRevision) || (key.snapshotRevision as number) < 1 || !text(key.spanId, 300) || !digest(key.quoteSha256))) fail()
    ids.add(row.id as string); keys.add(row.canonicalKey as string)
  }
  const observationIds = new Set<string>()
  for (const row of (observations ?? []) as unknown[]) {
    if (!exact(row, ['id', 'ownerId', 'obligationId', 'runId', 'candidateId', 'verdict', 'at']) || !text(row.id) || observationIds.has(row.id as string) || row.ownerId !== ownerId || !ids.has(row.obligationId as string) || row.runId !== null && !text(row.runId) || row.candidateId !== null && !text(row.candidateId) || !verdicts.includes(row.verdict as ObservationVerdict) || !time(row.at)) fail()
    observationIds.add(row.id as string)
  }
}
/** Dismissals made on this device after the backup are re-applied, never undone; observations are a union. */
export function mergeRestoredObligations(backup: DetectedObligation[] | undefined, local: DetectedObligation[], backupObservations: ObligationObservation[] | undefined, localObservations: ObligationObservation[], ownerId: string, datasetId: string): { obligations: DetectedObligation[]; observations: ObligationObservation[] } {
  const byKey = new Map((backup ?? []).map(row => [row.canonicalKey, row])), keep = new Set((backup ?? []).map(row => row.id))
  for (const row of local) {
    if (row.ownerId !== ownerId || row.datasetId !== datasetId || row.state !== 'dismissed') continue
    const restored = byKey.get(row.canonicalKey)
    if (!restored) { byKey.set(row.canonicalKey, row); keep.add(row.id) }
    else if (restored.state !== 'dismissed' && restored.state !== 'linked') byKey.set(row.canonicalKey, { ...restored, state: 'dismissed', revision: Math.max(restored.revision, row.revision) + 1, updatedAt: restored.updatedAt > row.updatedAt ? restored.updatedAt : row.updatedAt })
  }
  const obligations = [...byKey.values()], obligationIds = new Set(obligations.map(row => row.id)), seen = new Set<string>(), observations: ObligationObservation[] = []
  for (const row of [...(backupObservations ?? []), ...localObservations.filter(item => keep.has(item.obligationId))]) if (!seen.has(row.id) && obligationIds.has(row.obligationId) && row.ownerId === ownerId) { seen.add(row.id); observations.push(row) }
  return { obligations, observations }
}
