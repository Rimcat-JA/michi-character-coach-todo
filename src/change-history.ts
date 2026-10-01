import { db } from './db'
import type { Audit } from './domain'
import { decideChangePolicy, type ChangePolicy, type PreparedChangeSet, type TaskChangeField } from './change-set'
import { changeAuditFact, coachMediatedChange, localClock, operationsForFields, ownerTimezone, type ChangeAuditFact, type OperationGroup } from './automation-policy'

export type DryRunEntry = { changeSetId: string; at: string; taskIds: string[]; principal: ChangeAuditFact['principal']; fields: TaskChangeField[]; actual: 'auto' | 'approved'; wouldBe: 'auto' | 'awaiting_approval' | 'denied'; reason: string }
export type DryRunSummary = { from: string; to: string; total: number; auto: number; approval: number; denied: number; entries: DryRunEntry[] }

/** Agent (coach/external) task changes, newest first. Display data only; it cannot authorize anything. */
export function agentChangeHistory(audits: Audit[], limit = 50): ChangeAuditFact[] {
  return audits.map(changeAuditFact).filter((fact): fact is ChangeAuditFact => Boolean(fact && fact.principal.kind !== 'human')).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}
/** All task rows of the newest change made through the coach (agent changes or owner-approved coach-screen changes), for 「さっきの変更を戻して」. Owner changes older than 24h are not offered. */
export function latestCoachChange(audits: Audit[], now = new Date().toISOString()): ChangeAuditFact[] {
  const facts = audits.map(changeAuditFact).filter((fact): fact is ChangeAuditFact => Boolean(fact && !fact.undoOf && coachMediatedChange(fact) && (fact.principal.kind !== 'human' || Date.parse(now) - Date.parse(fact.at) <= 86400000))).sort((a, b) => b.at.localeCompare(a.at) || a.auditId.localeCompare(b.auditId))
  return facts.length ? facts.filter(fact => fact.changeSetId === facts[0].changeSetId) : []
}
export function undoneAuditIds(audits: Audit[]): Set<string> {
  return new Set(audits.map(changeAuditFact).flatMap(fact => fact?.undoOf ? [fact.undoOf] : []))
}
/** Pure re-evaluation of logged agent ChangeSets under a candidate policy. It writes nothing. */
export function dryRunPolicy(candidate: ChangePolicy, audits: Audit[], now = new Date().toISOString(), days = 7, timezone = ownerTimezone()): DryRunSummary {
  const from = new Date(Date.parse(now) - days * 86400000).toISOString()
  const facts = audits.map(changeAuditFact).filter((fact): fact is ChangeAuditFact => Boolean(fact && fact.principal.kind !== 'human' && !fact.undoOf && fact.at >= from && fact.at <= now)).sort((a, b) => a.at.localeCompare(b.at) || a.auditId.localeCompare(b.auditId))
  const groups = new Map<string, ChangeAuditFact[]>()
  for (const fact of facts) groups.set(fact.changeSetId, [...groups.get(fact.changeSetId) ?? [], fact])
  const counts = new Map<string, Partial<Record<OperationGroup, number>>>(), entries: DryRunEntry[] = []
  for (const [changeSetId, group] of groups) {
    const at = group[0].at, day = localClock(at, timezone).day, today = counts.get(day) ?? {}
    // Only the fields decideChangePolicy reads are reconstructed from the audit.
    const pseudo = { principal: group[0].principal, changes: group.map(fact => ({ taskId: fact.taskId, fields: fact.fields, before: fact.before, after: fact.after })) } as unknown as PreparedChangeSet
    const decision = decideChangePolicy(pseudo, candidate, { at, timezone, autoCountToday: today })
    if (decision.status === 'auto') { for (const fact of group) for (const operation of operationsForFields(fact.fields)) today[operation] = (today[operation] ?? 0) + 1; counts.set(day, today) }
    entries.push({ changeSetId, at, taskIds: group.flatMap(fact => fact.taskId ? [fact.taskId] : []), principal: group[0].principal, fields: [...new Set(group.flatMap(fact => fact.fields))], actual: group.every(fact => fact.decision === 'auto') ? 'auto' : 'approved', wouldBe: decision.status, reason: decision.reason })
  }
  return { from, to: now, total: entries.length, auto: entries.filter(entry => entry.wouldBe === 'auto').length, approval: entries.filter(entry => entry.wouldBe === 'awaiting_approval').length, denied: entries.filter(entry => entry.wouldBe === 'denied').length, entries }
}
export async function recentChangeAudits(days = 8): Promise<Audit[]> {
  return db.audits.where('at').above(new Date(Date.now() - days * 86400000).toISOString()).toArray()
}
export async function lastAutomaticChange(): Promise<ChangeAuditFact | null> {
  return agentChangeHistory(await db.audits.toArray()).find(fact => fact.decision === 'auto') ?? null
}

