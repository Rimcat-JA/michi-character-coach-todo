import { canonicalJSON } from './canonical'
import type { Audit, CalendarEvent, CommandReceipt } from './domain'
import type { CalendarRulesState } from './calendar-resolver'

const expiredTitle = '保持期限に達した外部予定'
/** Audits keep hashes and versions, never a second copy of the imported original. */
export function redactICSForAudit<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactICSForAudit) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'originalText' || key === 'originalJSON' ? null : redactICSForAudit(item)])) as T
  return value
}
export type ICSRetentionRecords = { calendarRules: CalendarRulesState[]; calendarEvents: CalendarEvent[]; audits: Audit[]; commands?: CommandReceipt[] }
/** Pure backup/restore filter. Times, identities, completion records and points are preserved. */
export function redactExpiredICSRecords<T extends ICSRetentionRecords>(records: T, at = new Date().toISOString()): T & { expiredSourceIds: string[] } {
  if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) throw new Error('ICS保持期限の評価日時が不正です')
  const next = structuredClone(records), sourceIds = new Set<string>(), activityIds = new Set<string>(), entityIds = new Set<string>()
  for (const state of next.calendarRules) {
    let changed = false
    for (const source of state.sources) {
      if (!source.ics?.retentionUntil || source.ics.retentionUntil > at) continue
      sourceIds.add(source.id)
      const before = canonicalJSON(source)
      source.status = 'stale'; source.title = '保持期限に達したICS資料'
      source.ics.snapshots = [ { ...source.ics.snapshots.at(-1)!, originalText: null } ]
      if (source.caldav) source.caldav.snapshots = [{...source.caldav.snapshots.at(-1)!,originalJSON:null}]
      if (canonicalJSON(source) !== before) changed = true
      for (const fact of state.facts) if (fact.sourceId === source.id && fact.kind === 'external_event') { activityIds.add(fact.activityId); if (fact.title !== expiredTitle) { fact.title = expiredTitle; changed = true } }
    }
    for (const activity of state.activities) if (activityIds.has(activity.id) && activity.title !== expiredTitle) { activity.title = expiredTitle; changed = true }
    for (const instance of state.instances) if (!instance.spec.ruleId && instance.spec.sourceRefs.some(item => sourceIds.has(item.sourceId))) { entityIds.add(instance.entityId); if (instance.spec.title !== expiredTitle) { instance.spec.title = expiredTitle; changed = true } }
    if (changed) state.revision++
  }
  for (const event of next.calendarEvents) if (entityIds.has(event.id)) event.title = expiredTitle
  function scrub(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(scrub)
    if (!value || typeof value !== 'object') return value
    const object = value as Record<string, unknown>, related = sourceIds.has(String(object.id)) || sourceIds.has(String(object.sourceId)) || activityIds.has(String(object.id)) || activityIds.has(String(object.activityId)) || Array.isArray(object.sourceRefs) && object.sourceRefs.some(item => item && typeof item === 'object' && sourceIds.has(String((item as Record<string, unknown>).sourceId)))
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, key === 'originalText' || key === 'originalJSON' ? null : related && key === 'title' ? expiredTitle : scrub(item)]))
  }
  for (const audit of next.audits) if (audit.operation.startsWith('calendar.') && sourceIds.size) { try { audit.detail = JSON.stringify(scrub(JSON.parse(audit.detail))) } catch { audit.detail = JSON.stringify({ redacted: '期限到達したICS資料の監査', at }) } }
  // Legacy receipts encoded the full proposal. Erase that second copy and fail closed on replay.
  const hasOriginal = (value: unknown): boolean => Array.isArray(value) ? value.some(hasOriginal) : Boolean(value && typeof value === 'object' && Object.entries(value).some(([key, item]) => key === 'originalText' && typeof item === 'string' || hasOriginal(item)))
  for (const command of next.commands ?? []) if (command.key.startsWith('calendar:') && command.hash.startsWith('{')) { try { if (hasOriginal(JSON.parse(command.hash))) command.hash = `redacted:calendar-receipt:${command.resultId}` } catch { /* Non-ICS legacy receipt stays intact. */ } }
  // Existing audits can have originals even before expiry; remove their duplicate immediately.
  for (const audit of next.audits) if (audit.operation.startsWith('calendar.')) { try { const detail: unknown = JSON.parse(audit.detail); if (hasOriginal(detail)) audit.detail = JSON.stringify(redactICSForAudit(detail)) } catch { /* No parsed original to expose. */ } }
  return { ...next, expiredSourceIds: [...sourceIds] }
}
