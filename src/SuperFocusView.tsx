import { useEffect, useState } from 'react'
import { Clock3, Flame } from 'lucide-react'
import { logSession } from './commands'
import { today, type Task, type WorkSession } from './domain'
import { FOCUS_STORAGE_KEY, beginFocus, completeFocusedTask, focusElapsedSeconds, parseFocusRuntime, pauseFocus, resumeFocus, type FocusRuntime } from './focus-session'
import { spotlightTasks } from './focus-tools'
import { unionSessionMinutes } from './time-tracking'

function initialRuntime(): FocusRuntime | null {
  const saved = parseFocusRuntime(localStorage.getItem(FOCUS_STORAGE_KEY))
  if (saved) return saved
  const startedAt = localStorage.getItem('michi-focus-start'), taskId = localStorage.getItem('michi-focus-task')
  return startedAt && taskId && Number.isFinite(Date.parse(startedAt)) ? { taskId, startedAt, elapsedMs: 0 } : null
}

export default function SuperFocusView({ tasks, sessions, onEdit, onBack, run }: { tasks: Task[]; sessions: WorkSession[]; onEdit: (task: Task) => void; onBack: () => void; run: (fn: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const [runtime, setRuntime] = useState<FocusRuntime | null>(initialRuntime)
  const [selectedId, setSelectedId] = useState(() => initialRuntime()?.taskId ?? '')
  const [tick, setTick] = useState(() => new Date().toISOString())
  const [manualPoints, setManualPoints] = useState('')
  const [trouble, setTrouble] = useState(false)
  const spotlight = spotlightTasks(tasks)
  const currentTask = tasks.find(task => task.id === (runtime?.taskId ?? selectedId))
  const next = spotlight.find(task => task.id !== currentTask?.id)
  const elapsed = focusElapsedSeconds(runtime, tick)
  const todayMinutes = unionSessionMinutes(sessions.filter(session => today(new Date(session.startedAt)) === today()))

  useEffect(() => { const timer = setInterval(() => setTick(new Date().toISOString()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => { if (runtime) localStorage.setItem(FOCUS_STORAGE_KEY, JSON.stringify(runtime)); localStorage.removeItem('michi-focus-start'); localStorage.removeItem('michi-focus-task') }, [runtime])
  function persist(nextState: FocusRuntime | null) { setRuntime(nextState); if (nextState) localStorage.setItem(FOCUS_STORAGE_KEY, JSON.stringify(nextState)); else localStorage.removeItem(FOCUS_STORAGE_KEY) }
  function start() { if (!spotlight.some(task => task.id === selectedId)) return; persist(beginFocus(selectedId, tick)) }
  async function pause() {
    if (!runtime?.startedAt) return true
    const result = pauseFocus(runtime, new Date().toISOString())
    if (result.segment && !(await run(() => logSession(result.segment!.taskId, result.segment!.startedAt, result.segment!.endedAt), '作業を中断し、区間を記録しました'))) return false
    persist(result.state)
    return true
  }
  function resume() { if (runtime) persist(resumeFocus(runtime, new Date().toISOString())) }
  async function stop() { if (runtime?.startedAt && !(await pause())) return false; persist(null); return true }
  async function complete() {
    if (!currentTask || (runtime?.startedAt && !(await pause()))) return
    const points = manualPoints.trim() === '' ? null : Number(manualPoints)
    if (await run(() => completeFocusedTask(currentTask, points), 'タスクを完了しました')) { persist(null); setSelectedId(next?.id ?? ''); setManualPoints(''); setTrouble(false) }
  }
  async function goNext() { if (runtime && !(await stop())) return; setSelectedId(next?.id ?? ''); setManualPoints(''); setTrouble(false) }
  return <><div className="page-heading"><div><span className="eyebrow">SUPER FOCUS</span><h1>いまのひとつに集中</h1><p>Spotlightの少数のタスクから一つを選び、作業区間を記録します。</p></div><button className="secondary-button" onClick={onBack}>今日へ戻る</button></div><div className="focus-card card"><div className="focus-ring"><Flame size={30} /><strong>{String(Math.floor(elapsed / 3600)).padStart(2, '0')}:{String(Math.floor(elapsed % 3600 / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</strong><small>{runtime?.startedAt ? '集中中' : runtime ? '中断中' : '集中時間'}</small></div>{runtime ? <><h2>{currentTask?.title ?? '対象タスクがありません'}</h2><div className="super-focus-actions">{runtime.startedAt ? <button className="secondary-button" onClick={pause}>中断</button> : <button className="primary-button" onClick={resume}>再開</button>}<button className="secondary-button" onClick={stop}>終了して時間を記録</button></div></> : <><label className="field focus-select">取り組むタスク<select value={selectedId} onChange={event => { setSelectedId(event.target.value); setManualPoints(''); setTrouble(false) }}><option value="">{spotlight.length ? '選択してください' : 'Spotlightへタスクを追加してください'}</option>{spotlight.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><button className="primary-button" disabled={!spotlight.some(task => task.id === selectedId)} onClick={start}>集中を始める</button></>}{currentTask && <><div className="super-focus-complete">{currentTask.effectivePoints === null ? <label className="field">完了前に必要ポイントを確認<input type="number" min={0} max={100000} step={1} value={manualPoints} onChange={event => setManualPoints(event.target.value)} placeholder="0も指定できます" /></label> : <p>確認済みの必要ポイント：{currentTask.effectivePoints}pt</p>}<button className="primary-button" disabled={currentTask.effectivePoints === null && manualPoints.trim() === ''} onClick={complete}>このタスクを完了</button></div><div className="super-focus-actions"><button className="secondary-button" onClick={() => setTrouble(value => !value)}>困っている</button><button className="secondary-button" disabled={!next} onClick={goNext}>次候補 {next?.title ?? ''}</button><button className="text-button" onClick={() => onEdit(currentTask)}>タスクを開く →</button></div>{trouble && <div className="super-focus-trouble"><strong>進めにくいとき</strong><p>作業を小さく分ける、予定を見直す、いったん中断する方法があります。</p><button className="text-button" onClick={() => onEdit(currentTask)}>タスクを開いて分割する</button><button className="text-button" onClick={pause}>いったん中断する</button></div>}</>}</div><div className="card info-card"><Clock3 size={20} /><p>今日記録した作業時間は <strong>{todayMinutes}分</strong> です。中断中の時間は追加しません。</p></div></>
}
