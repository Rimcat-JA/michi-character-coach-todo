import { db } from './db'
import { exportBackup, restoreBackup } from './backup'
import { validateSnapshot, type Snapshot } from './backup-validation'
import { updateTask, type TaskInput } from './commands'
import { calculateScore, uid, type Task } from './domain'
import { validateLabelsForOwner } from './labels'
import { computeHeads, computeRowIds, ensureLocalDevice, HANDOFF_ROW_TABLES, localHandoffSource, recordHandoff, type HandoffHeads, type HandoffRecord, type HeadFields } from './handoff-heads'
import type { HandoffManifest } from './handoff-manifest'

export type HandoffTaskState = 'identical' | 'incoming_only' | 'local_only' | 'both_changed' | 'created_local' | 'created_incoming' | 'deleted' | 'needs_review'
export type HandoffField = keyof HeadFields
export type HandoffFieldDiff = { field: HandoffField; base: unknown; local: unknown; incoming: unknown; changedBy: 'local' | 'incoming' | 'both' | 'unknown' }
export type HandoffTaskComparison = { taskId: string; title: string; state: HandoffTaskState; diffs: HandoffFieldDiff[]; manualConflict: boolean; completionConflict: boolean; localRevision: number | null }
export type HandoffComparison = { baseKnown: boolean; tasks: HandoffTaskComparison[]; localOnlyRows: Partial<Record<string, number>>; blocking: boolean }
export type HandoffPreview = { manifest: HandoffManifest | null; sameDataset: boolean; localDatasetId: string; incomingDatasetId: string; alreadyImported: boolean; comparison: HandoffComparison; counts: { localTasks: number; incomingTasks: number; localCompletions: number; incomingCompletions: number; localLedger: number; incomingLedger: number } }
type Side = { heads: HandoffHeads; rowIds: Record<string, string[]> }

/** States that mean this device holds something the incoming file does not; a direct replace is then blocked. */
export const BLOCKING_STATES: HandoffTaskState[] = ['local_only', 'both_changed', 'created_local', 'deleted', 'needs_review']
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export function compareHandoff(local: Side, incoming: Side, base: Side | null, sameDataset = true): HandoffComparison {
  const ids = [...new Set([...Object.keys(local.heads), ...Object.keys(incoming.heads)])].sort(), tasks: HandoffTaskComparison[] = []
  for (const taskId of ids) {
    const l = local.heads[taskId], i = incoming.heads[taskId], b = base?.heads[taskId]
    let state: HandoffTaskState
    if (l && i && l.criticalHash === i.criticalHash) state = 'identical'
    else if (!base) state = 'needs_review'
    else if (!l) state = b ? 'deleted' : 'created_incoming'
    else if (!i) state = b ? 'deleted' : 'created_local'
    else if (!b) state = 'both_changed'
    else { const lc = l.criticalHash !== b.criticalHash, ic = i.criticalHash !== b.criticalHash; state = lc && ic ? 'both_changed' : lc ? 'local_only' : 'incoming_only' }
    const fields = Object.keys((l ?? i).fields) as HandoffField[]
    const diffs = state === 'identical' ? [] : fields.filter(field => !same(l?.fields[field] ?? null, i?.fields[field] ?? null)).map(field => {
      const baseValue = b?.fields[field] ?? null, lc = !same(l?.fields[field] ?? null, baseValue), ic = !same(i?.fields[field] ?? null, baseValue)
      return { field, base: b ? baseValue : null, local: l?.fields[field] ?? null, incoming: i?.fields[field] ?? null, changedBy: !base || !b ? 'unknown' as const : lc && ic ? 'both' as const : lc ? 'local' as const : 'incoming' as const }
    })
    const manualConflict = diffs.some(diff => diff.field === 'manualPoints' || diff.field === 'scoreMode') && (l?.fields.scoreMode === 'manual' || i?.fields.scoreMode === 'manual')
    const completionConflict = diffs.some(diff => diff.field === 'completed' || diff.field === 'completionNetPoints' || diff.field === 'status')
    tasks.push({ taskId, title: (l ?? i).fields.title, state, diffs, manualConflict, completionConflict, localRevision: l?.revision ?? null })
  }
  const localOnlyRows: Partial<Record<string, number>> = {}
  for (const table of HANDOFF_ROW_TABLES) { const incomingIds = new Set(incoming.rowIds[table] ?? []), count = (local.rowIds[table] ?? []).filter(id => !incomingIds.has(id)).length; if (count) localOnlyRows[table] = count }
  const blocking = sameDataset && (tasks.some(task => BLOCKING_STATES.includes(task.state)) || Object.keys(localOnlyRows).length > 0)
  return { baseKnown: Boolean(base), tasks, localOnlyRows, blocking }
}

