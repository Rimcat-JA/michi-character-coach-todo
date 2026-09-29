import { completeTask, updateTask, type TaskInput } from './commands'
import type { Task } from './domain'

export type FocusRuntime = { taskId: string; startedAt: string | null; elapsedMs: number }
export const FOCUS_STORAGE_KEY = 'michi-focus-state-v2'

export function beginFocus(taskId: string, at: string): FocusRuntime {
  if (!taskId || !Number.isFinite(Date.parse(at))) throw new Error('集中開始の値が不正です')
  return { taskId, startedAt: at, elapsedMs: 0 }
}

export function focusElapsedSeconds(state: FocusRuntime | null, now: string) {
  if (!state) return 0
  return Math.floor((state.elapsedMs + (state.startedAt ? Math.max(0, Date.parse(now) - Date.parse(state.startedAt)) : 0)) / 1000)
}

export function pauseFocus(state: FocusRuntime, at: string) {
  if (!state.startedAt) return { state, segment: null }
  const end = Date.parse(at) < Date.parse(state.startedAt) ? state.startedAt : at
  return { state: { ...state, startedAt: null, elapsedMs: state.elapsedMs + Date.parse(end) - Date.parse(state.startedAt) }, segment: { taskId: state.taskId, startedAt: state.startedAt, endedAt: end } }
}

export function resumeFocus(state: FocusRuntime, at: string): FocusRuntime {
  if (state.startedAt) return state
  if (!Number.isFinite(Date.parse(at))) throw new Error('再開時刻が不正です')
  return { ...state, startedAt: at }
}

export function parseFocusRuntime(raw: string | null): FocusRuntime | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as FocusRuntime
    if (!value || typeof value.taskId !== 'string' || !value.taskId || (value.startedAt !== null && (typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)))) || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) return null
    return value
  } catch { return null }
}

function taskInput(task: Task, score: Task['score']): TaskInput {
  return { title: task.title, notes: task.notes, project: task.project, containerId: task.containerId ?? null, labels: [...task.labels], scheduledDate: task.scheduledDate, dueDate: task.dueDate, targetDate: task.targetDate, reviewDate: task.reviewDate, availableFrom: task.availableFrom, deferredUntil: task.deferredUntil ?? null, importance: task.importance, frog: task.frog ?? null, weight: task.weight ?? null, energyNeed: task.energyNeed ?? null, focusNeed: task.focusNeed ?? null, positiveFeeling: task.positiveFeeling ?? null, score }
}

export async function completeFocusedTask(task: Task, manualPoints: number | null) {
  if (task.deletedAt || task.status !== 'open') throw new Error('完了するタスクがありません')
  let revision = task.revision
  if (task.effectivePoints === null) {
    if (manualPoints === null || !Number.isInteger(manualPoints) || manualPoints < 0 || manualPoints > 100000) throw new Error('完了前に必要ポイントを0〜100000で確認してください')
    await updateTask(task.id, revision, taskInput(task, { ...task.score, mode: 'manual', manualPoints }))
    revision++
  }
  await completeTask(task.id, revision)
}
