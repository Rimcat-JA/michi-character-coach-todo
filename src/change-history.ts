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
