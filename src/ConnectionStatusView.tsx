import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import type { Settings } from './domain'
import type { CalendarRulesState } from './calendar-resolver'
import { calendarCoverage, conversationCoverage, providerCapabilities, type CapabilityKey, type CapabilityState, type ConversationCoverage, type ProviderCapability } from './coverage'

const capabilityLabels: Record<CapabilityKey, string> = { manual_import: '取得方式（手動取込）', history_backfill: '過去履歴の取得', incoming_events: '新着同期', edits: '編集の反映', deletions: '削除の反映', send: '送信・書込み', user_auth: 'アカウント接続', policy_status: '規約・組織ポリシー' }
const stateLabels: Record<CapabilityState, string> = { available: '利用可', needs_auth: '要認証', needs_scope: '要追加許可', policy_blocked: 'ポリシーで停止', unsupported: '未対応', degraded: '一部制限' }
const methodLabels = { 'manual-import': '手動取込', 'ics-file': 'ICSファイル', 'csv-file': 'CSVファイル' } as const
const when = (value: string | null) => value ? new Date(value).toLocaleString('ja-JP') : '未確認'

export function ConnectionStatusPanel({ coverage, capabilities }: { coverage: ConversationCoverage[]; capabilities: ProviderCapability[] }) {
  return <section className="card setting-section connection-status" aria-label="連携と取得範囲">
    <div className="setting-heading"><div><h2>連携と取得範囲</h2><p>この端末に本人が取り込んだ範囲だけを表示します。外部サービスの全履歴を取得したとは表示しません。外部アカウントの接続・新着同期はこの版では未接続です。</p></div></div>
    <div className="table-scroll"><table className="connection-capabilities"><thead><tr><th>サービス</th>{(Object.keys(capabilityLabels) as CapabilityKey[]).map(key => <th key={key}>{capabilityLabels[key]}</th>)}<th>既知の取得範囲</th></tr></thead>
      <tbody>{capabilities.map(row => <tr key={row.provider}><th scope="row">{row.label}</th>{(Object.keys(capabilityLabels) as CapabilityKey[]).map(key => <td key={key} data-capability={key} data-state={row.capabilities[key].state} title={row.capabilities[key].reason}>{stateLabels[row.capabilities[key].state]}{key === 'incoming_events' && row.capabilities[key].state === 'unsupported' ? '（新着同期: 未接続）' : ''}</td>)}<td>{row.maxKnownCoverage ? `${row.maxKnownCoverage.fromDate}〜${row.maxKnownCoverage.toDate}（${row.conversations}件、欠落あり得る）` : row.selections ? '' : '取込なし'}{row.selections ? `${row.maxKnownCoverage ? ' · ' : ''}選択した引用${row.selections}件（範囲なし）` : ''}</td></tr>)}</tbody></table></div>
    <h3>会話ごとの取得範囲</h3>
    {coverage.length === 0 && <p className="muted">保存期限内の取込済み会話・予定ファイルはありません。</p>}
    {coverage.map(item => <article className="setting-line" key={item.key} data-coverage={item.key}><div>
      <strong>{item.label}</strong><small> · {capabilities.find(row => row.provider === item.provider)?.label ?? item.provider} · 方式 {methodLabels[item.method]} · 取込{item.sources}件</small>
      {item.selectionOnly ? <p>選択した引用のみ（範囲・欠落の概念なし）・取込日：{item.segments.map(segment => segment.fromDate === segment.toDate ? segment.fromDate : `${segment.fromDate}〜${segment.toDate}`).join('、')}</p> : <><p>取得済み（和集合）：{item.segments.map(segment => `${segment.fromDate}〜${segment.toDate}`).join('、')}</p>
      <p>{item.gaps.length ? <span role="note">欠落期間：{item.gaps.map(gap => `${gap.fromDate}〜${gap.toDate}`).join('、')}（この期間の依頼の有無は不明）</span> : '取得範囲内の欠落：なし（範囲外と未取込の期間は未確認）'}</p></>}
      <small>最終取込確認 {when(item.lastCheckedAt)} · 新着同期: 未接続 · 保持期限 {item.earliestRetention ? `最短 ${when(item.earliestRetention)}` : '期限なし'}{item.unlimitedRetention && item.earliestRetention ? `（期限なし ${item.unlimitedRetention}件）` : ''}</small>
    </div></article>)}
  </section>
}

export default function ConnectionStatusView({ settings, calendarState }: { settings: Settings; calendarState?: CalendarRulesState | null }) {
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 60000); return () => window.clearInterval(timer) }, [])
  const sources = useLiveQuery(() => db.contextSources.where('ownerId').equals(settings.profileId).toArray(), [settings.profileId]) ?? []
  const coverage = [...conversationCoverage(sources, settings.profileId, clock), ...calendarCoverage(calendarState?.ownerId === settings.profileId ? calendarState : null, clock)]
  return <ConnectionStatusPanel coverage={coverage} capabilities={providerCapabilities(coverage)} />
}
