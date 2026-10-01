import { db } from './db'
import { uid, type Task } from './domain'
import type { ContextSource } from './source-library'

export type TaskSourceEvidence = { id: string; ownerId: string; datasetId: string; taskId: string; sourceId: string; snapshotRevision: number; permissionRevision: number; spanId: string; quote: string; quoteSha256: string; supports: string[]; runId: string; candidateId: string; createdAt: string }
export type LegacyDetectionNotes = { detector: string; verifier: string; basis: string; state: string; citations: { sourceId: string; revision: number; spanId: string; quote: string }[]; dueRaw: string | null }
export type LegacyNotesState = 'none' | 'exact' | 'edited'
export type TaskEvidenceDisplay = { quotes: (TaskSourceEvidence & { sourceTitle: string })[]; erasedSourceIds: string[]; legacy: LegacyNotesState }
export type LegacyMigrationResult = { migrated: number; movedQuotes: number; erasedQuotes: number; review: number }

// Exact shape written by detection-run.ts before evidence rows existed (one span per citation line).
export const legacyDetectionHeader = '資料から検出し本人が確認する候補。検出='
const legacyPattern = /^資料から検出し本人が確認する候補。検出=([\w~./:-]{3,120}) \/ 検証=([\w~./:-]{3,120})（同じモデル、独立評価未通過）\n根拠: (explicit_request|self_commitment|documented_obligation|approved_rule) \/ (requested|committed|required_by_rule)((?:\n\[[^\s\]]+ 内容版\d+ [^\s\]]+\] [^\n]*)+)(?:\n期限の原文: ([^\n]*))?$/
const citationPattern = /^\[([^\s\]]+) 内容版(\d+) ([^\s\]]+)\] (.*)$/
const erasedMark = '［資料の引用を消去］'

export function parseLegacyDetectionNotes(notes: string): LegacyDetectionNotes | null {
  const match = typeof notes === 'string' ? legacyPattern.exec(notes) : null
  if (!match) return null
  const citations = match[5].slice(1).split('\n').map(line => { const part = citationPattern.exec(line)!; return { sourceId: part[1], revision: Number(part[2]), spanId: part[3], quote: part[4] } })
  if (citations.some(citation => !Number.isSafeInteger(citation.revision) || citation.revision < 1 || !citation.quote)) return null
  return { detector: match[1], verifier: match[2], basis: match[3], state: match[4], citations, dueRaw: match[6] ?? null }
}
/** 'edited' keeps the owner's text untouched but marks it as possibly source-derived. */
export function legacyNotesState(notes: string): LegacyNotesState {
  if (parseLegacyDetectionNotes(notes)) return 'exact'
  return notes.split('\n').some(line => line.startsWith(legacyDetectionHeader) || citationPattern.test(line)) ? 'edited' : 'none'
}
export function detectionProvenanceNotes(detector: string, verifier: string, basis: string, state: string, runId: string): string {
  return `資料から検出し本人が採用した候補。検出=${detector} / 検証=${verifier}（同じモデル、独立評価未通過）\n根拠: ${basis} / ${state}\n資料の引用はメモに複写せず「資料の根拠」に保存（検出 ${runId}）。資料の削除・期限切れで引用も消去します。`
}
export async function quoteDigest(quote: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(quote)))].map(byte => byte.toString(16).padStart(2, '0')).join('') }
export function sourceEvidenceUsable(source: ContextSource | undefined | null, ownerId: string, now = Date.now()): source is ContextSource {
  return Boolean(source && source.ownerId === ownerId && !source.deletedAt && (source.retentionUntil === null || Date.parse(source.retentionUntil) > now) && source.permissions.acquire && source.permissions.retain && source.permissions.index)
}

function scrubValue(value: unknown, before: string, after: string, secrets: string[]): unknown {
  if (typeof value === 'string') return value === before ? after : secrets.reduce((text, secret) => text.split(secret).join(erasedMark), value.split(before).join(after))
  if (Array.isArray(value)) return value.map(item => scrubValue(item, before, after, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item, before, after, secrets)]))
  return value
}
/** Replaces legacy note copies kept in receipts and audits; JSON is rewritten structurally. */
export function scrubLegacyCopies(text: string, before: string, after: string, secrets: string[]): string {
  const list = [...new Set(secrets.filter(secret => secret.length > 0))].sort((left, right) => right.length - left.length)
  const escaped = (value: string) => JSON.stringify(value).slice(1, -1)
  if (![before, ...list].some(secret => text.includes(secret) || text.includes(escaped(secret)))) return text
  try { const parsed: unknown = JSON.parse(text); if (parsed && typeof parsed === 'object') return JSON.stringify(scrubValue(parsed, before, after, list)) } catch { /* Plain-text audit descriptions are scrubbed below. */ }
  return scrubValue(text, before, after, list) as string
}

