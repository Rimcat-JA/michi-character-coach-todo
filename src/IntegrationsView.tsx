import { calendarConnectorKinds, calendarConnectorTitles, connectorStatus, type CalendarConnectorRuntime, type CalendarConnectorKind, type CalendarCapabilityStatus } from './calendar-connectors'
import { useEffect, useState } from 'react'
import { refreshStatuses } from './schedule-refresh'
import type { CalDAVConnectionStatus } from './calendar-caldav'
const labels: Record<CalendarCapabilityStatus, string> = { available: '利用可能', needs_auth: '登録が必要', needs_scope: '権限・対象の確認が必要', policy_blocked: '設定により停止', unsupported: '未対応', degraded: '取得失敗・古い可能性' }
export function IntegrationsView({ runtime, connections = {} }: { runtime: CalendarConnectorRuntime; connections?: Partial<Record<CalendarConnectorKind, Partial<CalendarConnectorRuntime>>> }) {
  const [current, setCurrent] = useState<Partial<Record<CalendarConnectorKind, Partial<CalendarConnectorRuntime>>>>({})
  useEffect(() => {
    let active = true
    const read = () => { void refreshStatuses().then(rows => {
      if (!active) return
      const urls = rows.filter(row => row.format === 'ics' && row.kind === 'url'), caldav = rows.filter(row => row.format === 'caldav') as CalDAVConnectionStatus[]
      setCurrent({ ics_url: { adapterPresent: Boolean(window.michiScheduleRefresh), authenticated: urls.length > 0, stale: urls.some(row => row.status === 'stale'), lastCheckedAt: urls.map(row => row.lastCheckedAt).filter((at): at is string => Boolean(at)).sort().at(-1) ?? null }, caldav: { adapterPresent: Boolean(window.michiCalDAV), authenticated: caldav.length > 0, readCollection: caldav.length > 0, writeCollection: caldav.some(row => row.writeEnabled), stale: caldav.some(row => row.status === 'stale'), lastCheckedAt: caldav.map(row => row.lastCheckedAt).filter((at): at is string => Boolean(at)).sort().at(-1) ?? null } })
    }).catch(() => { if (active) setCurrent({}) }) }
    read();const timer = setInterval(read, 3000)
    return () => { active = false;clearInterval(timer) }
  }, [])
  return <section className="card setting-section" id="calendar-integrations"><h2>予定資料の外部接続</h2><p>読取・差分取得・書込を別々に表示します。資料の取込と予定への反映には、それぞれ本人の確認が必要です。</p>{calendarConnectorKinds.map(kind => {
    const status = connectorStatus(kind, { ...runtime, ...current[kind], ...connections[kind] })
    return <details key={kind} id={`calendar-connector-${kind}`}><summary>{calendarConnectorTitles[kind]} · 読取：{labels[status.incoming_events.status]} · 書込：{labels[status.write.status]}</summary><dl>{([['読取', status.incoming_events], ['差分取得', status.edits], ['書込', status.write], ['削除検知', status.deletions], ['通信設定', status.policy_status]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{labels[value.status]}：{value.reason}</dd></div>)}<dt>取得範囲</dt><dd>{status.max_known_coverage}</dd><dt>最終確認</dt><dd>{status.lastCheckedAt ? new Date(status.lastCheckedAt).toLocaleString('ja-JP') : '未確認'}</dd></dl></details>
  })}</section>
}
