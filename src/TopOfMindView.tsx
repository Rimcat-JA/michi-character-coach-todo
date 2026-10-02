import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { logSession } from './commands'
import { FOCUS_STORAGE_KEY, completeFocusedTask, focusElapsedSeconds, parseFocusRuntime, pauseFocus, resumeFocus, type FocusRuntime } from './focus-session'
import type { Task } from './domain'

export default function TopOfMindView({ tasks }: { tasks: Task[] }) {
  const [runtime, setRuntime] = useState<FocusRuntime | null>(() => parseFocusRuntime(localStorage.getItem(FOCUS_STORAGE_KEY)))
  const [tick, setTick] = useState(() => new Date().toISOString())
  const [manualPoints, setManualPoints] = useState('')
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const task = tasks.find(item => item.id === runtime?.taskId && !item.deletedAt && item.status === 'open')
  // Dexie's live query follows the main window's move/freeze across windows.
  const mode = useLiveQuery(() => db.datasetState.get('main').then(row => row?.mode ?? 'active'), [], 'active')
  useEffect(() => {
    const timer = setInterval(() => setTick(new Date().toISOString()), 1000)
    const sync = (event: StorageEvent) => { if (event.key === FOCUS_STORAGE_KEY) setRuntime(parseFocusRuntime(event.newValue)) }
    window.addEventListener('storage', sync)
    return () => { clearInterval(timer); window.removeEventListener('storage', sync) }
  }, [])
  function persist(next: FocusRuntime | null) {
    setRuntime(next)
    if (next) localStorage.setItem(FOCUS_STORAGE_KEY, JSON.stringify(next))
    else localStorage.removeItem(FOCUS_STORAGE_KEY)
  }
  async function pause() {
    if (!runtime?.startedAt) return true
    const result = pauseFocus(runtime, new Date().toISOString())
    try {
      if (result.segment) await logSession(result.segment.taskId, result.segment.startedAt, result.segment.endedAt, `focus:${result.segment.taskId}:${result.segment.startedAt}`)
      const shared = parseFocusRuntime(localStorage.getItem(FOCUS_STORAGE_KEY))
      if (!shared || shared.startedAt !== runtime.startedAt || shared.taskId !== runtime.taskId) { setRuntime(shared); return true }
      persist(result.state)
      return true
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); return false }
  }
  async function complete() {
    if (!task || busy) return
    setBusy(true); setMessage('')
    try {
      if (runtime?.startedAt && !(await pause())) return
      const latest = await db.tasks.get(task.id)
      if (!latest || latest.status !== 'open' || latest.deletedAt) { persist(null); setMessage('メイン画面で完了済みです'); return }
      await completeFocusedTask(latest, manualPoints.trim() === '' ? null : Number(manualPoints))
      persist(null)
      setMessage('完了を記録しました')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const elapsed = focusElapsedSeconds(runtime, tick)
  return <main className="mini-focus"><div className="mini-focus-heading"><strong>✦ michi · Top of Mind</strong><button className="text-button" onClick={() => window.michiDesktop?.showMain()}>メインを開く</button></div>
    {mode !== 'active' && <p role="status" className="dataset-mode-banner">{mode === 'frozen' ? '移行のため凍結中です。完了・記録はできません' : '別端末へ移行済みのため読み取り専用です'}</p>}
    {task && runtime ? <><h1>{task.title}</h1><strong className="mini-focus-clock">{String(Math.floor(elapsed / 3600)).padStart(2, '0')}:{String(Math.floor(elapsed % 3600 / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</strong><p>{runtime.startedAt ? '集中中' : '中断中'} · 同じ作業状態をメイン画面と共有</p><div className="mini-focus-actions">{runtime.startedAt ? <button className="secondary-button" disabled={busy} onClick={pause}>中断</button> : <button className="secondary-button" disabled={busy} onClick={() => persist(resumeFocus(runtime, new Date().toISOString()))}>再開</button>}<button className="primary-button" disabled={busy || task.effectivePoints === null && manualPoints.trim() === ''} onClick={complete}>完了</button></div>{task.effectivePoints === null ? <label className="field">必要ポイントを確認<input type="number" min={0} max={100000} step={1} value={manualPoints} onChange={event => setManualPoints(event.target.value)} placeholder="0も指定できます" /></label> : <small>必要ポイント {task.effectivePoints}pt</small>}</> : <p>メイン画面の「集中」からタスクを開始するとここに表示されます。</p>}
    {message && <p role="status">{message}</p>}
  </main>
}
