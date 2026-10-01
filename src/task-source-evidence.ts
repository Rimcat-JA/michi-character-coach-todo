import { db } from './db'
import { uid, type Audit, type CommandReceipt, type Task } from './domain'
import type { ContextSource } from './source-library'

export type TaskSourceEvidence = { id: string; ownerId: string; datasetId: string; taskId: string; sourceId: string; snapshotRevision: number; permissionRevision: number; spanId: string; quote: string; quoteSha256: string; supports: string[]; runId: string; candidateId: string; createdAt: string }
export type LegacyDetectionNotes = { detector: string; verifier: string; basis: string; state: string; citations: { sourceId: string; revision: number; spanId: string; quote: string }[]; dueRaw: string | null }
export type LegacyNotesState = 'none' | 'exact' | 'edited'
export type TaskEvidenceDisplay = { quotes: (TaskSourceEvidence & { sourceTitle: string })[]; erasedSourceIds: string[]; deletedSourceIds: string[]; legacy: LegacyNotesState }
export type LegacyMigrationResult = { migrated: number; movedQuotes: number; erasedQuotes: number; review: number; scrubbedReceipts: number }
export type LegacyReviewTask = { id: string; state: Exclude<LegacyNotesState, 'none'> }

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
/** Notes the app itself wrote for the task: inputs[index] of the bulk_create receipt that created it. */
function receiptNotes(commands: CommandReceipt[], taskId: string): string | null {
  for (const row of commands) {
    try {
      const ids: unknown = JSON.parse(row.resultId), index = Array.isArray(ids) ? ids.indexOf(taskId) : -1
      if (index < 0) continue
      const hash = JSON.parse(row.hash) as { operation?: unknown; inputs?: { notes?: unknown }[] }, notes = hash.operation === 'bulk_create' && Array.isArray(hash.inputs) ? hash.inputs[index]?.notes : null
      if (typeof notes === 'string') return notes
    } catch { /* Single-task receipts and plain hashes are not bulk_create receipts. */ }
  }
  return null
}
const fitsApproval = (parsed: LegacyDetectionNotes | null, approval: ApprovedDetection) => parsed && parsed.detector === approval.detectorModel && parsed.citations.every(citation => citation.sourceId === approval.sourceId) ? parsed : null
// Quote fragments are scrubbed only from rows the app generated; owner-authored records (completion, correction, ChangeSet) lose only the verbatim legacy block.
const machineAudit = (row: Audit) => row.operation === 'score.ai_attributes' || /^(detection|assist|egress)\./.test(row.operation)
const machineCommand = (row: CommandReceipt) => row.key.startsWith('assist:')
type LegacyCopies = { approval: ApprovedDetection; parsed: LegacyDetectionNotes; exact: boolean; blocks: string[]; quotes: string[]; after: string }
/** Legacy copies tied to a task: its current exact notes and/or the original block in its creation receipt. */
function legacyCopies(task: Task, approval: ApprovedDetection | undefined, commands: CommandReceipt[]): LegacyCopies | null {
  if (!approval) return null
  const exact = legacyNotesState(task.notes) === 'exact' ? fitsApproval(parseLegacyDetectionNotes(task.notes), approval) : null
  const receipt = receiptNotes(commands, task.id), original = receipt === null ? null : fitsApproval(parseLegacyDetectionNotes(receipt), approval)
  const parsed = exact ?? original
  if (!parsed) return null
  const blocks = [...new Set([...(exact ? [task.notes] : []), ...(original ? [receipt!] : [])])]
  // The due phrase is not a standalone secret: short phrases also occur in owner-written records and leave only as part of the whole block.
  const quotes = [...new Set([...(exact?.citations ?? []), ...(original?.citations ?? [])].map(citation => citation.quote))]
  return { approval, parsed, exact: Boolean(exact), blocks, quotes, after: detectionProvenanceNotes(parsed.detector, parsed.verifier, parsed.basis, parsed.state, approval.runId) }
}
/** Runs inside a transaction that covers commands and audits. Returns the number of rows rewritten. */
async function scrubTaskCopies(taskId: string, copies: LegacyCopies): Promise<number> {
  let changed = 0
  const scrub = (text: string, quotes: string[]) => copies.blocks.reduce((value, before) => scrubLegacyCopies(value, before, copies.after, quotes), text)
  for (const row of await db.commands.toArray()) if (row.hash.includes(taskId) || row.resultId.includes(taskId)) {
    const quotes = machineCommand(row) ? copies.quotes : [], hash = scrub(row.hash, quotes), resultId = scrub(row.resultId, quotes)
    if (hash !== row.hash || resultId !== row.resultId) { await db.commands.put({ ...row, hash, resultId }); changed++ }
  }
  for (const row of await db.audits.toArray()) if (row.taskId === taskId || row.detail.includes(taskId)) {
    const detail = scrub(row.detail, machineAudit(row) ? copies.quotes : [])
    if (detail !== row.detail) { await db.audits.put({ ...row, detail }); changed++ }
  }
  return changed
}
/** Inside deleteSource's transaction: machine-made receipt/audit copies of legacy notes citing this source. Task notes are never changed here. */
export async function scrubLegacySourceCopies(sourceId: string): Promise<number> {
  const approved = approvedDetections(await db.audits.toArray()), commands = await db.commands.toArray()
  let total = 0
  for (const approval of approved.values()) if (approval.sourceId === sourceId) {
    const task = await db.tasks.get(approval.taskId), copies = task ? legacyCopies(task, approval, commands) : null
    if (!copies) continue
    const rows = await scrubTaskCopies(approval.taskId, copies)
    if (rows) await db.audits.add({ id: uid(), taskId: approval.taskId, operation: 'task.source_quote_migrated', at: new Date().toISOString(), detail: JSON.stringify({ sourceId, runId: approval.runId, movedToEvidence: 0, erased: 0, receiptsOnly: true, rows }) })
    total += rows
  }
  return total
}
let migration: Promise<LegacyMigrationResult> | null = null
/** One-way and idempotent: exact machine blocks move to evidence (live source) or are erased; edited notes stay.
 * The app's own copies (creation receipt, AI audits) are found from the approval audit and scrubbed even when the owner changed the notes. */
