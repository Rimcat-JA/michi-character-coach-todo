import { db } from './db'
import { uid, type Task } from './domain'
import type { ContextSource } from './source-library'
import { legacyNotesState, parseLegacyDetectionNotes, sourceEvidenceUsable, type TaskSourceEvidence } from './task-source-evidence'

export type EgressRoute = 'coach-chat' | 'coach-task-change' | 'score-assist' | 'file-bridge'
export type EgressDestination = { kind: 'ai-model'; route: Exclude<EgressRoute, 'file-bridge'>; model: string | null } | { kind: 'external-agent'; route: 'file-bridge'; clientId: string; host: string }
export type EgressSourceRef = { sourceId: string; snapshotRevision: number; permissionRevision: number; sha256: string }
export type OwnerNotesEgress = { notes: string; withheldQuotes: number; notesWithheld: boolean }
export type TaskEgress = OwnerNotesEgress & { evidence: string[]; refs: EgressSourceRef[]; withheldSourceIds: string[] }
export type EvidenceSource = { source: ContextSource; sha256: string | null }

/** Owner-written notes leave unchanged. Only the exact legacy detection block is cut;
 * an edited legacy block is withheld whole because its quotes can no longer be separated. */
export function ownerNotesForEgress(notes: string): OwnerNotesEgress {
  const state = legacyNotesState(notes)
  if (state === 'none') return { notes, withheldQuotes: 0, notesWithheld: false }
  if (state === 'exact') { const parsed = parseLegacyDetectionNotes(notes)!; return { notes: notes.split('\n').slice(0, 2).join('\n'), withheldQuotes: parsed.citations.length, notesWithheld: false } }
  return { notes: '', withheldQuotes: Math.max(1, notes.split('\n').filter(line => / 内容版\d+ /.test(line)).length), notesWithheld: true }
}
/** Text the task editor sends to the score assistant: title plus egress-filtered notes, never evidence quotes. */
export function scoreAssistText(title: string, notes: string): string { return [title, ownerNotesForEgress(notes).notes].filter(Boolean).join('\n').slice(0, 6000) }
/** Quotes may only join a coach conversation, whose replies are purged with the source.
 * Score text, ChangeSet notes and agent views are persisted or leave the device without a revocable copy. */
export function evidenceAllowed(source: ContextSource | undefined, destination: EgressDestination, ownerId: string, now = Date.now()): boolean {
  return destination.kind === 'ai-model' && destination.route === 'coach-chat' && destination.model !== null && sourceEvidenceUsable(source, ownerId, now) && source.permissions.aiEgress && source.aiProvider === 'openrouter' && source.allowedModels.includes(destination.model)
}
export function taskEgressText(task: Pick<Task, 'notes'>, destination: EgressDestination, evidence: TaskSourceEvidence[], sources: Map<string, EvidenceSource>, ownerId: string, now = Date.now()): TaskEgress {
  const owner = ownerNotesForEgress(task.notes), lines: string[] = [], refs = new Map<string, EgressSourceRef>(), withheld = new Set<string>()
  let withheldQuotes = owner.withheldQuotes
  for (const row of [...evidence].sort((left, right) => left.id.localeCompare(right.id))) {
    const item = sources.get(row.sourceId)
    if (row.ownerId !== ownerId || !item?.sha256 || !evidenceAllowed(item.source, destination, ownerId, now)) { withheldQuotes++; withheld.add(row.sourceId); continue }
    lines.push(`資料の根拠（送信許可済み・内容版${row.snapshotRevision}）: ${row.quote}`)
    refs.set(row.sourceId, { sourceId: row.sourceId, snapshotRevision: item.source.latestRevision, permissionRevision: item.source.permissionRevision, sha256: item.sha256 })
  }
  return { ...owner, withheldQuotes, evidence: lines, refs: [...refs.values()], withheldSourceIds: [...withheld].sort() }
}
export async function loadTaskEgress(task: Task, destination: EgressDestination): Promise<TaskEgress> {
  const settings = await db.settings.get('main')
  if (!settings) throw new Error('本人の設定がありません')
  const evidence = await db.taskSourceEvidence.where('taskId').equals(task.id).toArray(), sources = new Map<string, EvidenceSource>()
  for (const id of new Set(evidence.map(row => row.sourceId))) {
    const source = await db.contextSources.get(id)
    if (!source) continue
    const snapshot = await db.contextSnapshots.get(`${source.id}:${source.latestRevision}`)
    sources.set(id, { source, sha256: snapshot && snapshot.ownerId === settings.profileId ? snapshot.sha256 : null })
  }
  return taskEgressText(task, destination, evidence, sources, settings.profileId)
}
export function egressNotice(egress: Pick<OwnerNotesEgress, 'withheldQuotes' | 'notesWithheld'>, destination = '送信'): string | null {
  if (!egress.withheldQuotes && !egress.notesWithheld) return null
  return `資料由来の引用${egress.withheldQuotes}件は${destination}対象外です。${egress.notesWithheld ? '資料由来の可能性があるメモは、本人が確認して旧形式の行を消すまで送りません。' : ''}`
}
/** Body-free audit of what left the device: route, destination, model, source IDs and permission revisions. */
export async function recordEgressAudit(destination: EgressDestination, items: { taskId: string | null; egress: TaskEgress | OwnerNotesEgress }[]): Promise<void> {
  const detail = { route: destination.route, destination: destination.kind === 'ai-model' ? 'openrouter' : 'external-agent', model: destination.kind === 'ai-model' ? destination.model : null, clientId: destination.kind === 'external-agent' ? destination.clientId : null, host: destination.kind === 'external-agent' ? destination.host : null, tasks: items.map(({ taskId, egress }) => ({ taskId, sources: 'refs' in egress ? egress.refs.map(ref => ({ sourceId: ref.sourceId, permissionRevision: ref.permissionRevision, snapshotRevision: ref.snapshotRevision })) : [], withheldSourceIds: 'withheldSourceIds' in egress ? egress.withheldSourceIds : [], withheldQuotes: egress.withheldQuotes, notesWithheld: egress.notesWithheld })) }
  await db.audits.add({ id: uid(), taskId: items.length === 1 ? items[0].taskId : null, operation: `egress.${destination.route}`, at: new Date().toISOString(), detail: JSON.stringify(detail) })
}
