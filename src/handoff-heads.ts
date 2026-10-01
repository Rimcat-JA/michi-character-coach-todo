import { db } from './db'
import { contentDigest } from './canonical'
import { uid, type Completion, type Task } from './domain'
import type { Snapshot } from './backup-validation'
import type { HandoffKind, HandoffManifest } from './handoff-manifest'

/** Device identity for file handoff. Kept out of every snapshot, so a restore never copies or replaces it. */
export type PendingMove = { moveId: string; secret: string; startedAt: string; bundleId: string | null }
export type LocalDevice = { id: 'main'; deviceId: string; createdAt: string; pendingMove: PendingMove | null }
export type HeadFields = { title: string; notes: string; project: string; labels: string[]; scoreMode: string; manualPoints: number | null; scheduledDate: string | null; dueDate: string | null; dueAt: string | null; status: Task['status']; completed: boolean; completionNetPoints: number | null; deletedAt: string | null }
export type TaskHead = { revision: number; criticalHash: string; fields: HeadFields }
export type HandoffHeads = Record<string, TaskHead>
export type HandoffDecision = 'exported' | 'kept' | 'replaced' | 'replaced_after_export' | 'adopted' | 'different_dataset' | 'move_accepted'
/** What this device exported or imported. Heads are always computed here from rows, never read from a manifest. */
export type HandoffRecord = { id: string; bundleId: string; datasetId: string; deviceId: string; sourceDeviceId: string; direction: 'export' | 'import'; kind: HandoffKind; decision: HandoffDecision; createdAt: string; heads: HandoffHeads; rowIds: Record<string, string[]>; moveCode: string | null }

/** Rows whose local-only additions (ledger, completions, notes...) would be lost by a replace. */
export const HANDOFF_ROW_TABLES = ['assessments', 'completions', 'ledger', 'sessions', 'routines', 'containers', 'checklistItems', 'taskNotes', 'taskComments', 'taskAttachments', 'taskDependencies', 'rollovers', 'habits', 'habitLogs', 'goals', 'goalCheckIns', 'trackerEntries', 'dayNotes', 'pomodoroCycles', 'reviewRecords'] as const
export type HandoffRowTable = typeof HANDOFF_ROW_TABLES[number]
type HeadSource = { tasks: Task[]; completions: Completion[] } & Partial<Record<HandoffRowTable, { id: string }[]>>

export async function ensureLocalDevice(): Promise<LocalDevice> {
  return db.transaction('rw', db.localDevice, async () => {
    const current = await db.localDevice.get('main')
    if (current) return current
    const device: LocalDevice = { id: 'main', deviceId: uid(), createdAt: new Date().toISOString(), pendingMove: null }
    await db.localDevice.add(device)
    return device
  })
}
export function headFields(task: Task, completion: Completion | undefined): HeadFields {
  return { title: task.title, notes: task.notes, project: task.project, labels: [...task.labels].sort(), scoreMode: task.score.mode, manualPoints: task.score.manualPoints, scheduledDate: task.scheduledDate, dueDate: task.dueDate, dueAt: task.dueAt ?? null, status: task.status, completed: Boolean(completion?.currentAt), completionNetPoints: completion?.currentAt ? completion.netPoints : null, deletedAt: task.deletedAt }
}
export async function computeHeads(source: HeadSource): Promise<HandoffHeads> {
  const completions = new Map(source.completions.map(row => [row.taskId, row])), heads: HandoffHeads = {}
  for (const task of source.tasks) { const fields = headFields(task, completions.get(task.id)); heads[task.id] = { revision: task.revision, criticalHash: await contentDigest(fields), fields } }
  return heads
}
export function computeRowIds(source: HeadSource): Record<string, string[]> {
  return Object.fromEntries(HANDOFF_ROW_TABLES.map(table => [table, (source[table] ?? []).map(row => row.id).sort()]))
}
export async function localHandoffSource(): Promise<HeadSource> {
  return db.transaction('r', [db.tasks, db.completions, ...HANDOFF_ROW_TABLES.map(table => db.table(table))], async () => ({ tasks: await db.tasks.toArray(), completions: await db.completions.toArray(), ...Object.fromEntries(await Promise.all(HANDOFF_ROW_TABLES.map(async table => [table, (await db.table(table).toArray()).map(row => ({ id: (row as { id: string }).id }))]))) }))
}
/** The newest bundle this device exported or imported for the dataset: the next export's base. */
export async function latestHandoff(datasetId: string): Promise<HandoffRecord | undefined> {
  return (await db.handoffHeads.where('datasetId').equals(datasetId).toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}
export async function stampHandoff(snapshot: Snapshot, kind: 'backup'): Promise<HandoffManifest>
export async function stampHandoff(snapshot: Snapshot, kind: 'move', extra: { move_id: string; move_secret: string }): Promise<HandoffManifest>
export async function stampHandoff(snapshot: Snapshot, kind: 'fork', extra: { parent_dataset_id: string }): Promise<HandoffManifest>
export async function stampHandoff(snapshot: Snapshot, kind: HandoffKind, extra: Record<string, string> = {}): Promise<HandoffManifest> {
  const device = await ensureLocalDevice(), datasetId = snapshot.settings[0].datasetId
  const base = kind === 'fork' ? undefined : await latestHandoff(datasetId)
  return { bundle_id: uid(), kind, dataset_id: datasetId, source_device_id: device.deviceId, exported_at: new Date().toISOString(), base_bundle_id: base?.bundleId ?? null, ...extra } as HandoffManifest
}
export async function recordHandoff(snapshot: Snapshot, direction: HandoffRecord['direction'], decision: HandoffDecision, moveCode: string | null = null): Promise<HandoffRecord | null> {
  const manifest = snapshot.handoff
  if (!manifest) return null
  const device = await ensureLocalDevice()
  const record: HandoffRecord = { id: `${direction}:${manifest.bundle_id}`, bundleId: manifest.bundle_id, datasetId: manifest.dataset_id, deviceId: device.deviceId, sourceDeviceId: manifest.source_device_id, direction, kind: manifest.kind, decision, createdAt: new Date().toISOString(), heads: await computeHeads(snapshot), rowIds: computeRowIds(snapshot), moveCode }
  // Re-importing the same bundle keeps its first time, so it never becomes a newer base than later exports.
  return db.transaction('rw', db.handoffHeads, async () => {
    const prior = await db.handoffHeads.get(record.id), next = prior ? { ...record, createdAt: prior.createdAt, moveCode: moveCode ?? prior.moveCode } : record
    await db.handoffHeads.put(next)
    return next
  })
}