export async function migrateLegacyDetectionNotes(): Promise<LegacyMigrationResult> {
  if (migration) return migration
  migration = (async () => {
    const result: LegacyMigrationResult = { migrated: 0, movedQuotes: 0, erasedQuotes: 0, review: 0, scrubbedReceipts: 0 }
    const settings = await db.settings.get('main')
    if (!settings) return result
    const approved = approvedDetections(await db.audits.toArray()), commands = await db.commands.toArray(), now = Date.now()
    for (const task of await db.tasks.toArray()) {
      const state = legacyNotesState(task.notes)
      if (state === 'edited') result.review++
      const copies = legacyCopies(task, approved.get(task.id), commands)
      if (state === 'exact' && !copies?.exact) result.review++
      if (!copies) continue
      const { approval, parsed } = copies, source = copies.exact ? await db.contextSources.get(approval.sourceId) : undefined, digests = copies.exact ? await Promise.all(parsed.citations.map(citation => quoteDigest(citation.quote))) : []
      const changed = await db.transaction('rw', [db.tasks, db.audits, db.commands, db.taskSourceEvidence, db.contextSources, db.contextSnapshots, db.settings], async () => {
        const current = await db.tasks.get(task.id), owner = await db.settings.get('main')
        if (!current || current.notes !== task.notes || !owner || owner.profileId !== settings.profileId || owner.datasetId !== settings.datasetId) return null
        let moved = 0
        if (copies.exact) {
          const live = await db.contextSources.get(approval.sourceId), usable = sourceEvidenceUsable(live, owner.profileId, now) && live!.permissionRevision === source?.permissionRevision
          for (const [index, citation] of parsed.citations.entries()) {
            const snapshot = usable ? await db.contextSnapshots.get(`${citation.sourceId}:${citation.revision}`) : undefined
            if (!snapshot || snapshot.ownerId !== owner.profileId || !snapshot.spans.some(span => span.id === citation.spanId && span.text.includes(citation.quote))) continue
            await db.taskSourceEvidence.put({ id: `legacy:${task.id}:${index}`, ownerId: owner.profileId, datasetId: owner.datasetId, taskId: task.id, sourceId: citation.sourceId, snapshotRevision: citation.revision, permissionRevision: live!.permissionRevision, spanId: citation.spanId, quote: citation.quote, quoteSha256: digests[index], supports: [], runId: approval.runId, candidateId: approval.candidateId, createdAt: new Date().toISOString() })
            moved++
          }
          await db.tasks.put({ ...current, notes: copies.after })
        }
        const rows = await scrubTaskCopies(task.id, copies)
        if (!copies.exact && !rows) return null
        await db.audits.add({ id: uid(), taskId: task.id, operation: 'task.source_quote_migrated', at: new Date().toISOString(), detail: JSON.stringify(copies.exact ? { sourceId: approval.sourceId, runId: approval.runId, movedToEvidence: moved, erased: parsed.citations.length - moved } : { sourceId: approval.sourceId, runId: approval.runId, movedToEvidence: 0, erased: 0, receiptsOnly: true, rows }) })
        return moved
      })
      if (changed === null) continue
      if (!copies.exact) { result.scrubbedReceipts++; continue }
      result.migrated++; result.movedQuotes += changed; result.erasedQuotes += parsed.citations.length - changed
    }
    return result
  })()
  try { return await migration } finally { migration = null }
}