/** K12/S21: one trace row per change from every entrance. Parsed from audits for display only; nothing is re-executed. */
export type TraceEntrance = 'ui_human' | 'ui_coach' | 'file' | 'mcp' | 'app'
export type TraceOperator = { kind: 'human' | 'coach' | 'external-agent'; id: string | null; model: string | null }
export type ChangeTraceEntry = {
  auditId: string; at: string; operation: string; label: string; taskId: string | null; entrance: TraceEntrance; operator: TraceOperator
  decision: 'auto' | 'approved' | 'self'; approver: string | null; policyEpoch: number | null; digest: string | null; basis: string | null; commandId: string | null
  fields: string[]; before: Record<string, unknown>; after: Record<string, unknown>; summary: string; legacy: boolean
}
export const TRACE_LABELS: Record<string, string> = {
  'changeset.update': 'タスクの変更', 'filebridge.approved': '外部コマンドの適用', 'filebridge.auto': '外部コマンドの自動適用', breakdown: 'タスクの分割', 'calendar.configuration': '周期・暦の設定', 'calendar.apply': '発生回の反映', 'calendar.csv.approved': '暦CSVの取込', 'routine.assistance.approved': '周期補助の承認',
  'assist.approved': '作成補助の登録', 'detection.approved': '検出タスクの登録', 'localaction.result': 'PCの許可済み操作', 'achievement.approve': '実績公開の承認',
  update: '本人の編集', bulk_update: '一括編集', set_flag: 'フラグ変更', complete: '完了', undo: '完了の取消', correct_points: '実績の訂正', trash: 'ゴミ箱へ移動', restore_task: 'ゴミ箱から戻す',
}
const HUMAN_OPERATIONS = new Set(['update', 'bulk_update', 'set_flag', 'complete', 'undo', 'correct_points', 'trash', 'restore_task', 'breakdown'])
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const text = (value: unknown, max = 200) => typeof value === 'string' && value ? value.slice(0, max) : null
const number = (value: unknown) => Number.isSafeInteger(value) ? Number(value) : null
const entranceOf = (value: unknown, fallback: TraceEntrance): TraceEntrance => value === 'file-bridge' ? 'file' : ['ui_human', 'ui_coach', 'file', 'mcp'].includes(value as string) ? value as TraceEntrance : fallback
function operatorOf(value: unknown, fallback: TraceOperator): TraceOperator {
  if (!isRecord(value) || !['human', 'coach', 'external-agent'].includes(value.kind as string)) return fallback
  return { kind: value.kind as TraceOperator['kind'], id: text(value.id), model: text(value.model, 120) }
}
const pick = (value: unknown, fields: string[]) => isRecord(value) ? Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]])) : {}
/** Tolerant of legacy free-text details; unknown operations are skipped, never guessed. ICS/CSV bodies are never copied. */
export function changeTraceEntry(audit: Audit): ChangeTraceEntry | null {
  if (!audit || typeof audit.operation !== 'string' || !Object.hasOwn(TRACE_LABELS, audit.operation)) return null
  let detail: unknown = null
  try { detail = typeof audit.detail === 'string' && audit.detail.trim().startsWith('{') ? JSON.parse(audit.detail) : null } catch { detail = null }
  const owner: TraceOperator = { kind: 'human', id: null, model: null }
  const base = { auditId: audit.id, at: audit.at, operation: audit.operation, label: TRACE_LABELS[audit.operation], taskId: audit.taskId ?? null }
  const empty = { fields: [] as string[], before: {}, after: {}, approver: null, policyEpoch: null, digest: null, basis: null, commandId: null }
  if (!isRecord(detail)) {
    // Legacy rows kept a short sentence only; they are shown as such.
    const summary = typeof audit.detail === 'string' ? audit.detail.slice(0, 300) : ''
    if (audit.operation === 'assist.approved') return { ...base, ...empty, entrance: 'app', operator: /origin=ai_accepted/.test(summary) ? { kind: 'coach', id: 'app-coach', model: null } : owner, decision: 'approved', digest: summary.match(/[a-f0-9]{64}/)?.[0] ?? null, summary: '本人が内容を確認して登録', legacy: true }
    if (!HUMAN_OPERATIONS.has(audit.operation)) return null
    return { ...base, ...empty, entrance: 'ui_human', operator: owner, decision: 'self', summary, legacy: true }
  }
  if (audit.operation === 'changeset.update') {
    const fact = changeAuditFact(audit)
    if (!fact) return null
    const fallback: TraceEntrance = fact.principal.kind === 'human' ? 'ui_human' : fact.principal.kind === 'coach' ? 'ui_coach' : 'file'
    return { ...base, entrance: entranceOf(detail.entrance, fallback), operator: operatorOf(fact.principal, owner), decision: fact.decision, approver: text(detail.approvedBy), policyEpoch: number(detail.policyEpoch), digest: text(detail.digest, 64), basis: text(detail.basis, 40) ?? (fact.principal.kind === 'external-agent' ? 'external_request' : 'app_instruction'), commandId: text(detail.commandId), fields: fact.fields, before: pick(fact.before, fact.fields), after: pick(fact.after, fact.fields), summary: fact.undoOf ? '代理変更の取り消し' : '', legacy: !Object.hasOwn(detail, 'entrance') }
  }
  if (detail.schema === 'command.audit/1') {
    const fields = Array.isArray(detail.fields) ? detail.fields.filter((field): field is string => typeof field === 'string').slice(0, 50) : []
    const decision = detail.decision === 'auto' || detail.decision === 'approved' ? detail.decision : 'self'
    return { ...base, entrance: entranceOf(detail.entrance, 'ui_human'), operator: operatorOf(detail.principal, owner), decision, approver: text(detail.approvedBy), policyEpoch: number(detail.policyEpoch), digest: text(detail.digest, 64), basis: text(detail.basis, 40), commandId: text(detail.commandId) ?? text(detail.commandKey), fields, before: pick(detail.before, fields), after: pick(detail.after, fields), summary: text(detail.summary, 500) ?? '', legacy: false }
  }
  if (audit.operation === 'filebridge.approved' || audit.operation === 'filebridge.auto') {
    const auto = detail.decision === 'auto' || audit.operation === 'filebridge.auto'
    return { ...base, ...empty, entrance: entranceOf(detail.entrance, 'file'), operator: { kind: 'external-agent', id: text(detail.clientId), model: null }, decision: auto ? 'auto' : 'approved', approver: auto ? null : text(detail.approvedBy), policyEpoch: number(detail.policyEpoch), digest: text(detail.applicationDigest, 64), basis: text(detail.basis, 40) ?? 'external_request', commandId: text(detail.commandId), summary: text(detail.operation, 40) ?? '', legacy: !Object.hasOwn(detail, 'basis') }
  }
  const approver = text(detail.approvedBy)
  if (audit.operation === 'routine.assistance.approved' || audit.operation === 'calendar.csv.approved') {
    const source = isRecord(detail.source) ? detail.source : detail, external = source.basis === 'external_request' || detail.origin === 'external_request'
    return { ...base, ...empty, entrance: external ? entranceOf(source.entrance, 'file') : 'app', operator: external ? { kind: 'external-agent', id: text(source.actorId), model: null } : text(detail.model, 120) ? { kind: 'coach', id: 'app-coach', model: text(detail.model, 120) } : owner, decision: 'approved', approver, policyEpoch: number(detail.policyEpoch), digest: text(detail.digest, 64), basis: text(source.basis, 40) ?? text(detail.origin, 40), commandId: text(source.commandId), summary: external ? '外部依頼の周期設定を本人が承認（発生回の反映は別承認）' : '', legacy: false }
  }
  if (audit.operation === 'calendar.configuration' || audit.operation === 'calendar.apply') return { ...base, ...empty, entrance: 'app', operator: owner, decision: 'approved', approver, policyEpoch: number(detail.policyEpoch), digest: text(detail.digest, 64), summary: audit.operation === 'calendar.configuration' ? `設定版 ${number(detail.fromRevision) ?? '?'} → ${number(detail.toRevision) ?? '?'}` : `作成${Array.isArray(detail.creates) ? detail.creates.length : 0}件・更新${Array.isArray(detail.updates) ? detail.updates.length : 0}件・取消${Array.isArray(detail.cancels) ? detail.cancels.length : 0}件`, legacy: false }
  if (audit.operation === 'detection.approved') return { ...base, ...empty, entrance: 'app', operator: { kind: 'coach', id: 'app-coach', model: text(detail.detectorModel, 120) }, decision: 'approved', approver, policyEpoch: number(detail.policyEpoch), digest: text(detail.digest, 64), basis: 'verified_detection', summary: '', legacy: false }
  if (HUMAN_OPERATIONS.has(audit.operation)) return null
  return { ...base, ...empty, entrance: 'app', operator: owner, decision: 'approved', approver, policyEpoch: number(detail.policyEpoch), digest: text(detail.digest, 64) ?? text(detail.approvalDigest, 64), summary: text(detail.status, 40) ?? '', legacy: false }
}
/** Newest first, `pageSize` per page. */
export function changeTrace(audits: Audit[], page = 0, pageSize = 50): { entries: ChangeTraceEntry[]; total: number } {
  const all = audits.map(changeTraceEntry).filter((entry): entry is ChangeTraceEntry => Boolean(entry)).sort((a, b) => b.at.localeCompare(a.at) || b.auditId.localeCompare(a.auditId))
  return { entries: all.slice(page * pageSize, (page + 1) * pageSize), total: all.length }
}
