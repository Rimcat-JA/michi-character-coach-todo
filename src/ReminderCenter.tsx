import { useState } from 'react'
import { taskDueTime, type ReminderRule, type Settings, type SmartList, type Task } from './domain'
import { createReminder, deadlineReminderAt, markReminderRead, setReminderPolicy, stopReminder } from './reminders'

type Props = { tasks: Task[]; lists: SmartList[]; settings: Settings; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean>; mode: 'today' | 'settings' }
const reminderLabel = (kind: ReminderRule['kind']) => kind === 'bug-me' ? 'Bug Me' : kind === 'smart-daily' ? 'Smart List毎日' : kind === 'review' ? '見直し日' : '1回'
const reservationTime = (rule: ReminderRule) => rule.kind === 'review' && !rule.reviewDate ? '見直し日未設定（通知を待機）' : rule.kind === 'review' && rule.sentCount ? `${rule.reviewDate} 通知済み（次の見直し日を待機）` : `次回 ${new Date(rule.nextAt).toLocaleString('ja-JP')}`

export default function ReminderCenter({ tasks, lists, settings, run, mode }: Props) {
  const [taskId, setTaskId] = useState('')
  const [listId, setListId] = useState('')
  const [when, setWhen] = useState(() => { const date = new Date(Date.now() + 3600000); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` })
  const [dailyTime, setDailyTime] = useState('09:00')
  const [reviewTime, setReviewTime] = useState('09:00')
  const [useOS, setUseOS] = useState(false)
  const state = settings.reminderState
  const rules = state?.rules ?? []
  const unread = (state?.events ?? []).filter(event => !event.readAt && (event.kind !== 'review' || tasks.some(task => task.id === event.targetId && !task.deletedAt && task.status === 'open' && task.reviewDate === event.reviewDate && task.revision === event.reviewRevision) && rules.some(rule => rule.id === event.ruleId && rule.enabled && rule.reviewDate === event.reviewDate)))
  const availableTasks = tasks.filter(task => !task.deletedAt && task.status === 'open')
  const selectedTask = availableTasks.find(task => task.id === taskId)
  const channels: ('in-app' | 'os')[] = useOS && settings.notifications ? ['in-app', 'os'] : ['in-app']

  if (mode === 'today') return unread.length ? <section className="card reminder-center"><h2>リマインダー {unread.length}件</h2><div className="reminder-items">{unread.slice(-10).reverse().map(event => <div key={event.id} className="setting-line"><div><strong>{event.title}</strong><small>{new Date(event.at).toLocaleString('ja-JP')} · {reminderLabel(event.kind)}</small></div><button className="secondary-button" onClick={() => run(() => markReminderRead(event.id), '確認しました')}>確認</button></div>)}</div></section> : null

  return <section className="card setting-section reminder-center"><div className="setting-heading"><div><h2>リマインダーと反復催促</h2><p>アプリを開いている間に判定します。終了中の予約通知は次回起動時に判定します。</p></div></div>
    <div className="form-grid">
      <label className="field">静かな時間 開始<input type="time" value={state?.quietStart ?? '22:00'} onChange={event => run(() => setReminderPolicy({ quietStart: event.target.value }), '静かな時間を保存しました')} /></label>
      <label className="field">静かな時間 終了<input type="time" value={state?.quietEnd ?? '08:00'} onChange={event => run(() => setReminderPolicy({ quietEnd: event.target.value }), '静かな時間を保存しました')} /></label>
      <label className="field">1日上限<input type="number" min={0} max={50} value={state?.dailyCap ?? 6} onChange={event => run(() => setReminderPolicy({ dailyCap: Number(event.target.value) }), '通知上限を保存しました')} /></label>
      <label className="field">OS通知<input type="checkbox" checked={useOS && settings.notifications} disabled={!settings.notifications} onChange={event => setUseOS(event.target.checked)} /> {settings.notifications ? 'この予約にも送る' : '上の通知を有効にすると選べます'}</label>
    </div>
    <div className="divider" />
    <label className="field">対象タスク<select value={taskId} onChange={event => setTaskId(event.target.value)}><option value="">選択してください</option>{availableTasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
    <label className="field">1回通知する時刻<input type="datetime-local" value={when} onChange={event => setWhen(event.target.value)} /></label>
    <div className="export-buttons"><button className="secondary-button" disabled={!taskId || !when} onClick={() => run(() => createReminder('once', taskId, when, channels), 'タスクの通知を予約しました')}>1回通知を予約</button><button className="secondary-button" disabled={!taskId} onClick={() => run(() => createReminder('bug-me', taskId, '', channels), '30分間隔の催促を予約しました')}>Bug Meを開始</button></div>
    {selectedTask?.dueAt && <><button className="secondary-button" onClick={() => run(() => createReminder('once', taskId, deadlineReminderAt(selectedTask, 30), channels), '締め切り時刻の30分前に通知を予約しました')}>締め切り時刻の30分前に通知</button><p className="muted">締め切り：{selectedTask.dueDate} {taskDueTime(selectedTask)}（{selectedTask.dueTimezone}）。時刻付きの締め切りから計算します。</p></>}
    <p className="muted">Bug Meは本人が開始したときだけ有効です。30分間隔で最大3回、今日までです。</p>
    <label className="field">見直し日の通知時刻<input type="time" value={reviewTime} onChange={event => setReviewTime(event.target.value)} /></label>
    <button className="secondary-button" disabled={!selectedTask?.reviewDate || !reviewTime || rules.some(rule => rule.kind === 'review' && rule.targetId === taskId && rule.enabled)} onClick={() => run(() => createReminder('review', taskId, reviewTime, channels), '見直し日の通知を予約しました')}>見直し日に通知</button>
    <p className="muted">{selectedTask?.reviewDate ? `見直し日: ${selectedTask.reviewDate}。` : 'タスク編集で見直し日を設定すると予約できます。'}その見直し日に1回通知し、見直し日を変更すると次の日付へ追従します。作業の完了・予定日・期限は変更しません。</p>
    <div className="divider" />
    <label className="field">Smart List<select value={listId} onChange={event => setListId(event.target.value)}><option value="">選択してください</option>{lists.filter(list => list.ownerId === settings.profileId).map(list => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>
    <label className="field">毎日の通知時刻<input type="time" value={dailyTime} onChange={event => setDailyTime(event.target.value)} /></label>
    <button className="secondary-button" disabled={!listId} onClick={() => run(() => createReminder('smart-daily', listId, dailyTime, channels), 'Smart Listの毎日通知を予約しました')}>毎日通知を予約</button>
    <div className="divider" />
    <h3>予約一覧</h3>{rules.length ? <div className="reminder-items">{rules.slice().reverse().map(rule => <div className="setting-line" key={rule.id}><div><strong>{rule.kind === 'smart-daily' ? lists.find(list => list.id === rule.targetId)?.name : tasks.find(task => task.id === rule.targetId)?.title ?? '削除された対象'}</strong><small>{reminderLabel(rule.kind)} · {reservationTime(rule)} · {rule.sentCount}回送信 · {rule.enabled ? '有効' : '停止済み'}</small></div>{rule.enabled && <button className="secondary-button" onClick={() => run(() => stopReminder(rule.id), '待機中の通知を全宛先で停止しました')}>停止</button>}</div>)}</div> : <p className="muted">予約はありません。</p>}
  </section>
}