/** Called inside the source library's purge transaction. */
export async function purgeTaskSourceEvidence(sourceId: string): Promise<number> { return db.taskSourceEvidence.where('sourceId').equals(sourceId).delete() }
/** 'exact' = unmigrated machine block, 'edited' = the owner's own text; both stay for the owner to review. */
export function legacyReviewTasks(tasks: Task[], sourceId: string): LegacyReviewTask[] {
  return tasks.flatMap(task => { const state = legacyNotesState(task.notes); return state !== 'none' && task.notes.includes(`[${sourceId} 内容版`) ? [{ id: task.id, state }] : [] })
}

export async function taskEvidenceDisplay(task: Task): Promise<TaskEvidenceDisplay> {
  const settings = await db.settings.get('main'), rows = await db.taskSourceEvidence.where('taskId').equals(task.id).toArray(), now = Date.now()
  const audits = await db.audits.where('taskId').equals(task.id).toArray(), approval = approvedDetections(audits).get(task.id)
  const ids = [...new Set([...rows.map(row => row.sourceId), ...(approval ? [approval.sourceId] : [])])], sources = new Map((await db.contextSources.bulkGet(ids)).filter((source): source is ContextSource => Boolean(source)).map(source => [source.id, source]))
  const usable = (id: string) => Boolean(settings && sourceEvidenceUsable(sources.get(id), settings.profileId, now))
  const quotes = rows.filter(row => settings && row.ownerId === settings.profileId && usable(row.sourceId)).sort((left, right) => left.id.localeCompare(right.id)).map(row => ({ ...row, sourceTitle: sources.get(row.sourceId)!.title }))
  const erasedSourceIds = ids.filter(id => !usable(id) && !quotes.some(row => row.sourceId === id))
  return { quotes, erasedSourceIds, deletedSourceIds: erasedSourceIds.filter(id => !sources.get(id) || Boolean(sources.get(id)!.deletedAt)), legacy: legacyNotesState(task.notes) }
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
    if (!text(row.id) || ids.has(row.id as string) || row.ownerId !== ownerId || row.datasetId !== datasetId || !taskIds.has(row.taskId as string) || !sourceIds.has(row.sourceId as string) || !Number.isSafeInteger(row.snapshotRevision) || (row.snapshotRevision as number) < 1 || !Number.isSafeInteger(row.permissionRevision) || (row.permissionRevision as number) < 1 || !text(row.spanId) || typeof row.quote !== 'string' || row.quote.length === 0 || row.quote.length > 2000 || typeof row.quoteSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.quoteSha256) || !Array.isArray(row.supports) || row.supports.length > 6 || row.supports.some(item => !text(item, 30)) || !text(row.runId) || !text(row.candidateId) || !timestamp(row.createdAt)) fail()
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