type ApprovedDetection = { taskId: string; sourceId: string; detectorModel: string; runId: string; candidateId: string }
function approvedDetections(audits: { id: string; operation: string; detail: string }[]): Map<string, ApprovedDetection> {
  const byTask = new Map<string, ApprovedDetection>()
  for (const audit of audits) {
    if (audit.operation !== 'detection.approved') continue
    try {
      const detail = JSON.parse(audit.detail) as { runId?: unknown; candidateId?: unknown; source?: { sourceId?: unknown }; detectorModel?: unknown; taskIds?: unknown }
      if (typeof detail.runId !== 'string' || typeof detail.candidateId !== 'string' || typeof detail.source?.sourceId !== 'string' || typeof detail.detectorModel !== 'string' || !Array.isArray(detail.taskIds)) continue
      for (const taskId of detail.taskIds) if (typeof taskId === 'string') byTask.set(taskId, { taskId, sourceId: detail.source.sourceId, detectorModel: detail.detectorModel, runId: detail.runId, candidateId: detail.candidateId })
    } catch { /* Unknown audit text is not detection provenance. */ }
  }
  return byTask
}
let migration: Promise<LegacyMigrationResult> | null = null
/** One-way and idempotent: exact machine blocks move to evidence (live source) or are erased; edited notes stay. */
export async function migrateLegacyDetectionNotes(): Promise<LegacyMigrationResult> {
  if (migration) return migration
  migration = (async () => {
    const result: LegacyMigrationResult = { migrated: 0, movedQuotes: 0, erasedQuotes: 0, review: 0 }
    const settings = await db.settings.get('main')
    if (!settings) return result
    const approved = approvedDetections(await db.audits.toArray()), now = Date.now()
    for (const task of await db.tasks.toArray()) {
      const state = legacyNotesState(task.notes)
      if (state === 'edited') result.review++
      const approval = approved.get(task.id), parsed = state === 'exact' ? parseLegacyDetectionNotes(task.notes) : null
      if (!approval || !parsed || parsed.detector !== approval.detectorModel || parsed.citations.some(citation => citation.sourceId !== approval.sourceId)) { if (state === 'exact') result.review++; continue }
      const source = await db.contextSources.get(approval.sourceId), digests = await Promise.all(parsed.citations.map(citation => quoteDigest(citation.quote)))
      const before = task.notes, after = detectionProvenanceNotes(parsed.detector, parsed.verifier, parsed.basis, parsed.state, approval.runId), secrets = [...parsed.citations.map(citation => citation.quote), ...(parsed.dueRaw ? [parsed.dueRaw] : [])]
      const changed = await db.transaction('rw', [db.tasks, db.audits, db.commands, db.taskSourceEvidence, db.contextSources, db.contextSnapshots, db.settings], async () => {
        const current = await db.tasks.get(task.id), owner = await db.settings.get('main')
        if (!current || current.notes !== before || !owner || owner.profileId !== settings.profileId || owner.datasetId !== settings.datasetId) return null
        const live = await db.contextSources.get(approval.sourceId), usable = sourceEvidenceUsable(live, owner.profileId, now) && live!.permissionRevision === source?.permissionRevision
        let moved = 0
        for (const [index, citation] of parsed.citations.entries()) {
          const snapshot = usable ? await db.contextSnapshots.get(`${citation.sourceId}:${citation.revision}`) : undefined
          if (!snapshot || snapshot.ownerId !== owner.profileId || !snapshot.spans.some(span => span.id === citation.spanId && span.text.includes(citation.quote))) continue
          await db.taskSourceEvidence.put({ id: `legacy:${task.id}:${index}`, ownerId: owner.profileId, datasetId: owner.datasetId, taskId: task.id, sourceId: citation.sourceId, snapshotRevision: citation.revision, permissionRevision: live!.permissionRevision, spanId: citation.spanId, quote: citation.quote, quoteSha256: digests[index], supports: [], runId: approval.runId, candidateId: approval.candidateId, createdAt: new Date().toISOString() })
          moved++
        }
        await db.tasks.put({ ...current, notes: after })
        for (const row of await db.commands.toArray()) if (row.hash.includes(task.id) || row.resultId.includes(task.id)) {
          const hash = scrubLegacyCopies(row.hash, before, after, secrets), resultId = scrubLegacyCopies(row.resultId, before, after, secrets)
          if (hash !== row.hash || resultId !== row.resultId) await db.commands.put({ ...row, hash, resultId })
        }
        for (const row of await db.audits.toArray()) if (row.taskId === task.id || row.detail.includes(task.id)) {
          const detail = scrubLegacyCopies(row.detail, before, after, secrets)
          if (detail !== row.detail) await db.audits.put({ ...row, detail })
        }
        await db.audits.add({ id: uid(), taskId: task.id, operation: 'task.source_quote_migrated', at: new Date().toISOString(), detail: JSON.stringify({ sourceId: approval.sourceId, runId: approval.runId, movedToEvidence: moved, erased: parsed.citations.length - moved }) })
        return moved
      })
      if (changed === null) continue
      result.migrated++; result.movedQuotes += changed; result.erasedQuotes += parsed.citations.length - changed
    }
    return result
  })()
  try { return await migration } finally { migration = null }
}

