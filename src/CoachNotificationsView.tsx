import { useEffect, useState } from 'react'
import type { Settings, Task } from './domain'
import { coachNotificationStateFor, muteCoachNotificationTarget, restCoachNotificationsToday, setCoachNotificationPolicy, setCoachNotificationTriggers } from './coach-notification-save'
import { coachTriggersOf, notificationLocalClock, type CoachTriggerSettings, type NotificationDeliveryStatus } from './coach-notifications'

type Props = { settings: Settings; tasks: Task[]; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }
const statusLabel: Record<NotificationDeliveryStatus, string> = { prepared: '準備済み', queued: '送信待ち', sending: '送信中', accepted_by_provider: 'アプリ表示・通知サービス受付', delivery_unknown: '送信結果不明', failed: '送信失敗', suppressed: '抑制', canceled: '取消済み' }
export default function CoachNotificationsView({ settings, tasks, run }: Props) {
  const [at, setAt] = useState(() => new Date().toISOString())
  useEffect(() => { const timer = setInterval(() => setAt(new Date().toISOString()), 60000); return () => clearInterval(timer) }, [])
  const state = coachNotificationStateFor(settings), policy = state.policy, day = notificationLocalClock(at, policy.timezone).day
  const [targetId, setTargetId] = useState(''), [timezone, setTimezone] = useState(policy.timezone)
  const resting = policy.restDays.includes(day), triggers = coachTriggersOf(state)
  const setTriggers = (patch: Partial<CoachTriggerSettings>, message: string) => run(() => setCoachNotificationTriggers(patch), message)
  const check = (label: string, checked: boolean, onChange: (value: boolean) => void, disabled = false) => <label><input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /> {label}</label>
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
    <div className="divider" /><h3>事実にもとづく通知（既定はすべてOFF）</h3>
    <p className="muted">登録済みの期限・本人が承認した公式カレンダーの変更・予定日を過ぎた件数だけを根拠にします。どれも上の停止・今日は休む・静かな時間・1日上限・対象停止を先に判定し、送信直前にも再確認します。</p>
    <div className="form-grid">
      {check('期限が近いタスクを知らせる', triggers.deadlineNear.enabled, value => setTriggers({ deadlineNear: { ...triggers.deadlineNear, enabled: value } }, value ? '期限の通知をONにしました' : '期限の通知をOFFにしました（待機中も取消）'))}
      <label className="field">期限の何日前から<input type="number" min={0} max={7} value={triggers.deadlineNear.leadDays} onChange={event => setTriggers({ deadlineNear: { ...triggers.deadlineNear, leadDays: Number(event.target.value) } }, '期限通知の日数を保存しました')} /></label>
      <label className="field">期限通知の時刻<input type="time" value={triggers.deadlineNear.time} onChange={event => setTriggers({ deadlineNear: { ...triggers.deadlineNear, time: event.target.value } }, '期限通知の時刻を保存しました')} /></label>
      {check('期限の通知を端末通知にも送る', triggers.deadlineNear.os, value => setTriggers({ deadlineNear: { ...triggers.deadlineNear, os: value } }, '送信先を保存しました'), !settings.notifications)}
      {check('公式カレンダーの変更で予定日が動いたら知らせる', triggers.calendarChange.enabled, value => setTriggers({ calendarChange: { ...triggers.calendarChange, enabled: value } }, value ? '公式変更の通知をONにしました' : '公式変更の通知をOFFにしました'))}
      {check('公式変更の通知を端末通知にも送る', triggers.calendarChange.os, value => setTriggers({ calendarChange: { ...triggers.calendarChange, os: value } }, '送信先を保存しました'), !settings.notifications)}
      {check('予定日を過ぎた未完了を1日1回知らせる（再計画の確認）', triggers.replanPrompt.enabled, value => setTriggers({ replanPrompt: { ...triggers.replanPrompt, enabled: value } }, value ? '再計画の確認通知をONにしました' : '再計画の確認通知をOFFにしました'))}
      <label className="field">再計画の確認の時刻<input type="time" value={triggers.replanPrompt.time} onChange={event => setTriggers({ replanPrompt: { ...triggers.replanPrompt, time: event.target.value } }, '時刻を保存しました')} /></label>
      {check('再計画の確認を端末通知にも送る', triggers.replanPrompt.os, value => setTriggers({ replanPrompt: { ...triggers.replanPrompt, os: value } }, '送信先を保存しました'), !settings.notifications)}
    </div>
    {check('AIで通知文を作る（期限の通知のみ）', triggers.aiText, value => setTriggers({ aiText: value }, value ? 'AIの通知文をONにしました' : 'AIの通知文をOFFにしました（保存済みの文面も使いません）'))}
    <p className="muted">通知の予約が上の判定を通った後にだけ、タスク名・期限・予定日を選択モデルへ送り一文を作ります。自動AI処理の回数上限（AI利用上限の設定、既定0回）が必要です。AIがOFF・上限・失敗・検査不合格・事実の変更時は事実の定型文で送ります。AI文面は保存済みとモデル名を表示します。</p>
    {check('ウィンドウを閉じても通知を続ける（トレイ常駐）', triggers.trayResident, value => setTriggers({ trayResident: value }, value ? 'トレイ常駐をONにしました' : 'トレイ常駐をOFFにしました'), !window.michiDesktop?.setTrayMode)}
    <p className="muted">トレイ常駐中のみウィンドウを閉じても通知を判定します。トレイの「終了」や完全終了中は通知せず、次回起動時に判定します。{window.michiDesktop?.setTrayMode ? '' : 'Windowsアプリでのみ利用できます。'}</p>
    <div className="divider" />
    <label className="field">通知しないタスク<select value={targetId} onChange={event => setTargetId(event.target.value)}><option value="">選択してください</option>{tasks.filter(task => !task.deletedAt && task.status === 'open').map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
    <button className="secondary-button" disabled={!targetId} onClick={() => run(() => muteCoachNotificationTarget(targetId), 'このタスクの全通知を停止しました')}>このタスクは通知しない</button>
    {policy.mutedTargets.map(id => <div className="setting-line" key={id}><strong>{tasks.find(task => task.id === id)?.title ?? '停止中の対象'}</strong><button className="secondary-button" onClick={() => run(() => muteCoachNotificationTarget(id, false), '対象の通知停止を解除しました')}>通知停止を解除</button></div>)}
    <div className="divider" /><h3>送信先</h3>
    {policy.destinations.map(destination => <div className="setting-line" key={destination.id}><div><strong>{destination.label}</strong><small>{destination.channel === 'messenger' ? '外部メッセンジャーは未接続です。接続・本人確認後に利用できます。' : destination.channel === 'os' ? settings.notifications ? '端末通知の許可あり。予約ごとに選択します。' : '端末通知の許可なし。上の通知設定から有効にできます。' : 'このアプリ内で表示します。'}</small></div><span className="status-tag">{destination.approved ? '許可済み' : '停止'}</span></div>)}
    <p className="muted">共有先へタスク名や会話を既定で送りません。通知サービスの受付は、端末への到着・既読とは別です。停止前に既に表示された通知を端末から消せるとは限りません。</p>
    <h3>最近の配信状況</h3>{state.intents.length ? state.intents.slice(-6).reverse().map(intent => <div className="setting-line" key={intent.id}><div> <strong>{intent.text.factual}</strong><small>{intent.text.savedAI ? `AI文面（保存済み・${intent.text.savedAIModel ?? 'モデル不明'}）: ${intent.text.savedAI} · ` : '事実の定型文 · '}{new Date(intent.reservedAt).toLocaleString('ja-JP')} · {intent.deliveries.map(delivery => `${policy.destinations.find(item => item.id === delivery.destinationId)?.label ?? delivery.destinationId}: ${statusLabel[delivery.state]}`).join(' / ')}{intent.reason ? ` · ${intent.reason}` : ''}</small></div></div>) : <p className="muted">共通ポリシーで評価した通知はまだありません。</p>}
  </section>
}
