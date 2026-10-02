import type { NetworkPolicy } from './domain'
export const calendarConnectorKinds = ['ics_file', 'ics_url', 'csv', 'pdf', 'xlsx', 'caldav', 'google', 'outlook', 'teams_shifts'] as const
export type CalendarConnectorKind = typeof calendarConnectorKinds[number]
export type CalendarCapabilityStatus = 'available' | 'needs_auth' | 'needs_scope' | 'policy_blocked' | 'unsupported' | 'degraded'
export type CalendarCapability = { status: CalendarCapabilityStatus; reason: string }
export type CalendarConnectorRuntime = { desktop: boolean; networkPolicy: NetworkPolicy; adapterPresent?: boolean; authenticated?: boolean; scopes?: string[]; writeCollection?: boolean; readCollection?: boolean; stale?: boolean; coverage?: string; lastCheckedAt?: string | null }
export const calendarConnectorTitles: Record<CalendarConnectorKind, string> = { ics_file: 'ICSファイル', ics_url: 'ICS URL', csv: 'CSV / TSV', pdf: '文字入りPDF', xlsx: 'XLSX', caldav: 'CalDAV', google: 'Google Calendar', outlook: 'Outlook', teams_shifts: 'Teams Shifts' }
/** Runtime scopes, not a claim that provider authorization has been implemented.
 * https://developers.google.com/workspace/calendar/api/auth
 * https://learn.microsoft.com/en-us/graph/permissions-reference */
export const capabilityPermissionManifest: Record<CalendarConnectorKind, { read: string[]; write: string[] }> = {
  ics_file: { read: [], write: [] }, ics_url: { read: [], write: [] }, csv: { read: [], write: [] }, pdf: { read: [], write: [] }, xlsx: { read: [], write: [] }, caldav: { read: [], write: [] },
  google: { read: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'], write: ['https://www.googleapis.com/auth/calendar.app.created'] },
  outlook: { read: ['User.Read', 'Calendars.Read'], write: ['Calendars.ReadWrite'] }, teams_shifts: { read: ['User.Read', 'Schedule.Read.All', 'Team.ReadBasic.All'], write: [] },
}
const capability = (status: CalendarCapabilityStatus, reason: string): CalendarCapability => ({ status, reason })
export function connectorStatus(kind: CalendarConnectorKind, runtime: CalendarConnectorRuntime) {
  const file = ['ics_file', 'csv', 'pdf', 'xlsx'].includes(kind), unsupported = capability('unsupported', 'この取込方法は元資料への書込に対応していません')
  let read: CalendarCapability
  if (file) read = kind === 'xlsx' && !runtime.desktop ? capability('unsupported', 'XLSXはデスクトップ版で読み取れます。CSVへの書出しも利用できます') : capability('available', '本人が選んだファイルを端末内で確認して取り込みます')
  else if (!runtime.desktop) read = capability('unsupported', 'このブラウザー版では外部予定の取得に対応していません')
  else if (runtime.networkPolicy === 'offline_only') read = capability('policy_blocked', 'オフライン専用の設定により取得を停止しています')
  else if (!runtime.adapterPresent || !runtime.authenticated) read = capability('needs_auth', ['google', 'outlook', 'teams_shifts'].includes(kind) && !runtime.adapterPresent ? 'OAuthクライアント・接続先を未登録です' : '接続先・読取対象の登録が必要です')
  else if (capabilityPermissionManifest[kind].read.some(scope => !runtime.scopes?.includes(scope))) read = capability('needs_scope', '読取に必要な権限がありません')
  else if (kind === 'caldav' && !runtime.readCollection) read = capability('needs_scope', '読取カレンダーを選んでください')
  else read = runtime.stale ? capability('degraded', '取得に失敗しました。端末内の資料は古い可能性があります') : capability('available', '間隔をおいて取得します。取得後の差分は本人の確認待ちになります')
  const canWrite = ['caldav', 'google', 'outlook'].includes(kind)
  let write = unsupported
  if (canWrite) {
    if (read.status !== 'available' && read.status !== 'degraded') write = read
    else if (capabilityPermissionManifest[kind].write.some(scope => !runtime.scopes?.includes(scope)) || kind === 'caldav' && !runtime.writeCollection) write = capability('needs_scope', 'アプリ専用の書込先と書込権限を別途選んでください')
    else write = capability('available', 'アプリ専用の書込先へ差分を別途承認して反映します')
  }
  return { kind, history_backfill: read, incoming_events: read, edits: file && read.status === 'available' ? capability('available', '再取込を確認します。端末内の本人編集は保護します') : read, deletions: file && read.status === 'available' ? capability('available', kind === 'ics_file' ? '明示取消だけ採録します。欠落で取消しません' : '本人の公開・明示取消だけを採録します。欠落で取消しません') : read, write, user_auth: file ? capability('unsupported', '本人が端末内のファイルを選びます') : read, max_known_coverage: runtime.coverage ?? '選択した取得期間・資料の有効期間内', policy_status: capability(runtime.networkPolicy === 'offline_only' && !file ? 'policy_blocked' : 'available', file ? 'ファイル取込は端末内で処理します' : '通信の許可と自動化の停止を毎回確認します'), lastCheckedAt: runtime.lastCheckedAt ?? null }
}
