import { db } from './db'
import { uid } from './domain'

export type PomodoroRuntime = { id: string; taskId: string; cycleStartedAt: string; startedAt: string | null; elapsedMs: number; targetMinutes: number }
export const POMODORO_STORAGE_KEY = 'michi-pomodoro-v1'

export function startPomodoro(taskId: string, targetMinutes: number, at: string): PomodoroRuntime {
  if (!taskId || !Number.isInteger(targetMinutes) || targetMinutes < 1 || targetMinutes > 120 || !Number.isFinite(Date.parse(at))) throw new Error('ポモドーロ設定が不正です')
  return { id: uid(), taskId, cycleStartedAt: at, startedAt: at, elapsedMs: 0, targetMinutes }
}

export function pomodoroElapsedMs(runtime: PomodoroRuntime, at: string): number {
  return runtime.elapsedMs + (runtime.startedAt ? Math.max(0, Date.parse(at) - Date.parse(runtime.startedAt)) : 0)
}

export function pausePomodoro(runtime: PomodoroRuntime, at: string): PomodoroRuntime {
  return runtime.startedAt ? { ...runtime, elapsedMs: pomodoroElapsedMs(runtime, at), startedAt: null } : runtime
}

export function resumePomodoro(runtime: PomodoroRuntime, at: string): PomodoroRuntime {
  if (!Number.isFinite(Date.parse(at))) throw new Error('再開時刻が不正です')
  return runtime.startedAt ? runtime : { ...runtime, startedAt: at }
}

export function parsePomodoroRuntime(raw: string | null): PomodoroRuntime | null {
  if (!raw) return null
  try {
    const runtime = JSON.parse(raw) as PomodoroRuntime
    if (!runtime || typeof runtime.id !== 'string' || typeof runtime.taskId !== 'string' || !runtime.taskId || !Number.isFinite(Date.parse(runtime.cycleStartedAt)) || runtime.startedAt !== null && !Number.isFinite(Date.parse(runtime.startedAt)) || !Number.isFinite(runtime.elapsedMs) || runtime.elapsedMs < 0 || !Number.isInteger(runtime.targetMinutes) || runtime.targetMinutes < 1 || runtime.targetMinutes > 120) return null
    return runtime
  } catch { return null }
}

export async function recordPomodoro(runtime: PomodoroRuntime, finishedAt: string): Promise<string> {
  const elapsed = pomodoroElapsedMs(runtime, finishedAt)
  if (!Number.isFinite(elapsed) || elapsed < runtime.targetMinutes * 60000 || elapsed > 24 * 3600000 || !Number.isFinite(Date.parse(finishedAt))) throw new Error('目標時間に達してから記録してください')
  return db.transaction('rw', [db.tasks, db.pomodoroCycles], async () => {
    const prior = await db.pomodoroCycles.get(runtime.id)
    if (prior) return prior.id
    const task = await db.tasks.get(runtime.taskId)
    if (!task || task.deletedAt) throw new Error('対象タスクがありません')
    await db.pomodoroCycles.add({ id: runtime.id, taskId: runtime.taskId, startedAt: runtime.cycleStartedAt, finishedAt, targetMinutes: runtime.targetMinutes, elapsedMinutes: Math.floor(elapsed / 60000) })
    return runtime.id
  })
}
