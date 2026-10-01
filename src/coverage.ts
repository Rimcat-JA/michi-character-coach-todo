import { addDays } from './domain'
import type { ContextSource, SourceProvider } from './source-library'
import type { CalendarRulesState } from './calendar-resolver'

export type CoverageRange = { fromDate: string; toDate: string }
export type CoverageMethod = 'manual-import' | 'ics-file' | 'csv-file'
export type ConversationCoverage = {
  key: string; kind: 'conversation' | 'calendar'; provider: SourceProvider | 'calendar'; label: string; method: CoverageMethod; sources: number
  segments: CoverageRange[]; gaps: CoverageRange[]; lastCheckedAt: string | null; earliestRetention: string | null; unlimitedRetention: number; complete: false
}
export type CapabilityState = 'available' | 'needs_auth' | 'needs_scope' | 'policy_blocked' | 'unsupported' | 'degraded'
export type CapabilityKey = 'manual_import' | 'history_backfill' | 'incoming_events' | 'edits' | 'deletions' | 'send' | 'user_auth' | 'policy_status'
export type ProviderCapability = { provider: SourceProvider | 'calendar'; label: string; capabilities: Record<CapabilityKey, { state: CapabilityState; reason: string }>; maxKnownCoverage: CoverageRange | null; conversations: number }

/** Union of imported day ranges; a day touching the previous range counts as contiguous. */
export function mergeCoverage(ranges: CoverageRange[]): { segments: CoverageRange[]; gaps: CoverageRange[] } {
  const sorted = ranges.filter(range => range.fromDate <= range.toDate).map(range => ({ ...range })).sort((left, right) => left.fromDate.localeCompare(right.fromDate) || left.toDate.localeCompare(right.toDate))
  const segments: CoverageRange[] = []
  for (const range of sorted) {
    const last = segments[segments.length - 1]
    if (last && range.fromDate <= addDays(last.toDate, 1)) { if (range.toDate > last.toDate) last.toDate = range.toDate }
    else segments.push(range)
  }
  return { segments, gaps: segments.slice(1).map((segment, index) => ({ fromDate: addDays(segments[index].toDate, 1), toDate: addDays(segment.fromDate, -1) })) }
}
const latest = (values: (string | null)[]) => values.filter((value): value is string => Boolean(value)).sort().pop() ?? null
const earliest = (values: (string | null)[]) => values.filter((value): value is string => Boolean(value)).sort()[0] ?? null
const live = (source: ContextSource, ownerId: string, now: number) => source.ownerId === ownerId && !source.deletedAt && (source.retentionUntil === null || Date.parse(source.retentionUntil) > now)

/** Per-conversation coverage of what the owner imported. It never claims a complete external history. */
export function conversationCoverage(sources: ContextSource[], ownerId: string, now = Date.now()): ConversationCoverage[] {
  const groups = new Map<string, ContextSource[]>()
  for (const source of sources) if (source.provider !== 'local' && live(source, ownerId, now)) { const key = JSON.stringify([source.provider, source.conversation ?? '']); groups.set(key, [...(groups.get(key) ?? []), source]) }
  return [...groups.entries()].map(([key, rows]) => ({ key, kind: 'conversation' as const, provider: rows[0].provider, label: rows[0].conversation ?? '会話名未設定', method: 'manual-import' as const, sources: rows.length, ...mergeCoverage(rows.map(row => ({ fromDate: row.coverage.fromDate, toDate: row.coverage.toDate }))), lastCheckedAt: latest(rows.map(row => row.coverage.lastCheckedAt)), earliestRetention: earliest(rows.map(row => row.retentionUntil)), unlimitedRetention: rows.filter(row => row.retentionUntil === null).length, complete: false as const })).sort((left, right) => left.provider.localeCompare(right.provider) || left.label.localeCompare(right.label))
}
export function calendarCoverage(state: CalendarRulesState | null | undefined, now = Date.now()): ConversationCoverage[] {
  if (!state) return []
  return state.sources.flatMap(source => {
    const file = source.ics ?? source.csv
    if (!file || source.csv?.retiredAt || file.retentionUntil !== null && Date.parse(file.retentionUntil) <= now) return []
    const snapshots: { fromDate: string; toDate: string; importedAt: string }[] = file.snapshots
    return [{ key: `calendar:${source.id}`, kind: 'calendar' as const, provider: 'calendar' as const, label: source.title, method: source.ics ? 'ics-file' as const : 'csv-file' as const, sources: snapshots.length, ...mergeCoverage(snapshots), lastCheckedAt: latest(snapshots.map(row => row.importedAt)), earliestRetention: file.retentionUntil, unlimitedRetention: file.retentionUntil === null ? 1 : 0, complete: false as const }]
  })
}

const providerLabels: [SourceProvider | 'calendar', string, string][] = [
  ['line', 'LINE', 'LINEのテキスト履歴を本人が選んで取込'], ['discord', 'Discord', '選択したメッセージJSONを取込'], ['slack', 'Slack', '手動exportの本文を資料として取込'],
  ['teams', 'Microsoft Teams', '手動exportの本文を資料として取込'], ['other', 'メール・Web・その他', 'Web選択引用・ローカル.eml・その他exportを取込'], ['calendar', 'カレンダー（ICS/CSVファイル）', 'ICS・CSVファイルを本人が選んで取込']
]
const notConnected = 'unsupported_on_this_runtime: この単独版には外部providerのadapterがありません'
/** Capability table for the standalone build: every network capability is unsupported; only manual import exists. */
export function providerCapabilities(coverage: ConversationCoverage[]): ProviderCapability[] {
  return providerLabels.map(([provider, label, manual]) => {
    const rows = coverage.filter(item => item.provider === provider), segments = rows.flatMap(item => item.segments)
    return { provider, label, conversations: rows.length, maxKnownCoverage: segments.length ? { fromDate: segments.map(item => item.fromDate).sort()[0], toDate: segments.map(item => item.toDate).sort().pop()! } : null, capabilities: {
      manual_import: { state: 'available', reason: manual },
      history_backfill: { state: 'unsupported', reason: `${notConnected}。APIによる過去履歴の取得はしません` },
      incoming_events: { state: 'unsupported', reason: `新着同期: 未接続（${notConnected}）` },
      edits: { state: 'unsupported', reason: '外部での編集は反映しません。再取込した版だけを保存します' },
      deletions: { state: 'unsupported', reason: '外部での削除は反映しません。端末内の削除は資料画面で行います' },
      send: { state: 'unsupported', reason: 'このproviderへの送信・書込みは未接続です' },
      user_auth: { state: 'unsupported', reason: 'アカウント接続（OAuth等）は実装していません' },
      policy_status: { state: 'unsupported', reason: '接続していないため、組織・providerの規約状態は取得していません' }
    } }
  })
}
