import { useState } from 'react'
import type { Settings, SmartList, Task } from './domain'
import { createReminder, markReminderRead, setReminderPolicy, stopReminder } from './reminders'

type Props = { tasks: Task[]; lists: SmartList[]; settings: Settings; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean>; mode: 'today' | 'settings' }

export default function ReminderCenter({ tasks, lists, settings, run, mode }: Props) {
  const [taskId, setTaskId] = useState('')
  const [listId, setListId] = useState('')
  const [when, setWhen] = useState(() => { const date = new Date(Date.now() + 3600000); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` })
  const [dailyTime, setDailyTime] = useState('09:00')
  const [useOS, setUseOS] = useState(false)
  const state = settings.reminderState
  const rules = state?.rules ?? []
  const unread = (state?.events ?? []).filter(event => !event.readAt)
  const availableTasks = tasks.filter(task => !task.deletedAt && task.status === 'open')
  const channels: ('in-app' | 'os')[] = useOS && settings.notifications ? ['in-app', 'os'] : ['in-app']

  if (mode === 'today') return unread.length ? <section className="card reminder-center"><h2>リマインダー {unread.length}件</h2><div className="reminder-items">{unread.slice(-10).reverse().map(event => <div key={event.id} className="setting-line"><div><strong>{event.title}</strong><small>{new Date(event.at).toLocaleString('ja-JP')} · {event.kind === 'bug-me' ? '反復催促' : event.kind === 'smart-daily' ? 'Smart List' : 'タスク'}</small></div><button className="secondary-button" onClick={() => run(() => markReminderRead(event.id), '確認しました')}>確認</button></div>)}</div></section> : null

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
    <p className="muted">Bug Meは本人が開始したときだけ有効です。30分間隔で最大3回、今日までです。</p>
    <div className="divider" />
    <label className="field">Smart List<select value={listId} onChange={event => setListId(event.target.value)}><option value="">選択してください</option>{lists.filter(list => list.ownerId === settings.profileId).map(list => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>
    <label className="field">毎日の通知時刻<input type="time" value={dailyTime} onChange={event => setDailyTime(event.target.value)} /></label>
    <button className="secondary-button" disabled={!listId} onClick={() => run(() => createReminder('smart-daily', listId, dailyTime, channels), 'Smart Listの毎日通知を予約しました')}>毎日通知を予約</button>
    <div className="divider" />
    <h3>予約一覧</h3>{rules.length ? <div className="reminder-items">{rules.slice().reverse().map(rule => <div className="setting-line" key={rule.id}><div><strong>{rule.kind === 'smart-daily' ? lists.find(list => list.id === rule.targetId)?.name : tasks.find(task => task.id === rule.targetId)?.title ?? '削除された対象'}</strong><small>{rule.kind === 'bug-me' ? 'Bug Me' : rule.kind === 'smart-daily' ? 'Smart List毎日' : '1回'} · 次回 {new Date(rule.nextAt).toLocaleString('ja-JP')} · {rule.sentCount}回送信 · {rule.enabled ? '有効' : '停止済み'}</small></div>{rule.enabled && <button className="secondary-button" onClick={() => run(() => stopReminder(rule.id), '待機中の通知を全宛先で停止しました')}>停止</button>}</div>)}</div> : <p className="muted">予約はありません。</p>}
  </section>
}
