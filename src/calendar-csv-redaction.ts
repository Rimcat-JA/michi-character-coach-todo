import { canonicalJSON } from './canonical'
import type { Audit, CalendarEvent, CommandReceipt } from './domain'
import { csvSnapshotRetentionUntil, type CalendarRulesState } from './calendar-resolver'

export type CSVRetentionRecords = { calendarRules: CalendarRulesState[]; calendarEvents: CalendarEvent[]; audits: Audit[]; commands?: CommandReceipt[] }

type Row = Record<string, unknown>
const rowsOf = (value: unknown) => Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === 'object') : []
/**
 * Audits keep a compact summary of a CSV source (record IDs, versions, statuses and per-import hashes and row
 * counts), never the selected rows themselves. That keeps original cells, quote hashes and the CSV person ID out
 * of audits and keeps each configuration audit small however many imports the source has.
 */
export function redactCSVForAudit<T>(value: T): T {
  function summary(csv: Row): Row {
    return {
      format: csv.format, feedId: csv.feedId, retentionUntil: csv.retentionUntil ?? null, retiredAt: csv.retiredAt ?? null,
      target: csv.target && typeof csv.target === 'object' ? { ...(csv.target as Row), personRef: null } : null,
      heads: rowsOf(csv.heads).map(head => ({ recordId: head.recordId, recordRevision: head.recordRevision, status: head.status, factId: head.factId ?? null })),
      snapshots: rowsOf(csv.snapshots).map(snapshot => ({ revision: snapshot.revision, fingerprint: snapshot.fingerprint, bodyHash: snapshot.bodyHash, importedAt: snapshot.importedAt, fromDate: snapshot.fromDate, toDate: snapshot.toDate, retentionUntil: snapshot.retentionUntil ?? null, rowCount: Array.isArray(snapshot.rows) ? snapshot.rows.length : snapshot.rowCount ?? 0 })),
    }
  }
  function scrub(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(scrub)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, key === 'csv' && child && typeof child === 'object' && !Array.isArray(child) ? summary(child as Row) : scrub(child)]))
  }
  return scrub(value) as T
}
const earliest = (left: string | null, right: string | null) => [left, right].filter((value): value is string => value !== null).sort()[0] ?? null
/**
 * Restoring an older backup must not bring back CSV originals the person has since erased or given an earlier
 * deadline (design 23.2: deletion requests are re-applied after restore). Deadlines only become earlier, and rows
 * whose original is already erased in the current data stay erased with their records expired.
 */
export function applyCurrentCSVRetention(restored: CalendarRulesState[], current: CalendarRulesState[]): CalendarRulesState[] {
  const next = structuredClone(restored)
  for (const state of next) {
    const live = current.find(row => row.ownerId === state.ownerId && row.datasetId === state.datasetId)
    for (const source of live ? state.sources : []) {
      const csv = source.csv, now = live!.sources.find(row => row.id === source.id)?.csv
      if (!csv || !now) continue
      csv.retentionUntil = earliest(csv.retentionUntil, now.retentionUntil)
      for (const snapshot of csv.snapshots) snapshot.retentionUntil = earliest(snapshot.retentionUntil, now.retentionUntil)
      const erased = new Set(now.snapshots.flatMap(snapshot => snapshot.rows.filter(row => row.quote === null).map(row => `${row.recordId}:${row.recordRevision}:${row.quoteSha256}`)))
      const allErased = now.snapshots.every(snapshot => snapshot.rows.every(row => row.quote === null))
      for (const snapshot of csv.snapshots) for (const row of snapshot.rows) if (allErased || erased.has(`${row.recordId}:${row.recordRevision}:${row.quoteSha256}`)) row.quote = null
      for (const head of csv.heads) {
        const row = csv.snapshots.find(snapshot => snapshot.revision === head.snapshotRevision)?.rows.find(item => item.rowIndex === head.rowIndex)
        if (row?.quote !== null || head.status === 'expired') continue
        head.status = 'expired'
        const fact = state.facts.find(item => item.id === head.factId && item.sourceId === source.id)
        if (fact) fact.validity = 'withdrawn'
      }
      if (csv.snapshots.every(snapshot => snapshot.rows.every(row => row.quote === null))) csv.target.personRef = null
      if (csv.heads.length && csv.heads.every(head => head.status === 'expired')) source.status = 'stale'
    }
  }
  return next
}

/** Source quotes expire independently. Participation configuration and past records stay intact. */
export function redactExpiredCSVRecords<T extends CSVRetentionRecords>(records: T, at = new Date().toISOString()): T & { expiredSourceIds: string[] } {
  if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) throw new Error('CSV保持期限の評価日時が不正です')
  const next = structuredClone(records), expiredSourceIds = new Set<string>()
  for (const state of next.calendarRules) {
    const before = canonicalJSON(state)
    for (const source of state.sources) {
      const csv = source.csv
      if (!csv) continue
      for (const snapshot of csv.snapshots) {
        const until = csvSnapshotRetentionUntil(csv, snapshot)
        if (until === null || until > at) continue
        expiredSourceIds.add(source.id)
        for (const row of snapshot.rows) row.quote = null
        for (const head of csv.heads.filter(head => head.snapshotRevision === snapshot.revision)) {
          head.status = 'expired'
          const fact = state.facts.find(fact => fact.id === head.factId && fact.sourceId === source.id)
          if (fact) fact.validity = 'withdrawn'
        }
      }
      if (csv.snapshots.every(snapshot => snapshot.rows.every(row => row.quote === null))) csv.target.personRef = null
      if (csv.heads.length && csv.heads.every(head => head.status === 'expired')) { source.status = 'stale'; source.title = '保持期限に達したCSV資料' }
    }
    if (canonicalJSON(state) !== before) state.revision++
  }
  // Old calendar audits and receipts may contain an embedded source. Remove the
  // extra cells even before expiry; the actual source is the single retained copy.
  for (const audit of next.audits) {
    // Only calendar configuration audits embed a CSV source; skip parsing everything else on each purge tick.
    if (!audit.detail.includes('"csv"')) continue
    try {
      const before = JSON.parse(audit.detail), after = redactCSVForAudit(before)
      if (canonicalJSON(before) !== canonicalJSON(after)) audit.detail = JSON.stringify(after)
    } catch { /* No parsed CSV source to redact. */ }
  }
  function hasCSVOriginal(value: unknown, inCSV = false): boolean {
    if (Array.isArray(value)) return value.some(row => hasCSVOriginal(row, inCSV))
    return Boolean(value && typeof value === 'object' && Object.entries(value).some(([key, item]) => inCSV && (key === 'quote' || key === 'personRef') && typeof item === 'string' || hasCSVOriginal(item, inCSV || key === 'csv')))
  }
  for (const receipt of next.commands ?? []) if (/^(?:calendar|csv)(?::|-)/.test(receipt.key) && receipt.hash.startsWith('{')) {
    try { if (hasCSVOriginal(JSON.parse(receipt.hash))) receipt.hash = `redacted:calendar-receipt:${receipt.resultId}` } catch { /* A non-CSV receipt is not changed. */ }
  }
  return { ...next, expiredSourceIds: [...expiredSourceIds].sort() }
}
