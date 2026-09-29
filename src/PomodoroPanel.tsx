import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { today, type Task } from './domain'
import { POMODORO_STORAGE_KEY, parsePomodoroRuntime, pausePomodoro, pomodoroElapsedMs, recordPomodoro, resumePomodoro, startPomodoro, type PomodoroRuntime } from './pomodoro'

export default function PomodoroPanel({ tasks, run }: { tasks: Task[]; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [runtime, setRuntime] = useState<PomodoroRuntime | null>(() => parsePomodoroRuntime(localStorage.getItem(POMODORO_STORAGE_KEY)))
  const [taskId, setTaskId] = useState(''), [target, setTarget] = useState(25), [tick, setTick] = useState(() => new Date().toISOString())
  const cycles = useLiveQuery(() => db.pomodoroCycles.toArray(), []) ?? []
  const elapsed = runtime ? Math.floor(pomodoroElapsedMs(runtime, tick) / 1000) : 0
  const due = !!runtime && elapsed >= runtime.targetMinutes * 60
  const count = cycles.filter(cycle => today(new Date(cycle.finishedAt)) === today()).length
  useEffect(() => { const timer = setInterval(() => setTick(new Date().toISOString()), 1000); return () => clearInterval(timer) }, [])
  function persist(value: PomodoroRuntime | null) { setRuntime(value); if (value) localStorage.setItem(POMODORO_STORAGE_KEY, JSON.stringify(value)); else localStorage.removeItem(POMODORO_STORAGE_KEY) }
  async function finish() {
    if (!runtime) return
    if (await run(() => recordPomodoro(runtime, new Date().toISOString()), 'ポモドーロを1回記録しました')) persist(null)
  }
  return <section className="card pomodoro-panel"><div className="card-heading"><h2>ポモドーロ</h2><span className="status-tag">今日 {count}回</span></div><p>実施回数を作業時間・完了ポイントとは別に記録します。スリープ後も実時刻から経過を復元します。</p>
    {runtime ? <><strong className="pomodoro-clock">{String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</strong><p>{tasks.find(task => task.id === runtime.taskId)?.title ?? 'タスク'} · 目標 {runtime.targetMinutes}分 · {runtime.startedAt ? '進行中' : '中断中'}</p><div className="super-focus-actions">{runtime.startedAt ? <button className="secondary-button" onClick={() => persist(pausePomodoro(runtime, new Date().toISOString()))}>中断</button> : <button className="secondary-button" onClick={() => persist(resumePomodoro(runtime, new Date().toISOString()))}>再開</button>}<button className="primary-button" disabled={!due} onClick={finish}>1回を記録</button><button className="text-button" onClick={() => persist(null)}>記録せず終了</button></div></> : <><div className="form-grid"><label className="field">タスク<select value={taskId} onChange={event => setTaskId(event.target.value)}><option value="">選択してください</option>{tasks.filter(task => !task.deletedAt && task.status === 'open').map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><label className="field">集中時間<select value={target} onChange={event => setTarget(Number(event.target.value))}>{[15, 25, 45, 60].map(minutes => <option key={minutes} value={minutes}>{minutes}分</option>)}</select></label></div><button className="primary-button" disabled={!taskId} onClick={() => persist(startPomodoro(taskId, target, new Date().toISOString()))}>ポモドーロを始める</button></>}
  </section>
}