/** Called inside the source library's purge transaction. */
export async function purgeTaskSourceEvidence(sourceId: string): Promise<number> { return db.taskSourceEvidence.where('sourceId').equals(sourceId).delete() }
export function legacyReviewTasks(tasks: Task[], sourceId: string): Task[] {
  return tasks.filter(task => legacyNotesState(task.notes) !== 'none' && task.notes.includes(`[${sourceId} 内容版`))
}

export async function taskEvidenceDisplay(task: Task): Promise<TaskEvidenceDisplay> {
  const settings = await db.settings.get('main'), rows = await db.taskSourceEvidence.where('taskId').equals(task.id).toArray(), now = Date.now()
  const audits = await db.audits.where('taskId').equals(task.id).toArray(), approval = approvedDetections(audits).get(task.id)
  const ids = [...new Set([...rows.map(row => row.sourceId), ...(approval ? [approval.sourceId] : [])])], sources = new Map((await db.contextSources.bulkGet(ids)).filter((source): source is ContextSource => Boolean(source)).map(source => [source.id, source]))
  const usable = (id: string) => Boolean(settings && sourceEvidenceUsable(sources.get(id), settings.profileId, now))
  const quotes = rows.filter(row => settings && row.ownerId === settings.profileId && usable(row.sourceId)).sort((left, right) => left.id.localeCompare(right.id)).map(row => ({ ...row, sourceTitle: sources.get(row.sourceId)!.title }))
  return { quotes, erasedSourceIds: ids.filter(id => !usable(id) && !quotes.some(row => row.sourceId === id)), legacy: legacyNotesState(task.notes) }
}

const timestamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value
const text = (value: unknown, max = 300) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const evidenceKeys = ['id', 'ownerId', 'datasetId', 'taskId', 'sourceId', 'snapshotRevision', 'permissionRevision', 'spanId', 'quote', 'quoteSha256', 'supports', 'runId', 'candidateId', 'createdAt']
export function validateTaskSourceEvidenceRecords(rows: unknown, taskIds: Set<string>, sourceIds: Set<string>, ownerId: string, datasetId: string): asserts rows is TaskSourceEvidence[] | undefined {
  if (rows === undefined) return
  const fail = () => { throw new Error('バックアップのタスク内の資料引用が不正です') }
  if (!Array.isArray(rows) || rows.length > 100000) fail()
  const ids = new Set<string>()
  for (const raw of rows as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== evidenceKeys.length || evidenceKeys.some(key => !Object.hasOwn(raw, key))) fail()
    const row = raw as Record<string, unknown>
    if (!text(row.id) || ids.has(row.id as string) || row.ownerId !== ownerId || row.datasetId !== datasetId || !taskIds.has(row.taskId as string) || !sourceIds.has(row.sourceId as string) || !Number.isSafeInteger(row.snapshotRevision) || (row.snapshotRevision as number) < 1 || !Number.isSafeInteger(row.permissionRevision) || (row.permissionRevision as number) < 1 || !text(row.spanId) || !text(row.quote, 2000) || typeof row.quoteSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.quoteSha256) || !Array.isArray(row.supports) || row.supports.length > 6 || row.supports.some(item => !text(item, 30)) || !text(row.runId) || !text(row.candidateId) || !timestamp(row.createdAt)) fail()
    ids.add(row.id as string)
  }
}
export async function verifyTaskSourceEvidenceDigests(rows: TaskSourceEvidence[] | undefined): Promise<void> {
  for (const row of rows ?? []) if (await quoteDigest(row.quote) !== row.quoteSha256) throw new Error('バックアップのタスク内の資料引用のハッシュが一致しません')
}
/** Restore keeps only quotes whose source is still live in the restored data and not erased on this device. */
export function restorableTaskSourceEvidence(rows: TaskSourceEvidence[] | undefined, sources: ContextSource[] | undefined, ownerId: string, erasedSourceIds: Set<string>, now = Date.now()): TaskSourceEvidence[] {
  const byId = new Map((sources ?? []).map(source => [source.id, source]))
  return (rows ?? []).filter(row => !erasedSourceIds.has(row.sourceId) && sourceEvidenceUsable(byId.get(row.sourceId), ownerId, now))
}
export async function evidenceCountsBySource(ownerId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  for (const row of await db.taskSourceEvidence.where('ownerId').equals(ownerId).toArray()) counts.set(row.sourceId, (counts.get(row.sourceId) ?? 0) + 1)
  return counts
}
