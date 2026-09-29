import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { today, type Habit } from './domain'
import { createHabit, habitProgress, recordHabitLog } from './habits'

export default function HabitsView({ run }: { run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [title, setTitle] = useState(''), [unit, setUnit] = useState('回'), [target, setTarget] = useState('1')
  const [direction, setDirection] = useState<Habit['direction']>('increase'), [cadence, setCadence] = useState<Habit['cadence']>('daily'), [routineId, setRoutineId] = useState('')
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const habits = useLiveQuery(() => db.habits.toArray(), []) ?? []
  const logs = useLiveQuery(() => db.habitLogs.toArray(), []) ?? []
  const tasks = useLiveQuery(() => db.tasks.toArray(), []) ?? []
  const routines = useLiveQuery(() => db.routines.toArray(), []) ?? []
  const settings = useLiveQuery(() => db.settings.get('main'), [])
  const date = today()
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  async function add() {
    if (await run(() => createHabit({ title, unit, targetAmount: Number(target), direction, cadence, weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: zone, routineId: routineId || null }), '習慣を作成しました')) setTitle('')
  }
  return <><div className="page-heading"><div><span className="eyebrow">HABITS</span><h1>習慣</h1><p>量を記録します。習慣ログだけでポイントは増えません。</p></div></div>
    <section className="card list-card"><div className="card-heading"><h2>習慣を作成</h2></div><div className="form-grid">
      <label className="field">名前<input value={title} maxLength={100} onChange={event => setTitle(event.target.value)} placeholder="例：読書" /></label>
      <label className="field">方向<select value={direction} onChange={event => setDirection(event.target.value as Habit['direction'])}><option value="increase">増やす</option><option value="decrease">減らす</option></select></label>
      <label className="field">目標量<input type="number" min={0} value={target} onChange={event => setTarget(event.target.value)} /></label>
      <label className="field">単位<input value={unit} maxLength={30} onChange={event => setUnit(event.target.value)} /></label>
      <label className="field">周期<select value={cadence} onChange={event => setCadence(event.target.value as Habit['cadence'])}><option value="daily">毎日</option><option value="weekly">毎週</option><option value="monthly">毎月</option></select></label>
      <label className="field">関連ルーティン（任意）<select value={routineId} onChange={event => setRoutineId(event.target.value)}><option value="">なし</option>{routines.map(routine => <option key={routine.id} value={routine.id}>{routine.title}</option>)}</select></label>
    </div><p className="muted">記録のtimezone：{zone}。関連タスクの完了だけがポイント台帳に入ります。</p><button className="primary-button" disabled={!title.trim() || !unit.trim() || target === ''} onClick={add}>習慣を作成</button></section>
    <section className="card list-card"><div className="card-heading"><h2>継続記録</h2></div>{habits.filter(habit => habit.ownerId === settings?.profileId && habit.active).map(habit => {
      const progress = habitProgress(habit, date, logs, tasks)
      const currentLog = logs.find(log => log.habitId === habit.id && log.date === date)
      return <div className="habit-row" key={habit.id}><div><strong>{habit.title}</strong><small>{habit.direction === 'increase' ? '増やす' : '減らす'} · {habit.cadence === 'daily' ? '毎日' : habit.cadence === 'weekly' ? '毎週' : '毎月'} · 目標 {habit.targetAmount}{habit.unit}</small><span>{progress.amount === null ? '未入力' : `${progress.amount}${habit.unit}`} {progress.metTarget ? '· 目標達成' : ''}{progress.linkedTaskCompleted ? ' · 関連タスク完了' : ''}</span></div><input aria-label={`${habit.title}の今日の量`} type="number" min={0} value={amounts[habit.id] ?? (currentLog ? String(currentLog.amount) : '')} onChange={event => setAmounts(values => ({ ...values, [habit.id]: event.target.value }))} placeholder="今日の量" /><button className="secondary-button" disabled={(amounts[habit.id] ?? (currentLog ? String(currentLog.amount) : '')) === ''} onClick={() => run(() => recordHabitLog(habit.id, date, Number(amounts[habit.id] ?? currentLog?.amount)), '習慣ログを保存しました')}>記録</button>{currentLog && <small>版 {currentLog.revision} · 訂正履歴 {currentLog.history.length}件</small>}</div>
    })}{!habits.length && <p className="muted">習慣はまだありません。</p>}</section>
  </>
}