async function baseFor(manifest: HandoffManifest | undefined, datasetId: string): Promise<HandoffRecord | null> {
  if (!manifest?.base_bundle_id) return null
  const rows = await db.handoffHeads.where('bundleId').equals(manifest.base_bundle_id).toArray()
  return rows.find(row => row.datasetId === datasetId) ?? null
}
/** Compares an inspected bundle with this device. Heads on both sides come from rows, never from the file's manifest. */
export async function inspectHandoff(snapshot: Snapshot): Promise<HandoffPreview> {
  validateSnapshot(snapshot)
  const settings = await db.settings.get('main')
  if (!settings) throw new Error('設定がありません')
  const source = await localHandoffSource(), incomingDatasetId = snapshot.settings[0].datasetId, sameDataset = incomingDatasetId === settings.datasetId
  const local = { heads: await computeHeads(source), rowIds: computeRowIds(source) }, incoming = { heads: await computeHeads(snapshot), rowIds: computeRowIds(snapshot) }
  const base = sameDataset ? await baseFor(snapshot.handoff, settings.datasetId) : null
  const alreadyImported = Boolean(snapshot.handoff && await db.handoffHeads.get(`import:${snapshot.handoff.bundle_id}`))
  return { manifest: snapshot.handoff ?? null, sameDataset, localDatasetId: settings.datasetId, incomingDatasetId, alreadyImported, comparison: compareHandoff(local, incoming, base, sameDataset), counts: { localTasks: source.tasks.length, incomingTasks: snapshot.tasks.length, localCompletions: source.completions.length, incomingCompletions: snapshot.completions.length, localLedger: source.ledger?.length ?? 0, incomingLedger: snapshot.ledger.length } }
}
function trusted(event: Event) {
  const getter = Object.getOwnPropertyDescriptor(Event.prototype, 'type')?.get
  if (!(event instanceof Event) || !event.isTrusted || !getter || !['click', 'submit'].includes(getter.call(event))) throw new Error('本人確認ボタンから操作してください')
}
/** (b) Keep this device as the master. Nothing is written except the record that this file was reviewed. */
export async function keepLocalForHandoff(snapshot: Snapshot): Promise<void> {
  validateSnapshot(snapshot)
  if ((await inspectHandoff(snapshot)).sameDataset) await recordHandoff(snapshot, 'import', 'kept')
}
/** Direct replace: allowed only when nothing on this device would be lost, or after the explicit different-dataset confirmation. */
export async function replaceWithHandoff(snapshot: Snapshot, options: { confirmDifferentDataset?: boolean } = {}): Promise<void> {
  const preview = await inspectHandoff(snapshot)
  if (snapshot.handoff?.kind === 'move') throw new Error('移行ファイルは「移行を受け入れる」から取り込んでください')
  if (!preview.sameDataset && !options.confirmDifferentDataset) throw new Error('別データセットのファイルです。「別データセットで置き換え」を確認してください')
  if (preview.comparison.blocking) throw new Error('この端末だけの変更があります。書き出してから置き換えるか、個別に取り込んでください')
  await restoreBackup(snapshot)
  await recordHandoff(snapshot, 'import', preview.sameDataset ? 'replaced' : 'different_dataset')
}
/** (c) Export this device first; the replace runs only after the export succeeded. */
export async function replaceAfterExport(snapshot: Snapshot, password: string, exporter: (password: string) => Promise<void> = exportBackup): Promise<void> {
  validateSnapshot(snapshot)
  if (snapshot.handoff?.kind === 'move') throw new Error('移行ファイルは「移行を受け入れる」から取り込んでください')
  const preview = await inspectHandoff(snapshot)
  if (!preview.sameDataset) throw new Error('別データセットのファイルは「別データセットで置き換え」から取り込んでください')
  await exporter(password)
  await restoreBackup(snapshot)
  await recordHandoff(snapshot, 'import', 'replaced_after_export')
}
export const ADOPTABLE_FIELDS = ['title', 'notes', 'score', 'scheduledDate', 'dueDate'] as const
export type AdoptableField = typeof ADOPTABLE_FIELDS[number]
/** (d) Adopt chosen fields through a normal revision-checked update: a new assessment and an audit row, never ledger or completions. */
export async function adoptHandoffFields(snapshot: Snapshot, taskId: string, fields: AdoptableField[], expectedRevision: number, event: Event): Promise<string> {
  trusted(event)
  validateSnapshot(snapshot)
  const manifest = snapshot.handoff
  if (!manifest) throw new Error('引継ぎ情報のないファイルは個別に取り込めません。書き出してから置き換えてください')
  if (!fields.length || fields.some(field => !ADOPTABLE_FIELDS.includes(field))) throw new Error('取り込む項目を選んでください')
  const incoming = snapshot.tasks.find(task => task.id === taskId)
  if (!incoming) throw new Error('取込ファイルにこのタスクがありません')
  const settings = await db.settings.get('main')
  if (!settings || settings.datasetId !== manifest.dataset_id) throw new Error('別データセットのタスクは個別に取り込めません')
  const local = await db.tasks.get(taskId)
  if (!local || local.deletedAt) throw new Error('この端末にタスクがありません')
  const input: TaskInput = { title: local.title, notes: local.notes, project: local.project, containerId: local.containerId ?? null, labels: local.labels, scheduledDate: local.scheduledDate, dueDate: local.dueDate, dueAt: local.dueAt ?? null, dueTimezone: local.dueTimezone ?? null, targetDate: local.targetDate, reviewDate: local.reviewDate, availableFrom: local.availableFrom, deferredUntil: local.deferredUntil ?? null, importance: local.importance, frog: local.frog ?? null, weight: local.weight ?? null, energyNeed: local.energyNeed ?? null, focusNeed: local.focusNeed ?? null, positiveFeeling: local.positiveFeeling ?? null, score: local.score }
  for (const field of fields) {
    if (field === 'score') input.score = { ...incoming.score }
    else if (field === 'dueDate') Object.assign(input, { dueDate: incoming.dueDate, dueAt: incoming.dueAt ?? null, dueTimezone: incoming.dueTimezone ?? null })
    else Object.assign(input, { [field]: incoming[field] })
  }
  // Adopting values this device already has is a no-op, so re-importing the same file never adds revisions.
  const changed = fields.some(field => field === 'score' ? !same(incoming.score, local.score) : field === 'dueDate' ? !same([incoming.dueDate, incoming.dueAt ?? null], [local.dueDate, local.dueAt ?? null]) : !same(incoming[field], local[field]))
  if (!changed) { await recordHandoff(snapshot, 'import', 'adopted'); return taskId }
  await db.transaction('rw', [db.tasks, db.assessments, db.completions, db.ledger, db.routines, db.sessions, db.commands, db.audits, db.containers, db.settings, db.labelGroups, db.labelDefinitions, db.tripBundles], async () => {
    await updateTask(taskId, expectedRevision, input)
    await db.audits.add({ id: uid(), taskId, operation: `adopted_from_handoff:${manifest.bundle_id}`, at: new Date().toISOString(), detail: `別端末のファイルから本人が取込: ${fields.join(',')}` })
  })
  await recordHandoff(snapshot, 'import', 'adopted')
  return taskId
}
/** Adopts a task that only exists in the incoming file. Completed tasks need manual handling: completions and ledger are never copied. */
export async function adoptHandoffTask(snapshot: Snapshot, taskId: string, event: Event): Promise<string> {
  trusted(event)
  validateSnapshot(snapshot)
  const manifest = snapshot.handoff
  if (!manifest) throw new Error('引継ぎ情報のないファイルは個別に取り込めません')
  const incoming = snapshot.tasks.find(task => task.id === taskId)
  if (!incoming || incoming.deletedAt) throw new Error('取込ファイルにこのタスクがありません')
  if (incoming.status !== 'open' || snapshot.completions.some(row => row.taskId === taskId)) throw new Error('完了記録のあるタスクは要手動対応です。完了と台帳は取り込みません')
  const settings = await db.settings.get('main')
  if (!settings || settings.datasetId !== manifest.dataset_id) throw new Error('別データセットのタスクは個別に取り込めません')
  let labels = [...incoming.labels]
  try { await validateLabelsForOwner(labels) } catch { labels = [] }
  await db.transaction('rw', [db.tasks, db.assessments, db.audits], async () => {
    if (await db.tasks.get(taskId)) throw new Error('このタスクは取込済みです')
    const at = new Date().toISOString(), assessmentId = uid()
    const task: Task = { ...structuredClone(incoming), labels, generationKey: `handoff:${manifest.bundle_id}:${taskId}`, routineId: null, containerId: null, planBucketId: null, assessmentId, status: 'open', revision: 1, updatedAt: at, deletedAt: null }
    await db.tasks.add(task)
    await db.assessments.add({ id: assessmentId, taskId, score: { ...incoming.score }, result: calculateScore(incoming.score), createdAt: at, origin: 'human', ruleVersion: 'v1' })
    await db.audits.add({ id: uid(), taskId, operation: `adopted_from_handoff:${manifest.bundle_id}`, at, detail: '別端末のファイルから本人がタスクを取込' })
  })
  await recordHandoff(snapshot, 'import', 'adopted')
  return taskId
}
export async function lastHandoffAt(): Promise<string | null> {
  const settings = await db.settings.get('main')
  if (!settings) return null
  return (await db.handoffHeads.where('datasetId').equals(settings.datasetId).toArray()).reduce<string | null>((latest, row) => !latest || row.createdAt > latest ? row.createdAt : latest, null)
}
export { ensureLocalDevice }
