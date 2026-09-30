import { useEffect, useState } from 'react'
import type { Settings, Task } from './domain'
import { coachNotificationStateFor, muteCoachNotificationTarget, restCoachNotificationsToday, setCoachNotificationPolicy } from './coach-notification-save'
import { notificationLocalClock, type NotificationDeliveryStatus } from './coach-notifications'

type Props = { settings: Settings; tasks: Task[]; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }
const statusLabel: Record<NotificationDeliveryStatus, string> = { prepared: '準備済み', queued: '送信待ち', sending: '送信中', accepted_by_provider: 'アプリ表示・通知サービス受付', delivery_unknown: '送信結果不明', failed: '送信失敗', suppressed: '抑制', canceled: '取消済み' }
export default function CoachNotificationsView({ settings, tasks, run }: Props) {
  const [at, setAt] = useState(() => new Date().toISOString())
  useEffect(() => { const timer = setInterval(() => setAt(new Date().toISOString()), 60000); return () => clearInterval(timer) }, [])
  const state = coachNotificationStateFor(settings), policy = state.policy, day = notificationLocalClock(at, policy.timezone).day
  const [targetId, setTargetId] = useState(''), [timezone, setTimezone] = useState(policy.timezone)
  const resting = policy.restDays.includes(day)
  return <section className="card setting-section coach-notifications-view">
    <div className="setting-heading"><div><h2>共通の通知とコーチ介入</h2><p>リマインダー・Bug Me・コーチ通知の全送信先に同じ停止・休み・上限を適用します。</p></div></div>
    <div className="setting-line"><div><strong>すべての通知</strong><small>停止すると送信待ちの通知も取り消します。</small></div><button className="secondary-button" onClick={() => run(() => setCoachNotificationPolicy({ enabled: !policy.enabled }), policy.enabled ? '共通通知を停止しました' : '共通通知を有効にしました')}>{policy.enabled ? 'すべて停止' : '通知を有効にする'}</button></div>
    <div className="setting-line"><div><strong>{resting ? '今日は休みに設定済み' : '今日だけコーチ通知を休む'}</strong><small>別のきっかけや送信先からの催促も止めます。本人への返信・本人が開始したタイマーは対象外です。</small></div>{resting ? <button className="secondary-button" onClick={() => run(() => setCoachNotificationPolicy({ restDays: policy.restDays.filter(value => value !== day) }), '今日の休みを解除しました')}>今日の休みを解除</button> : <button className="secondary-button" onClick={() => run(() => restCoachNotificationsToday(), '今日のコーチ通知を停止しました')}>今日は休む</button>}</div>
    <div className="form-grid">
      <label className="field">静かな時間 開始<input type="time" value={policy.quietStart} onChange={event => run(() => setCoachNotificationPolicy({ quietStart: event.target.value }), '静かな時間を保存しました')} /></label>
      <label className="field">静かな時間 終了<input type="time" value={policy.quietEnd} onChange={event => run(() => setCoachNotificationPolicy({ quietEnd: event.target.value }), '静かな時間を保存しました')} /></label>
      <label className="field">共通の1日上限<input type="number" min={0} max={50} value={policy.dailyCap} onChange={event => run(() => setCoachNotificationPolicy({ dailyCap: Number(event.target.value) }), '通知上限を保存しました')} /></label>
      <label className="field">同じ対象の間隔（分）<input type="number" min={1} max={1440} value={policy.targetIntervalMinutes} onChange={event => run(() => setCoachNotificationPolicy({ targetIntervalMinutes: Number(event.target.value) }), '通知間隔を保存しました')} /></label>
      <label className="field">日付と静かな時間のタイムゾーン<input value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="Asia/Tokyo" /></label>
      <button className="secondary-button" onClick={() => run(() => setCoachNotificationPolicy({ timezone }), '通知のタイムゾーンを保存しました')}>タイムゾーンを保存</button>
    </div>
    <p className="muted">能動的な通知を1件として数え、アプリ内と端末通知で二重に数えません。本人が開始したBug Meには指定した間隔を使います。AI停止中は同じ事実の定型文を使います。</p>
    <div className="divider" />
    <label className="field">通知しないタスク<select value={targetId} onChange={event => setTargetId(event.target.value)}><option value="">選択してください</option>{tasks.filter(task => !task.deletedAt && task.status === 'open').map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
    <button className="secondary-button" disabled={!targetId} onClick={() => run(() => muteCoachNotificationTarget(targetId), 'このタスクの全通知を停止しました')}>このタスクは通知しない</button>
    {policy.mutedTargets.map(id => <div className="setting-line" key={id}><strong>{tasks.find(task => task.id === id)?.title ?? '停止中の対象'}</strong><button className="secondary-button" onClick={() => run(() => muteCoachNotificationTarget(id, false), '対象の通知停止を解除しました')}>通知停止を解除</button></div>)}
    <div className="divider" /><h3>送信先</h3>
    {policy.destinations.map(destination => <div className="setting-line" key={destination.id}><div><strong>{destination.label}</strong><small>{destination.channel === 'messenger' ? '外部メッセンジャーは未接続です。接続・本人確認後に利用できます。' : destination.channel === 'os' ? settings.notifications ? '端末通知の許可あり。予約ごとに選択します。' : '端末通知の許可なし。上の通知設定から有効にできます。' : 'このアプリ内で表示します。'}</small></div><span className="status-tag">{destination.approved ? '許可済み' : '停止'}</span></div>)}
    <p className="muted">共有先へタスク名や会話を既定で送りません。通知サービスの受付は、端末への到着・既読とは別です。停止前に既に表示された通知を端末から消せるとは限りません。</p>
    <h3>最近の配信状況</h3>{state.intents.length ? state.intents.slice(-6).reverse().map(intent => <div className="setting-line" key={intent.id}><div><strong>{intent.text.factual}</strong><small>{new Date(intent.reservedAt).toLocaleString('ja-JP')} · {intent.deliveries.map(delivery => `${policy.destinations.find(item => item.id === delivery.destinationId)?.label ?? delivery.destinationId}: ${statusLabel[delivery.state]}`).join(' / ')}{intent.reason ? ` · ${intent.reason}` : ''}</small></div></div>) : <p className="muted">共通ポリシーで評価した通知はまだありません。</p>}
  </section>
}
